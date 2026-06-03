# AttentionSpam — Chrome Extension (Manifest V3)

Automates sending repeated messages in YouTube Live Chat via a **long-press activation loop** with smart anti-spam protection.

---

## File Structure

```
AttentionSpam/
├── manifest.json        ← Extension metadata & permissions
├── content.js           ← Core automation logic (content script)
├── hint-banner.css      ← Injected hint banner styles (YT CSS variables)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## How to Install (Developer Mode)

1. Open Chrome and navigate to `chrome://extensions/`
2. Toggle **Developer mode** ON (top-right corner)
3. Click **Load unpacked**
4. Select the `AttentionSpam/` folder

The extension will now be active on any YouTube Live Chat page.

---

## How It Works

### Normal Use
Type your message and click **Send** normally — the extension does not interfere.

### Activation
Type your message, then **press and hold the Send button for 1.5 seconds**.  
The hint banner will change to `"Looping active. Hold Send again to stop."`

### Deactivation
While looping, **press and hold the Send button for 1.5 seconds** again.

---

## Smart Anti-Spam Features

| Feature | Behaviour |
|---|---|
| **Slow-mode Detection** | Reads the slow-mode banner and sets the base cooldown automatically |
| **Default Cooldown** | 10 seconds if no slow-mode is detected |
| **Humanizer Jitter** | Adds 500–1500 ms random variance per cycle |
| **Error Banner Parser** | Reads "Please wait X seconds…" and recalculates the true cooldown as `X + elapsed` |

---

## DOM Selectors Used (Stable, No Minified Classes)

| Target | Selector Strategy |
|---|---|
| Chat input | `yt-live-chat-text-input-field [contenteditable='true']` |
| Send button | `#send-button button` then `button[aria-label='Send message']` |
| Input container | `#input-panel` or `yt-live-chat-text-input-field` |

---

## Security

- **No remote data transmission** — all logic is local DOM manipulation only.
- **No background service worker** — zero persistent background processes.
- **Host permission** is scoped strictly to `https://www.youtube.com/*`.
- `permissions` array is intentionally empty (no `storage`, `tabs`, etc.).
