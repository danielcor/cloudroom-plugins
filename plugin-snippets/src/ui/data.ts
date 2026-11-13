// The page's data: the list for one project plus the global folder, and the
// write calls. Every write is followed by a re-read; there is no file watcher.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { ListResult, MoveOutcome, ProjectSummary, RemoveOutcome, RestoreOutcome, SnippetsContract } from "../contract.js";
import type { Scope, SnippetFields, SnippetView } from "../model.js";
import type { WriteOutcome } from "../store.js";

export function useProjects(): ProjectSummary[] {
  const rpc = useRpc<SnippetsContract>();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  useEffect(() => {
    let live = true;
    rpc.call("projects", {}).then((p) => live && setProjects(p), () => undefined);
    return () => {
      live = false;
    };
  }, [rpc]);
  return projects;
}

/** A write the server rejected outright (an RPC or host error), so the page can show it. */
export type Failed = { outcome: "failed"; message: string };

export interface SnippetsData {
  data: ListResult | null;
  error: string | null;
  loading: boolean;
  reload(): Promise<void>;
  create(scope: Scope, fields: SnippetFields): Promise<WriteOutcome | Failed>;
  save(s: SnippetView, fields: SnippetFields, expectedSha256?: string): Promise<WriteOutcome | Failed>;
  duplicate(s: SnippetView): Promise<WriteOutcome | Failed>;
  remove(s: SnippetView): Promise<RemoveOutcome | Failed>;
  restore(s: SnippetView, trash: string): Promise<RestoreOutcome | Failed>;
  move(s: SnippetView, toIndex: number): Promise<MoveOutcome | Failed>;
}

export function useSnippets(projectId: string | null): SnippetsData {
  const rpc = useRpc<SnippetsContract>();
  const [data, setData] = useState<ListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const next = await rpc.call("list", { projectId });
      if (mine === seq.current) {
        setData(next);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [rpc, projectId]);

  // A project switch drops the old rows at once, so nothing stale can be acted on.
  useEffect(() => {
    setData(null);
    void reload();
  }, [reload]);

  // Every write resolves: a rejected call becomes a `failed` outcome the caller must show.
  const after = useCallback(
    async <T>(p: Promise<T>): Promise<T | Failed> => {
      try {
        return await p;
      } catch (e) {
        return { outcome: "failed", message: e instanceof Error ? e.message : String(e) };
      } finally {
        await reload();
      }
    },
    [reload],
  );

  // Writes go to the project whose rows are on screen, never to a newly picked one still loading.
  const loaded = data?.project?.id ?? null;
  return {
    data,
    error,
    loading,
    reload,
    create: (scope, fields) => after(rpc.call("create", { scope, projectId: loaded, ...fields })),
    save: (s, fields, expectedSha256) => after(rpc.call("save", { scope: s.scope, projectId: loaded, id: s.id, expectedSha256: expectedSha256 ?? s.sha256, ...fields })),
    duplicate: (s) => after(rpc.call("duplicate", { scope: s.scope, projectId: loaded, id: s.id })),
    remove: (s) => after(rpc.call("remove", { scope: s.scope, projectId: loaded, id: s.id, expectedSha256: s.sha256 })),
    restore: (s, trash) => after(rpc.call("restore", { scope: s.scope, projectId: loaded, id: s.id, trash })),
    move: (s, toIndex) => after(rpc.call("move", { scope: s.scope, projectId: loaded, id: s.id, toIndex })),
  };
}
