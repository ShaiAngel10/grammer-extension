/**
 * background.js — Service Worker (v2)
 *
 * Handles all outbound API requests so the OpenAI API key never
 * touches the content-script layer.
 *
 * Message protocol:
 *   { type: 'CHECK_GRAMMAR', text, language, mode, tone, requestId }
 *   { type: 'SAVE_API_KEY', apiKey }
 *   { type: 'CLEAR_USAGE' }
 *   { type: 'OPEN_OPTIONS' }
 *
 * Responses always include { requestId } so content.js can discard stale replies.
 */

// Firefox / Chrome compatibility shim
const ext = typeof browser !== 'undefined' ? browser : chrome;

// ─── Configuration ───────────────────────────────────────────────────────────

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
const MAX_TOKENS = 1500;
const MAX_RETRIES = 1;

// Cost estimate: GPT-4o-mini ~$0.15/1M input + ~$0.60/1M output
// Use a blended conservative estimate of $0.40/1M total tokens
const COST_PER_TOKEN = 0.40 / 1_000_000;

// ─── Language map ─────────────────────────────────────────────────────────────

const LANGUAGE_NAMES = {
  en: 'English',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
  de: 'German (Deutsch)',
  it: 'Italian (Italiano)',
  pt: 'Portuguese (Português)',
  nl: 'Dutch (Nederlands)',
  pl: 'Polish (Polski)',
  ru: 'Russian (Русский)',
  ja: 'Japanese (日本語)',
  zh: 'Chinese Simplified (中文)',
  ar: 'Arabic (العربية)',
};

const TONE_DESCRIPTIONS = {
  formal:     'formal and professional',
  casual:     'friendly and casual',
  concise:    'concise and direct, removing unnecessary words',
  persuasive: 'persuasive and compelling',
};

// ─── Prompt factories ─────────────────────────────────────────────────────────

/**
 * Smart unified grammar prompt.
 * The AI decides whether to do a targeted fix or a full rephrase
 * based on the quality of the input text.
 */
function buildGrammarPrompt(langCode, customPrompt = '') {
  const langName = LANGUAGE_NAMES[langCode] ?? langCode;
  const base = `You are a professional ${langName} grammar and writing assistant.

Analyse the text the user sends and decide which type of response is most helpful:

TYPE "fix" — Use this when the text has specific isolated errors (spelling, punctuation, wrong word, minor grammar) but the overall sentence structure and clarity are acceptable. Only patch the exact errors; keep everything else identical.

TYPE "rephrase" — Use this when the overall sentence quality is poor: the text is confusing, awkward, hard to follow, repetitive, or would benefit significantly from being rewritten rather than patched. Rewrite to maximise clarity, flow, and readability while preserving the original meaning.

Return ONLY a raw JSON object (no markdown, no code fences).

For TYPE "fix":
{
  "type": "fix",
  "correctedText": "<the corrected text with only the errors patched>",
  "explanation": "<one concise sentence summarising what was changed and why>",
  "corrections": [
    {
      "original": "<the original erroneous fragment>",
      "corrected": "<the corrected fragment>",
      "reason": "<brief grammatical or spelling reason>"
    }
  ]
}

For TYPE "rephrase":
{
  "type": "rephrase",
  "correctedText": "<the fully rewritten text>",
  "explanation": "<one sentence describing the main improvements made>",
  "corrections": []
}

If the text has NO errors and reads well, return type "fix" with correctedText equal to the original, explanation "No errors found." and corrections [].
Never include anything outside the JSON object.`;

  return customPrompt ? `${base}\n\nAdditional instructions: ${customPrompt}` : base;
}

function buildTonePrompt(langCode, tone = 'formal', customPrompt = '') {
  const langName = LANGUAGE_NAMES[langCode] ?? langCode;
  const toneDesc = TONE_DESCRIPTIONS[tone] ?? tone;
  const base = `You are a ${langName} writing assistant that rewrites text to be ${toneDesc}.

The user will send you a piece of text. Rewrite it in a ${toneDesc} style while preserving the core meaning.
Return ONLY a raw JSON object with this exact shape (no markdown, no code fences):

{
  "type": "rephrase",
  "correctedText": "<the rewritten text>",
  "explanation": "<one sentence describing how the tone was adjusted>",
  "corrections": []
}

Never include anything outside the JSON object.`;

  return customPrompt ? `${base}\n\nAdditional instructions: ${customPrompt}` : base;
}

// ─── Storage helper ───────────────────────────────────────────────────────────

function storageGet(store, keys) {
  return new Promise(resolve => store.get(keys, resolve));
}

// ─── Per-tab in-flight lock ───────────────────────────────────────────────────

const inFlightTabs = new Set();

// ─── Core API call with retry ─────────────────────────────────────────────────

async function callOpenAI(messages, apiKey, attempt = 0) {
  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0.2,
      messages,
    }),
  });

  // Rate limit — surface immediately, do not retry
  if (response.status === 429) {
    throw new Error('RATE_LIMIT:OpenAI rate limit reached. Please wait a moment before trying again.');
  }

  // Server error — retry once after a short delay
  if (response.status >= 500 && attempt < MAX_RETRIES) {
    await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    return callOpenAI(messages, apiKey, attempt + 1);
  }

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    const msg = errBody?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`OpenAI API error: ${msg}`);
  }

  const payload = await response.json();
  const raw = payload?.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('Empty response from OpenAI API.');

  // Track usage
  const totalTokens = payload.usage?.total_tokens ?? 0;
  if (totalTokens > 0) {
    storageGet(ext.storage.local, ['usageStats']).then(({ usageStats = { calls: 0, total_tokens: 0 } }) => {
      ext.storage.local.set({
        usageStats: {
          calls: usageStats.calls + 1,
          total_tokens: usageStats.total_tokens + totalTokens,
        },
      });
    });
  }

  // Strip accidental markdown fences
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned);

  if (typeof parsed.correctedText !== 'string') {
    throw new Error('Malformed API response: missing correctedText.');
  }

  return parsed;
}

// ─── Message listener ─────────────────────────────────────────────────────────

ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  // ── Grammar / tone check ──────────────────────────────────────────────────
  if (message.type === 'CHECK_GRAMMAR') {
    const { text, language = 'en', mode = 'grammar', tone = 'formal', requestId } = message;
    const tabId = _sender.tab?.id ?? 'popup';

    // Return IN_FLIGHT code so content.js can schedule a retry
    if (inFlightTabs.has(tabId)) {
      sendResponse({ success: false, error: 'IN_FLIGHT', requestId });
      return true;
    }

    (async () => {
      const [{ apiKey }, { customSystemPrompt = '' }] = await Promise.all([
        storageGet(ext.storage.local, ['apiKey']),
        storageGet(ext.storage.sync, ['customSystemPrompt']),
      ]);

      if (!apiKey) {
        sendResponse({ success: false, error: 'NO_API_KEY', requestId });
        return;
      }

      inFlightTabs.add(tabId);
      try {
        const systemPrompt = mode === 'tone'
          ? buildTonePrompt(language, tone, customSystemPrompt)
          : buildGrammarPrompt(language, customSystemPrompt);

        const data = await callOpenAI(
          [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }],
          apiKey
        );
        sendResponse({ success: true, data, requestId });
      } catch (err) {
        console.error('[GrammarAI background]', err);
        sendResponse({ success: false, error: err.message, requestId });
      } finally {
        inFlightTabs.delete(tabId);
      }
    })();

    return true; // keep channel open for async sendResponse
  }

  // ── Save / clear API key ──────────────────────────────────────────────────
  if (message.type === 'SAVE_API_KEY') {
    const key = message.apiKey?.trim();
    if (!key) {
      ext.storage.local.remove('apiKey', () => sendResponse({ success: true }));
    } else {
      ext.storage.local.set({ apiKey: key }, () => sendResponse({ success: true }));
    }
    return true;
  }

  // ── Clear usage stats ─────────────────────────────────────────────────────
  if (message.type === 'CLEAR_USAGE') {
    ext.storage.local.set({ usageStats: { calls: 0, total_tokens: 0 } }, () =>
      sendResponse({ success: true })
    );
    return true;
  }

  // ── Open options page (called from content.js) ────────────────────────────
  if (message.type === 'OPEN_OPTIONS') {
    ext.runtime.openOptionsPage();
    return false;
  }
});
