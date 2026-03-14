/**
 * content.js — Content Script (v3)
 *
 * Features:
 *  - Constant floating icon on every focused editable field
 *  - Hover mini-menu: view suggestions, turn off for site, settings
 *  - Live word-underline overlay (mirror div) for textarea/input
 *  - Debounce + per-request ID for stale-response cancellation
 *  - IN_FLIGHT retry, spinner, undo bar
 *  - Suggestion tooltip with corrections, keyboard shortcuts, undo
 */

'use strict';

const ext = typeof browser !== 'undefined' ? browser : chrome;

// ─── Constants ────────────────────────────────────────────────────────────────

const DEBOUNCE_MS       = 850;
const MIN_TEXT_LENGTH   = 15;
const TOOLTIP_ID        = 'grammarai-tooltip';
const UNDO_BAR_ID       = 'grammarai-undo-bar';
const ACTIVE_FIELD_ATTR = 'data-grammarai-active';
const EDITABLE_SELECTOR = 'textarea, input[type="text"], input[type="search"], [contenteditable]';

// ─── State ────────────────────────────────────────────────────────────────────

let isEnabled       = true;
let selectedLang    = 'en';
let selectedMode    = 'grammar';
let selectedTone    = 'formal';
let isSiteDisabled  = false;
let currentHostname = window.location.hostname;
let ignoredPhrases  = new Set();

let btnShowApply   = true;
let btnShowDismiss = true;
let btnShowUndo    = true;

let shortcutApply   = 'Enter';
let shortcutDismiss = 'Escape';
let shortcutUndo    = '';

let tooltipInUndoMode = false;
let undoCallback      = null;

// Per-element WeakMaps
const debounceTimers  = new WeakMap();
const requestIds      = new WeakMap();
const retryTimers     = new WeakMap();
const spinners        = new WeakMap();
const lastCorrections = new WeakMap(); // el → corrections[] from last API call
const lastResults     = new WeakMap(); // el → full result object
const lastTexts       = new WeakMap(); // el → original text that was checked
const constantIcons   = new WeakMap(); // el → icon DOM element
const overlays        = new WeakMap(); // el → mirror overlay DOM element

// Tooltip cleanup state
let currentTooltipTarget = null;
let outsideClickHandler  = null;
let keyboardHandler      = null;
let undoBarTimer         = null;

// ─── Readability ──────────────────────────────────────────────────────────────

function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1;
  const groups = w.replace(/e$/, '').match(/[aeiou]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

function fleschKincaid(text) {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!sentences.length || !words.length) return null;
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const score = Math.round(Math.max(0, Math.min(100,
    206.835 - 1.015 * (words.length / sentences.length) - 84.6 * (syllables / words.length)
  )));
  let label;
  if      (score >= 90) label = 'Very Easy';
  else if (score >= 80) label = 'Easy';
  else if (score >= 70) label = 'Fairly Easy';
  else if (score >= 60) label = 'Standard';
  else if (score >= 50) label = 'Fairly Difficult';
  else if (score >= 30) label = 'Difficult';
  else                  label = 'Very Difficult';
  return { score, label };
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

function matchesShortcut(e, shortcut) {
  if (!shortcut) return false;
  const parts = shortcut.split('+');
  const key   = parts[parts.length - 1];
  return (
    e.key      === key                     &&
    e.shiftKey === parts.includes('Shift') &&
    e.ctrlKey  === parts.includes('Ctrl')  &&
    e.altKey   === parts.includes('Alt')
  );
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

// ─── Tooltip positioning ──────────────────────────────────────────────────────

function positionTooltip(tooltip, targetEl) {
  const rect   = targetEl.getBoundingClientRect();
  const margin = 8;
  let top  = rect.bottom + window.scrollY + margin;
  let left = rect.left   + window.scrollX;
  const tipWidth = tooltip.offsetWidth || 340;
  if (left + tipWidth > window.innerWidth + window.scrollX - margin)
    left = window.innerWidth + window.scrollX - tipWidth - margin;
  tooltip.style.top  = `${top}px`;
  tooltip.style.left = `${left}px`;
}

function repositionCurrentTooltip() {
  const tooltip = document.getElementById(TOOLTIP_ID);
  if (tooltip && currentTooltipTarget) positionTooltip(tooltip, currentTooltipTarget);
}

// ─── Tooltip cleanup ──────────────────────────────────────────────────────────

function removeTooltip() {
  const prevTarget = currentTooltipTarget;
  document.getElementById(TOOLTIP_ID)?.remove();
  currentTooltipTarget = null;
  tooltipInUndoMode = false;
  undoCallback      = null;
  if (outsideClickHandler) {
    document.removeEventListener('mousedown', outsideClickHandler);
    outsideClickHandler = null;
  }
  if (keyboardHandler) {
    document.removeEventListener('keydown', keyboardHandler, true);
    keyboardHandler = null;
  }
  window.removeEventListener('scroll', repositionCurrentTooltip, true);
  window.removeEventListener('resize', repositionCurrentTooltip);

  // Re-show icon if the field is still focused
  if (prevTarget && document.activeElement === prevTarget && isEnabled && !isSiteDisabled) {
    showConstantIcon(prevTarget);
  }
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

// ─── Mirror overlay (live word underlines) ────────────────────────────────────

function buildHighlightedHTML(text, corrections) {
  if (!corrections || !corrections.length) return escapeHTML(text);

  const ranges = [];
  for (const c of corrections) {
    if (!c.original?.trim()) continue;
    let start = 0;
    while (start < text.length) {
      const idx = text.indexOf(c.original, start);
      if (idx === -1) break;
      ranges.push({ start: idx, end: idx + c.original.length });
      start = idx + c.original.length;
    }
  }
  ranges.sort((a, b) => a.start - b.start);

  const merged = [];
  for (const r of ranges) {
    if (merged.length && r.start < merged[merged.length - 1].end) continue;
    merged.push(r);
  }

  let html = '';
  let pos  = 0;
  for (const { start, end } of merged) {
    html += escapeHTML(text.slice(pos, start));
    html += `<span class="grammarai-mark">${escapeHTML(text.slice(start, end))}</span>`;
    pos = end;
  }
  html += escapeHTML(text.slice(pos));
  return html;
}

function syncOverlayStyles(overlay, el) {
  const s    = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  overlay.style.top    = `${rect.top  + window.scrollY}px`;
  overlay.style.left   = `${rect.left + window.scrollX}px`;
  overlay.style.width  = `${el.offsetWidth}px`;
  overlay.style.height = `${el.offsetHeight}px`;
  overlay.style.fontFamily      = s.fontFamily;
  overlay.style.fontSize        = s.fontSize;
  overlay.style.fontWeight      = s.fontWeight;
  overlay.style.fontStyle       = s.fontStyle;
  overlay.style.fontVariant     = s.fontVariant;
  overlay.style.lineHeight      = s.lineHeight;
  overlay.style.letterSpacing   = s.letterSpacing;
  overlay.style.wordSpacing     = s.wordSpacing;
  overlay.style.paddingTop      = s.paddingTop;
  overlay.style.paddingRight    = s.paddingRight;
  overlay.style.paddingBottom   = s.paddingBottom;
  overlay.style.paddingLeft     = s.paddingLeft;
  overlay.style.borderTopWidth    = s.borderTopWidth;
  overlay.style.borderRightWidth  = s.borderRightWidth;
  overlay.style.borderBottomWidth = s.borderBottomWidth;
  overlay.style.borderLeftWidth   = s.borderLeftWidth;
  overlay.style.boxSizing    = s.boxSizing;
  overlay.style.textIndent   = s.textIndent;
  overlay.style.whiteSpace   = el.tagName === 'TEXTAREA' ? 'pre-wrap' : 'pre';
  overlay.style.wordBreak    = s.wordBreak;
  overlay.style.wordWrap     = s.wordWrap || 'break-word';
  overlay.style.overflowWrap = s.overflowWrap || 'break-word';
  overlay.style.tabSize      = s.tabSize;
  overlay.style.direction    = s.direction;
  overlay.style.unicodeBidi  = s.unicodeBidi;
}

function createOrUpdateOverlay(el) {
  if (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT') return;
  let overlay = overlays.get(el);
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'grammarai-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    document.body.appendChild(overlay);
    overlays.set(el, overlay);
    el.addEventListener('scroll', () => { overlay.scrollTop = el.scrollTop; });
  }
  syncOverlayStyles(overlay, el);
  overlay.innerHTML = buildHighlightedHTML(getTextFromElement(el), lastCorrections.get(el) ?? []);
  overlay.scrollTop = el.scrollTop;
}

function refreshOverlayContent(el) {
  const overlay = overlays.get(el);
  if (!overlay) return;
  overlay.innerHTML = buildHighlightedHTML(getTextFromElement(el), lastCorrections.get(el) ?? []);
  overlay.scrollTop = el.scrollTop;
}

function removeOverlay(el) {
  overlays.get(el)?.remove();
  overlays.delete(el);
}

// ─── Constant floating icon ───────────────────────────────────────────────────

function positionConstantIcon(icon, el) {
  const r = el.getBoundingClientRect();
  icon.style.top  = `${r.bottom + window.scrollY - 14}px`;
  icon.style.left = `${r.right  + window.scrollX - 14}px`;
}

function showConstantIcon(el) {
  if (constantIcons.has(el)) return;
  if (!isEnabled || isSiteDisabled) return;

  const icon = document.createElement('div');
  icon.className = 'grammarai-float-icon';
  icon.innerHTML = `
    <div class="grammarai-float-menu">
      <button class="grammarai-float-view" style="display:none">✦ Checking…</button>
      <div class="grammarai-float-divider" style="display:none"></div>
      <button class="grammarai-float-siteoff">🚫 Turn off for this site</button>
      <button class="grammarai-float-settings">⚙ Settings</button>
    </div>
    <div class="grammarai-float-btn" title="GrammarAI">
      <span class="grammarai-float-symbol">✦</span>
    </div>
  `;

  positionConstantIcon(icon, el);
  document.body.appendChild(icon);
  constantIcons.set(el, icon);

  const btn  = icon.querySelector('.grammarai-float-btn');
  const menu = icon.querySelector('.grammarai-float-menu');

  icon.addEventListener('mouseenter', () => menu.classList.add('grammarai-float-menu--open'));
  icon.addEventListener('mouseleave', () => menu.classList.remove('grammarai-float-menu--open'));

  const openTooltip = (e) => {
    e?.stopPropagation();
    const result   = lastResults.get(el);
    const origText = lastTexts.get(el);
    if (result && origText) {
      // Keep the icon visible — just open the tooltip alongside it
      showTooltip(el, result, origText);
    }
  };

  btn.addEventListener('click', openTooltip);
  icon.querySelector('.grammarai-float-view').addEventListener('click', openTooltip);

  icon.querySelector('.grammarai-float-siteoff').addEventListener('click', (e) => {
    e.stopPropagation();
    ext.storage.sync.get(['disabledSites'], ({ disabledSites = [] }) => {
      const disabled = disabledSites.includes(currentHostname);
      const updated  = disabled
        ? disabledSites.filter(h => h !== currentHostname)
        : [...disabledSites, currentHostname];
      ext.storage.sync.set({ disabledSites: updated });
      isSiteDisabled = !disabled;
      const siteBtn = icon.querySelector('.grammarai-float-siteoff');
      if (siteBtn) siteBtn.textContent = isSiteDisabled ? '✅ Turn on for this site' : '🚫 Turn off for this site';
      if (isSiteDisabled) { removeTooltip(); removeConstantIcon(el); removeOverlay(el); }
    });
  });

  icon.querySelector('.grammarai-float-settings').addEventListener('click', (e) => {
    e.stopPropagation();
    ext.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
  });

  const reposition = () => positionConstantIcon(icon, el);
  icon._reposition = reposition;
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
}

function updateConstantIconBadge(el, count, isRephrase, hasChanges = false) {
  const icon = constantIcons.get(el);
  if (!icon) return;

  const btn     = icon.querySelector('.grammarai-float-btn');
  const viewBtn = icon.querySelector('.grammarai-float-view');

  btn.querySelector('.grammarai-float-badge')?.remove();

  if (hasChanges && (count > 0 || isRephrase)) {
    const badge = document.createElement('span');
    badge.className   = 'grammarai-float-badge';
    badge.textContent = isRephrase ? '✏' : String(count);
    if (isRephrase) badge.style.background = '#7c3aed';
    btn.appendChild(badge);
  }

  const divider = icon.querySelector('.grammarai-float-divider');
  if (viewBtn) {
    if (hasChanges) {
      viewBtn.style.display = '';
      if (divider) divider.style.display = '';
      viewBtn.textContent   = isRephrase
        ? '✏ View rephrase suggestion'
        : count > 0
          ? `✦ View ${count} fix${count !== 1 ? 'es' : ''}`
          : '✦ View suggestion';
    } else {
      viewBtn.style.display = 'none';
      if (divider) divider.style.display = 'none';
    }
  }
}

function removeConstantIcon(el) {
  const icon = constantIcons.get(el);
  if (!icon) return;
  if (icon._reposition) {
    window.removeEventListener('scroll', icon._reposition, true);
    window.removeEventListener('resize', icon._reposition);
  }
  icon.remove();
  constantIcons.delete(el);
}

// ─── Error tooltip ────────────────────────────────────────────────────────────

function showErrorTooltip(targetEl, errorMsg) {
  removeTooltip();
  currentTooltipTarget = targetEl;
  const isNoKey     = errorMsg === 'NO_API_KEY';
  const isRateLimit = errorMsg?.startsWith('RATE_LIMIT:');
  const displayMsg  = isNoKey
    ? 'No API key set. Click here to open settings.'
    : isRateLimit ? errorMsg.replace('RATE_LIMIT:', '').trim() : errorMsg;

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

  const { type = 'fix', correctedText, explanation, corrections = [] } = result;
  const isRephrase = type === 'rephrase';

  if (correctedText.trim() === originalText.trim()) return;

  const validCorrections = corrections.filter(
    c => c.original && c.corrected && c.original.trim() !== '' && c.corrected.trim() !== ''
  );
  const visible = validCorrections.filter(c => !ignoredPhrases.has((c.original ?? '').toLowerCase()));
  if (!isRephrase && validCorrections.length > 0 && visible.length === 0) return;

  currentTooltipTarget = targetEl;

  const tooltip = document.createElement('div');
  tooltip.id = TOOLTIP_ID;
  tooltip.setAttribute('role', 'dialog');
  tooltip.setAttribute('aria-label', 'GrammarAI Suggestion');
  tooltip.setAttribute('tabindex', '-1');

  // Header
  const readability = fleschKincaid(correctedText);
  const header = document.createElement('div');
  header.className = 'grammarai-header';
  header.innerHTML = `
    <span class="grammarai-logo">✦ GrammarAI</span>
    ${isRephrase
      ? `<span class="grammarai-score grammarai-rephrase-badge">✏ Rephrase</span>`
      : readability ? `<span class="grammarai-score" title="Flesch-Kincaid">${readability.label} <strong>${readability.score}</strong>/100</span>` : ''
    }
    <button class="grammarai-close" aria-label="Dismiss">✕</button>
  `;

  // Explanation
  const exp = document.createElement('p');
  exp.className = 'grammarai-explanation';
  exp.textContent = explanation;

  // Corrections list
  let corrList = null;
  if (!isRephrase && visible.length) {
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
      ignoreBtn.className   = 'grammarai-ignore-btn';
      ignoreBtn.textContent = '✕';
      ignoreBtn.title       = 'Ignore this suggestion';
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
      reasonSpan.className   = 'grammarai-reason';
      reasonSpan.textContent = reason;

      main.appendChild(ignoreBtn);
      li.appendChild(main);
      li.appendChild(reasonSpan);
      li.addEventListener('click', () => li.classList.toggle('grammarai-correction-item--expanded'));
      corrList.appendChild(li);
    });

    const hint = document.createElement('p');
    hint.className   = 'grammarai-corrections-hint';
    hint.textContent = 'Click a correction to see why';
    corrList.appendChild(hint);
  }

  // Actions
  const actions = document.createElement('div');
  actions.className = 'grammarai-actions';

  if (btnShowApply) {
    const fixBtn = document.createElement('button');
    fixBtn.className   = 'grammarai-fix-btn';
    fixBtn.textContent = isRephrase ? '✏ Apply Rephrase' : '✓ Apply Fix';
    fixBtn.addEventListener('click', (e) => { e.stopPropagation(); applyFix(); });
    actions.appendChild(fixBtn);
  }

  if (btnShowDismiss) {
    const dismissBtn = document.createElement('button');
    dismissBtn.className   = 'grammarai-dismiss-btn';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', removeTooltip);
    actions.appendChild(dismissBtn);
  }

  tooltip.appendChild(header);
  tooltip.appendChild(exp);
  if (corrList) tooltip.appendChild(corrList);
  tooltip.appendChild(actions);

  document.body.appendChild(tooltip);
  positionTooltip(tooltip, targetEl);

  window.addEventListener('scroll', repositionCurrentTooltip, true);
  window.addEventListener('resize', repositionCurrentTooltip);

  // Apply fix
  const applyFix = () => {
    const textBefore = getTextFromElement(targetEl);
    setTextInElement(targetEl, correctedText);
    clearTimeout(debounceTimers.get(targetEl));
    debounceTimers.delete(targetEl);
    lastCorrections.delete(targetEl);
    refreshOverlayContent(targetEl);
    targetEl.style.outline = '2px solid #22c55e';
    setTimeout(() => (targetEl.style.outline = ''), 1200);
    showUndoBar(targetEl, textBefore);

    if (btnShowUndo) {
      const UNDO_DURATION = 5000;
      tooltipInUndoMode = true;
      actions.innerHTML = '';

      const appliedMsg = document.createElement('span');
      appliedMsg.className   = 'grammarai-applied-msg';
      appliedMsg.textContent = '✓ Fix applied';

      const countdown = document.createElement('span');
      countdown.className   = 'grammarai-countdown';
      countdown.textContent = `${UNDO_DURATION / 1000}s`;

      const undoBtn = document.createElement('button');
      undoBtn.className   = 'grammarai-undo-inline-btn';
      undoBtn.textContent = shortcutUndo ? `Undo (${shortcutUndo})` : 'Undo';

      actions.appendChild(appliedMsg);
      actions.appendChild(countdown);
      actions.appendChild(undoBtn);

      undoCallback = () => {
        clearInterval(countdownInterval);
        setTextInElement(targetEl, textBefore);
        removeTooltip();
      };

      let remaining = UNDO_DURATION / 1000;
      const countdownInterval = setInterval(() => {
        remaining -= 1;
        countdown.textContent = `${remaining}s`;
        if (remaining <= 0) clearInterval(countdownInterval);
      }, 1000);

      undoBtn.addEventListener('click', (e) => { e.stopPropagation(); undoCallback(); });
      setTimeout(() => { clearInterval(countdownInterval); removeTooltip(); }, UNDO_DURATION);
    } else {
      removeTooltip();
    }
  };

  header.querySelector('.grammarai-close').addEventListener('click', removeTooltip);

  keyboardHandler = (e) => {
    if (tooltipInUndoMode) {
      if (matchesShortcut(e, shortcutUndo) && undoCallback) { e.preventDefault(); undoCallback(); }
      else if (matchesShortcut(e, shortcutDismiss))         { e.preventDefault(); removeTooltip(); }
    } else {
      if (matchesShortcut(e, shortcutApply))        { e.preventDefault(); applyFix(); }
      else if (matchesShortcut(e, shortcutDismiss)) { e.preventDefault(); removeTooltip(); }
    }
  };
  document.addEventListener('keydown', keyboardHandler, true);

  setTimeout(() => { if (document.activeElement !== targetEl) tooltip.focus(); }, 0);

  outsideClickHandler = (e) => {
    if (!document.contains(e.target)) return;
    if (!tooltip.contains(e.target) && e.target !== targetEl) removeTooltip();
  };
  setTimeout(() => document.addEventListener('mousedown', outsideClickHandler), 50);
}

// ─── Core grammar check ───────────────────────────────────────────────────────

async function requestGrammarCheck(el) {
  const text = getTextFromElement(el).trim();
  if (!text || text.length < MIN_TEXT_LENGTH) return;
  if (!isEnabled || isSiteDisabled) return;

  const requestId = crypto.randomUUID();
  requestIds.set(el, requestId);

  try {
    showSpinner(el);

    const response = await ext.runtime.sendMessage({
      type: 'CHECK_GRAMMAR',
      text,
      language: selectedLang,
      mode:     selectedMode,
      tone:     selectedTone,
      requestId,
    });

    if (requestIds.get(el) !== requestId) return;
    hideSpinner(el);

    if (!response.success && response.error === 'IN_FLIGHT') {
      clearTimeout(retryTimers.get(el));
      retryTimers.set(el, setTimeout(() => requestGrammarCheck(el), 500));
      return;
    }

    if (!response.success) {
      showErrorTooltip(el, response.error);
      return;
    }

    const result   = response.data;
    const validCorr = (result.corrections ?? []).filter(
      c => c.original?.trim() && c.corrected?.trim()
    );

    lastResults.set(el, result);
    lastTexts.set(el, text);
    lastCorrections.set(el, validCorr);

    // Update live underline overlay
    createOrUpdateOverlay(el);

    // Update badge — pass hasChanges so the view button shows even when
    // the corrections list is empty (e.g. rephrase, or poorly-formatted fix)
    const hasChanges = (result.correctedText ?? '').trim() !== text.trim();
    updateConstantIconBadge(el, validCorr.length, result.type === 'rephrase', hasChanges);

  } catch (err) {
    hideSpinner(el);
    if (err.message?.includes('Extension context invalidated')) return;
    console.error('[GrammarAI content]', err);
  }
}

// ─── Element attachment ───────────────────────────────────────────────────────

function isEffectivelyEditable(el) {
  if (el.readOnly || el.disabled) return false;
  if (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') === 'false') return false;
  const role = el.getAttribute('role');
  if (role && ['presentation', 'none', 'img', 'log', 'status'].includes(role)) return false;
  return true;
}

function attachToElement(el) {
  if (el.hasAttribute(ACTIVE_FIELD_ATTR)) return;
  if (!isEffectivelyEditable(el)) return;
  el.setAttribute(ACTIVE_FIELD_ATTR, '1');

  ext.storage.local.get(['apiKey'], ({ apiKey }) => {
    if (!apiKey && !el.hasAttribute('spellcheck')) el.setAttribute('spellcheck', 'true');
  });

  el.addEventListener('focus', () => {
    if (isEnabled && !isSiteDisabled) {
      showConstantIcon(el);
      createOrUpdateOverlay(el);
    }
  });

  el.addEventListener('blur', () => {
    clearTimeout(debounceTimers.get(el));
    // Short delay so clicking the icon menu doesn't instantly hide it
    setTimeout(() => {
      if (currentTooltipTarget !== el) {
        removeConstantIcon(el);
        removeOverlay(el);
      }
    }, 200);
  });

  el.addEventListener('input', () => {
    removeTooltip();
    clearTimeout(debounceTimers.get(el));
    refreshOverlayContent(el); // live-update underlines as user types
    debounceTimers.set(el, setTimeout(() => requestGrammarCheck(el), DEBOUNCE_MS));
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
      if (node.matches?.(EDITABLE_SELECTOR))          attachToElement(node);
      node.querySelectorAll?.(EDITABLE_SELECTOR).forEach(attachToElement);
    }
  }
});

observer.observe(document.body, { childList: true, subtree: true });

// ─── Settings messages from popup ─────────────────────────────────────────────

ext.runtime.onMessage.addListener((message) => {
  if (message.type !== 'SETTINGS_UPDATED') return;
  if (message.enabled        !== undefined) isEnabled      = message.enabled;
  if (message.language       !== undefined) selectedLang   = message.language;
  if (message.mode           !== undefined) selectedMode   = message.mode;
  if (message.tone           !== undefined) selectedTone   = message.tone;
  if (message.siteDisabled   !== undefined) isSiteDisabled = message.siteDisabled;
  if (message.btnShowApply    !== undefined) btnShowApply    = message.btnShowApply;
  if (message.btnShowDismiss  !== undefined) btnShowDismiss  = message.btnShowDismiss;
  if (message.btnShowUndo     !== undefined) btnShowUndo     = message.btnShowUndo;
  if (message.shortcutApply   !== undefined) shortcutApply   = message.shortcutApply;
  if (message.shortcutDismiss !== undefined) shortcutDismiss = message.shortcutDismiss;
  if (message.shortcutUndo    !== undefined) shortcutUndo    = message.shortcutUndo;
  if (!isEnabled || isSiteDisabled) {
    removeTooltip();
    document.querySelectorAll('.grammarai-float-icon').forEach(i => i.remove());
    document.querySelectorAll('.grammarai-overlay').forEach(i => i.remove());
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  const [syncData, localData] = await Promise.all([
    new Promise(r => ext.storage.sync.get(
      ['grammarEnabled', 'grammarLanguage', 'grammarMode', 'grammarTone', 'disabledSites',
       'btnShowApply', 'btnShowDismiss', 'btnShowUndo',
       'shortcutApply', 'shortcutDismiss', 'shortcutUndo'], r
    )),
    new Promise(r => ext.storage.local.get(['ignoredPhrases'], r)),
  ]);

  isEnabled       = syncData.grammarEnabled  ?? true;
  selectedLang    = syncData.grammarLanguage ?? 'en';
  selectedMode    = syncData.grammarMode     ?? 'grammar';
  selectedTone    = syncData.grammarTone     ?? 'formal';
  isSiteDisabled  = (syncData.disabledSites  ?? []).includes(currentHostname);
  ignoredPhrases  = new Set(localData.ignoredPhrases ?? []);
  btnShowApply    = syncData.btnShowApply    ?? true;
  btnShowDismiss  = syncData.btnShowDismiss  ?? true;
  btnShowUndo     = syncData.btnShowUndo     ?? true;
  shortcutApply   = syncData.shortcutApply   ?? 'Enter';
  shortcutDismiss = syncData.shortcutDismiss ?? 'Escape';
  shortcutUndo    = syncData.shortcutUndo    ?? '';

  scanAndAttach();
})();
