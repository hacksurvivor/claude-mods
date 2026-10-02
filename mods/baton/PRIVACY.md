# Baton privacy policy

Last updated: October 2, 2026

Baton is a Claude Code mod by hacksurvivor. It runs entirely on your own computer. It has no server, no account and no analytics, and its author receives nothing from it.

## What Baton reads

- **Your Claude Code conversation**, when it hands the chat to Codex, when you use `/codex`, or when Claude calls Baton's `codex` tool.
- **Your microphone**, through the voice helper in the Codex CLI, only while you have pressed Talk and until you press End.
- **From Codex's own folder (`~/.codex`)**: its usage-limit lines (not your messages), its model list, two settings (your default model and effort), and the images Codex saved, so it can show them.
- **What Codex reads in Claude's browser pane** while Codex browses there.

Baton never reads Codex's credentials (`~/.codex/auth.json`) or any other credential.

## What Baton sends, and where

Everything Baton sends goes to **OpenAI, through the Codex CLI you installed and signed in to**:

- When Codex picks up the chat: your message and up to the last 20 messages of the conversation (their text and the names of tools used).
- Whatever you send with `/codex`, and the brief Claude writes when it calls the `codex` tool.
- During Talk: your voice, streamed by Codex's voice helper.
- While Codex browses in Claude's browser pane: what Codex reads there.

OpenAI handles that data under your own OpenAI account and settings: see OpenAI's privacy policy at https://openai.com/policies/privacy-policy. Baton sends nothing anywhere else. Its helpers talk to it only over Unix sockets in your private temp folder, which never leave your computer.

## What Baton keeps

- Your Baton settings (mode, Codex model and effort, who works, Tools), in Claude Code's plugin store, until you change them.
- Nothing else. Image previews are temporary files deleted right after they are made.

## Children

Baton is not intended for people under 18.

## Contact

Open an issue at https://github.com/hacksurvivor/claude-mods/issues.
