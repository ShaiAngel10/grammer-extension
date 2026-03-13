/**
 * content.js — Content Script (v2)
 *
 * Features:
 *  - Debounce per element (WeakMap timers)
 *  - Per-request ID for stale-response cancellation
 *  - IN_FLIGHT retry (500ms backoff)
 *  - Spinner overlay on active field
 *  - Suggestion tooltip with:
 *      • Flesch-Kincaid readability score
 *      • Expandable corrections (click to reveal reason)
 *      • Per-correction "Ignore" button
 *      • Keyboard shortcuts (Escape = dismiss, Enter = apply)
 *  - Undo bar after applying a fix
 *  - Error tooltip (with clickable link for NO_API_KEY)
 *  - Per-site disable support
 *  - Tone rewriting mode
 *  - Native spellcheck as offline fallback
 */

// Firefox / Chrome compatibility shim
const ext = typeof browser !== 'undefined' ? browser : chrome;

// ─── Constants ────────────────────────────────────────────────────────────────

const DEBOUNCE_MS       = 850;
const MIN_TEXT_LENGTH   = 15;
const TOOLTIP_ID        = 'grammarai-tooltip';
const UNDO_BAR_ID       = 'grammarai-undo-bar';
const ACTIVE_FIELD_ATTR = 'data-grammarai-active';
const EDITABLE_SELECTOR = 'textarea, input[type="text"], input[type="search"], [contenteditable]';

// ─── State ────────────────────────────────────────────────────────────────────

let isEnabled      = true;
let selectedLang   = 'en';
let selectedMode   = 'grammar';   // 'grammar' | 'tone'
let selectedTone   = 'formal';
let isSiteDisabled = false;
let ignoredPhrases = new Set();

// Per-element WeakMaps
const debounceTimers = new WeakMap(); // el → setTimeout handle
const requestIds     = new WeakMap(); // el → latest requestId string
const retryTimers    = new WeakMap(); // el → retry setTimeout handle
const spinners       = new WeakMap(); // el → spinner div

// Tooltip cleanup state
let currentTooltipTarget  = null;
let outsideClickHandler   = null;
let keyboardHandler       = null;
let undoBarTimer          = null;

// ─── Readability ──────────────────────────────────────────────────────────────

function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1;
  const stripped = w.replace(/e$/, '');
  const groups = stripped.match(/[aeiou]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

function fleschKincaid(text) {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!sentences.length || !words.length) return null;

  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const score = Math.round(Math.max(0, Math.min(100,
    206.835
    - 1.015 * (words.length / sentences.length)
    - 84.6  * (syllables / words.length)
  )));

  let label;
  if      (score >= 90) label = 'Very Easy';
  else if (score >= 80) label = 'Easy';
  else if (score >= 70) label = 'Fairly Easy';
  else if (score >= 60) label = 'Standard';
  else if (score >= 50) label = 'Fairly Difficult';
  else if (score >= 30) label = 'Difficult';
  else                  label = 'Very Difficult';

  return { score, label, words: words.length };
}

// ─── Element helpers ──────────────────────────────────────────────────────────

function getTextFromElement(el) {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value;
  return el.innerText ?? el.textContent ?? '';
}

function setTextInElement(el, text) {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (nativeSetter) nativeSetter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    el.innerText = text;
    const range = document.createRange();
    const sel   = window.getSelection();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

function showSpinner(el) {
  hideSpinner(el);
  const rect    = el.getBoundingClientRect();
  const spinner = document.createElement('div');
  spinner.className = 'grammarai-spinner';
  spinner.style.top  = `${rect.top  + window.scrollY + 6}px`;
  spinner.style.left = `${rect.right + window.scrollX - 26}px`;
  document.body.appendChild(spinner);
  spinners.set(el, spinner);
}

function hideSpinner(el) {
  spinners.get(el)?.remove();
  spinners.delete(el);
}

// ─── Positioning ──────────────────────────────────────────────────────────────

function positionTooltip(tooltip, targetEl) {
  const rect    = targetEl.getBoundingClientRect();
  const scrollY = window.scrollY;
  const scrollX = window.scrollX;
  const margin  = 8;

  let top  = rect.bottom + scrollY + margin;
  let left = rect.left   + scrollX;

  const tipWidth = tooltip.offsetWidth || 340;
  if (left + tipWidth > window.innerWidth + scrollX - margin) {
    left = window.innerWidth + scrollX - tipWidth - margin;
  }
  tooltip.style.top  = `${top}px`;
  tooltip.style.left = `${left}px`;
}

function repositionCurrentTooltip() {
  const tooltip = document.getElementById(TOOLTIP_ID);
  if (tooltip && currentTooltipTarget) positionTooltip(tooltip, currentTooltipTarget);
}

// ─── Tooltip cleanup ──────────────────────────────────────────────────────────

function removeTooltip() {
  document.getElementById(TOOLTIP_ID)?.remove();
  currentTooltipTarget = null;

  if (outsideClickHandler) {
    document.removeEventListener('mousedown', outsideClickHandler);
    outsideClickHandler = null;
  }
  if (keyboardHandler) {
    document.removeEventListener('keydown', keyboardHandler);
    keyboardHandler = null;
  }
  window.removeEventListener('scroll', repositionCurrentTooltip, true);
  window.removeEventListener('resize', repositionCurrentTooltip);
}

// ─── Undo bar ─────────────────────────────────────────────────────────────────

function showUndoBar(targetEl, originalText) {
  document.getElementById(UNDO_BAR_ID)?.remove();
  clearTimeout(undoBarTimer);

  const bar = document.createElement('div');
  bar.id = UNDO_BAR_ID;
  bar.innerHTML = `<span>Fix applied</span><button>Undo</button>`;
  document.body.appendChild(bar);

  bar.querySelector('button').addEventListener('click', () => {
    setTextInElement(targetEl, originalText);
    bar.remove();
    clearTimeout(undoBarTimer);
  });

  undoBarTimer = setTimeout(() => bar.remove(), 5000);
}

// ─── Error tooltip ────────────────────────────────────────────────────────────

function showErrorTooltip(targetEl, errorMsg) {
  removeTooltip();
  currentTooltipTarget = targetEl;

  const isNoKey    = errorMsg === 'NO_API_KEY';
  const isRateLimit = errorMsg?.startsWith('RATE_LIMIT:');
  const displayMsg  = isNoKey
    ? 'No API key set. Click here to open settings.'
    : isRateLimit
      ? errorMsg.replace('RATE_LIMIT:', '').trim()
      : errorMsg;

  const tooltip = document.createElement('div');
  tooltip.id = TOOLTIP_ID;
  tooltip.setAttribute('role', 'alert');

  const header = document.createElement('div');
  header.className = 'grammarai-header';
  header.innerHTML = `
    <span class="grammarai-logo grammarai-logo--error">✦ GrammarAI</span>
    <button class="grammarai-close" aria-label="Dismiss">✕</button>
  `;

  const msg = document.createElement('p');
  msg.className = 'grammarai-explanation grammarai-error-msg';
  msg.textContent = displayMsg;
  if (isNoKey) {
    msg.style.cursor = 'pointer';
    msg.addEventListener('click', () => ext.runtime.sendMessage({ type: 'OPEN_OPTIONS' }));
  }

  tooltip.appendChild(header);
  tooltip.appendChild(msg);
  document.body.appendChild(tooltip);
  positionTooltip(tooltip, targetEl);

  window.addEventListener('scroll', repositionCurrentTooltip, true);
  window.addEventListener('resize', repositionCurrentTooltip);

  header.querySelector('.grammarai-close').addEventListener('click', removeTooltip);
  outsideClickHandler = (e) => {
    if (!tooltip.contains(e.target) && e.target !== targetEl) removeTooltip();
  };
  setTimeout(() => document.addEventListener('mousedown', outsideClickHandler), 50);
  setTimeout(removeTooltip, 6000);
}

// ─── Main suggestion tooltip ──────────────────────────────────────────────────

function showTooltip(targetEl, result, originalText) {
  removeTooltip();

  const { correctedText, explanation, corrections = [] } = result;

  // Nothing changed
  if (correctedText.trim() === originalText.trim()) return;

  // Filter ignored phrases
  const visible = corrections.filter(c => !ignoredPhrases.has((c.original ?? '').toLowerCase()));
  // If every correction was ignored, skip showing tooltip
  if (corrections.length > 0 && visible.length === 0) return;

  currentTooltipTarget = targetEl;

  const tooltip = document.createElement('div');
  tooltip.id = TOOLTIP_ID;
  tooltip.setAttribute('role', 'dialog');
  tooltip.setAttribute('aria-label', 'GrammarAI Suggestion');
  tooltip.setAttribute('tabindex', '-1');

  // ── Header ─────────────────────────────────────────────────────────────────
  const readability = fleschKincaid(correctedText);
  const header = document.createElement('div');
  header.className = 'grammarai-header';
  header.innerHTML = `
    <span class="grammarai-logo">✦ GrammarAI</span>
    ${readability ? `<span class="grammarai-score" title="Flesch-Kincaid Readability">${readability.label} <strong>${readability.score}</strong>/100</span>` : ''}
    <button class="grammarai-close" aria-label="Dismiss">✕</button>
  `;

  // ── Explanation ────────────────────────────────────────────────────────────
  const exp = document.createElement('p');
  exp.className = 'grammarai-explanation';
  exp.textContent = explanation;

  // ── Corrections list ───────────────────────────────────────────────────────
  let corrList = null;
  if (visible.length) {
    corrList = document.createElement('ul');
    corrList.className = 'grammarai-corrections';

    visible.slice(0, 4).forEach(({ original: orig = '', corrected: corr = '', reason = '' }) => {
      const li = document.createElement('li');
      li.className = 'grammarai-correction-item';
      li.title = 'Click to see reason';

      const main = document.createElement('div');
      main.className = 'grammarai-correction-main';
      main.innerHTML = `<del>${escapeHTML(orig)}</del> → <ins>${escapeHTML(corr)}</ins>`;

      const ignoreBtn = document.createElement('button');
      ignoreBtn.className = 'grammarai-ignore-btn';
      ignoreBtn.textContent = '✕';
      ignoreBtn.title = 'Ignore this suggestion';
      ignoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const phrase = orig.toLowerCase();
        ignoredPhrases.add(phrase);
        ext.storage.local.get(['ignoredPhrases'], ({ ignoredPhrases: stored = [] }) => {
          ext.storage.local.set({ ignoredPhrases: [...new Set([...stored, phrase])] });
        });
        li.remove();
        if (!corrList.children.length) removeTooltip();
      });

      const reasonSpan = document.createElement('span');
      reasonSpan.className = 'grammarai-reason';
      reasonSpan.textContent = reason;

      main.appendChild(ignoreBtn);
      li.appendChild(main);
      li.appendChild(reasonSpan);
      li.addEventListener('click', () => li.classList.toggle('grammarai-correction-item--expanded'));
      corrList.appendChild(li);
    });

    const hint = document.createElement('p');
    hint.className = 'grammarai-corrections-hint';
    hint.textContent = 'Click a correction to see why';
    corrList.appendChild(hint);
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  const fixBtn = document.createElement('button');
  fixBtn.className = 'grammarai-fix-btn';
  fixBtn.textContent = '✓ Apply Fix';

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'grammarai-dismiss-btn';
  dismissBtn.textContent = 'Dismiss';

  const actions = document.createElement('div');
  actions.className = 'grammarai-actions';
  actions.appendChild(fixBtn);
  actions.appendChild(dismissBtn);

  // ── Assemble ───────────────────────────────────────────────────────────────
  tooltip.appendChild(header);
  tooltip.appendChild(exp);
  if (corrList) tooltip.appendChild(corrList);
  tooltip.appendChild(actions);

  document.body.appendChild(tooltip);
  positionTooltip(tooltip, targetEl);

  window.addEventListener('scroll', repositionCurrentTooltip, true);
  window.addEventListener('resize', repositionCurrentTooltip);

  // ── Event listeners ────────────────────────────────────────────────────────
  const applyFix = () => {
    const textBefore = getTextFromElement(targetEl);
    setTextInElement(targetEl, correctedText);
    removeTooltip();
    targetEl.style.outline = '2px solid #22c55e';
    setTimeout(() => (targetEl.style.outline = ''), 1200);
    showUndoBar(targetEl, textBefore);
  };

  fixBtn.addEventListener('click', applyFix);
  dismissBtn.addEventListener('click', removeTooltip);
  header.querySelector('.grammarai-close').addEventListener('click', removeTooltip);

  // Keyboard shortcuts
  keyboardHandler = (e) => {
    if (e.key === 'Escape') {
      removeTooltip();
    } else if (e.key === 'Enter' && document.activeElement === tooltip) {
      applyFix();
    }
  };
  document.addEventListener('keydown', keyboardHandler);

  // Auto-focus tooltip for keyboard nav, but don't steal from the input
  setTimeout(() => { if (document.activeElement !== targetEl) tooltip.focus(); }, 0);

  // Outside click
  outsideClickHandler = (e) => {
    if (!tooltip.contains(e.target) && e.target !== targetEl) removeTooltip();
  };
  setTimeout(() => document.addEventListener('mousedown', outsideClickHandler), 50);
}

// ─── Core grammar check ───────────────────────────────────────────────────────

async function requestGrammarCheck(el) {
  const text = getTextFromElement(el).trim();
  if (!text || text.length < MIN_TEXT_LENGTH) return;
  if (!isEnabled || isSiteDisabled) return;

  // Assign unique ID for stale-response cancellation
  const requestId = crypto.randomUUID();
  requestIds.set(el, requestId);

  try {
    showSpinner(el);

    const response = await ext.runtime.sendMessage({
      type: 'CHECK_GRAMMAR',
      text,
      language: selectedLang,
      mode: selectedMode,
      tone: selectedTone,
      requestId,
    });

    // Discard if user has typed again (newer request is pending/in-flight)
    if (requestIds.get(el) !== requestId) return;

    hideSpinner(el);

    // Background was busy — retry after a short delay
    if (!response.success && response.error === 'IN_FLIGHT') {
      clearTimeout(retryTimers.get(el));
      retryTimers.set(el, setTimeout(() => requestGrammarCheck(el), 500));
      return;
    }

    if (!response.success) {
      showErrorTooltip(el, response.error);
      return;
    }

    showTooltip(el, response.data, text);

  } catch (err) {
    hideSpinner(el);
    if (err.message?.includes('Extension context invalidated')) return;
    console.error('[GrammarAI content]', err);
  }
}

// ─── Element attachment ───────────────────────────────────────────────────────

function attachToElement(el) {
  if (el.hasAttribute(ACTIVE_FIELD_ATTR)) return;
  el.setAttribute(ACTIVE_FIELD_ATTR, '1');

  // Offline fallback: enable native browser spellcheck when no API key is set
  ext.storage.local.get(['apiKey'], ({ apiKey }) => {
    if (!apiKey && !el.hasAttribute('spellcheck')) {
      el.setAttribute('spellcheck', 'true');
    }
  });

  el.addEventListener('input', () => {
    removeTooltip();
    clearTimeout(debounceTimers.get(el));
    debounceTimers.set(el, setTimeout(() => requestGrammarCheck(el), DEBOUNCE_MS));
  });

  el.addEventListener('blur', () => {
    clearTimeout(debounceTimers.get(el));
    // Don't remove tooltip on blur — user might be clicking the Fix button
  });
}

function scanAndAttach() {
  document.querySelectorAll(
    'textarea, input[type="text"], input[type="search"], [contenteditable="true"], [contenteditable=""]'
  ).forEach(attachToElement);
}

// ─── MutationObserver ─────────────────────────────────────────────────────────

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.matches?.(EDITABLE_SELECTOR))           attachToElement(node);
      node.querySelectorAll?.(EDITABLE_SELECTOR).forEach(attachToElement);
    }
  }
});

observer.observe(document.body, { childList: true, subtree: true });

// ─── Settings messages from popup ────────────────────────────────────────────

ext.runtime.onMessage.addListener((message) => {
  if (message.type !== 'SETTINGS_UPDATED') return;
  if (message.enabled      !== undefined) isEnabled      = message.enabled;
  if (message.language     !== undefined) selectedLang   = message.language;
  if (message.mode         !== undefined) selectedMode   = message.mode;
  if (message.tone         !== undefined) selectedTone   = message.tone;
  if (message.siteDisabled !== undefined) isSiteDisabled = message.siteDisabled;
  if (!isEnabled || isSiteDisabled) removeTooltip();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  const hostname = window.location.hostname;

  const [syncData, localData] = await Promise.all([
    new Promise(r => ext.storage.sync.get(
      ['grammarEnabled', 'grammarLanguage', 'grammarMode', 'grammarTone', 'disabledSites'],
      r
    )),
    new Promise(r => ext.storage.local.get(['ignoredPhrases'], r)),
  ]);

  isEnabled      = syncData.grammarEnabled  ?? true;
  selectedLang   = syncData.grammarLanguage ?? 'en';
  selectedMode   = syncData.grammarMode     ?? 'grammar';
  selectedTone   = syncData.grammarTone     ?? 'formal';
  isSiteDisabled = (syncData.disabledSites  ?? []).includes(hostname);
  ignoredPhrases = new Set(localData.ignoredPhrases ?? []);

  scanAndAttach();
})();
