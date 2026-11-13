// The picker view: fuzzy search, a full preview, placeholder fields and an
// Insert button that appends the filled text to the target composer.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useBbNavigate, useComposers } from "@get-bb/plugin-sdk/app";
import { prepareInsert } from "../compose.js";
import { rank } from "../fuzzy.js";
import type { SnippetView } from "../model.js";
import { markInvisible } from "../secrets.js";
import { appendToComposer, bridge, useBridge, type ComposerTarget } from "./bridge.js";

export function targetLabel(target: ComposerTarget | null): string {
  if (!target) return "No composer picked. Open the picker from a thread's + menu → Insert snippet…";
  if (target.scope.kind === "new-thread") return "Inserts into the new-thread composer.";
  return "Inserts at the end of the thread's message box.";
}

export function Picker({ snippets, projectName }: { snippets: SnippetView[]; projectName: string | null }) {
  const navigate = useBbNavigate();
  const composers = useComposers();
  const { target } = useBridge();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirmSecret, setConfirmSecret] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fieldRefs = useRef<(HTMLInputElement | null)[]>([]);

  const visible = useMemo(() => snippets.filter((s) => !s.shadowed), [snippets]);
  const results = useMemo(() => rank(visible, query), [visible, query]);
  const current = results[Math.min(active, results.length - 1)] ?? null;

  useEffect(() => searchRef.current?.focus(), []);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    setValues({});
    setConfirmSecret(false);
    setStatus(null);
  }, [current?.scope, current?.id]);

  // A composer on screen (a split view) can be written directly; otherwise
  // queue the text for the target composer and go back to it.
  const onScreen = target ? composers.find((c) => c.key === target.key) : composers.length === 1 ? composers[0] : undefined;
  const canInsert = current !== null && (onScreen !== undefined || target !== null) && (current.secrets.length === 0 || confirmSecret);

  function insert(): void {
    if (!current || !canInsert) return;
    const text = prepareInsert(current.body, values);
    if (onScreen) {
      appendToComposer(onScreen, text);
      setStatus("Inserted. Nothing is sent until you press Enter.");
      return;
    }
    if (!target) return;
    bridge.queueInsert(target.key, text);
    goBack();
  }

  function goBack(): void {
    if (!target) return;
    const scope = target.scope;
    if (scope.kind === "new-thread") navigate.toCompose(scope.projectId ? { projectId: scope.projectId } : undefined);
    else navigate.toThread(scope.threadId);
  }

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if ((e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) && current) {
      if (current.placeholders.length > 0) {
        e.preventDefault();
        fieldRefs.current[0]?.focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        insert();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else goBack();
    }
  }

  function onFieldKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Enter") {
      e.preventDefault();
      insert();
    } else if (e.key === "Escape") {
      e.preventDefault();
      searchRef.current?.focus();
    }
  }

  return (
    <div className="snip-picker">
      <div className="snip-picker-list">
        <div className="snip-picker-search">
          <input
            ref={searchRef}
            aria-label="Search snippets"
            placeholder="Search title, tags, id, body…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
          <span className="snip-muted">
            {results.length} of {visible.length}
          </span>
        </div>
        <ul role="listbox" aria-label="Snippets">
          {results.map((s, i) => (
            <li
              key={`${s.scope}:${s.id}`}
              role="option"
              aria-selected={s === current}
              className={s === current ? "is-active" : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setActive(i)}
              onDoubleClick={() => {
                setActive(i);
                if (s.placeholders.length === 0) insert();
              }}
            >
              <div className="snip-picker-title">
                {s.title}
                {s.secrets.length > 0 && <span className="snip-warn"> ⚠ secret?</span>}
              </div>
              <div className="snip-picker-sub">{s.body.split("\n")[0]}</div>
              <div className="snip-picker-chips">
                {s.tags.map((t) => (
                  <span key={t} className="snip-chip">
                    {t}
                  </span>
                ))}
                <span className={`snip-scope snip-scope-${s.scope}`}>{s.scope === "project" ? projectName ?? "project" : "global"}</span>
              </div>
            </li>
          ))}
          {results.length === 0 && <li className="snip-muted snip-empty">No snippets match.</li>}
        </ul>
        <div className="snip-keys snip-muted">
          <kbd>↑</kbd>
          <kbd>↓</kbd> move · <kbd>Tab</kbd> fill placeholders · <kbd>Enter</kbd> insert · <kbd>Esc</kbd> back
        </div>
      </div>
      <div className="snip-picker-preview">
        {current ? (
          <>
            {/* Plain text only: bodies are never rendered as HTML or Markdown. */}
            <pre className="snip-body" aria-label="Snippet preview">
              {markInvisible(current.body)}
            </pre>
            {current.invisible > 0 && (
              <p className="snip-warn">{current.invisible} invisible or direction-changing character(s), shown as ⟦U+…⟧, are removed on insert.</p>
            )}
            {current.secrets.length > 0 && (
              <label className="snip-warn">
                <input type="checkbox" checked={confirmSecret} onChange={(e) => setConfirmSecret(e.target.checked)} /> This snippet looks like it holds a
                secret ({current.secrets.join("; ")}). Insert anyway.
              </label>
            )}
            {current.placeholders.length > 0 && (
              <div className="snip-fields">
                {current.placeholders.map((p, i) => (
                  <label key={p.name}>
                    <span>{p.name}</span>
                    <input
                      ref={(el) => {
                        fieldRefs.current[i] = el;
                      }}
                      value={values[p.name] ?? ""}
                      placeholder={p.default !== null ? `default: ${p.default}` : "left as {{" + p.name + "}} if empty"}
                      onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
                      onKeyDown={onFieldKey}
                    />
                  </label>
                ))}
              </div>
            )}
            <div className="snip-actions">
              <button type="button" className="snip-primary" disabled={!canInsert} onClick={insert}>
                Insert
              </button>
              <span className="snip-muted">{status ?? targetLabel(target)}</span>
            </div>
          </>
        ) : (
          <p className="snip-muted">Pick a snippet.</p>
        )}
      </div>
    </div>
  );
}
