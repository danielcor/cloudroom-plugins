// The page's data: the list for one project plus the global folder, and the
// write calls. Every write is followed by a re-read; there is no file watcher.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { ListResult, MoveOutcome, ProjectSummary, RemoveOutcome, SnippetsContract } from "../contract.js";
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

export interface SnippetsData {
  data: ListResult | null;
  error: string | null;
  loading: boolean;
  reload(): Promise<void>;
  create(scope: Scope, fields: SnippetFields, restore?: Pick<SnippetView, "id" | "order" | "created">): Promise<WriteOutcome>;
  save(s: SnippetView, fields: SnippetFields, expectedSha256?: string): Promise<WriteOutcome>;
  duplicate(s: SnippetView): Promise<WriteOutcome>;
  remove(s: SnippetView): Promise<RemoveOutcome>;
  move(s: SnippetView, toIndex: number): Promise<MoveOutcome>;
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

  useEffect(() => {
    void reload();
  }, [reload]);

  const after = useCallback(
    async <T>(p: Promise<T>): Promise<T> => {
      try {
        return await p;
      } finally {
        await reload();
      }
    },
    [reload],
  );

  return {
    data,
    error,
    loading,
    reload,
    create: (scope, fields, restore) =>
      after(
        rpc.call("create", {
          scope,
          projectId,
          ...fields,
          ...(restore ? { id: restore.id, ...(restore.order !== null ? { order: restore.order } : {}), ...(restore.created ? { created: restore.created } : {}) } : {}),
        }),
      ),
    save: (s, fields, expectedSha256) => after(rpc.call("save", { scope: s.scope, projectId, id: s.id, expectedSha256: expectedSha256 ?? s.sha256, ...fields })),
    duplicate: (s) => after(rpc.call("duplicate", { scope: s.scope, projectId, id: s.id })),
    remove: (s) => after(rpc.call("remove", { scope: s.scope, projectId, id: s.id, expectedSha256: s.sha256 })),
    move: (s, toIndex) => after(rpc.call("move", { scope: s.scope, projectId, id: s.id, toIndex })),
  };
}
