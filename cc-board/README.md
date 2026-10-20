# cc-board

A Claude Code mod for people who run several sessions at once. It keeps a
per-session checklist you can tick off, tells Claude what you ticked, and
shows a live board of every session on the machine above the prompt.

Requires Claude Code 2.1.287 or later (built and tested on 2.1.304).

## What you get

**A checklist pane for this session.** Claude's TodoWrite items appear as
rows. Manual steps you have to do yourself join them, from `/manual <text>`
or from any line in Claude's reply that starts with `MANUAL:`. Each row is a
button: click it in the Desktop Code tab or in a fullscreen terminal, or
Tab to it and press Enter. `/done <id>` ticks an item from the keyboard.

**Claude knows what you ticked.** Every change is sent to Claude as one
short hidden note, only when something changed, and only the delta. If a
later TodoWrite would reopen an item you ticked, the item stays done and the
note says so, so Claude stops reminding you and does not add it back.

**A live board of all sessions.** Each session writes
`~/.claude/board/<session-id>.json` (atomically, temp file plus rename).
Every session polls that folder every two seconds and draws one line per
live session in the band above the prompt: project, a one-sentence summary,
open item count. The current session is marked with `▶`. Sessions with no
update for 24 hours are dimmed as stale. Nothing here needs a Claude turn.

**Restarts, resumes and older sessions.** A session keeps its id across a
restart or `claude --resume`, so at startup the mod reads its own board
file back, ticks included. A session that predates the mod has no file, so
the mod reads the transcript instead and seeds the checklist from the last
TodoWrite call and any `MANUAL:` lines Claude wrote. Neither sends Claude a
note, since Claude already knows all of it.

**`/board`** prints the full board: every session, its open items, and the
`claude --resume` command to get back to it. **`/board prune`** asks, then
removes the files of stale or ended sessions.

The summary comes from the in-progress todo, then the first pending todo,
then the first line of your last prompt. Only when the todo list is empty
does the mod ask Haiku for one sentence, at most once every five minutes.
Turn that off with the `haikuSummary` option in `/config`.

## Install for development

Run the plugin straight from this folder for one session:

```sh
claude --plugin-dir ~/src/claude-mods/cc-board
```

Saving a file in the folder reloads the mod in that session. To have the
Desktop app's local Code sessions load it too, name the folder in your
settings instead, because the app takes no flag. Add this to the `env`
block of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/src/claude-mods/cc-board"
  }
}
```

Open two sessions in two repos. Each one gets its own checklist and both
bands list both sessions within a couple of seconds.

## Install from the marketplace

This repository doubles as a marketplace: `.claude-plugin/marketplace.json`
at its root lists the mod. Once it is pushed to GitHub, anyone with access
installs it with one line at the Claude Code prompt:

```text
/plugin install cc-board --marketplace timjamwoo/claude-mods
```

Or from the shell:

```sh
claude plugin marketplace add timjamwoo/claude-mods
claude plugin install cc-board@claude-mods
```

Answer `y` to add the marketplace and pick the user scope so every project
gets it. In the Desktop app, click + next to the prompt box, then Plugins,
Add marketplace with `timjamwoo/claude-mods`, then Add plugin. Run
`/reload-plugins` in any session that was already open.

Installing from a local clone works the same way with the clone's path in
place of `timjamwoo/claude-mods`, and the mod is then read from that folder,
so edits only need `/reload-plugins`.

## Check it

```sh
claude plugin validate cc-board
claude plugin test cc-board
```

`validate` lists every event the mod hooks and every call it makes. `test`
runs the files under `tests/`: the board file round trip and malformed
files, `MANUAL:` parsing, keeping ticked items done through a TodoWrite
update, the note sent to Claude, the band on the terminal and desktop
surfaces, and both restore paths at startup.

## Files

- `hooks/register.tsx` wires the events to the engine: commands, the pane,
  the band, the poll, the board file writes.
- `hooks/checklist.ts` is the checklist logic, pure functions only.
- `hooks/board.ts` is the board file shape, the stale rule and the text the
  band and `/board` print.
- `types/index.d.ts` declares the values kept in `$.state`.
- `tests/` holds the tests `claude plugin test` runs.

## What it does not do

It never answers or changes a tool call, and the only text it adds to a
request is the checklist note. It makes no network calls apart from the
optional Haiku summary, which goes through your own Claude Code
credentials. A missing board folder or a malformed board file is logged to
the debug log (`claude --debug`) and skipped.

There is no way for a mod to set the terminal tab title, and Claude Code
sets its own, so that part of the original idea is left out.
