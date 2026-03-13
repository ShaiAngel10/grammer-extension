/**
 * popup.js — Popup Controller
 *
 * Handles:
 *  • Loading persisted settings from chrome.storage.local on open
 *  • Saving new settings and notifying the active tab's content script
 *  • Toggling the extension on/off
 *  • Revealing/hiding the API key field
 */

'use strict';

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const enabledToggle    = document.getElementById('enabled-toggle');
const statusText       = document.getElementById('status-text');
const languageSelect   = document.getElementById('language-select');
const apiKeyInput      = document.getElementById('api-key-input');
const toggleVisBtn     = document.getElementById('toggle-key-visibility');
const saveBtn          = document.getElementById('save-btn');
const statusBanner     = document.getElementById('status-banner');

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Shows a transient status banner inside the popup.
 * @param {'success'|'error'} type
 * @param {string} message
 */
function showBanner(type, message) {
  statusBanner.className = type;
  statusBanner.textContent = type === 'success' ? `✓ ${message}` : `✕ ${message}`;
  clearTimeout(showBanner._timer);
  showBanner._timer = setTimeout(() => {
    statusBanner.className = '';
    statusBanner.textContent = '';
  }, 3000);
}

/** Updates the descriptive text beneath the toggle. */
function updateStatusText(enabled) {
  statusText.textContent = enabled
    ? 'Active — checking text fields'
    : 'Paused — grammar checks disabled';
}

// ─── Load persisted settings ──────────────────────────────────────────────────

chrome.storage.local.get(
  ['grammarEnabled', 'grammarLanguage', 'apiKey'],
  ({ grammarEnabled = true, grammarLanguage = 'en', apiKey = '' }) => {
    enabledToggle.checked = grammarEnabled;
    languageSelect.value = grammarLanguage;
    apiKeyInput.value = apiKey;
    updateStatusText(grammarEnabled);
  }
);

// ─── Toggle switch ────────────────────────────────────────────────────────────

enabledToggle.addEventListener('change', () => {
  const enabled = enabledToggle.checked;
  updateStatusText(enabled);

  // Persist immediately — don't wait for "Save"
  chrome.storage.local.set({ grammarEnabled: enabled });

  // Notify content script in the active tab
  broadcastSettings({ enabled, language: languageSelect.value });
});

// ─── Language change ──────────────────────────────────────────────────────────

languageSelect.addEventListener('change', () => {
  // Persist immediately so background.js picks it up on next request
  chrome.storage.local.set({ grammarLanguage: languageSelect.value });

  // Broadcast to active tab so content script switches language without reload
  broadcastSettings({ enabled: enabledToggle.checked, language: languageSelect.value });
});

// ─── API key visibility toggle ────────────────────────────────────────────────

toggleVisBtn.addEventListener('click', () => {
  const isHidden = apiKeyInput.type === 'password';
  apiKeyInput.type = isHidden ? 'text' : 'password';
  toggleVisBtn.textContent = isHidden ? '🙈' : '👁';
});

// ─── Save button ──────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', async () => {
  const apiKey   = apiKeyInput.value.trim();
  const language = languageSelect.value;
  const enabled  = enabledToggle.checked;

  // Validate key format loosely (allow empty to clear the stored key)
  if (apiKey && !apiKey.startsWith('sk-')) {
    showBanner('error', 'API key should start with "sk-"');
    return;
  }

  // Disable button while saving
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    // Persist language and enabled state to local storage
    await chrome.storage.local.set({ grammarLanguage: language, grammarEnabled: enabled });

    // Forward the API key to background.js — it handles both saving and clearing
    // (empty string → clears the stored key; non-empty → saves it)
    const response = await chrome.runtime.sendMessage({
      type: 'SAVE_API_KEY',
      apiKey,
    });
    if (!response?.success) throw new Error('Background failed to save key.');

    // Broadcast settings update to content scripts on the active tab
    await broadcastSettings({ enabled, language });

    showBanner('success', apiKey ? 'Settings saved' : 'API key cleared');
  } catch (err) {
    console.error('[GrammarAI popup]', err);
    showBanner('error', err.message || 'Failed to save settings.');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Settings';
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sends a SETTINGS_UPDATED message to the content script running in the
 * currently active tab. The content script uses this to update its
 * isEnabled and selectedLanguage state immediately without a page reload.
 *
 * @param {{ enabled: boolean, language: string }} settings
 */
async function broadcastSettings(settings) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    await chrome.tabs.sendMessage(tab.id, {
      type: 'SETTINGS_UPDATED',
      enabled: settings.enabled,
      language: settings.language,
    });
  } catch (_err) {
    // Content script might not be injected on chrome:// pages — ignore
  }
}
