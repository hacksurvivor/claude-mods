# Nightshift

Codex inside Claude Code. Nightshift is a Claude Code mod that puts OpenAI's Codex one click away in the same window:

- **When your Claude usage limit runs out**, Codex picks up the same conversation and answers in the chat. When the limit resets, Claude takes it back and is told what Codex did.
- **A Codex strip above the message box** shows Codex's effort and model pickers, its 7-day limit as a week of tiles, a Tools switch and a Talk button.
- **Talk** opens Codex's live voice. Each spoken exchange lands in the chat. Say "pass this to Claude" (or switch Work to Claude) and Claude does the work, then the voice reads you its answer.
- **Images**: ask Claude for an image and it asks Codex, which makes it with Codex's own image generator on your ChatGPT plan. The image shows in the chat.
- **Tools: Codex** hands browser work, Mac apps, images and documents to Codex. When Codex browses, it browses in Claude's own browser pane, so you watch it there.
- `/codex <prompt>` answers one message with Codex, whatever the mode.

## Requirements

- Claude Code 2.1.286 or later (mods). The strip, image cards and browser pane are drawn by the Claude desktop app; the terminal gets a plain-text strip.
- The [Codex CLI](https://github.com/openai/codex) 0.159 or later on your `PATH`, signed in (`codex login`). A ChatGPT plan works; no OpenAI API key is needed.
- Node.js 22 or later on your `PATH`, for Nightshift's two small helper scripts.
- macOS for voice: it uses the voice helper that ships with the Codex CLI.

## Install

In Claude Code:

```
/plugin marketplace add hacksurvivor/claude-mods
/plugin install nightshift@hacksurvivor
/reload-plugins
```

## Use it

- The strip: pick Codex's effort and model, see its 7-day limit (lit tiles are what's left; the thin mark is how much of the week is left), switch Tools, press Talk.
- `/nightshift auto | codex | claude`: Codex only when Claude's limit is used up (the default), Codex for every message, or never.
- `/nightshift effort <level>`, `/nightshift model <name>`, `/nightshift tools claude | codex | auto`.
- `/codex <prompt>`: one message to Codex. Start it with `$imagegen` for an image.

## What Nightshift runs, reads and sends

Nightshift is open about everything it does on your machine and what leaves it:

- **It runs the Codex CLI** from your `PATH` through your login shell: `codex exec` in the project folder with Codex's `workspace-write` sandbox, and `codex app-server` for voice. Codex then works with your own Codex login and settings.
- **It sends to OpenAI, through Codex**: when Codex picks up the chat, your message and up to the last 20 messages of the conversation (their text and the names of tools used); whatever you send with `/codex`; the brief Claude writes when it calls the `codex` tool; and during Talk, your voice, which Codex's voice helper streams to OpenAI. The microphone is used only while Talk is on.
- **It reads, from Codex's folder**: the usage-limit lines in `~/.codex/sessions` (never your messages there), the model list in `~/.codex/models_cache.json`, the default model and effort in `~/.codex/config.toml`, and the images Codex saves in `~/.codex/generated_images`, to show them (it makes small JPEG previews with macOS `sips`). It never reads `~/.codex/auth.json` or any credential.
- **It runs two helper scripts with Node**: `hooks/voice.mjs` (the voice bridge) and `hooks/browser-mcp.mjs` (the browser bridge Codex uses). They talk to Nightshift over Unix sockets in your private temp folder (`$TMPDIR`). Neither opens a network port.
- **Claude's browser pane**: when Codex browses, Nightshift carries each of Codex's steps into Claude's browser pane with Claude Code's own connection to it, which does not show Claude Code's permission prompt. Nightshift asks instead: steps that change something (opening a page, clicking, typing, filling a field) wait for your Allow, Allow all or Deny above the strip; steps that only look (reading the page, screenshots, scrolling) run at once. With **Tools: Codex · auto**, every step runs without asking.
- **Tools: Codex** switches off Claude's own browser and computer-use tools (Claude is told they're off, and calls to them are refused) until you set Tools back to Claude. Code, files and the shell stay with Claude.
- **During voice**, a permission request from Codex that your own Codex hooks don't answer is declined, so a call never waits on a prompt you can't see.
- **It keeps your choices** (mode, model, effort, who works, Tools) in Claude Code's plugin store.

## How Nightshift works, call by call

### Programs it runs

All on your computer. Nothing is downloaded or installed, and no package manager runs.

| Program | When | Why |
| --- | --- | --- |
| `codex exec --json …` and `codex exec resume …`, through `/bin/zsh -lc 'exec codex "$@"'` | When Codex picks up the chat, for `/codex`, and when Claude calls the `codex` tool | To have Codex do the work. The login shell finds `codex` on your `PATH` the way your terminal does. The arguments are fixed apart from the prompt, the Codex model and effort, images you attach, and the settings that connect Codex to the browser bridge. |
| `node hooks/voice.mjs`, through `/bin/zsh -lc 'exec node "$@"'` | While Talk is on | The voice bridge. It runs `codex app-server` and the voice helper that ships with the Codex CLI. |
| `node hooks/browser-mcp.mjs` | Started by Codex during runs Nightshift begins | The browser bridge: Codex's way into Claude's browser pane. |
| `/bin/zsh -c` with `ls`, `grep` and `tail` | At session start, after each Codex run, and every 5 minutes | To read the newest usage-limit line from `~/.codex/sessions`, for the 7-day meter. |
| `/bin/zsh -c` with `cat` and `awk` | At session start | To read Codex's model list and the two settings it uses (default model and effort) from `~/.codex`. |
| `/bin/zsh -c` with `stat`, and `sips` with `base64` | After a Codex run that made images | To find the PNGs Codex saved for that run and make small JPEG previews (in a temporary file deleted right after). |
| `/usr/bin/getconf DARWIN_USER_TEMP_DIR` | When a bridge starts | To find your private temp folder for the bridges' sockets. |

### Requests it makes

Nightshift's own requests (`$.http.fetch`) go only to `http://localhost`, over Unix sockets in your private temp folder, to its two bridges. They never leave your computer:

- Browser bridge: `GET /next` (the next step Codex asks for) and `POST /result` (its result).
- Voice bridge: `POST /mute`, `POST /end`, `POST /route` (Codex or Claude does the work) and `POST /speak` (Claude's answer, for the voice to read out).

Data leaves your computer only through the Codex CLI, to OpenAI, as listed above.

### Tools it calls itself

While a Codex run or a call that Nightshift started is going, Nightshift calls the tools of Claude's browser pane (`navigate`, `get_page_text`, `read_page`, `find`, `computer`, `form_input`, `tabs_context`, `tabs_create`) on Codex's behalf: one call for each step Codex asks for, asked or not as described above. It calls no other tools.

### Prompts it submits

- **A voice exchange:** what you said, as a chat row. Nightshift answers it with Codex's spoken reply and images, and no model runs.
- **Work you pass to Claude by voice:** the task as Codex's voice wrote it. Claude then does the work.
- **`/codex <prompt>`:** your prompt, and Codex answers it.
- **A message that hit Claude's limit mid-reply (auto mode):** your last message again, so Codex can answer it.

When Claude answers again after Codex covered for it, Nightshift adds one note to Claude's context. The note says how many messages Codex answered and which files it changed.

### Hooks and what they change

- `session.start`: registers `/nightshift`, `/codex` and the `codex` tool, and reads your settings and Codex's limits.
- `prompt.submit`: adds the note above when Claude takes back over from Codex. Everything else passes through unchanged.
- `turn.start`, `turn.step`, `turn.complete`: when Codex covers for Claude, or a voice exchange is kept, `turn.step` answers the turn itself instead of Claude. Otherwise the turn goes to Claude unchanged. `turn.complete` sends Claude's answer to the voice for work you passed to Claude, and retries a limit-hit message with Codex.
- `tool.call`: answers Nightshift's own `codex` tool. When Tools is set to Codex, it refuses calls to Claude's browser tools (`mcp__Claude_Browser__*`, `mcp__claude-in-chrome__*`) and computer-use tools (`mcp__computer-use__*`), telling Claude to use Codex instead. Every other tool call passes through unchanged.
- `tool.describe`: only when Tools is set to Codex. It describes those same browser and computer-use tools as off and moves them behind tool search, and adds to the `codex` tool's description that it takes that work.
- `ui.render`: draws the strip, Codex's replies, voice rows, image cards and the Allow row. It changes nothing else.
- `command.run`: serves `/nightshift` and `/codex`.

### Credentials

Nightshift uses your Codex login only by running the Codex CLI. It never reads, stores or sends a credential, so there is no key or token to configure.

## Notes

- Voice drives the private voice helper bundled with the Codex CLI, whose protocol is tied to the exact Codex build. A Codex update can break voice until Nightshift is updated; everything else keeps working.
- Nightshift is not made or endorsed by OpenAI. Codex, its logo and the `>_` header are OpenAI's; parts of the Codex CLI's art and shimmer are ported under Apache-2.0 (see `NOTICE`).

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
