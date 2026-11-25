import { defineRpcContract, type ExperimentalHostClient } from "@get-bb/plugin-sdk";
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

export const repoMetaSchema = z
  .object({
    slug: repoSlugSchema,
    owner: z.string(),
    name: z.string(),
    defaultBranch: z.string(),
    isPrivate: z.boolean(),
    isFork: z.boolean(),
    parentSlug: z.string().nullable(),
    viewerLogin: z.string(),
    viewerPermission: z.string(),
  })
  .strict();

export const pullRequestSummarySchema = z
  .object({
    number: z.number().int(),
    url: z.string(),
    title: z.string(),
    state: z.string(),
    isDraft: z.boolean(),
    headRefName: z.string(),
    headRefOid: z.string(),
    baseRefName: z.string(),
    baseRefOid: z.string(),
    authorLogin: z.string(),
    labels: z.array(z.string()),
    mergeStateStatus: z.string(),
    isCrossRepository: z.boolean(),
  })
  .strict();

export const inspectPublishContextOutputSchema = z
  .object({
    inspection: inspectCheckoutOutputSchema,
    remoteName: z.string(),
    remoteUrl: z.string(),
    repoMeta: repoMetaSchema.nullable(),
    existingPr: pullRequestSummarySchema.nullable(),
    aheadCount: z.number().int(),
    commitSubjects: z.array(z.string()),
    diffText: z.string(),
    diffSecretFinding: z.object({ kind: z.string(), line: z.number().int() }).strict().nullable(),
    localSecretMatchSource: z.string().nullable(),
  })
  .strict();

export type InspectPublishContextOutput = z.infer<typeof inspectPublishContextOutputSchema>;

export const publishChangesInputSchema = z
  .object({
    root: z.string().min(1).max(4096),
    remote: z.string().min(1).max(120),
    repoSlug: repoSlugSchema,
    targetBranch: z.string().min(1).max(200),
    createBranch: z.boolean(),
    baseBranch: z.string().min(1).max(200),
    filesToStage: z.array(z.string().min(1).max(1024)),
    commitMessage: z.string().max(8000),
    prTitle: z.string().min(1).max(500),
    prBody: z.string().min(1).max(20_000),
    draft: z.boolean(),
    createPr: z.boolean(),
    expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/u),
  })
  .strict();

export const publishChangesOutputSchema = z
  .object({
    ok: z.boolean(),
    branch: z.string(),
    headSha: z.string().nullable(),
    committed: z.boolean(),
    pushed: z.boolean(),
    prNumber: z.number().int().nullable(),
    prUrl: z.string().nullable(),
    prCreated: z.boolean(),
    error: z.string().nullable(),
  })
  .strict();

export type PublishChangesOutput = z.infer<typeof publishChangesOutputSchema>;

export const trustedPrCommentSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["issue_comment", "review", "review_comment"]),
    authorLogin: z.string(),
    body: z.string(),
    createdAt: z.string(),
    path: z.string().nullable(),
    line: z.number().int().nullable(),
    reviewId: z.string().nullable(),
    inReplyToId: z.string().nullable(),
    mayHide: z.boolean(),
    truncated: z.boolean(),
    trustReason: z.enum(["author", "trusted_bot", "collaborator"]),
  })
  .strict();

export const filteredPrDiscussionSchema = z
  .object({
    pr: z
      .object({
        number: z.number().int(),
        url: z.string(),
        title: z.string(),
        body: z.string(),
        mayHideBody: z.boolean(),
        state: z.string(),
        isDraft: z.boolean(),
        headRefName: z.string(),
        headRefOid: z.string(),
        baseRefName: z.string(),
        baseRefOid: z.string(),
        authorLogin: z.string(),
        labels: z.array(z.string()),
        mergeStateStatus: z.string(),
      })
      .strict(),
    items: z.array(trustedPrCommentSchema),
    excludedCount: z.number().int(),
    truncatedCount: z.number().int(),
    droppedForBudgetCount: z.number().int(),
    collisionLabels: z.array(z.string()),
  })
  .strict();

export const inspectReviewContextOutputSchema = z
  .object({
    root: z.string(),
    repoSlug: z.string().nullable(),
    branch: z.string().nullable(),
    headSha: z.string(),
    baseSha: z.string(),
    priorReviewedIsAncestor: z.boolean(),
    changedFiles: z.array(z.string()),
    committedFiles: z.array(z.string()),
    diffText: z.string(),
    unsafeWorktreeHooks: z.boolean(),
    worktreeHookReason: z.string().nullable(),
    hasEscapingSymlinks: z.boolean(),
    symlinkReason: z.string().nullable(),
    secretBlockedReason: z.string().nullable(),
  })
  .strict();

export type InspectReviewContextOutput = z.infer<typeof inspectReviewContextOutputSchema>;

export const polledCheckRunSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    detailsUrl: z.string().nullable(),
  })
  .strict();

export type PolledCheckRunOutput = z.infer<typeof polledCheckRunSchema>;

export const pollPrStateOutputSchema = z
  .object({
    discussion: filteredPrDiscussionSchema,
    checkRuns: z.array(polledCheckRunSchema),
  })
  .strict();

export type PollPrStateOutput = z.infer<typeof pollPrStateOutputSchema>;

export const approvalChangedFileSchema = z
  .object({
    path: z.string(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })
  .strict();

export const approvalClassifierSourceSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    raw: z.string(),
    sha: z.string(),
  })
  .strict();

export const inspectApprovalContextOutputSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().nullable(),
    defaultBranch: z.string(),
    baseRemote: z.string(),
    policyFound: z.boolean(),
    policyRaw: z.string().nullable(),
    policySha: z.string().nullable(),
    classifiers: z.array(approvalClassifierSourceSchema),
    pr: z
      .object({
        number: z.number().int(),
        title: z.string(),
        state: z.string(),
        isDraft: z.boolean(),
        headSha: z.string(),
        baseBranch: z.string(),
        headBranch: z.string(),
        authorLogin: z.string(),
        authorAssociation: z.string(),
        labels: z.array(z.string()),
        collisionLabels: z.array(z.string()),
        changedFiles: z.array(approvalChangedFileSchema),
      })
      .nullable(),
    checkRuns: z.array(polledCheckRunSchema),
    diffText: z.string(),
    diffTruncated: z.boolean(),
  })
  .strict();

export type InspectApprovalContextOutput = z.infer<typeof inspectApprovalContextOutputSchema>;

export const mergeDevPrOutputSchema = z
  .object({
    ok: z.boolean(),
    merged: z.boolean(),
    error: z.string().nullable(),
  })
  .strict();

export type MergeDevPrOutput = z.infer<typeof mergeDevPrOutputSchema>;

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
  inspectPublishContext: {
    experimental_retryable: true,
    input: z
      .object({
        root: z.string().min(1).max(4096),
        remote: z.string().min(1).max(120).optional(),
        baseBranch: z.string().min(1).max(200).optional(),
      })
      .strict(),
    output: inspectPublishContextOutputSchema,
  },
  publishChanges: {
    input: publishChangesInputSchema,
    output: publishChangesOutputSchema,
  },
  readPrDiscussion: {
    experimental_retryable: true,
    input: z
      .object({
        root: z.string().min(1).max(4096),
        repo: repoSlugSchema,
        prNumber: z.number().int().positive(),
        trustedBots: z.array(z.string().min(1).max(80)).max(32).default([]),
        authorLogin: z.string().max(120).optional(),
      })
      .strict(),
    output: filteredPrDiscussionSchema,
  },
  inspectReviewContext: {
    experimental_retryable: true,
    input: z
      .object({
        root: z.string().min(1).max(4096),
        baseRef: z.string().min(1).max(512).optional(),
        priorReviewedSha: z.string().regex(/^[0-9a-f]{40}$/u).optional(),
      })
      .strict(),
    output: inspectReviewContextOutputSchema,
  },
  pollPrState: {
    experimental_retryable: true,
    input: z
      .object({
        root: z.string().min(1).max(4096),
        repo: repoSlugSchema,
        prNumber: z.number().int().positive(),
        trustedBots: z.array(z.string().min(1).max(80)).max(32).default([]),
        authorLogin: z.string().max(120).optional(),
      })
      .strict(),
    output: pollPrStateOutputSchema,
  },
  readRepoStewardSkill: {
    experimental_retryable: true,
    input: z.object({ root: z.string().min(1).max(4096) }).strict(),
    output: z
      .object({
        found: z.boolean(),
        sourcePath: z.string().nullable(),
        content: z.string().nullable(),
        truncated: z.boolean(),
      })
      .strict(),
  },
  stewardFetchAndCheckBase: {
    experimental_retryable: true,
    input: z
      .object({
        root: z.string().min(1).max(4096),
        baseRemote: z.string().min(1).max(120),
        baseBranch: z.string().min(1).max(200),
        expectedPins: z.record(z.string(), z.string()),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        pinsOk: z.boolean(),
        driftReason: z.string().nullable(),
        fetchedSha: z.string().nullable(),
        safe: z.boolean(),
        alreadyMerged: z.boolean(),
        blockedPaths: z.array(z.string()),
        noticePaths: z.array(z.string()),
        reason: z.string().nullable(),
      })
      .strict(),
  },
  stewardMergeBase: {
    input: z
      .object({
        root: z.string().min(1).max(4096),
        baseRemote: z.string().min(1).max(120),
        baseBranch: z.string().min(1).max(200),
        headRemote: z.string().min(1).max(120).optional(),
        headBranch: z.string().min(1).max(200).optional(),
        expectedBaseSha: z.string().regex(/^[0-9a-f]{40}$/u),
        expectedPins: z.record(z.string(), z.string()),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        headSha: z.string().nullable(),
        pushed: z.boolean(),
        noticePaths: z.array(z.string()),
        reason: z.string().nullable(),
      })
      .strict(),
  },
  stewardCommitAndPush: {
    input: z
      .object({
        root: z.string().min(1).max(4096),
        headRemote: z.string().min(1).max(120),
        headBranch: z.string().min(1).max(200),
        files: z.array(z.string().min(1).max(1024)).min(1),
        commitMessage: z.string().min(1).max(8000),
        expectedPins: z.record(z.string(), z.string()),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        headSha: z.string().nullable(),
        committed: z.boolean(),
        pushed: z.boolean(),
        error: z.string().nullable(),
      })
      .strict(),
  },
  stewardRerunJob: {
    input: z
      .object({
        root: z.string().min(1).max(4096),
        repo: repoSlugSchema,
        jobId: z.number().int().positive(),
        expectedPins: z.record(z.string(), z.string()),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        error: z.string().nullable(),
      })
      .strict(),
  },
  stewardFetchJobLogs: {
    experimental_retryable: true,
    input: z
      .object({
        root: z.string().min(1).max(4096),
        repo: repoSlugSchema,
        jobId: z.number().int().positive(),
        maxBytes: z.number().int().min(512).max(65_536).optional(),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        logs: z.string(),
        truncated: z.boolean(),
        redactedCount: z.number().int(),
        error: z.string().nullable(),
      })
      .strict(),
  },
  inspectApprovalContext: {
    experimental_retryable: true,
    input: z
      .object({
        root: z.string().min(1).max(4096),
        repo: repoSlugSchema,
        prNumber: z.number().int().positive(),
        baseRemote: z.string().min(1).max(120).optional(),
        defaultBranch: z.string().min(1).max(200).optional(),
        maxDiffBytes: z.number().int().min(1024).max(131_072).optional(),
      })
      .strict(),
    output: inspectApprovalContextOutputSchema,
  },
  mergeDevPr: {
    input: z
      .object({
        root: z.string().min(1).max(4096),
        repo: repoSlugSchema,
        prNumber: z.number().int().positive(),
        baseBranch: z.string().min(1).max(200),
        expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/u),
        method: z.enum(["squash", "merge", "rebase"]).optional(),
      })
      .strict(),
    output: mergeDevPrOutputSchema,
  },
});

export type ShipHostContract = typeof hostContract;
export type ShipHostClient = ExperimentalHostClient<ShipHostContract>;

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
  controlWatch: {
    input: z
      .object({
        id: z.string().min(1).max(120),
        action: z.enum(["stop", "pause", "resume"]),
      })
      .strict(),
    output: watchRecordSchema,
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
