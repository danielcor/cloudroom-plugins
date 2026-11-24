import type { PluginInteractionRequest, PluginInteractionResult } from "@get-bb/plugin-sdk";
import type { InspectPublishContextOutput, PublishChangesOutput } from "../contract.js";
import type { ShipStore } from "../db.js";
import { validateCommitMessage } from "../safety/outbound-text.js";
import { findSecrets } from "../safety/secrets.js";
import { runPreflight, type PreflightIssue, type PreflightResult } from "./preflight.js";
import { synthesizeCommitMessage, synthesizePrTexts } from "./pr-texts.js";

export const CONFIRM_DWELL_MS = 3500;

export interface PublishConfirmPayload {
  repoSlug: string;
  isPrivate: boolean;
  remote: string;
  targetBranch: string;
  createBranch: boolean;
  baseBranch: string;
  filesToStage: string[];
  aheadCount: number;
  existingPrNumber: number | null;
  existingPrUrl: string | null;
  commitMessage: string;
  prTitle: string;
  prBody: string;
  draft: boolean;
  warnings: PreflightIssue[];
  dwellMs: number;
  [key: string]: unknown;
}

export interface PublishConfirmResponse {
  approved: boolean;
  prTitle?: string;
  prBody?: string;
  commitMessage?: string;
  draft?: boolean;
}

export interface RunShipPublishOptions {
  hostId: string;
  root: string;
  threadId?: string | null;
  remote?: string;
  requestedBranch?: string;
  baseBranch?: string;
  titleHint?: string;
  bodyHint?: string;
  commitMessageHint?: string;
  draft?: boolean;
  dryRun?: boolean;
  confirm?: boolean;
  skipConfirmation?: boolean;
  allowPublicCommit?: boolean;
  includeFooter?: boolean;
  minDwellMs?: number;
  nowMs?: () => number;
}

export type ShipPublishResult =
  | { status: "blocked"; preflight: PreflightResult }
  | {
      status: "dry_run";
      preflight: PreflightResult;
      commitMessage: string;
      prTitle: string;
      prBody: string;
      usedFallback: boolean;
      fallbackReason: string | null;
    }
  | {
      status: "confirmation_required";
      preflight: PreflightResult;
      commitMessage: string;
      prTitle: string;
      prBody: string;
      reason: string;
    }
  | { status: "cancelled"; preflight: PreflightResult; reason: string }
  | { status: "rejected"; preflight: PreflightResult; reason: string }
  | { status: "failed"; preflight: PreflightResult; publish: PublishChangesOutput }
  | { status: "published"; preflight: PreflightResult; publish: PublishChangesOutput };

export interface ShipPublishDeps {
  inspectPublishContext: (input: {
    root: string;
    remote?: string;
    baseBranch?: string;
  }) => Promise<InspectPublishContextOutput>;
  publishChanges: (input: {
    root: string;
    remote: string;
    repoSlug: string;
    targetBranch: string;
    createBranch: boolean;
    baseBranch: string;
    filesToStage: string[];
    commitMessage: string;
    prTitle: string;
    prBody: string;
    draft: boolean;
    createPr: boolean;
    expectedHeadSha: string;
  }) => Promise<PublishChangesOutput>;
  requestInput: (req: PluginInteractionRequest) => Promise<PluginInteractionResult>;
  store: ShipStore;
}

export async function runShipPublish(
  opts: RunShipPublishOptions,
  deps: ShipPublishDeps,
): Promise<ShipPublishResult> {
  const actor = opts.threadId ? "thread" : "cli";
  const nowMs = opts.nowMs ?? Date.now;
  const minDwellMs = opts.minDwellMs ?? CONFIRM_DWELL_MS;

  const ctx = await deps.inspectPublishContext({
    root: opts.root,
    ...(opts.remote ? { remote: opts.remote } : {}),
    ...(opts.baseBranch ? { baseBranch: opts.baseBranch } : {}),
  });

  const nonInteractive = !opts.threadId || Boolean(opts.skipConfirmation);
  const preflight = runPreflight({
    inspection: ctx.inspection,
    remoteName: ctx.remoteName,
    remoteUrl: ctx.remoteUrl,
    repoMeta: ctx.repoMeta,
    existingPr: ctx.existingPr,
    aheadCount: ctx.aheadCount,
    diffSecretFinding: ctx.diffSecretFinding,
    localSecretMatchSource: ctx.localSecretMatchSource,
    requestedBranch: opts.requestedBranch,
    baseBranch: opts.baseBranch,
    nonInteractive,
    allowPublicCommit: opts.allowPublicCommit,
  });

  if (!preflight.ok || !preflight.plan) {
    deps.store.appendAudit({
      actor,
      action: "publish.preflight_blocked",
      outcome: "blocked",
      detail: {
        hostId: opts.hostId,
        blockers: preflight.blockers.map((b) => b.code),
      },
    });
    return { status: "blocked", preflight };
  }

  const plan = preflight.plan;
  let commitMessage = "";
  if (plan.filesToStage.length > 0) {
    const commitSynth = synthesizeCommitMessage({
      branch: plan.targetBranch,
      changedFiles: plan.filesToStage,
      hint: opts.commitMessageHint,
    });
    if (!commitSynth.ok) {
      const reason = `Invalid commit message: ${commitSynth.reason}`;
      deps.store.appendAudit({
        actor,
        action: "publish.invalid_commit_msg",
        outcome: "rejected",
        detail: { repo: plan.repoSlug, branch: plan.targetBranch, reason },
      });
      return { status: "rejected", preflight, reason };
    }
    commitMessage = commitSynth.message;
  }

  const textSynth = synthesizePrTexts({
    branch: plan.targetBranch,
    commitSubjects: ctx.commitSubjects,
    changedFiles: plan.filesToStage,
    diffText: ctx.diffText,
    titleHint: opts.titleHint,
    bodyHint: opts.bodyHint,
    includeFooter: opts.includeFooter,
  });

  let prTitle = plan.existingPr ? (opts.titleHint?.trim() || plan.existingPr.title) : textSynth.title;
  let prBody = textSynth.body;
  let draft = Boolean(opts.draft);

  if (opts.dryRun) {
    return {
      status: "dry_run",
      preflight,
      commitMessage,
      prTitle,
      prBody,
      usedFallback: textSynth.usedFallback,
      fallbackReason: textSynth.fallbackReason,
    };
  }

  if (opts.threadId && !opts.skipConfirmation) {
    const requestedAtMs = nowMs();
    const payload: PublishConfirmPayload = {
      repoSlug: plan.repoSlug,
      isPrivate: plan.isPrivate,
      remote: plan.remote,
      targetBranch: plan.targetBranch,
      createBranch: plan.createBranch,
      baseBranch: plan.baseBranch,
      filesToStage: plan.filesToStage,
      aheadCount: plan.aheadCount,
      existingPrNumber: plan.existingPr?.number ?? null,
      existingPrUrl: plan.existingPr?.url ?? null,
      commitMessage,
      prTitle,
      prBody,
      draft,
      warnings: preflight.warnings,
      dwellMs: minDwellMs,
    };

    const res = await deps.requestInput({
      threadId: opts.threadId,
      rendererId: "ship-publish-confirm",
      title: "Confirm Ship & Publish PR",
      payload: payload as never,
      describeSubmission: (val) => {
        const obj = (typeof val === "object" && val !== null ? val : {}) as Partial<PublishConfirmResponse>;
        return {
          title: obj.approved ? `Approved push to ${plan.targetBranch}` : "Cancelled publish",
          detail: `Repo: \`${plan.repoSlug}\` → \`${plan.baseBranch}\` (${plan.filesToStage.length} file(s) staged)`,
        };
      },
    });

    if (res.outcome !== "submitted") {
      deps.store.appendAudit({
        actor,
        action: "publish.cancelled",
        outcome: "cancelled",
        detail: { repo: plan.repoSlug, branch: plan.targetBranch, reason: res.reason },
      });
      return { status: "cancelled", preflight, reason: res.reason };
    }

    const sub = (typeof res.value === "object" && res.value !== null ? res.value : {}) as Partial<PublishConfirmResponse>;
    if (sub.approved !== true) {
      deps.store.appendAudit({
        actor,
        action: "publish.cancelled",
        outcome: "cancelled",
        detail: { repo: plan.repoSlug, branch: plan.targetBranch, reason: "user_declined" },
      });
      return { status: "cancelled", preflight, reason: "user_declined" };
    }

    const elapsedMs = nowMs() - requestedAtMs;
    if (elapsedMs < minDwellMs) {
      const reason = "Confirmation submitted before 3.5s dwell period elapsed.";
      deps.store.appendAudit({
        actor,
        action: "publish.dwell_rejected",
        outcome: "rejected",
        detail: { repo: plan.repoSlug, branch: plan.targetBranch, elapsedMs, minDwellMs },
      });
      return { status: "rejected", preflight, reason };
    }

    if (typeof sub.prTitle === "string") prTitle = sub.prTitle.trim();
    if (typeof sub.prBody === "string") prBody = sub.prBody.trim();
    if (typeof sub.commitMessage === "string" && plan.filesToStage.length > 0) {
      commitMessage = sub.commitMessage.trim();
    }
    if (typeof sub.draft === "boolean") draft = sub.draft;

    if (!prTitle || prTitle.length > 500) {
      return { status: "rejected", preflight, reason: "PR title must be between 1 and 500 characters." };
    }
    if (!prBody || prBody.length > 8000) {
      return { status: "rejected", preflight, reason: "PR description must be between 1 and 8000 characters." };
    }
    const secretHit = findSecrets(`${prTitle}\n${prBody}`)[0];
    if (secretHit) {
      const reason = `Potential secret detected in PR title/description (${secretHit.kind}).`;
      deps.store.appendAudit({
        actor,
        action: "publish.secret_rejected",
        outcome: "rejected",
        detail: { repo: plan.repoSlug, branch: plan.targetBranch, kind: secretHit.kind },
      });
      return { status: "rejected", preflight, reason };
    }
    if (plan.filesToStage.length > 0) {
      const cmCheck = validateCommitMessage(commitMessage);
      if (!cmCheck.ok) {
        const reason = `Invalid commit message: ${cmCheck.reason}`;
        deps.store.appendAudit({
          actor,
          action: "publish.invalid_commit_msg",
          outcome: "rejected",
          detail: { repo: plan.repoSlug, branch: plan.targetBranch, reason },
        });
        return { status: "rejected", preflight, reason };
      }
    }
  } else if (!opts.skipConfirmation && !opts.confirm) {
    return {
      status: "confirmation_required",
      preflight,
      commitMessage,
      prTitle,
      prBody,
      reason: "Pass --confirm to publish without an interactive confirmation card, or run inside a Cloudroom thread.",
    };
  }

  const rawPublish = await deps.publishChanges({
    root: opts.root,
    remote: plan.remote,
    repoSlug: plan.repoSlug,
    targetBranch: plan.targetBranch,
    createBranch: plan.createBranch,
    baseBranch: plan.baseBranch,
    filesToStage: plan.filesToStage,
    commitMessage,
    prTitle,
    prBody,
    draft,
    createPr: plan.existingPr === null,
    expectedHeadSha: plan.expectedHeadSha,
  });

  const publish: PublishChangesOutput =
    rawPublish.ok && !rawPublish.prCreated && plan.existingPr
      ? { ...rawPublish, prNumber: plan.existingPr.number, prUrl: plan.existingPr.url }
      : rawPublish;

  deps.store.appendAudit({
    actor,
    action: publish.ok ? "publish.succeeded" : "publish.failed",
    outcome: publish.ok ? "ok" : "error",
    detail: {
      repo: plan.repoSlug,
      branch: publish.branch,
      headSha: publish.headSha,
      prNumber: publish.prNumber,
      prCreated: publish.prCreated,
      ...(publish.error ? { error: publish.error } : {}),
    },
  });

  return publish.ok
    ? { status: "published", preflight, publish }
    : { status: "failed", preflight, publish };
}
