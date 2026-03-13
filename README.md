# ✦ GrammarAI — Chrome Extension

Real-time AI grammar and spell-checking across 12 languages, powered by **GPT-4o mini**.

---

## 📁 File Structure

```
grammar-extension/
├── manifest.json       ← Extension manifest (MV3)
├── background.js       ← Service worker — secure API calls
├── content.js          ← Injected into every page — detects typing
├── content.css         ← Tooltip styles injected into pages
├── popup.html          ← Extension popup UI
├── popup.js            ← Popup controller
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 🚀 Quick Setup

### 1. Load the Extension
1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `grammar-extension/` folder

### 2. Add Your OpenAI API Key
1. Click the ✦ GrammarAI icon in your toolbar
2. Paste your `sk-...` API key in the **OpenAI API Key** field
3. Select your target language
4. Click **Save Settings**

> **Security note:** Your API key is stored in `chrome.storage.local` (on-device only)
> and all API calls are routed through the background service worker —
> the key is never accessible to page content scripts.

---

## 🔧 How It Works

### Architecture Flow

```
User types in textarea/contenteditable
        │
        ▼ (debounce 850ms)
  content.js captures text
        │
        ▼ chrome.runtime.sendMessage
  background.js receives message
        │
        ▼ fetch() with stored API key
  OpenAI GPT-4o mini API
        │
        ▼ JSON response
  background.js parses & validates
        │
        ▼ sendResponse()
  content.js renders tooltip
        │
        ▼ User clicks "Apply Fix"
  Text is replaced in the field
```

### Debounce Logic
The extension waits **850ms** after the user stops typing before sending a request.
This prevents flooding the API on every keystroke. You can adjust `DEBOUNCE_MS`
in `content.js`.

### AI Response Shape
The background script instructs GPT-4o mini to return strictly:

```json
{
  "correctedText": "The corrected full text",
  "explanation": "Brief summary of what was fixed",
  "corrections": [
    {
      "original": "teh",
      "corrected": "the",
      "reason": "Spelling error"
    }
  ]
}
```

---

## ⚙️ Configuration

| Setting | Location | Default |
|---------|----------|---------|
| Debounce delay | `content.js → DEBOUNCE_MS` | `850` ms |
| Minimum text length | `content.js → MIN_TEXT_LENGTH` | `15` chars |
| AI model | `background.js → MODEL` | `gpt-4o-mini` |
| Max response tokens | `background.js → MAX_TOKENS` | `500` |

---

## 🌐 Supported Languages

English, Spanish, French, German, Italian, Portuguese, Dutch, Polish, Russian, Japanese, Chinese (Simplified), Arabic

---

## 🔒 Permissions Explained

| Permission | Why it's needed |
|-----------|----------------|
| `storage` | Save API key and language preference locally |
| `activeTab` | Send settings updates to the current tab's content script |
| `scripting` | Future use: programmatic script injection |
| `host_permissions: api.openai.com` | Allow the background worker to call the OpenAI API |

---

## 💡 Tips

- The extension skips text fields with fewer than 15 characters (configurable)
- It works on Gmail, Notion, Linear, GitHub, and virtually any `<textarea>` or `contenteditable`
- Clicking **Apply Fix** uses the native setter pattern so React/Vue controlled inputs update correctly
- The tooltip auto-dismisses when you click outside it

---

## 📦 Publishing

Before publishing to the Chrome Web Store:
1. Remove the API key input from the popup and move to an **Options page** (better UX)
2. Consider adding a usage counter to track token spend
3. Add `"minimum_chrome_version": "116"` to `manifest.json`
