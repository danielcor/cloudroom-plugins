import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const reviewModeSchema = z.enum(["triad", "sol-loop", "single"]);
export const reviewEffortSchema = z.enum(["low", "medium", "high", "max"]);
export const autoStewardSchema = z.enum(["manual", "auto"]);
export const approvalsModeSchema = z.enum(["off", "observe", "enforce"]);

export type ReviewMode = z.infer<typeof reviewModeSchema>;
export type ReviewEffort = z.infer<typeof reviewEffortSchema>;
export type AutoStewardMode = z.infer<typeof autoStewardSchema>;
export type ApprovalsMode = z.infer<typeof approvalsModeSchema>;

export const repoSlugSchema = z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u, "Must be owner/repo");

export const remoteEntrySchema = z
  .object({
    name: z.string(),
    url: z.string(),
    kind: z.enum(["fetch", "push"]),
  })
  .strict();

export const inspectCheckoutOutputSchema = z
  .object({
    root: z.string(),
    gitDir: z.string(),
    commonDir: z.string(),
    headSha: z.string().nullable(),
    branch: z.string().nullable(),
    isDetached: z.boolean(),
    isClean: z.boolean(),
    inProgressOp: z.string().nullable(),
    remotes: z.array(remoteEntrySchema),
    changedFiles: z.array(z.string()),
    hardLinks: z.array(z.string()),
    submodules: z.array(z.string()),
    gitDirLinkIssue: z.string().nullable(),
  })
  .strict();

export type CheckoutInspection = z.infer<typeof inspectCheckoutOutputSchema>;

export const hostContract = defineRpcContract({
  inspectCheckout: {
    experimental_retryable: true,
    input: z.object({ root: z.string().min(1).max(4096) }).strict(),
    output: inspectCheckoutOutputSchema,
  },
  computePins: {
    experimental_retryable: true,
    input: z.object({ root: z.string().min(1).max(4096) }).strict(),
    output: z
      .object({
        ok: z.boolean(),
        pins: z.record(z.string(), z.string()),
        error: z.string().nullable(),
      })
      .strict(),
  },
  verifyPins: {
    experimental_retryable: true,
    input: z
      .object({
        root: z.string().min(1).max(4096),
        expectedPins: z.record(z.string(), z.string()),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        driftedKey: z.string().nullable(),
        reason: z.string().nullable(),
      })
      .strict(),
  },
  checkMergeSafe: {
    experimental_retryable: true,
    input: z
      .object({
        root: z.string().min(1).max(4096),
        targetRef: z.string().min(1).max(512),
        mode: z.enum(["base", "head"]),
        expectedTipSha: z.string().regex(/^[0-9a-f]{40}$/u).optional(),
      })
      .strict(),
    output: z
      .object({
        safe: z.boolean(),
        alreadyMerged: z.boolean(),
        reason: z.string().nullable(),
        blockedPaths: z.array(z.string()),
        noticePaths: z.array(z.string()),
        touchedPaths: z.array(z.string()),
      })
      .strict(),
  },
  scanOutboundForLocalSecrets: {
    experimental_retryable: true,
    input: z
      .object({
        root: z.string().min(1).max(4096),
        text: z.string().max(100_000),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        matchedSource: z.string().nullable(),
      })
      .strict(),
  },
});

export type ShipHostContract = typeof hostContract;

export const repoConfigSchema = z
  .object({
    repo: repoSlugSchema,
    enabled: z.boolean(),
    reviewMode: reviewModeSchema,
    reviewEffort: reviewEffortSchema,
    autoSteward: autoStewardSchema,
    approvalsMode: approvalsModeSchema,
    allowDevAutomerge: z.boolean(),
    trustedBots: z.array(z.string()),
    maxPushesPerCause: z.number().int().min(1).max(20),
    maxReviewRounds: z.number().int().min(1).max(10),
    updatedAt: z.number().int(),
  })
  .strict();

export type RepoConfig = z.infer<typeof repoConfigSchema>;

export const repoUpsertInputSchema = z
  .object({
    repo: repoSlugSchema,
    enabled: z.boolean().optional(),
    reviewMode: reviewModeSchema.optional(),
    reviewEffort: reviewEffortSchema.optional(),
    autoSteward: autoStewardSchema.optional(),
    approvalsMode: approvalsModeSchema.optional(),
    allowDevAutomerge: z.boolean().optional(),
    trustedBots: z.array(z.string().min(1).max(80)).max(32).optional(),
    maxPushesPerCause: z.number().int().min(1).max(20).optional(),
    maxReviewRounds: z.number().int().min(1).max(10).optional(),
  })
  .strict();

export const watchRecordSchema = z
  .object({
    id: z.string(),
    projectId: z.string().nullable(),
    hostId: z.string(),
    worktreePath: z.string(),
    repo: z.string(),
    prNumber: z.number().int(),
    headBranch: z.string(),
    headRemote: z.string(),
    baseBranch: z.string(),
    baseRemote: z.string(),
    authorLogin: z.string(),
    state: z.string(),
    lastHeadSha: z.string().nullable(),
    startedAt: z.number().int(),
    expiresAt: z.number().int(),
    lastWokeAt: z.number().int().nullable(),
    workerThreadId: z.string().nullable(),
    stopReason: z.string().nullable(),
  })
  .strict();

export type WatchRecord = z.infer<typeof watchRecordSchema>;

export const auditEntrySchema = z
  .object({
    id: z.number().int(),
    watchId: z.string().nullable(),
    ts: z.number().int(),
    actor: z.string(),
    action: z.string(),
    outcome: z.string(),
    detailJson: z.string(),
  })
  .strict();

export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const shipStatusSchema = z
  .object({
    pluginVersion: z.string(),
    botConfigured: z.boolean(),
    botLogin: z.string(),
    defaultReviewMode: reviewModeSchema,
    defaultReviewEffort: reviewEffortSchema,
    pollIntervalSeconds: z.number().int(),
    watchMaxDays: z.number().int(),
    defaultMaxPushesPerCause: z.number().int(),
    repoCount: z.number().int(),
    activeWatchCount: z.number().int(),
  })
  .strict();

export type ShipStatus = z.infer<typeof shipStatusSchema>;

export const rpcContract = defineRpcContract({
  status: {
    input: z.object({}).strict(),
    output: shipStatusSchema,
  },
  listRepos: {
    input: z.object({}).strict(),
    output: z.array(repoConfigSchema),
  },
  upsertRepo: {
    input: repoUpsertInputSchema,
    output: repoConfigSchema,
  },
  listWatches: {
    input: z
      .object({
        state: z.string().max(40).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
    output: z.array(watchRecordSchema),
  },
  listAudit: {
    input: z
      .object({
        watchId: z.string().max(120).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
    output: z.array(auditEntrySchema),
  },
});

export type ShipRpcContract = typeof rpcContract;
