# Grudge privacy policy

Last updated: October 4, 2026

Grudge is a Claude Code mod by hacksurvivor. It runs entirely on your own computer. It has no server, no account and no analytics, and its author receives nothing from it.

## What it reads

- The messages you type in Claude Code, to recognise when you reject or approve a look.
- The paths of files Claude edits, to recognise UI files.
- When you reject a look with a screenshot: that message's images, from the session's transcript in `~/.claude/projects`.

## What it sends, and where

Grudge sends nothing itself. The rules it keeps, and the file paths of their screenshots, are added to your conversation with Claude, which Claude Code sends to **Anthropic under your own Claude account**, like any message. See https://www.anthropic.com/legal/privacy.

## What it keeps

On your computer, until you remove them: the rules (up to 400) in Claude Code's plugin store, and the screenshots in `~/.claude/grudge/`. `/grudge forget` and Undo remove a rule; its screenshot stays in that folder until you delete it.

## Children

Grudge is not intended for people under 18.

## Contact

Open an issue at https://github.com/hacksurvivor/claude-mods/issues.
