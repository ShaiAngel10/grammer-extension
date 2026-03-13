/**
 * background.js — Service Worker
 *
 * Handles all outbound API requests so the OpenAI API key never
 * touches the content-script layer (which runs in page context and
 * could be inspected via DevTools by any site).
 *
 * Message protocol (from content.js → background.js):
 *   { type: 'CHECK_GRAMMAR', text: string, language: string }
 *
 * Response back to content.js:
 *   { success: true,  data: { correctedText, explanation, corrections[] } }
 *   { success: false, error: string }
 */

// ─── Configuration ──────────────────────────────────────────────────────────

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
const MAX_TOKENS = 1500; // Increased from 500 to avoid truncation on longer texts

/**
 * IMPORTANT: Do NOT hard-code your API key here in production.
 * Store it via the extension's Options page → chrome.storage.local.
 * The key is retrieved dynamically on every request below.
 */

// ─── Language → locale display name map ─────────────────────────────────────

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

// ─── System prompt factory ───────────────────────────────────────────────────

/**
 * Builds a strict system prompt that forces the model to return
 * only a parseable JSON object — no markdown fences, no prose.
 *
 * @param {string} langCode - BCP-47 language code, e.g. 'en'
 * @returns {string}
 */
function buildSystemPrompt(langCode) {
  const langName = LANGUAGE_NAMES[langCode] ?? langCode;

  return `You are a professional ${langName} grammar and spell-checking assistant.

The user will send you a piece of text. Your job is to:
1. Correct all spelling mistakes, grammar errors, punctuation issues, and awkward phrasing.
2. Preserve the original meaning and tone as closely as possible.
3. Return ONLY a raw JSON object with this exact shape (no markdown, no code fences):

{
  "correctedText": "<the fully corrected text>",
  "explanation": "<one concise sentence summarising what was changed and why>",
  "corrections": [
    {
      "original": "<the original erroneous fragment>",
      "corrected": "<the corrected fragment>",
      "reason": "<brief grammatical or spelling reason>"
    }
  ]
}

If the text has NO errors, return the original text unchanged and set "explanation" to "No errors found." and "corrections" to [].
Never include anything outside the JSON object.`;
}

// ─── Per-tab in-flight lock ───────────────────────────────────────────────────
// Prevents overlapping requests from the same tab, which could happen if a
// slow API response comes back after the user has already triggered another check.

const inFlightTabs = new Set();

// ─── Core API call ───────────────────────────────────────────────────────────

/**
 * Calls the OpenAI Chat Completions endpoint.
 *
 * @param {string} text      - The user's text to check
 * @param {string} language  - BCP-47 language code
 * @param {string} apiKey    - The stored OpenAI API key
 * @returns {Promise<{correctedText, explanation, corrections[]}>}
 */
async function callGrammarAPI(text, language, apiKey) {
  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0.2, // Low temperature = more deterministic corrections
      messages: [
        { role: 'system', content: buildSystemPrompt(language) },
        { role: 'user',   content: text },
      ],
    }),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    const msg = errBody?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`OpenAI API error: ${msg}`);
  }

  const payload = await response.json();

  // Extract the raw string from the first choice
  const raw = payload?.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('Empty response from OpenAI API.');

  // Parse the JSON the model returned
  // Strip accidental code fences just in case the model misbehaves
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned);

  // Validate expected shape
  if (typeof parsed.correctedText !== 'string') {
    throw new Error('Malformed API response: missing correctedText.');
  }

  return parsed;
}

// ─── Message listener ────────────────────────────────────────────────────────

/**
 * chrome.runtime.onMessage fires whenever content.js (or popup.js)
 * calls chrome.runtime.sendMessage().
 *
 * We must return `true` from the listener to keep the message channel
 * open while the async work resolves (Manifest V3 requirement).
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  // ── Grammar check request ──────────────────────────────────────────────────
  if (message.type === 'CHECK_GRAMMAR') {
    const { text, language = 'en' } = message;
    const tabId = _sender.tab?.id ?? 'popup';

    // Reject if a request is already in-flight for this tab
    if (inFlightTabs.has(tabId)) {
      sendResponse({ success: false, error: 'A check is already in progress. Please wait.' });
      return true;
    }

    // Retrieve the API key from secure local storage before every request
    chrome.storage.local.get(['apiKey'], async ({ apiKey }) => {
      if (!apiKey) {
        sendResponse({ success: false, error: 'No API key set. Please open the extension popup and enter your OpenAI API key.' });
        return;
      }

      inFlightTabs.add(tabId);
      try {
        const data = await callGrammarAPI(text, language, apiKey);
        sendResponse({ success: true, data });
      } catch (err) {
        console.error('[GrammarAI background]', err);
        sendResponse({ success: false, error: err.message });
      } finally {
        inFlightTabs.delete(tabId);
      }
    });

    return true; // ← keeps channel open for async sendResponse
  }

  // ── API key save (called from popup.js) ───────────────────────────────────
  if (message.type === 'SAVE_API_KEY') {
    const key = message.apiKey?.trim();
    if (!key) {
      // Empty key — clear any stored key
      chrome.storage.local.remove('apiKey', () => sendResponse({ success: true }));
    } else {
      chrome.storage.local.set({ apiKey: key }, () => sendResponse({ success: true }));
    }
    return true;
  }
});
