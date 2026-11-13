// The "Snippets" sidebar page: the table with its editor pane, and the picker.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useBbContext, useBbNavigate, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { SnippetsContract } from "../contract.js";
import { rank } from "../fuzzy.js";
import { parseTags, type Scope, type SnippetFields, type SnippetView } from "../model.js";
import { parsePlaceholders } from "../placeholders.js";
import { markInvisible } from "../secrets.js";
import type { WriteOutcome } from "../store.js";
import { useBridge } from "./bridge.js";
import { useProjects, useSnippets, type SnippetsData } from "./data.js";
import { Picker } from "./Picker.js";

type ScopeFilter = "all" | Scope;
const keyOf = (s: Pick<SnippetView, "scope" | "id">) => `${s.scope}:${s.id}`;

export function SnippetsPage({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const context = useBbContext();
  const rpc = useRpc<SnippetsContract>();
  const { target } = useBridge();
  const projects = useProjects();
  const [projectId, setProjectId] = useState<string | null>(context.projectId);

  // Follow the composer that opened the picker: its thread's project.
  useEffect(() => {
    if (!target) return;
    if (target.scope.kind === "new-thread") {
      if (target.scope.projectId) setProjectId(target.scope.projectId);
      return;
    }
    let live = true;
    rpc.call("threadProject", { threadId: target.scope.threadId }).then(
      (r) => live && r.projectId && setProjectId(r.projectId),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [target, rpc]);

  useEffect(() => {
    if (projectId === null && projects.length === 1) setProjectId(projects[0]!.id);
  }, [projectId, projects]);

  const snippets = useSnippets(projectId);
  const view = subPath.startsWith("pick") ? "picker" : "table";
  const projectName = snippets.data?.project?.name ?? projects.find((p) => p.id === projectId)?.name ?? null;
  const all = snippets.data?.snippets ?? [];
  const errors = [
    snippets.error,
    snippets.data?.global.error && `Global folder: ${snippets.data.global.error}`,
    snippets.data?.project?.error && `Project folder: ${snippets.data.project.error}`,
  ].filter(Boolean) as string[];

  return (
    <div className="snip-page">
      <header className="snip-header">
        <h1>Snippets</h1>
        <span className="snip-muted">
          {all.length} snippets · {all.filter((s) => s.scope === "global").length} global
          {projectName ? ` · ${all.filter((s) => s.scope === "project").length} in ${projectName}` : ""}
        </span>
        <div className="snip-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={view === "table"} onClick={() => navigate.toPluginPanel("snippets", { subPath: "" })}>
            Table
          </button>
          <button type="button" role="tab" aria-selected={view === "picker"} onClick={() => navigate.toPluginPanel("snippets", { subPath: "pick" })}>
            Picker
          </button>
        </div>
        <label className="snip-project">
          <span className="snip-muted">Project</span>
          <select value={projectId ?? ""} onChange={(e) => setProjectId(e.target.value || null)}>
            <option value="">(global only)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </header>
      {errors.map((e) => (
        <p key={e} className="snip-error" role="alert">
          {e}
        </p>
      ))}
      {view === "picker" ? (
        <Picker snippets={all} projectName={projectName} />
      ) : (
        <Table snippets={snippets} all={all} projectName={projectName} hasProject={projectId !== null} />
      )}
    </div>
  );
}

function Table({ snippets, all, projectName, hasProject }: { snippets: SnippetsData; all: SnippetView[]; projectName: string | null; hasProject: boolean }) {
  const [filter, setFilter] = useState("");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [tag, setTag] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ key: string; field: "title" | "tags"; value: string } | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const [focusTitle, setFocusTitle] = useState(0);
  const dragKey = useRef<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const tags = useMemo(() => [...new Set(all.flatMap((s) => s.tags))].sort(), [all]);
  const rows = useMemo(() => {
    const scoped = all.filter((s) => (scopeFilter === "all" || s.scope === scopeFilter) && (!tag || s.tags.includes(tag)));
    return rank(scoped, filter);
  }, [all, scopeFilter, tag, filter]);
  const current = all.find((s) => keyOf(s) === selected) ?? null;
  const inScope = (s: SnippetView) => all.filter((x) => x.scope === s.scope);

  function report(r: WriteOutcome | { outcome: "removed" } | { outcome: "moved" }, ok?: string): boolean {
    if (r.outcome === "blocked") setToast({ text: r.reasons.join(" ") });
    else if (r.outcome === "conflict") setToast({ text: `${r.message} Reloaded from disk.` });
    else {
      const note = "note" in r && r.note ? ` ${r.note}` : "";
      if (ok || note) setToast({ text: `${ok ?? ""}${note}`.trim() });
      return true;
    }
    return false;
  }

  async function add(): Promise<void> {
    const scope: Scope = scopeFilter === "project" || (scopeFilter === "all" && hasProject) ? "project" : "global";
    if (scope === "project" && !hasProject) return;
    const r = await snippets.create(scope, { title: "New snippet", tags: tag ? [tag] : [], body: "" });
    if (report(r) && r.outcome === "saved") {
      setSelected(keyOf(r.snippet));
      setFocusTitle((n) => n + 1);
    }
  }

  async function duplicate(s: SnippetView): Promise<void> {
    const r = await snippets.duplicate(s);
    if (report(r) && r.outcome === "saved") setSelected(keyOf(r.snippet));
  }

  async function remove(s: SnippetView): Promise<void> {
    const r = await snippets.remove(s);
    if (r.outcome !== "removed") return void report(r);
    if (selected === keyOf(s)) setSelected(null);
    setToast({
      text: `Deleted “${s.title}”.`,
      undo: () => {
        setToast(null);
        void snippets.create(s.scope, { title: s.title, tags: s.tags, body: s.body }, s).then((u) => report(u, "Restored."));
      },
    });
  }

  async function moveBy(s: SnippetView, delta: number): Promise<void> {
    const list = inScope(s);
    const to = list.findIndex((x) => x.id === s.id) + delta;
    if (to < 0 || to >= list.length) return;
    report(await snippets.move(s, to));
  }

  async function commitInline(s: SnippetView): Promise<void> {
    if (!editing) return;
    const fields: SnippetFields = { title: s.title, tags: s.tags, body: s.body };
    if (editing.field === "title") fields.title = editing.value;
    else fields.tags = parseTags(editing.value);
    setEditing(null);
    report(await snippets.save(s, fields));
  }

  function onRowKey(e: KeyboardEvent<HTMLTableRowElement>, s: SnippetView, index: number): void {
    if (editing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      void moveBy(s, e.key === "ArrowUp" ? -1 : 1);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const next = rows[index + (e.key === "ArrowUp" ? -1 : 1)];
      if (next) {
        setSelected(keyOf(next));
        (e.currentTarget.parentElement?.children[index + (e.key === "ArrowUp" ? -1 : 1)] as HTMLElement | undefined)?.focus();
      }
    } else if (mod && e.key.toLowerCase() === "d") {
      e.preventDefault();
      void duplicate(s);
    } else if (e.key === "Delete" || (e.key === "Backspace" && mod)) {
      e.preventDefault();
      void remove(s);
    }
  }

  return (
    <div className="snip-main">
      <div className="snip-table-pane">
        <div className="snip-toolbar">
          <input aria-label="Filter snippets" placeholder="Filter snippets…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="snip-seg" role="group" aria-label="Scope">
            {(["all", "global", ...(hasProject ? ["project"] : [])] as ScopeFilter[]).map((f) => (
              <button key={f} type="button" aria-pressed={scopeFilter === f} onClick={() => setScopeFilter(f)}>
                {f === "all" ? "All" : f === "global" ? "Global" : projectName ?? "Project"}
              </button>
            ))}
          </div>
          {tags.map((t) => (
            <button key={t} type="button" className="snip-chip" aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>
              {t}
            </button>
          ))}
          <button type="button" className="snip-primary snip-push" onClick={() => void add()} disabled={snippets.loading && !snippets.data}>
            + New snippet
          </button>
        </div>
        <table className="snip-table">
          <thead>
            <tr>
              <th aria-label="Drag to reorder" />
              <th>Title</th>
              <th>Tags</th>
              <th>Scope</th>
              <th>Body</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((s, index) => {
              const k = keyOf(s);
              const isEditing = (field: "title" | "tags") => editing?.key === k && editing.field === field;
              const inlineInput = (
                <input
                  autoFocus
                  aria-label={editing?.field === "title" ? "Title" : "Tags"}
                  value={editing?.value ?? ""}
                  onChange={(e) => setEditing((ed) => ed && { ...ed, value: e.target.value })}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") void commitInline(s);
                    if (e.key === "Escape") setEditing(null);
                  }}
                  onBlur={() => setEditing(null)}
                />
              );
              return (
                <tr
                  key={k}
                  tabIndex={0}
                  aria-selected={selected === k}
                  className={selected === k ? "is-selected" : undefined}
                  onClick={() => setSelected(k)}
                  onKeyDown={(e) => onRowKey(e, s, index)}
                  onDragOver={(e) => {
                    if (dragKey.current?.startsWith(`${s.scope}:`)) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = all.find((x) => keyOf(x) === dragKey.current);
                    dragKey.current = null;
                    if (!from || from.scope !== s.scope || from.id === s.id) return;
                    void snippets.move(from, inScope(s).findIndex((x) => x.id === s.id)).then((r) => report(r));
                  }}
                >
                  <td
                    className="snip-handle"
                    draggable
                    title="Drag, or Alt+↑ / Alt+↓, to reorder"
                    onDragStart={(e) => {
                      dragKey.current = k;
                      e.dataTransfer.effectAllowed = "move";
                    }}
                  >
                    ⠿
                  </td>
                  <td onClick={() => setEditing({ key: k, field: "title", value: s.title })}>
                    {isEditing("title") ? (
                      inlineInput
                    ) : (
                      <>
                        {s.title}
                        {s.secrets.length > 0 && <span className="snip-warn" title={s.secrets.join("; ")}> ⚠ secret?</span>}
                        {s.invisible > 0 && <span className="snip-warn" title="Holds invisible characters"> ⚠ hidden chars</span>}
                        {s.shadowed && <span className="snip-muted" title="A project snippet with the same id is used instead"> (hidden by project)</span>}
                      </>
                    )}
                  </td>
                  <td onClick={() => setEditing({ key: k, field: "tags", value: s.tags.join(", ") })}>
                    {isEditing("tags")
                      ? inlineInput
                      : s.tags.map((t) => (
                          <span key={t} className="snip-chip">
                            {t}
                          </span>
                        ))}
                  </td>
                  <td>
                    <span className={`snip-scope snip-scope-${s.scope}`}>{s.scope === "project" ? projectName ?? "project" : "global"}</span>
                  </td>
                  <td className="snip-preview">{s.body.split("\n")[0]}</td>
                  <td className="snip-row-actions">
                    <button type="button" title="Duplicate (Ctrl+D)" aria-label={`Duplicate ${s.title}`} onClick={(e) => (e.stopPropagation(), void duplicate(s))}>
                      ⧉
                    </button>
                    <button type="button" title="Delete (Del)" aria-label={`Delete ${s.title}`} onClick={(e) => (e.stopPropagation(), void remove(s))}>
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && !snippets.loading && <p className="snip-muted snip-empty">No snippets yet. “+ New snippet” adds one.</p>}
        <p className="snip-muted snip-keys">
          Click a title or tags to edit in place · drag <span aria-hidden>⠿</span> or <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> to reorder · <kbd>Ctrl</kbd>+<kbd>D</kbd>{" "}
          duplicate · <kbd>Del</kbd> delete, with undo
        </p>
        {toast && (
          <div className="snip-toast" role="status">
            {toast.text}
            {toast.undo && (
              <button type="button" onClick={toast.undo}>
                Undo
              </button>
            )}
          </div>
        )}
      </div>
      {current && (
        <Editor
          key={keyOf(current)}
          snippet={current}
          projectName={projectName}
          focusTitle={focusTitle}
          save={snippets.save}
          onDuplicate={() => void duplicate(current)}
          onDelete={() => void remove(current)}
        />
      )}
    </div>
  );
}

type EditorStatus = { kind: "idle" | "saving" | "saved" } | { kind: "blocked"; reasons: string[] } | { kind: "conflict"; message: string; current: SnippetView | null };

function Editor({
  snippet,
  projectName,
  focusTitle,
  save,
  onDuplicate,
  onDelete,
}: {
  snippet: SnippetView;
  projectName: string | null;
  focusTitle: number;
  save: SnippetsData["save"];
  onDuplicate(): void;
  onDelete(): void;
}) {
  const fromView = (s: SnippetView) => ({ title: s.title, tags: s.tags.join(", "), body: s.body });
  const [draft, setDraft] = useState(() => fromView(snippet));
  const [saved, setSaved] = useState(() => fromView(snippet));
  const [baseSha, setBaseSha] = useState(snippet.sha256);
  const [status, setStatus] = useState<EditorStatus>({ kind: "idle" });
  const titleRef = useRef<HTMLInputElement>(null);
  const dirty = draft.title !== saved.title || draft.tags !== saved.tags || draft.body !== saved.body;

  useEffect(() => {
    if (focusTitle) titleRef.current?.select();
  }, [focusTitle]);

  // A change made elsewhere (inline edit, reorder, a hand edit on disk) is
  // adopted while nothing here is unsaved; otherwise the next save reports a conflict.
  useEffect(() => {
    if (snippet.sha256 === baseSha) return;
    if (!dirty) {
      setDraft(fromView(snippet));
      setSaved(fromView(snippet));
      setBaseSha(snippet.sha256);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snippet.sha256]);

  async function commit(expectedSha256 = baseSha): Promise<void> {
    if (!dirty && expectedSha256 === baseSha) return;
    const fields = { title: draft.title, tags: parseTags(draft.tags), body: draft.body };
    setStatus({ kind: "saving" });
    const r = await save(snippet, fields, expectedSha256);
    if (r.outcome === "saved") {
      const next = { ...draft };
      setSaved(next);
      setBaseSha(r.snippet.sha256);
      setStatus({ kind: "saved" });
    } else if (r.outcome === "blocked") setStatus({ kind: "blocked", reasons: r.reasons });
    else setStatus({ kind: "conflict", message: r.message, current: r.current });
  }

  // Save after a short pause in typing, and on blur.
  useEffect(() => {
    if (!dirty || status.kind === "conflict" || status.kind === "blocked") return;
    const t = setTimeout(() => void commit(), 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const edit = (patch: Partial<typeof draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    if (status.kind === "blocked") setStatus({ kind: "idle" });
  };
  const placeholders = parsePlaceholders(draft.body);

  return (
    <aside className="snip-editor" aria-label="Snippet editor" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && void commit()}>
      <label>
        <span>Title</span>
        <input ref={titleRef} value={draft.title} maxLength={80} onChange={(e) => edit({ title: e.target.value })} />
      </label>
      <div className="snip-row2">
        <label>
          <span>Scope</span>
          <input value={snippet.scope === "project" ? projectName ?? "project" : "global"} readOnly />
        </label>
        <label>
          <span>Tags</span>
          <input value={draft.tags} placeholder="review, git" onChange={(e) => edit({ tags: e.target.value })} />
        </label>
      </div>
      <label>
        <span>Body</span>
        <textarea value={draft.body} rows={14} spellCheck={false} onChange={(e) => edit({ body: e.target.value })} />
      </label>
      {snippet.invisible > 0 && <pre className="snip-body snip-warn">{markInvisible(snippet.body)}</pre>}
      {placeholders.length > 0 && (
        <div className="snip-found">
          <span className="snip-label">Placeholders found</span>
          {placeholders.map((p) => (
            <div key={p.name}>
              <code>{p.name}</code> <span className="snip-muted">{p.default !== null ? `default: ${p.default}` : "asked at insert"}</span>
            </div>
          ))}
        </div>
      )}
      <EditorStatusLine status={status} dirty={dirty} secrets={snippet.secrets} onOverwrite={(sha) => void commit(sha)} onDiscard={(s) => {
        const v = s ? fromView(s) : fromView(snippet);
        setDraft(v);
        setSaved(v);
        if (s) setBaseSha(s.sha256);
        setStatus({ kind: "idle" });
      }} />
      <div className="snip-actions">
        <button type="button" onClick={onDuplicate}>
          Duplicate
        </button>
        <button type="button" className="snip-danger" onClick={onDelete}>
          Delete
        </button>
      </div>
      <code className="snip-path">{snippet.path}</code>
    </aside>
  );
}

function EditorStatusLine({
  status,
  dirty,
  secrets,
  onOverwrite,
  onDiscard,
}: {
  status: EditorStatus;
  dirty: boolean;
  secrets: string[];
  onOverwrite(sha: string): void;
  onDiscard(current: SnippetView | null): void;
}) {
  if (status.kind === "blocked") {
    return (
      <p className="snip-error" role="alert">
        Not saved: {status.reasons.join(" ")}
      </p>
    );
  }
  if (status.kind === "conflict") {
    return (
      <div className="snip-error" role="alert">
        {status.message} Your text is kept here.{" "}
        {status.current && (
          <button type="button" onClick={() => onOverwrite(status.current!.sha256)}>
            Overwrite with mine
          </button>
        )}{" "}
        <button type="button" onClick={() => onDiscard(status.current)}>
          Discard mine
        </button>
      </div>
    );
  }
  if (secrets.length) return <p className="snip-warn">⚠ The file on disk looks like it holds a secret: {secrets.join("; ")}. Remove it before saving.</p>;
  return <p className="snip-muted">{status.kind === "saving" ? "Saving…" : dirty ? "Unsaved changes" : status.kind === "saved" ? "✓ Saved · no secrets found" : "No secrets found"}</p>;
}
