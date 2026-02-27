# Secrets & Revelations Tracker (SillyTavern Extension)

A lightweight **secrets tracker** for SillyTavern that helps you keep **who knows what** between **{{user}}** and the current **NPC**.

It provides:
- A floating **tracker widget** + side drawer editor (optional)
- Per-chat storage (uses **chat metadata**) so each chat keeps its own secrets
- Automatic **prompt injection** via `setExtensionPrompt()` (no chat log pollution)

> ⚠️ This extension is UI-only and runs in the browser context.

## Install (local)
1. Put this folder into:
   - **Server-wide**: `public/scripts/extensions/third-party/`
   - **User scope**: `data/<your-handle>/extensions/`
2. Restart SillyTavern.
3. Enable it in **Extensions**.

## Install (from GitHub)
Use SillyTavern's built-in extension installer with your repo URL once you upload it.

## Usage
- Open the floating 🔐 widget (bottom-right) to add/edit secrets.
- Toggle whether a secret is known (revealed).
- The current summary is injected into the prompt each generation (unless disabled).

## Data model (per chat)
Stored under `chatMetadata["srt_state_v1"]`:
- `npcSecrets[]`: secrets *about NPC*, toggle `knownToUser`
- `userSecrets[]`: secrets *about user*, toggle `knownToNpc`
- `mutualSecrets[]`: shared secrets (known to both)

## License
AGPL-3.0-or-later


> Note: `template.html` is included for convenience but the extension UI is embedded in `index.js` (so it works in both user-scoped and server-scoped installs).
