/**
 * popup.js — Popup Controller (v2)
 *
 * Handles:
 *  • Loading/saving settings from chrome.storage.sync
 *  • Global enable toggle
 *  • Per-site disable toggle
 *  • Mode (grammar / tone) and tone style selection
 *  • Language selection
 *  • Usage stats display and clearing
 *  • Broadcasting settings to the active tab's content script
 */

'use strict';

// Firefox / Chrome compatibility shim
const ext = typeof browser !== 'undefined' ? browser : chrome;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const enabledToggle    = document.getElementById('enabled-toggle');
const statusText       = document.getElementById('status-text');
const languageSelect   = document.getElementById('language-select');
const toneSelect       = document.getElementById('tone-select');
const toneRow          = document.getElementById('tone-row');
const modeTabs         = document.querySelectorAll('.mode-tab');
const siteHostnameEl   = document.getElementById('site-hostname');
const siteToggleBtn    = document.getElementById('site-toggle-btn');
const usageCallsEl     = document.getElementById('usage-calls');
const usageTokensEl    = document.getElementById('usage-tokens');
const usageCostEl      = document.getElementById('usage-cost');
const clearUsageBtn    = document.getElementById('clear-usage-btn');
const statusBanner     = document.getElementById('status-banner');
const optionsBtn       = document.getElementById('options-btn');
const footerOptionsLink= document.getElementById('footer-options-link');

// ─── Utilities ────────────────────────────────────────────────────────────────

function storageGet(store, keys) {
  return new Promise(resolve => store.get(keys, resolve));
}

function showBanner(type, message) {
  statusBanner.className = type;
  statusBanner.textContent = type === 'success' ? `✓ ${message}` : `✕ ${message}`;
  clearTimeout(showBanner._timer);
  showBanner._timer = setTimeout(() => {
    statusBanner.className = '';
    statusBanner.textContent = '';
  }, 3000);
}

function updateStatusText(enabled) {
  statusText.textContent = enabled
    ? 'Active — checking text fields'
    : 'Paused — grammar checks disabled';
}

function formatCost(tokens) {
  // GPT-4o-mini blended ~$0.40/1M tokens
  const cost = tokens * 0.40 / 1_000_000;
  return `$${cost.toFixed(4)}`;
}

function updateUsageDisplay({ calls = 0, total_tokens = 0 }) {
  usageCallsEl.textContent  = calls.toLocaleString();
  usageTokensEl.textContent = total_tokens.toLocaleString();
  usageCostEl.textContent   = formatCost(total_tokens);
}

// ─── Per-site state ───────────────────────────────────────────────────────────

let currentHostname = '';
let disabledSites   = [];

function refreshSiteButton() {
  const isDisabled = disabledSites.includes(currentHostname);
  siteToggleBtn.textContent = isDisabled ? 'Enable here' : 'Disable here';
  siteToggleBtn.classList.toggle('disabled-site', isDisabled);
}

// ─── Mode tabs ────────────────────────────────────────────────────────────────

let currentMode = 'grammar';

function setMode(mode) {
  currentMode = mode;
  modeTabs.forEach(tab => tab.classList.toggle('active', tab.dataset.mode === mode));
  toneRow.style.display = mode === 'tone' ? 'flex' : 'none';
}

// ─── Load settings on open ───────────────────────────────────────────────────

(async () => {
  // Get current tab hostname
  try {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    currentHostname = tab?.url ? new URL(tab.url).hostname : '';
    siteHostnameEl.textContent = currentHostname || '(no hostname)';
  } catch {
    siteHostnameEl.textContent = '(unavailable)';
  }

  // Load sync settings
  const sync = await storageGet(ext.storage.sync, [
    'grammarEnabled', 'grammarLanguage', 'grammarMode', 'grammarTone', 'disabledSites',
  ]);
  disabledSites = sync.disabledSites ?? [];

  enabledToggle.checked  = sync.grammarEnabled  ?? true;
  languageSelect.value   = sync.grammarLanguage  ?? 'en';
  toneSelect.value       = sync.grammarTone      ?? 'formal';
  setMode(sync.grammarMode ?? 'grammar');
  updateStatusText(enabledToggle.checked);
  refreshSiteButton();

  // Load usage stats
  const local = await storageGet(ext.storage.local, ['usageStats']);
  updateUsageDisplay(local.usageStats ?? {});
})();

// ─── Global enable toggle ─────────────────────────────────────────────────────

enabledToggle.addEventListener('change', () => {
  const enabled = enabledToggle.checked;
  updateStatusText(enabled);
  ext.storage.sync.set({ grammarEnabled: enabled });
  broadcastSettings();
});

// ─── Per-site toggle ──────────────────────────────────────────────────────────

siteToggleBtn.addEventListener('click', () => {
  if (!currentHostname) return;
  const isDisabled = disabledSites.includes(currentHostname);
  if (isDisabled) {
    disabledSites = disabledSites.filter(h => h !== currentHostname);
  } else {
    disabledSites = [...disabledSites, currentHostname];
  }
  ext.storage.sync.set({ disabledSites });
  refreshSiteButton();
  broadcastSettings();
});

// ─── Mode tabs ────────────────────────────────────────────────────────────────

modeTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    setMode(tab.dataset.mode);
    ext.storage.sync.set({ grammarMode: currentMode });
    broadcastSettings();
  });
});

// ─── Tone selector ────────────────────────────────────────────────────────────

toneSelect.addEventListener('change', () => {
  ext.storage.sync.set({ grammarTone: toneSelect.value });
  broadcastSettings();
});

// ─── Language selector ────────────────────────────────────────────────────────

languageSelect.addEventListener('change', () => {
  ext.storage.sync.set({ grammarLanguage: languageSelect.value });
  broadcastSettings();
});

// ─── Usage ────────────────────────────────────────────────────────────────────

clearUsageBtn.addEventListener('click', async () => {
  await ext.runtime.sendMessage({ type: 'CLEAR_USAGE' });
  updateUsageDisplay({ calls: 0, total_tokens: 0 });
  showBanner('success', 'Usage cleared');
});

// ─── Options page ─────────────────────────────────────────────────────────────

function openOptions() { ext.runtime.openOptionsPage(); }
optionsBtn.addEventListener('click', openOptions);
footerOptionsLink.addEventListener('click', (e) => { e.preventDefault(); openOptions(); });

// ─── Broadcast to content script ─────────────────────────────────────────────

async function broadcastSettings() {
  try {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const siteDisabled = disabledSites.includes(currentHostname);
    await ext.tabs.sendMessage(tab.id, {
      type:        'SETTINGS_UPDATED',
      enabled:     enabledToggle.checked,
      language:    languageSelect.value,
      mode:        currentMode,
      tone:        toneSelect.value,
      siteDisabled,
    });
  } catch {
    // Content script not injected on this page — ignore
  }
}
