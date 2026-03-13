/**
 * content.js — Content Script
 *
 * Responsibilities:
 *  1. Observe all <textarea> and [contenteditable] elements on the page.
 *  2. Debounce the "input" event so we wait for the user to pause typing.
 *  3. Send the text to background.js for AI grammar checking.
 *  4. Render an unobtrusive suggestion tooltip with a "Fix" button.
 *
 * This script is intentionally sandboxed from the background service worker.
 * It NEVER touches the API key — all API calls go through background.js.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 850;          // Wait this long after user stops typing
const MIN_TEXT_LENGTH = 15;       // Ignore very short strings (single words, etc.)
const TOOLTIP_ID = 'grammarai-tooltip';
const ACTIVE_FIELD_ATTR = 'data-grammarai-active';
const EDITABLE_SELECTOR = 'textarea, input[type="text"], input[type="search"], [contenteditable]';

// ─── State ───────────────────────────────────────────────────────────────────

let isEnabled = true;             // Toggled by the popup
let selectedLanguage = 'en';      // Set by the popup

// Per-element debounce timers stored in a WeakMap so each field has its own
// timer and they don't interfere with each other.
const debounceTimers = new WeakMap();

// The element the current tooltip is anchored to (needed for repositioning).
let currentTooltipTarget = null;

// Reference to the active outside-click handler so every dismiss path can
// remove it and avoid dangling listeners.
let outsideClickHandler = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extracts plain text from either a <textarea> or a contenteditable element.
 * @param {HTMLElement} el
 * @returns {string}
 */
function getTextFromElement(el) {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    return el.value;
  }
  // contenteditable — innerText preserves line breaks better than textContent
  return el.innerText ?? el.textContent ?? '';
}

/**
 * Sets text back into a field, handling both textarea and contenteditable.
 * Picks the correct prototype based on tagName so the native setter is always
 * right on the first try (important for React/Vue controlled inputs).
 * @param {HTMLElement} el
 * @param {string} text
 */
function setTextInElement(el, text) {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    if (nativeSetter) nativeSetter.call(el, text);
    else el.value = text;

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // contenteditable — preserve caret at end for UX
    el.innerText = text;
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────

/**
 * Removes any existing tooltip from the DOM and cleans up all associated
 * event listeners (outside-click, scroll, resize).
 */
function removeTooltip() {
  document.getElementById(TOOLTIP_ID)?.remove();
  currentTooltipTarget = null;

  if (outsideClickHandler) {
    document.removeEventListener('mousedown', outsideClickHandler);
    outsideClickHandler = null;
  }

  window.removeEventListener('scroll', repositionCurrentTooltip, true);
  window.removeEventListener('resize', repositionCurrentTooltip);
}

/**
 * Repositions the current tooltip relative to its target element.
 * Called on scroll and resize events to keep the tooltip anchored.
 */
function repositionCurrentTooltip() {
  const tooltip = document.getElementById(TOOLTIP_ID);
  if (tooltip && currentTooltipTarget) {
    positionTooltip(tooltip, currentTooltipTarget);
  }
}

/**
 * Creates and positions the suggestion tooltip near the target element.
 *
 * @param {HTMLElement} targetEl   - The input/textarea being corrected
 * @param {object}      result     - The parsed API response
 * @param {string}      result.correctedText
 * @param {string}      result.explanation
 * @param {Array}       result.corrections
 */
function showTooltip(targetEl, result) {
  removeTooltip();

  const { correctedText, explanation, corrections } = result;

  // Don't show tooltip if nothing changed
  const original = getTextFromElement(targetEl).trim();
  if (correctedText.trim() === original) return;

  currentTooltipTarget = targetEl;

  // ── Build tooltip DOM ──────────────────────────────────────────────────────
  const tooltip = document.createElement('div');
  tooltip.id = TOOLTIP_ID;
  tooltip.setAttribute('role', 'dialog');
  tooltip.setAttribute('aria-label', 'GrammarAI Suggestion');

  // Header
  const header = document.createElement('div');
  header.className = 'grammarai-header';
  header.innerHTML = `
    <span class="grammarai-logo">✦ GrammarAI</span>
    <button class="grammarai-close" aria-label="Dismiss">✕</button>
  `;

  // Explanation
  const exp = document.createElement('p');
  exp.className = 'grammarai-explanation';
  exp.textContent = explanation;

  // Corrections list (if any)
  let corrList = null;
  if (corrections?.length) {
    corrList = document.createElement('ul');
    corrList.className = 'grammarai-corrections';
    corrections.slice(0, 4).forEach(({ original: orig, corrected: corr, reason }) => {
      const li = document.createElement('li');
      li.innerHTML = `<del>${escapeHTML(orig)}</del> → <ins>${escapeHTML(corr)}</ins><span class="grammarai-reason">${escapeHTML(reason)}</span>`;
      corrList.appendChild(li);
    });
  }

  // Fix button
  const fixBtn = document.createElement('button');
  fixBtn.className = 'grammarai-fix-btn';
  fixBtn.textContent = '✓ Apply Fix';

  // Dismiss button
  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'grammarai-dismiss-btn';
  dismissBtn.textContent = 'Dismiss';

  const actions = document.createElement('div');
  actions.className = 'grammarai-actions';
  actions.appendChild(fixBtn);
  actions.appendChild(dismissBtn);

  // Assemble
  tooltip.appendChild(header);
  tooltip.appendChild(exp);
  if (corrList) tooltip.appendChild(corrList);
  tooltip.appendChild(actions);

  // ── Position ───────────────────────────────────────────────────────────────
  document.body.appendChild(tooltip);
  positionTooltip(tooltip, targetEl);

  // Keep tooltip anchored when the page scrolls or resizes
  window.addEventListener('scroll', repositionCurrentTooltip, true);
  window.addEventListener('resize', repositionCurrentTooltip);

  // ── Event listeners ────────────────────────────────────────────────────────
  fixBtn.addEventListener('click', () => {
    setTextInElement(targetEl, correctedText);
    removeTooltip();
    // Brief visual confirmation
    targetEl.style.outline = '2px solid #22c55e';
    setTimeout(() => (targetEl.style.outline = ''), 1200);
  });

  dismissBtn.addEventListener('click', removeTooltip);
  header.querySelector('.grammarai-close').addEventListener('click', removeTooltip);

  // Auto-dismiss when user clicks elsewhere — stored so removeTooltip can
  // always clean it up regardless of which dismiss path is taken.
  outsideClickHandler = (e) => {
    if (!tooltip.contains(e.target) && e.target !== targetEl) {
      removeTooltip();
    }
  };
  // Small delay so the current click that triggered the tooltip doesn't fire this immediately
  setTimeout(() => document.addEventListener('mousedown', outsideClickHandler), 50);
}

/**
 * Shows a transient error tooltip anchored to the target element.
 * Auto-dismisses after 6 seconds.
 *
 * @param {HTMLElement} targetEl
 * @param {string}      errorMsg
 */
function showErrorTooltip(targetEl, errorMsg) {
  removeTooltip();
  currentTooltipTarget = targetEl;

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
  msg.textContent = errorMsg;

  tooltip.appendChild(header);
  tooltip.appendChild(msg);

  document.body.appendChild(tooltip);
  positionTooltip(tooltip, targetEl);

  window.addEventListener('scroll', repositionCurrentTooltip, true);
  window.addEventListener('resize', repositionCurrentTooltip);

  header.querySelector('.grammarai-close').addEventListener('click', removeTooltip);

  outsideClickHandler = (e) => {
    if (!tooltip.contains(e.target) && e.target !== targetEl) {
      removeTooltip();
    }
  };
  setTimeout(() => document.addEventListener('mousedown', outsideClickHandler), 50);

  // Auto-dismiss after 6 seconds
  setTimeout(removeTooltip, 6000);
}

/**
 * Positions the tooltip directly below the target element,
 * clamping to viewport edges so it never goes off-screen.
 * Uses the tooltip's actual rendered width for accurate clamping.
 */
function positionTooltip(tooltip, targetEl) {
  const rect = targetEl.getBoundingClientRect();
  const scrollY = window.scrollY;
  const scrollX = window.scrollX;
  const margin = 8;

  let top = rect.bottom + scrollY + margin;
  let left = rect.left + scrollX;

  // Use actual rendered width for accurate edge-clamping
  const tipWidth = tooltip.offsetWidth || 340;
  if (left + tipWidth > window.innerWidth + scrollX - margin) {
    left = window.innerWidth + scrollX - tipWidth - margin;
  }

  tooltip.style.top  = `${top}px`;
  tooltip.style.left = `${left}px`;
}

/** Escapes HTML special characters to prevent XSS in correction labels. */
function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Core Logic ───────────────────────────────────────────────────────────────

/**
 * Sends the current text to the background service worker for grammar checking.
 * This function is called by the per-element debounce timer.
 *
 * @param {HTMLElement} el - The input element whose text should be checked
 */
async function requestGrammarCheck(el) {
  const text = getTextFromElement(el).trim();

  // Guard: skip very short or empty text
  if (!text || text.length < MIN_TEXT_LENGTH) return;

  // Guard: skip if user toggled extension off
  if (!isEnabled) return;

  try {
    // Show a subtle "checking…" indicator on the element border
    el.style.outline = '2px solid #a78bfa';

    // Send to background.js — response is async
    const response = await chrome.runtime.sendMessage({
      type: 'CHECK_GRAMMAR',
      text,
      language: selectedLanguage,
    });

    // Clear the checking indicator
    el.style.outline = '';

    if (!response.success) {
      console.warn('[GrammarAI]', response.error);
      showErrorTooltip(el, response.error);
      return;
    }

    showTooltip(el, response.data);

  } catch (err) {
    el.style.outline = '';
    // Extension context may be invalidated on page navigation — silently ignore
    if (err.message?.includes('Extension context invalidated')) return;
    console.error('[GrammarAI content]', err);
  }
}

// ─── Element Observation ─────────────────────────────────────────────────────

/**
 * Attaches input listeners to a qualifying editable element.
 * Each element gets its own debounce timer via a WeakMap so rapid typing
 * in one field doesn't cancel a pending check in another field.
 * Guards against double-attaching with a data attribute.
 *
 * @param {HTMLElement} el
 */
function attachToElement(el) {
  if (el.hasAttribute(ACTIVE_FIELD_ATTR)) return; // already attached
  el.setAttribute(ACTIVE_FIELD_ATTR, '1');

  el.addEventListener('input', () => {
    removeTooltip(); // hide old tooltip while user is typing
    clearTimeout(debounceTimers.get(el));
    debounceTimers.set(el, setTimeout(() => requestGrammarCheck(el), DEBOUNCE_MS));
  });

  el.addEventListener('blur', () => {
    clearTimeout(debounceTimers.get(el));
    // Don't remove tooltip on blur — user might be clicking the Fix button
  });
}

/**
 * Scans the DOM for editable elements and attaches listeners.
 * Called initially and whenever new nodes are added (MutationObserver).
 */
function scanAndAttach() {
  const selector = 'textarea, input[type="text"], input[type="search"], [contenteditable="true"], [contenteditable=""]';
  document.querySelectorAll(selector).forEach(attachToElement);
}

// ─── MutationObserver ─────────────────────────────────────────────────────────
// Handles SPAs and dynamically added editors (e.g., Gmail compose, Notion, etc.)
// Uses the same selector as scanAndAttach (including input[type="search"]).

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      // Check the node itself
      if (node.matches?.(EDITABLE_SELECTOR)) {
        attachToElement(node);
      }
      // Check its descendants
      node.querySelectorAll?.(EDITABLE_SELECTOR).forEach(attachToElement);
    }
  }
});

observer.observe(document.body, { childList: true, subtree: true });

// ─── Popup ↔ Content messaging ────────────────────────────────────────────────

/**
 * Listens for settings changes broadcast from popup.js.
 * The popup sends { type: 'SETTINGS_UPDATED', enabled, language }.
 */
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SETTINGS_UPDATED') {
    isEnabled = message.enabled;
    selectedLanguage = message.language;

    // Remove any open tooltip when user disables the extension
    if (!isEnabled) {
      removeTooltip();
    }
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  // Load persisted settings on startup
  const { grammarEnabled = true, grammarLanguage = 'en' } = await chrome.storage.local.get([
    'grammarEnabled',
    'grammarLanguage',
  ]);
  isEnabled = grammarEnabled;
  selectedLanguage = grammarLanguage;

  // First scan
  scanAndAttach();
})();
