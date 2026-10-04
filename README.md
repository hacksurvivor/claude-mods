# claude-mods

Claude Code mods by hacksurvivor.

| Mod | What it does |
| --- | --- |
| [Nightshift](mods/nightshift) | Codex inside Claude Code: it picks up the chat when your Claude limit runs out, talks with you through Codex's live voice, makes images Claude can ask for, and browses in Claude's browser pane. |
| [Third eye](mods/third-eye) | A folded footnote under Claude's reply with one idea you wouldn't have suggested yourself, anchored in the chat. |
| [Grudge](mods/grudge) | Every look you reject becomes a rule for that project, with your screenshot, so Claude never brings it back. |
| [Bouncer](mods/bouncer) | Paste a link and Claude's answer opens with a verdict for your projects: use it, later or skip, with the effort and one line why. |
| [Clock](mods/clock) | Every prompt carries your local date, time and week ranges, so Claude stops guessing dates; a reply with the wrong week gets flagged. |
| [Updates](mods/updates) | A weekly check of your plugins, global npm packages and adapted skills for newer versions; The Tree of Mods applies them. |
| [The Tree of Mods](mods/tree-of-mods) | `/mods` opens a panel with your mods and plugins: switch them on or off, see tests and GitHub numbers, apply updates. |

Install in Claude Code:

```
/plugin marketplace add hacksurvivor/claude-mods
/plugin install nightshift@hacksurvivor
/plugin install third-eye@hacksurvivor
/plugin install grudge@hacksurvivor
/plugin install bouncer@hacksurvivor
/plugin install clock@hacksurvivor
/plugin install updates@hacksurvivor
/plugin install tree-of-mods@hacksurvivor
/reload-plugins
```

Each mod's README lists its requirements and everything it runs, reads and sends: [Nightshift](mods/nightshift/README.md), [Third eye](mods/third-eye/README.md), [Grudge](mods/grudge/README.md), [Bouncer](mods/bouncer/README.md), [Clock](mods/clock/README.md), [Updates](mods/updates/README.md), [The Tree of Mods](mods/tree-of-mods/README.md).
