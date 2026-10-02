# Baton

Codex inside Claude Code. Baton is a Claude Code mod that puts OpenAI's Codex one click away in the same window:

- **When your Claude usage limit runs out**, Codex picks up the same conversation and answers in the chat. When the limit resets, Claude takes it back and is told what Codex did.
- **A Codex strip above the message box** shows Codex's effort and model pickers, its 7-day limit as a week of tiles, a Tools switch and a Talk button.
- **Talk** opens Codex's live voice. Each spoken exchange lands in the chat. Say "pass this to Claude" (or switch Work to Claude) and Claude does the work, then the voice reads you its answer.
- **Images**: ask Claude for an image and it asks Codex, which makes it with Codex's own image generator on your ChatGPT plan. The image shows in the chat.
- **Tools: Codex** hands browser work, Mac apps, images and documents to Codex. When Codex browses, it browses in Claude's own browser pane, so you watch it there.
- `/codex <prompt>` answers one message with Codex, whatever the mode.

## Requirements

- Claude Code 2.1.286 or later (mods). The strip, image cards and browser pane are drawn by the Claude desktop app; the terminal gets a plain-text strip.
- The [Codex CLI](https://github.com/openai/codex) 0.159 or later on your `PATH`, signed in (`codex login`). A ChatGPT plan works; no OpenAI API key is needed.
- Node.js 22 or later on your `PATH`, for Baton's two small helper scripts.
- macOS for voice: it uses the voice helper that ships with the Codex CLI.

## Install

In Claude Code:

```
/plugin marketplace add hacksurvivor/claude-mods
/plugin install baton@hacksurvivor
/reload-plugins
```

## Use it

- The strip: pick Codex's effort and model, see its 7-day limit (lit tiles are what's left; the thin mark is how much of the week is left), switch Tools, press Talk.
- `/baton auto | codex | claude`: Codex only when Claude's limit is used up (the default), Codex for every message, or never.
- `/baton effort <level>`, `/baton model <name>`, `/baton tools claude | codex | auto`.
- `/codex <prompt>`: one message to Codex. Start it with `$imagegen` for an image.

## What Baton runs, reads and sends

Baton is open about everything it does on your machine and what leaves it:

- **It runs the Codex CLI** from your `PATH` through your login shell: `codex exec` in the project folder with Codex's `workspace-write` sandbox, and `codex app-server` for voice. Codex then works with your own Codex login and settings.
- **It sends to OpenAI, through Codex**: when Codex picks up the chat, your message and up to the last 20 messages of the conversation (their text and the names of tools used); whatever you send with `/codex`; the brief Claude writes when it calls the `codex` tool; and during Talk, your voice, which Codex's voice helper streams to OpenAI. The microphone is used only while Talk is on.
- **It reads, from Codex's folder**: the usage-limit lines in `~/.codex/sessions` (never your messages there), the model list in `~/.codex/models_cache.json`, the default model and effort in `~/.codex/config.toml`, and the images Codex saves in `~/.codex/generated_images`, to show them (it makes small JPEG previews with macOS `sips`). It never reads `~/.codex/auth.json` or any credential.
- **It runs two helper scripts with Node**: `hooks/voice.mjs` (the voice bridge) and `hooks/browser-mcp.mjs` (the browser bridge Codex uses). They talk to Baton over Unix sockets in your private temp folder (`$TMPDIR`). Neither opens a network port.
- **Claude's browser pane**: when Codex browses, Baton carries each of Codex's steps into Claude's browser pane with Claude Code's own connection to it, which does not show Claude Code's permission prompt. Baton asks instead: steps that change something (opening a page, clicking, typing, filling a field) wait for your Allow, Allow all or Deny above the strip; steps that only look (reading the page, screenshots, scrolling) run at once. With **Tools: Codex · auto**, every step runs without asking.
- **Tools: Codex** switches off Claude's own browser and computer-use tools (Claude is told they're off, and calls to them are refused) until you set Tools back to Claude. Code, files and the shell stay with Claude.
- **During voice**, a permission request from Codex that your own Codex hooks don't answer is declined, so a call never waits on a prompt you can't see.
- **It keeps your choices** (mode, model, effort, who works, Tools) in Claude Code's plugin store.

## Notes

- Voice drives the private voice helper bundled with the Codex CLI, whose protocol is tied to the exact Codex build. A Codex update can break voice until Baton is updated; everything else keeps working.
- Baton is not made or endorsed by OpenAI. Codex, its logo and the `>_` header are OpenAI's; parts of the Codex CLI's art and shimmer are ported under Apache-2.0 (see `NOTICE`).

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
