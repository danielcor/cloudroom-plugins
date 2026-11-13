# Prompt Snippets Cloudroom plugin design

Status: design only. Nothing is built. Date: 2026-11-12.

## Intent and why

Daniel retypes the same prompts and code fragments many times a day: review briefs, worker briefs, commit-message rules, shell headers. Prompt Snippets keeps them in one table, lets him pick one with the keyboard, and writes it into the chat composer where he can still edit it before sending.

## Goals

- Keep a table of snippets with create, edit, duplicate, delete and reorder.
- Insert a snippet into the composer at the cursor, from the keyboard, with fuzzy search.
- Fill `{{placeholders}}` at insert time.
- Store snippets as plain files that a person can edit by hand and keep in Git, one set per project plus one global set.
- Never send anything on the user's behalf. Insert only writes visible, editable text.

## Non-goals

- No auto-send, no scheduled send, no hidden context injected into agents.
- No snippet sharing service, marketplace, or remote URL import.
- No version history inside the plugin. Git is the history.
- No secrets in snippets, and no secret settings in the plugin.
- No new Plugin SDK surface. The plugin uses what SDK 0.6.49 already exposes.

## What a Cloudroom plugin can do: verified facts

Evidence sources, with the short names used in the tables below:

- **refs/** is the `plugin-authoring` skill that ships with the running Cloudroom, next to the `room-cli` skill folder (`…/skills/plugin-authoring/references/<file>.md`).
- **app.d.ts** and **sdk.d.ts** are the installed SDK 0.6.49 declarations in this repo: `plugin-muse/node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts` and `bb-plugin-sdk.d.ts`. The host runs at least this SDK: `plugin-muse/package.json` requires `bbPluginSdk >=0.6.49` and `room-cli plugin list` shows `provider-muse@0.1.0 running`.
- **CLI** is live `room-cli` output on this machine (`room-cli` v152).

Status words: **confirmed** means documented in refs/ or shown by the CLI. **types only** means present in the installed SDK declarations but not described in refs/ and not exercised live. **assumed** means inferred, with no direct evidence.

### The four questions

| Question | Answer | Evidence | Status |
| --- | --- | --- | --- |
| Can a plugin add UI? | Yes. A sidebar page (`navPanel`), a settings section, composer buttons (`actions`), `+` menu rows (`plusMenu`), banners, thread panel tabs, message actions, and command-palette commands with keyboard shortcuts. | refs/frontend-core-slots.md:87-96, 65-74; refs/frontend-hooks-and-ui.md:86-108; refs/frontend-renderer-slots.md:73-114 | confirmed |
| Can it add a slash command? | No. "There is deliberately no plugin slash-command surface: the composer's `/` menu lists skills". A plugin skill does appear in that menu. | refs/backend-ui-lifecycle.md:37-39; refs/quickstart.md:72-74 | confirmed |
| Can it write text into the composer? | Yes. `useComposer()` gives `setText`, `updateText`, `clear`, `focus`. SDK 0.6.49 adds `insert(parts, { at: "cursor" \| "end", block })`. | refs/frontend-hooks-and-ui.md:37-59; app.d.ts:20798-20810, 20917 | `setText`/`updateText` confirmed; `insert` types only |
| Where can it store data? | Declarative settings (`room-cli plugin config`), `bb.storage.kv` (JSON rows, 256 KB per value), its own SQLite at `<dataDir>/plugins/<id>/data.db`, and files on any connected machine through `bb.sdk.files` with a compare-and-swap guard. | refs/backend-foundation.md:49-131; refs/backend-sdk.md:196-222; `~/.gui-cloudroom/plugins/workflows/data.db` exists on disk | confirmed |
| Does that data sync to cloud threads? | No evidence that it does. Plugin storage lives in the local server's data directory. A cloud sandbox "starts from GitHub, not local files", so only files committed and pushed reach it. | `room-cli` skill, references/thread-creation.md:3 and thread-operation.md:14-19 | confirmed for Git; no sync of plugin storage is an inference from absence |

### Other facts the design leans on

- A composer command with a default shortcut exists: `app.composer.experimental_registerCommand({ id, title, defaultShortcut, run({ composer }) })`. The composer holding the caret runs it. It is listed in the palette and can be rebound (app.d.ts:20163-20185, 20480-20484). **types only**.
- A host-managed composer popup exists: `experimental_popups` on `app.composer.customize`, opened with `composer.experimental_openPopup(id)`. The host owns placement, dismissal and focus restore, and shows a drawer on small screens (app.d.ts:20661-20672, 20860-20864). **types only**.
- Plain palette commands (`app.commands.register`) get `{ threadId, projectId, openPanel }` and no composer handle (refs/frontend-renderer-slots.md:88-114). They cannot insert text by themselves. **confirmed**.
- A plugin CLI runs on the server and is listed for agents in the generated `plugin-commands` skill (refs/backend-cli-agents.md:3-29, 63-66). **confirmed**.
- File I/O must go through `bb.sdk.files` with the right `hostId`, never `node:fs` on a user path (refs/backend-cli-agents.md:75-85). **confirmed**.
- A mention provider can answer the `~` or `!` trigger with server-side search. The picked item becomes a pill whose text is resolved at send time as agent-only, user-hidden context (refs/backend-ui-lifecycle.md:5-34; sdk.d.ts:23989-24019). **confirmed**.
- `experimental_copyToClipboard` and `experimental_saveFile` exist for copy and export (app.d.ts:21821, 21834). **types only**.
- Built-in plugins inject instructions into agents with `bb.agents.contributeInstructions`. The docs name `connect` as the example, and this thread's own system prompt carries a block labelled as coming from the `connect` plugin. This design does not use it (see Security).

Limits of the research: built-in plugins (`connect`, `workflows`, `drafts`, `custom-instructions`) have source `builtin:<name>` in `room-cli plugin list`. Their folders under `~/.gui-cloudroom/plugins/` hold only logs and `data.db`, so there is no plugin source to read there. Their behaviour is taken from the CLI output and the shipped references.

## Design

### Package

- Folder `plugin-snippets/` in this repo, package `bb-plugin-snippets`, plugin id `snippets`.
- Manifest: `bb.server: ./server.ts`, `bb.app: ./app.tsx`, `bb.skills: ["skills"]`, `engines.bbPluginSdk: ">=0.6.49"`.
- This is the first plugin in the repo with a frontend bundle. `room-cli plugin new snippets` scaffolds the vendored UI files and type-only devDependencies; the two provider plugins here are headless and are not a template for the frontend.
- No `bb.host` entry in the MVP.

### Data model

One Markdown file per snippet. The file name is the id.

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

| Field | Where it lives | Rule |
| --- | --- | --- |
| `id` | file name, `<id>.md` | `[a-z0-9][a-z0-9-]{0,63}`. Made from the title on create. A title edit never renames the file. |
| `title` | frontmatter | 1 to 80 characters. |
| `body` | below the frontmatter | Up to 16 KB of plain text. Stored and inserted verbatim. |
| `tags` | frontmatter, comma list | Up to 8, lowercase. |
| `scope` | not stored | Derived from the folder: global or one project. |
| `order` | frontmatter integer | Gaps of 10. A move rewrites only the moved file; a full renumber happens only when a gap runs out. |
| `created`, `updated` | frontmatter | Written by the plugin on save. For a hand-edited file the table shows the file's modified time. |
| placeholders | not stored | Parsed from the body each time. |
| `usageCount`, `lastUsedAt` | `bb.storage.kv`, key `usage/<scope>/<id>` | Kept out of the file so that using a snippet never dirties Git. Local to this server. Losing them is harmless. |
| version history | none | Git already does this. |

The frontmatter is a strict flat subset: `key: value` lines only, no nesting. The plugin parses it by hand, so it needs no YAML dependency. Unknown keys are kept on save.

Why Markdown per snippet and not one JSON file: prompt bodies are multi-line, and JSON turns them into one escaped line that is painful to edit and to diff. Separate files also merge cleanly when two branches add snippets.

### Storage and scope

| Scope | Folder | In Git? |
| --- | --- | --- |
| Project | `<project root>/.cloudroom/snippets/` | Yes, committed with the repo. |
| Global | setting `globalDir`, default `~/.config/cloudroom/snippets/` on the primary machine | Optional. Point the setting at a Git checkout to version it. |

- A project snippet with the same id as a global one wins. The picker lists project snippets first.
- The server resolves the project root from `bb.sdk.projects` and does all reads and writes through `bb.sdk.files` with that project's `hostId`, `rootPath` set to the snippets folder, and `expectedSha256` on every write. A conflict reloads the file and keeps the user's unsaved text in the editor.
- Project snippets are read from the project's source root, not from a thread's worktree, so the table and the picker show one set everywhere.
- The frontend never touches files. It calls typed RPC methods: `list`, `create`, `save`, `remove`, `reorder`, `recordUse`. Every input is validated on the server.
- Refresh: the list is re-read when the table mounts, when the picker opens, and after each write. There is no file watcher in the MVP.

### How cloud threads get the data

- **Inserting from the picker needs nothing in the cloud.** The text is expanded in the app and travels as the message itself.
- **Project snippets reach a cloud sandbox through Git** once they are committed and pushed. An agent there can read `.cloudroom/snippets/<id>.md` like any other file.
- **Global snippets do not reach the cloud.** If Daniel wants them there, the options are a Git repo cloned by the cloud setup script, or `room-cli vm push`. This is left as an open decision.
- **Usage counts do not sync** anywhere.
- With the computer off, the phone still runs cloud threads, but the local server and this plugin's UI are not running. The picker is then unavailable (assumed; not tested).

### Insertion UX

Three ways to open one picker. All of them end in `composer.insert(text, { at: "cursor" })`.

1. **Keyboard shortcut.** A composer command `Snippets: insert snippet`, default `Ctrl+Alt+S` (`Cmd+Opt+S` on macOS). It is rebindable in Settings → Keyboard, and a colliding default stays unbound rather than stealing a key.
2. **`+` menu row** "Insert snippet…". Host-rendered, so it also works with a mouse and on small screens.
3. **Quick palette.** The same composer command is listed in the palette (`Mod+Shift+P`).

The picker is a composer popup, so it sits where the `@` mention menu sits:

- A search field with fuzzy matching over title, tags, id and body, weighted in that order. The scorer is a small subsequence matcher written in the plugin, with no dependency. Ties keep the manual order.
- `↑` `↓` move. The right-hand pane always shows the full body of the highlighted row.
- `Enter` on a snippet without placeholders inserts it at once.
- `Enter` or `Tab` on a snippet with placeholders moves focus into the fields. `Enter` again inserts.
- `Esc` closes and returns focus to the composer.
- A multi-line snippet inserted into a non-empty draft goes in as its own paragraph (`block: true`).
- The plugin never calls `submit`.

There is no `/snip` slash command in the composer, because the SDK does not allow plugin slash commands. The nearest thing is the skill fallback below.

### Placeholders

- Syntax: `{{name}}` and `{{name|default}}`. Names match `[a-z][a-z0-9_]*`. `\{{` is a literal brace pair.
- A name used twice is asked once.
- A field left empty takes its default. With no default, the literal `{{name}}` is inserted so the gap is visible in the composer.
- MVP: every placeholder is a free-text field.
- Later, reserved names fill themselves: `{{project}}`, `{{branch}}`, `{{date}}`, `{{clipboard}}`, `{{selection}}`, `{{file}}`. The confirmed route for `{{selection}}` is a message action, which receives the exact highlighted text of an assistant message (refs/frontend-renderer-slots.md:73-87). Reading the clipboard or the page selection directly is assumed to work and needs a spike.

### Table and editor UX

A sidebar page "Snippets" (`navPanel`). See the mockup.

- **Table columns:** drag handle, title, tags, scope, body preview, used, last used, row actions.
- **Inline edit:** click a title or tags cell to edit in place. `Enter` saves, `Esc` cancels.
- **Editor pane:** the selected row opens on the right with title, scope, tags, body, the placeholders found, and the file path. It saves on blur and after a short pause in typing.
- **Add:** "New snippet" creates a row in the current scope filter and focuses the title.
- **Duplicate:** `Ctrl+D` or the row icon. The copy gets id `<id>-copy`.
- **Delete:** `Del` or the row icon. The file is removed and a toast offers Undo for a few seconds.
- **Reorder:** drag the handle, or `Alt+↑` and `Alt+↓`.
- **Move scope:** changing Scope in the editor moves the file between the global and project folders.
- **Open file:** opens the Markdown file in Cloudroom's file viewer for hand editing.
- **Import and export (later phase):** export writes one JSON bundle of the filtered rows. Import reads a local bundle or `.md` files and always goes through a review dialog (see Security). Because snippets are plain files, copying a folder is also a valid export.

### Mockup

The mockup is `2026-11-12-prompt-snippets-plugin-mockup.html` in this folder. Open it in a browser at 1600 px wide. It shows two views: the table with the editor pane, and the picker popup above a thread composer.

There is no PNG. Rendering needs headless Chrome, which the lean-ctx shell allowlist did not permit in the design session. To make one:

```sh
google-chrome --headless=new --hide-scrollbars --window-size=1600,1500 \
  --user-data-dir="$TMPDIR/snip-mock-profile" \
  --screenshot=docs/superpowers/specs/2026-11-12-prompt-snippets-plugin-mockup.png \
  docs/superpowers/specs/2026-11-12-prompt-snippets-plugin-mockup.html
```

The HTML was never rendered, so its layout is unchecked.

### Fallback paths

The primary path depends on three calls that are in the SDK types but not in the shipped references. If the Phase 0 spike shows one of them does not work, drop down this ladder.

| Path | What the user does | Rests on | Status of the API |
| --- | --- | --- | --- |
| Primary | Shortcut or `+` menu, popup picker, insert at cursor | `experimental_registerCommand`, `experimental_popups`, `insert` | types only |
| A. Documented composer API | `+` menu row or a composer button opens the plugin's own popover; text is written with `updateText` (appended, not at the cursor); no shortcut | `plusMenu`, `actions`, `useComposer().updateText` | confirmed |
| B. Skill and CLI | Type `/snippets review-pr` in the composer. The agent runs `room-cli snip show review-pr` and follows it. | plugin `skills/`, `bb.cli` | confirmed |
| C. No plugin at all | Tell the agent "follow `.cloudroom/snippets/review-pr.md`" | plain files in the repo | works today, also in cloud threads for committed files |
| D. Clipboard | "Copy" in the table, then paste | `experimental_copyToClipboard` | types only |

Plainly: **nothing is built, so no path is running today except C.** By the SDK contract the plugin can write into the composer; path A is the one fully covered by the shipped documentation. Paths B and C differ from the goal in one important way: the agent expands the snippet after sending, so the user cannot edit it first.

### Security

Snippets are prompts. Whoever controls a snippet's text controls what an agent is told.

**Prompt injection from snippets the user did not write.** This covers imported sets and project snippets that arrive with a cloned or pulled repo.

- Insert always produces visible, editable text in the composer, and the plugin never sends. The user's Enter is the control.
- The picker always shows the full body of the highlighted row and its scope before insert.
- Invisible and direction-changing characters (zero-width, bidi overrides, Unicode tag characters) are shown as visible markers in the preview and stripped on insert.
- Bodies are rendered as plain text, never as HTML or Markdown.
- The plugin never puts snippet text into agent instructions on its own. No `contributeInstructions`, no mention pills with hidden context in the MVP.
- The fallback skill tells the agent to expand only a snippet the user named in that message.
- Later phase: import goes through a review dialog with every body shown and a per-snippet checkbox. Local files only, no URLs. Imported or externally changed files carry an "unreviewed" badge until the user opens and accepts them; the plugin tracks the accepted content hash in `bb.storage.kv`.
- Limits: 16 KB per body, 500 snippets per scope.

**No secrets in snippets.** Snippet files are plain text meant for Git.

- On save, the server scans the title and body for common secret shapes: private-key blocks, `AKIA…`, `ghp_…`, `sk-…`, `xox[bp]-…`, long bearer tokens, and long random strings next to words like `token`, `secret` or `password`. A hit blocks the save and says why.
- Hand-edited files skip that gate, so the same scan runs when files are listed. A hit shows a warning badge and the picker asks for confirmation before inserting.
- The guidance in the UI: name the environment variable, not the value, and use `room-cli secret request` for real credentials.
- The plugin has no secret settings. Logs and usage rows hold ids only, never bodies.

**Paths and input.** Ids are validated slugs, the server builds every path, and writes are confined with `rootPath`. All RPC input is treated as untrusted.

## Phases

**Phase 0, spike (half a day).** Prove on this host that the popup opens, the shortcut fires, and `insert` lands at the cursor, in a thread composer, the new-thread composer and a cloud thread's composer. The result picks Primary or fallback A.

**MVP.**

- Markdown files in the project and global folders, with list, create, save, delete and reorder over RPC.
- Picker with fuzzy search, opened by shortcut and `+` menu, inserting at the cursor, with free-text placeholders.
- Table page with inline edit, editor pane, add, duplicate, delete with undo, and reorder.
- Secret scan on save and on load, invisible-character handling, never auto-send.
- `room-cli snip list|show` and a `snippets` skill as the fallback.

**Phase 2.** Usage counts and "recent first" sorting. Import and export with the review dialog. "Unreviewed" badge for changed files. Self-filling placeholders. Message actions "Save as snippet" and "Insert snippet with this selection".

**Phase 3.** A typed `~` trigger through a mention provider. A composer button. A file watcher through a `bb.host` entry. Global snippets in the cloud.

## Verification plan for the build

- Unit tests for the frontmatter parser, placeholder parser, fuzzy scorer, secret scan and reorder maths.
- Slot tests with the SDK's `renderSlot` harness for the picker and the table.
- A live check through a real thread: create, edit by hand on disk, insert, reorder, delete, and a CAS conflict.
- A live check that a project snippet is readable in a cloud thread after a push.

## Decisions (Daniel, 2026-11-12)

1. **File format:** one Markdown file per snippet.
2. **Global folder:** `~/skills/.snippets/`, a Git-backed folder, so global snippets can reach cloud sandboxes. It is a dot-folder because `distribute-skills` only picks up `~/skills/*/` folders that hold a `SKILL.md`, so it skips this one (revised 2026-11-13). This replaces the `~/.config/cloudroom/snippets/` default used elsewhere in this spec and in the mockup.
3. **Experimental APIs:** use the popup, composer command and `insert` calls only if they pass the live spike; if a call fails live, fall back to the documented composer API for that feature. The spike failed all three on v152 (see "Spike results"), so the MVP uses the fallback for every one.
4. **Secret scan:** block the save.
5. **Project folder:** `.snippets/` at the repo root, committed in each repo (revised 2026-11-13). This replaces the `.cloudroom/snippets/` folder used elsewhere in this spec: Cloudroom puts a `.gitignore` containing `*` in `.cloudroom/`, which would keep snippets out of Git. The plugin never edits `.cloudroom/.gitignore`.
6. **Default shortcut:** `Ctrl+Alt+S`.
7. **Typed `~name` trigger:** not built. Every insert stays visible in the composer.

## Spike results (2026-11-13, Cloudroom v152, host SDK 0.6.51)

These were tested live by Daniel in a scratch thread, plus a static read of the shipped `app.asar`.

| Call | Verdict | Evidence |
| --- | --- | --- |
| `+` menu rows (`composerPlusMenuItems`) | WORKS | All six spike rows were shown. |
| `composer.updateText` | WORKS | It appended `[UPD]`. |
| `composer.setText` | WORKS | It replaced the text with `SET-TEXT`. |
| `composer.insert` (cursor or end) | FAILS | Toast: `e.insert is not a function`. The host handle has no `insert`. |
| `experimental_openPopup` / `closePopup` | FAILS | In the host bundle it is a stub that returns `false`. Not clicked live. |
| `experimental_registerCommand` + `Ctrl+Alt+S` | FAILS | The command is registered, but pressing the keys did nothing and showed no toast. |
| `composer.selection` | FAILS | It is hard-coded to `null`, so the plugin cannot read the caret position. |

The 0.6.49 types in this repo list `insert` and the popup calls and omit `setText` and `updateText`. That is the reverse of what v152 actually ships, so trust the runtime, not the types.

**What the MVP builds on:**
- **Picker:** the picker lives in the plugin's own sidebar page (`navPanel`) and is opened from a `+` menu row. It does not use a host popup.
- **Insert:** `updateText` appends the filled snippet, as its own paragraph, at the end of the composer. Insert at the cursor waits for a host that ships `insert`.
- **Shortcut:** none in the MVP. Retry `experimental_registerCommand` on each new host version; the spike plugin source is kept in the spike worktree.
