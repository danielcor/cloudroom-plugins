# Prompt Snippets (`snippets`)

A Cloudroom plugin that keeps reusable prompts as Markdown files and writes the one you pick into the chat
composer. You can still edit the text there, and nothing is sent until you press Enter.

Design: [`docs/superpowers/specs/2026-11-12-prompt-snippets-plugin-design.md`](../docs/superpowers/specs/2026-11-12-prompt-snippets-plugin-design.md).
Its "Decisions" and "Spike results" sections are binding. On Cloudroom v152 the composer `insert`, the host
popup and the `Ctrl+Alt+S` composer command do not work, so this plugin uses none of them.

## What it adds

| Piece | What it does |
| --- | --- |
| Sidebar page **Snippets** | A **Table** view and a **Picker** view. The table has a filter, scope and tag chips, inline title and tag edit, and an editor pane that saves after a short pause and on blur. It also does add, duplicate (`Ctrl+D`), delete with Undo (`Del`), and reorder (drag `⠿`, or `Alt+↑`/`Alt+↓`). The picker has fuzzy search, a plain-text preview, `{{placeholder}}` fields and an **Insert** button. |
| `+` menu row **Insert snippet…** | Opens the picker for the composer you clicked it in. **Insert** goes back to that thread and appends the filled snippet to the end of its draft, as its own paragraph, through `composer.updateText`. |
| `room-cli snip list` / `room-cli snip show <id>` | A fallback for agents. A project snippet comes from the thread's project and wins over a global one with the same id. |
| Skill `snippets` | Tells an agent to expand only a snippet the user named in that message, using `room-cli snip show`. |

## Files

One Markdown file per snippet. The file name is the id (`[a-z0-9][a-z0-9-]{0,63}`).

```markdown
---
title: Review this PR
tags: review, git
order: 10
created: 2026-11-12T09:30:00Z
updated: 2026-11-12T16:02:11Z
---
Review {{target}} as a strict senior reviewer.
Focus on {{focus|correctness}}.
```

| Scope | Folder |
| --- | --- |
| Project | `<repo>/.snippets/`, committed with the repo. |
| Global | The `globalDir` setting. The default is `~/skills/.snippets` on the Cloudroom server's machine, a dot-folder that `distribute-skills` skips. Change it with `room-cli plugin config snippets set globalDir <path>`. |

- Neither folder has to exist. The first create makes it with `bb.sdk.files.mkdir` (recursive). The host
  will not write into a missing `rootPath`, even with `createParents`.
- The frontmatter is a flat subset: one `key: value` per line. Keys the plugin does not know are kept when it saves.
- Every write carries the SHA-256 of the file as it was read. If the file changed on disk in the meantime, the
  editor keeps your text and offers **Overwrite with mine** or **Discard mine**.
- A delete never removes bytes. It checks the hash, then renames the file into `.trash/<id>~<time>.md` in the
  same folder. The rename is atomic on the host. It then compares the moved bytes with the hash it checked.
  If an edit landed in between, it renames the file back and reports a conflict. If that rename fails, it names
  the trash file that holds the edit. **Undo** renames the file back byte for byte: unknown keys and comments
  survive, and the secret scan does not run on content that was already on disk. The table and
  `room-cli snip` never list `.trash/`. The plugin writes a `.trash/.gitignore` containing `*` so deleted
  snippets stay out of Git. Nothing empties the trash yet: delete old files there by hand.
- A move rewrites only the moved file's `order` key. The plugin renumbers the scope only when there is no gap left.

## Safety

- The plugin never submits. Insert only appends visible, editable text.
- **Secret scan.** It checks for private keys, AWS, GitHub, `sk-`, Slack and Google keys, JWTs, bearer tokens,
  and long random values assigned to a name whose last word is secret-ish (`API_TOKEN=…`, `DATABASE_PASSWORD: …`,
  `apiKey: …`, `token=…`). Names are split on `_`, `.`, `-` and camelCase. On save, a hit blocks the save and names
  the kind and the line, never the value. On load, a hit shows a warning badge. The picker then needs a
  confirmation before it inserts. `room-cli snip show` refuses to print the snippet, and `room-cli snip list`
  shows only its id. The scan runs with invisible characters removed, so a token split by a zero-width space
  still counts.
- **Invisible characters.** Zero-width, bidi (including U+061C ARABIC LETTER MARK) and Unicode tag characters
  are stripped on save and on insert.
  The preview shows them as `⟦U+XXXX⟧`.
- Bodies are always rendered as plain text, never as HTML or Markdown.

## Install (on the Cloudroom server, aipc)

```sh
cd ~/src/cloudroom-plugins && git fetch && git checkout feat/prompt-snippets && git pull
cd plugin-snippets && npm ci
room-cli plugin build .
room-cli plugin install path:$HOME/src/cloudroom-plugins/plugin-snippets --yes
room-cli plugin list | grep -A1 snippets          # snippets@0.1.0  running
```

## Develop

```sh
cd plugin-snippets && npm ci
npx tsc --noEmit
npx vitest run      # parsers, scorer, secret scan, reorder maths, storage, server/CLI, and slot tests
```

The `0.6.49` SDK types list `composer.insert` and leave out `updateText`, which is the reverse of what host
v152 ships. `src/ui/bridge.ts` casts to `updateText` and cites the spike. `0.6.51`, the version the host runs, is
not on npm. The registry goes from 0.6.49 to 0.6.52.
