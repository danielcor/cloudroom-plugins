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
- A delete never removes bytes. It checks the hash, then renames the file into `.trash/<id>~<time>-<random>.md` in the
  same folder. The rename is atomic on the host. It then compares the moved bytes with the hash it checked.
  If an edit landed in between, it writes those bytes back and reports a conflict. If a new file already holds
  that name, it names the trash file that has the edit. **Undo** writes the trashed bytes back exactly: unknown
  keys and comments survive, and the secret scan does not run on content that was already on disk. Both write
  with `expectedSha256: null`, so they never replace a file that appeared in the meantime. The host's
  move checks the destination and then renames, which could replace one. The trash copy stays. The table and
  `room-cli snip` never list `.trash/`. The random part keeps two deletes in the same millisecond from sharing
  a name. Before it moves anything, the plugin makes sure the last rule in `.trash/.gitignore` is a bare `*`.
  A later rule wins, and ` *` or `*<tab>` are different patterns to Git. It creates the file, or appends `*`,
  with a compare-and-swap write. If that write conflicts,
  nothing is deleted. Nothing empties the trash yet: delete old files there by hand.
- A move rewrites only the moved file's `order` key. The plugin renumbers the scope only when there is no gap left.

## Safety

- The plugin never submits. Insert only appends visible, editable text.
- **Secret scan.** It checks for:
  - private keys, AWS, GitHub, `sk-`, Slack and Google keys, JWTs and bearer tokens (in any case);
  - passwords in URLs (`postgres://user:pass@host`, also `https://:pass@host`), `Authorization: Basic …` that
    decodes (UTF-8 or Latin-1) to `user:password`, and `curl -u`/`-uuser:pass`/`--user user:pass`;
  - **any literal value assigned to a secret-named key or flag**, whatever it looks like. This is the strict
    rule (Daniel, 2026-11-13). It covers `API_TOKEN=…`, `DATABASE_PASSWORD: …`, `"apiKey": "…"`,
    `clientsecret: …`, `--api-key=…` and `--token …`. The same goes for secret-named HTTP headers, in
    `curl -H "X-API-Key: …"`, `--header 'X-Auth-Token: …'` or a bare `Private-Token: …` line. A bare `Name: value` line is the same text in
    YAML and HTTP. So a line counts as a header only when it is unindented, its name is unquoted and
    header-shaped (capitalized like `ApiKey` or `X-API-Key`, or lowercase with hyphens like `x-api-key`), and it
    does not open a YAML block. Then its value is header text, so `X-API-Key: true` blocks. An unindented
    hyphenated key such as `require-password: true` therefore counts as a header too. `apiKey: true`, indented
    keys and JSON (`{"X-API-Key": true}`) follow the YAML/JSON rules below. Guidance written as an assignment also blocks, for
    example `password: "choose a new one"`: reword it, or write a reference.

  A name is secret-named when its last word ends in token, secret, password, passwd, passphrase or
  credential(s), or is `key`, `pwd`, `auth`, `pat`, or a compound like `apikey` or `accesskey`. Names are split
  on `_`, `.`, `-`, camelCase and acronyms. So `--password-file` and `--token-count` are not secret-named.

  After `=` or a flag, the value is the whole shell word, so `""hunter2`, `"$PASSWORD"hunter2` and `"   "` are
  literal. Single-quoted text and backslash-escaped characters are always literal, because the shell does not
  expand them: `'$PASSWORD'`, `'$(echo x)'` and `"\$x"` all count. In plain or double-quoted text, these add
  nothing:
  - references: `$VAR`, `${VAR}`, `%VAR%`, `{{placeholder}}`, `${{ secrets.X }}`;
  - a whole `$(cmd)` or backtick command (`"$(echo)hunter2"` is literal);
  - the empty string.

  An unquoted `;&|<>)` ends a shell word (`$VAR; echo`). A shell default `${VAR:-text}` counts as `text`. After
  a spaced flag, a following option or shell operator (`--with-token < file`) is not its value.

  After `:` (YAML or JSON), the value is a scalar. `key: value` counts only where a key can start: at line
  start, after one or more `- `, or after `{`, `,` or `[`. So prose like "the password: it must be long"
  stays clean.
  - At line start the scalar runs to the end of the line, without a ` # comment`. A quoted scalar may be
    followed by `,`, as in a multi-line JSON object. A plain scalar keeps its comma, so
    `password: true hunter2` and `password: $PASSWORD,` are literal.
  - A key with no value on its own line takes the scalar on the next line that is not blank or a `#` comment (`"password":` then
    `"…"`, or a YAML `password:` with the value indented below). A nested mapping or list is not a value.
  - Inside `{…}` it ends at `,` `}` or `]`. So `{"password":"$PASSWORD"}` and `{"password":""}` stay clean.
  - An unquoted `true`, `false` or `null` adds nothing; `password: "null"` and `PASSWORD=true` are literal.
  - `$(cmd)` is literal there, because YAML does not run it.
  - URL and curl passwords get no command exemption. curl keeps the quoting rules above, and an escaped `\:`
    separates user and password too.

  A YAML/JSON parse adds coverage (Daniel, 2026-11-14; the `yaml` package). The parse covers the whole body,
  each fenced code block and each indented block. JSON is a YAML subset, so every map in them counts, including
  anchors and aliases, several documents, flow maps and values on a later line. A secret-named key whose value is
  a scalar falls under the same rule. An unquoted `null` or boolean is not literal, and a block scalar is checked
  without its final newline. Findings carry the body line of the value. The parse only adds findings: the line
  scanner above still runs over everything, including text that does not parse and the shell, header, URL and
  curl rules.

  Values are taken whole, quoted or not, punctuation included. So are values continued onto the next line with a
  shell `\`, and YAML `key: |` or `>` blocks. The body is also scanned with placeholder defaults filled in, so
  `--token {{token|…}}` counts. Findings give the line the value is on.

  On save, a hit blocks the save. The message names the kind and the line, never the value, and says to use
  `$PASSWORD` or `{{password}}` instead of a literal value. On load, a hit shows a warning badge, and the
  picker then needs a confirmation before it inserts. `room-cli snip show` refuses to print the snippet, and
  `room-cli snip list` shows only its id. The scan runs with invisible characters removed, so a token split by
  a zero-width space still counts.
- **Invisible characters.** Zero-width, bidi (including U+061C ARABIC LETTER MARK) and Unicode tag characters
  are stripped on save and on insert.
  The preview shows them as `⟦U+XXXX⟧`.
- Bodies are always rendered as plain text, never as HTML or Markdown.

## Dependencies

- `@get-bb/plugin-sdk` 0.6.49.
- `yaml` 2.9.1, pinned exactly (eemeli/yaml, no dependencies of its own). It is used only by the server-side
  secret scan (`src/find-secrets.ts`). The app bundle does not include it: the app imports only React and
  `@get-bb/plugin-sdk/app`.

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
