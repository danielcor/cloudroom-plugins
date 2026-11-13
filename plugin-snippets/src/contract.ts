// The RPC contract shared by server.ts and the app. Inputs are validated by
// the host before a handler runs; handlers re-check ids and paths themselves.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { ID_PATTERN, LIMITS, type SnippetView } from "./model.js";
import { v } from "./schema.js";
import type { WriteOutcome } from "./store.js";

const scope = v.literal("global", "project");
const projectId = v.nullable(v.string({ max: 200 }));
const id = v.string({ pattern: ID_PATTERN });
const sha = v.string({ max: 128 });
const fields = {
  title: v.string({ max: 400 }),
  tags: v.array(v.string({ max: 200 }), 32),
  body: v.string({ max: LIMITS.bodyBytesMax * 2 }),
};
const target = { scope, projectId };

export interface ScopeInfo {
  dir: string;
  /** Set when the folder could not be read; the snippets list then lacks this scope. */
  error: string | null;
}

export interface ListResult {
  global: ScopeInfo;
  project: (ScopeInfo & { id: string; name: string }) | null;
  snippets: SnippetView[];
}

export interface ProjectSummary {
  id: string;
  name: string;
}

export type RemoveOutcome = { outcome: "removed" } | Extract<WriteOutcome, { outcome: "conflict" }>;
export type MoveOutcome = { outcome: "moved"; writes: number } | Extract<WriteOutcome, { outcome: "conflict" }>;

export const contract = defineRpcContract({
  projects: { input: v.object({}), output: v.json<ProjectSummary[]>() },
  threadProject: { input: v.object({ threadId: v.string({ max: 200 }) }), output: v.json<{ projectId: string | null }>() },
  list: { input: v.object({ projectId }), output: v.json<ListResult>() },
  create: {
    input: v.object({
      ...target,
      ...fields,
      // Set only by Undo after a delete, which restores the same file name, order and created time.
      id: v.optional(id),
      order: v.optional(v.int({ min: -1_000_000_000, max: 1_000_000_000 })),
      created: v.optional(v.string({ max: 40 })),
    }),
    output: v.json<WriteOutcome>(),
  },
  save: { input: v.object({ ...target, id, expectedSha256: sha, ...fields }), output: v.json<WriteOutcome>() },
  duplicate: { input: v.object({ ...target, id }), output: v.json<WriteOutcome>() },
  remove: { input: v.object({ ...target, id, expectedSha256: sha }), output: v.json<RemoveOutcome>() },
  move: { input: v.object({ ...target, id, toIndex: v.int({ min: 0, max: LIMITS.perScope }) }), output: v.json<MoveOutcome>() },
});

export type SnippetsContract = typeof contract;
