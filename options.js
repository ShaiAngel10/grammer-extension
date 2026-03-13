/**
 * options.js — Options Page Controller (v2)
 *
 * Handles:
 *  • API key save / clear
 *  • Custom system prompt save
 *  • Ignored phrases list management
 *  • Usage stats display and clearing
 */

'use strict';

// Firefox / Chrome compatibility shim
const ext = typeof browser !== 'undefined' ? browser : chrome;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const apiKeyInput      = document.getElementById('api-key-input');
const toggleVisBtn     = document.getElementById('toggle-vis-btn');
const saveKeyBtn       = document.getElementById('save-key-btn');
const keyBanner        = document.getElementById('key-banner');

const customPromptInput = document.getElementById('custom-prompt-input');
const savePromptBtn     = document.getElementById('save-prompt-btn');
const promptBanner      = document.getElementById('prompt-banner');

const btnApplyChk      = document.getElementById('btn-apply');
const btnDismissChk    = document.getElementById('btn-dismiss');
const btnUndoChk       = document.getElementById('btn-undo');
const saveBtnsBtn      = document.getElementById('save-btns-btn');
const btnsBanner       = document.getElementById('btns-banner');

const ignoredList      = document.getElementById('ignored-list');
const noIgnoredMsg     = document.getElementById('no-ignored');
const ignoredCountEl   = document.getElementById('ignored-count');
const clearIgnoredBtn  = document.getElementById('clear-ignored-btn');

const statCalls        = document.getElementById('stat-calls');
const statTokens       = document.getElementById('stat-tokens');
const statCost         = document.getElementById('stat-cost');
const clearUsageBtn    = document.getElementById('clear-usage-btn');

// ─── Utilities ────────────────────────────────────────────────────────────────

function storageGet(store, keys) {
  return new Promise(resolve => store.get(keys, resolve));
}

function showBanner(el, type, message) {
  el.className = `status-banner ${type}`;
  el.textContent = type === 'success' ? `✓ ${message}` : `✕ ${message}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.className = 'status-banner';
    el.textContent = '';
  }, 3000);
}

function formatCost(tokens) {
  const cost = tokens * 0.40 / 1_000_000;
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

// ─── Load on open ─────────────────────────────────────────────────────────────

(async () => {
  const [local, sync] = await Promise.all([
    storageGet(ext.storage.local, ['apiKey', 'usageStats', 'ignoredPhrases']),
    storageGet(ext.storage.sync,  ['customSystemPrompt', 'btnShowApply', 'btnShowDismiss', 'btnShowUndo']),
  ]);

  apiKeyInput.value        = local.apiKey             ?? '';
  customPromptInput.value  = sync.customSystemPrompt  ?? '';
  btnApplyChk.checked      = sync.btnShowApply   ?? true;
  btnDismissChk.checked    = sync.btnShowDismiss ?? true;
  btnUndoChk.checked       = sync.btnShowUndo    ?? true;

  renderIgnoredPhrases(local.ignoredPhrases ?? []);
  renderUsage(local.usageStats ?? {});
})();

// ─── API key ──────────────────────────────────────────────────────────────────

toggleVisBtn.addEventListener('click', () => {
  const hidden = apiKeyInput.type === 'password';
  apiKeyInput.type    = hidden ? 'text' : 'password';
  toggleVisBtn.textContent = hidden ? '🙈' : '👁';
});

saveKeyBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();

  if (key && !key.startsWith('sk-')) {
    showBanner(keyBanner, 'error', 'API key should start with "sk-"');
    return;
  }

  saveKeyBtn.disabled    = true;
  saveKeyBtn.textContent = 'Saving…';

  try {
    const res = await ext.runtime.sendMessage({ type: 'SAVE_API_KEY', apiKey: key });
    if (!res?.success) throw new Error('Failed to save key.');
    showBanner(keyBanner, 'success', key ? 'Key saved' : 'Key cleared');
  } catch (err) {
    showBanner(keyBanner, 'error', err.message);
  } finally {
    saveKeyBtn.disabled    = false;
    saveKeyBtn.textContent = 'Save Key';
  }
});

// ─── Custom system prompt ─────────────────────────────────────────────────────

savePromptBtn.addEventListener('click', async () => {
  const prompt = customPromptInput.value.trim();
  savePromptBtn.disabled    = true;
  savePromptBtn.textContent = 'Saving…';
  try {
    await new Promise(resolve => ext.storage.sync.set({ customSystemPrompt: prompt }, resolve));
    showBanner(promptBanner, 'success', 'Instructions saved');
  } catch (err) {
    showBanner(promptBanner, 'error', err.message || 'Failed to save.');
  } finally {
    savePromptBtn.disabled    = false;
    savePromptBtn.textContent = 'Save Instructions';
  }
});

// ─── Button preferences ───────────────────────────────────────────────────────

saveBtnsBtn.addEventListener('click', async () => {
  // Prevent disabling all buttons at once
  if (!btnApplyChk.checked && !btnDismissChk.checked) {
    showBanner(btnsBanner, 'error', 'At least one of Apply Fix or Dismiss must be enabled');
    return;
  }
  saveBtnsBtn.disabled    = true;
  saveBtnsBtn.textContent = 'Saving…';
  try {
    await new Promise(resolve => ext.storage.sync.set({
      btnShowApply:   btnApplyChk.checked,
      btnShowDismiss: btnDismissChk.checked,
      btnShowUndo:    btnUndoChk.checked,
    }, resolve));
    showBanner(btnsBanner, 'success', 'Button preferences saved');
  } catch (err) {
    showBanner(btnsBanner, 'error', err.message || 'Failed to save.');
  } finally {
    saveBtnsBtn.disabled    = false;
    saveBtnsBtn.textContent = 'Save Button Preferences';
  }
});

// ─── Ignored phrases ──────────────────────────────────────────────────────────

function renderIgnoredPhrases(phrases) {
  ignoredList.innerHTML = '';
  noIgnoredMsg.style.display  = phrases.length ? 'none'  : 'block';
  ignoredCountEl.textContent  = `${phrases.length} phrase${phrases.length !== 1 ? 's' : ''}`;

  phrases.forEach(phrase => {
    const li = document.createElement('li');
    li.className = 'ignored-item';

    const text = document.createElement('span');
    text.textContent = phrase;

    const removeBtn = document.createElement('button');
    removeBtn.className   = 'ignored-remove';
    removeBtn.textContent = '✕';
    removeBtn.title       = 'Remove';
    removeBtn.addEventListener('click', async () => {
      const { ignoredPhrases: stored = [] } = await storageGet(ext.storage.local, ['ignoredPhrases']);
      const updated = stored.filter(p => p !== phrase);
      await new Promise(resolve => ext.storage.local.set({ ignoredPhrases: updated }, resolve));
      renderIgnoredPhrases(updated);
    });

    li.appendChild(text);
    li.appendChild(removeBtn);
    ignoredList.appendChild(li);
  });
}

clearIgnoredBtn.addEventListener('click', async () => {
  await new Promise(resolve => ext.storage.local.set({ ignoredPhrases: [] }, resolve));
  renderIgnoredPhrases([]);
});

// ─── Usage stats ──────────────────────────────────────────────────────────────

function renderUsage({ calls = 0, total_tokens = 0 }) {
  statCalls.textContent  = calls.toLocaleString();
  statTokens.textContent = total_tokens.toLocaleString();
  statCost.textContent   = formatCost(total_tokens);
}

clearUsageBtn.addEventListener('click', async () => {
  await ext.runtime.sendMessage({ type: 'CLEAR_USAGE' });
  renderUsage({ calls: 0, total_tokens: 0 });
});
