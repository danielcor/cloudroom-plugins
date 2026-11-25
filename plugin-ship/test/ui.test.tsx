// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  RepoConfig,
  ShipStatus,
  ThreadWatchSummary,
  VerifyBotOutput,
  WatchDetail,
  WatchRecord,
} from "../src/contract.js";
import { ShipPage } from "../src/ui/ShipPage.js";
import { ThreadBar } from "../src/ui/ThreadBar.js";

afterEach(() => {
  cleanup();
});

function makeStatus(overrides: Partial<ShipStatus> = {}): ShipStatus {
  return {
    pluginVersion: "0.1.0",
    botConfigured: true,
    botLogin: "cloudroom-ship-bot",
    webhookConfigured: true,
    webhookPath: "/api/v1/plugins/ship/http/webhook/github",
    defaultReviewMode: "triad",
    defaultReviewEffort: "high",
    pollIntervalSeconds: 120,
    watchMaxDays: 7,
    defaultMaxPushesPerCause: 3,
    repoCount: 1,
    activeWatchCount: 2,
    ...overrides,
  };
}

function makeWatch(overrides: Partial<WatchRecord> = {}): WatchRecord {
  return {
    id: "w_1",
    projectId: "proj_1",
    hostId: "host_1",
    worktreePath: "/opt/dev/pmzbot",
    repo: "PeakBot/pmzbot",
    prNumber: 42,
    headBranch: "feat/risk-cap",
    headRemote: "origin",
    baseBranch: "dev",
    baseRemote: "origin",
    authorLogin: "danielcor",
    state: "needs_human",
    lastHeadSha: "a1b2c3d4e5f60708090a0b0c0d0e0f1011121314",
    startedAt: 1_700_000_000_000,
    expiresAt: 1_700_600_000_000,
    lastWokeAt: 1_700_000_500_000,
    workerThreadId: "thr_worker_1",
    stopReason: "Reached max push cap (3) for check failure.",
    ...overrides,
  };
}

describe("Ship PR 6 Dashboard, Inspector, Repo Policy Editor, ThreadBar & Composer", () => {
  it("registers plusMenu entries that insert slash commands cleanly without auto-submitting", async () => {
    const app = await loadPluginApp(() => import("../app.js"));
    const custom = app.composerCustomizations.find((c) => c.id === "ship-actions");
    expect(custom).toBeDefined();
    expect(custom!.plusMenu?.map((m) => m.label)).toEqual([
      "Ship this branch…",
      "Watch PR with Steward…",
      "Check PR approvals…",
    ]);

    const inserts: Array<{ text: unknown; opts: unknown }> = [];
    let focusCount = 0;
    let submitCount = 0;
    const mockComposer = {
      insert: (parts: unknown, opts?: unknown) => {
        inserts.push({ text: parts, opts });
      },
      focus: () => {
        focusCount += 1;
      },
      submit: () => {
        submitCount += 1;
      },
    };

    for (const item of custom!.plusMenu ?? []) {
      await item.run({ composer: mockComposer as never } as never);
    }

    expect(inserts).toEqual([
      { text: "/ship ", opts: { at: "cursor" } },
      { text: "/steward ", opts: { at: "cursor" } },
      { text: "/ship-approvals ", opts: { at: "cursor" } },
    ]);
    expect(focusCount).toBe(3);
    expect(submitCount).toBe(0);
  });

  it("renders ShipPage Watches tab -> opens WatchDetail drawer -> switches to Repos editor & Setup tab", async () => {
    const watches: WatchRecord[] = [
      makeWatch(),
      makeWatch({
        id: "w_2",
        repo: "danielcor/cloudroom-plugins",
        prNumber: 13,
        headBranch: "feat/ship-plugin",
        baseBranch: "main",
        state: "ready",
        stopReason: null,
      }),
    ];

    const detailMap: Record<string, WatchDetail> = {
      w_1: {
        watch: watches[0]!,
        budgets: {
          causePushCounts: { "check:tests": 2 },
          maxPushesPerCause: 3,
          behindMergesCount: 1,
          maxBehindMerges: 2,
          rerunJobIds: [901],
          pinsCount: 6,
          trustedBots: ["coderabbitai"],
          seenCommentsCount: 4,
        },
        latestReview: {
          id: "rev_1",
          watchId: "w_1",
          repo: "PeakBot/pmzbot",
          prNumber: 42,
          headSha: "a1b2c3d4e5f60708090a0b0c0d0e0f1011121314",
          mode: "triad",
          round: 1,
          seats: ["claude", "codex", "grok"],
          verdict: "REQUEST_CHANGES",
          meanScore: 7.4,
          createdAt: 1_700_000_200_000,
        },
        findings: [
          {
            id: "f_1",
            reviewRunId: "rev_1",
            severity: "major",
            file: "src/risk.cs",
            line: 88,
            claim: "Missing null check before Kelly sizing",
            raisers: ["codex", "grok"],
            status: "open",
            resolutionSha: null,
          },
        ],
        latestApproval: {
          id: "apr_1",
          repo: "PeakBot/pmzbot",
          prNumber: 42,
          headSha: "a1b2c3d4e5f60708090a0b0c0d0e0f1011121314",
          policySha: "p".repeat(64),
          mode: "enforce",
          verdict: "request_changes",
          requiredSeats: 1,
          matchedRuleIds: ["core-review"],
          classifierErrors: [],
          statusPosted: true,
          reviewPosted: false,
          createdAt: 1_700_000_300_000,
        },
        audits: [
          {
            id: 1,
            watchId: "w_1",
            ts: 1_700_000_500_000,
            actor: "poller",
            action: "steward.needs_human",
            outcome: "needs_human",
            detailJson: JSON.stringify({ causeKey: "check:tests" }),
          },
        ],
      },
    };

    let repos: RepoConfig[] = [
      {
        repo: "PeakBot/pmzbot",
        enabled: true,
        reviewMode: "triad",
        reviewEffort: "high",
        autoSteward: "auto",
        approvalsMode: "enforce",
        allowDevAutomerge: false,
        trustedBots: ["coderabbitai"],
        maxPushesPerCause: 3,
        maxReviewRounds: 4,
        updatedAt: 1_700_000_000_000,
      },
    ];

    const startWatchMock = vi.fn((raw: unknown) => {
      const inp = raw as { repo: string; prNumber: number; baseBranch?: string };
      const created = makeWatch({
        id: "w_3",
        repo: inp.repo,
        prNumber: inp.prNumber,
        baseBranch: inp.baseBranch ?? "dev",
        state: "watching",
        stopReason: null,
      });
      watches.push(created);
      return { alreadyWatching: false, watch: created };
    });

    renderSlot(
      { component: ShipPage },
      { subPath: "" },
      {
        rpc: {
          status: () => makeStatus(),
          listWatches: () => watches,
          getWatchDetail: (raw: unknown) => {
            const { id } = raw as { id: string };
            return (
              detailMap[id] ?? {
                watch: watches.find((w) => w.id === id)!,
                budgets: {
                  causePushCounts: {},
                  maxPushesPerCause: 3,
                  behindMergesCount: 0,
                  maxBehindMerges: 2,
                  rerunJobIds: [],
                  pinsCount: 4,
                  trustedBots: [],
                  seenCommentsCount: 0,
                },
                latestReview: null,
                findings: [],
                latestApproval: null,
                audits: [],
              }
            );
          },
          startWatch: startWatchMock,
          listRepos: () => repos,
          upsertRepo: (raw: unknown) => {
            const patch = raw as Partial<RepoConfig> & { repo: string };
            repos = repos.map((r) => (r.repo === patch.repo ? { ...r, ...patch } : r));
            return repos.find((r) => r.repo === patch.repo)!;
          },
          verifyBot: (): VerifyBotOutput => ({
            configured: true,
            ok: true,
            configuredLogin: "cloudroom-ship-bot",
            login: "cloudroom-ship-bot",
            viewerId: 5511,
            loginMatches: true,
            error: null,
          }),
        },
      },
    );

    await waitFor(() => {
      expect(screen.getByText("PeakBot/pmzbot#42")).toBeTruthy();
      expect(screen.getByText("danielcor/cloudroom-plugins#13")).toBeTruthy();
    });

    // Search filter narrows watches
    fireEvent.change(screen.getByLabelText("Search watches"), { target: { value: "pmzbot" } });
    expect(screen.queryByText("danielcor/cloudroom-plugins#13")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search watches"), { target: { value: "" } });

    // Clicking watch row opens WatchDetail inspector drawer
    fireEvent.click(screen.getByTestId("watch-row-w_1"));
    await waitFor(() => {
      expect(screen.getByTestId("watch-detail-drawer")).toBeTruthy();
      expect(screen.getByTestId("watch-detail-budgets").textContent).toContain("6 verified");
      expect(screen.getByText(/Missing null check before Kelly sizing/)).toBeTruthy();
      expect(screen.getByText("steward.needs_human")).toBeTruthy();
    });

    // "+ Watch PR" modal starts a watch cleanly
    fireEvent.click(screen.getByRole("button", { name: "+ Watch PR" }));
    fireEvent.change(screen.getByLabelText("Watch repository"), { target: { value: "PeakBot/AiTradingBot" } });
    fireEvent.change(screen.getByLabelText("Watch PR number"), { target: { value: "77" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start Watch" }));
    });
    expect(startWatchMock).toHaveBeenCalledWith({
      repo: "PeakBot/AiTradingBot",
      prNumber: 77,
      acceptTerms: true,
    });

    // Switch to Repos tab & edit policy including non-dev auto-merge warning check
    fireEvent.click(screen.getByRole("tab", { name: /Repos/ }));
    await waitFor(() => {
      expect(screen.getByTestId("repo-policy-editor")).toBeTruthy();
      expect(screen.getByText(/Hard-blocked on main, master, beta/i)).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText("Review mode"), { target: { value: "sol-loop" } });
    fireEvent.click(screen.getByLabelText("Allow dev-only auto-merge"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    });
    await waitFor(() => {
      expect(screen.getByText("Saved policy for PeakBot/pmzbot.")).toBeTruthy();
    });
    expect(repos[0]).toMatchObject({ reviewMode: "sol-loop", allowDevAutomerge: true });

    // Switch to Setup & Commands tab -> Verify bot works without leaking any token
    fireEvent.click(screen.getByRole("tab", { name: /Setup & Commands/ }));
    expect(screen.getByTestId("setup-webhook-card")).toBeTruthy();
    expect(screen.getByTestId("setup-container-gates-card")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Verify bot" }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("bot-verify-result").textContent).toContain("Verified as cloudroom-ship-bot");
    });
  });

  it("renders ThreadBar only when thread has an active watch and navigates cleanly to Ship panel", async () => {
    const noWatchSummary: ThreadWatchSummary = {
      watch: null,
      latestReviewVerdict: null,
      latestReviewScore: null,
      latestApprovalVerdict: null,
    };
    const slotEmpty = renderSlot(
      { component: ThreadBar },
      { threadId: "thr_unrelated", projectId: "proj_1", environment: null },
      { rpc: { getThreadWatch: () => noWatchSummary } },
    );
    await waitFor(() => {
      expect(screen.queryByTestId("ship-thread-bar")).toBeNull();
    });
    slotEmpty.unmount();

    const activeSummary: ThreadWatchSummary = {
      watch: makeWatch({ id: "w_active", state: "ready", stopReason: null }),
      latestReviewVerdict: "APPROVE",
      latestReviewScore: 9.2,
      latestApprovalVerdict: "approve",
    };
    const slotActive = renderSlot(
      { component: ThreadBar },
      { threadId: "thr_worker_1", projectId: "proj_1", environment: null },
      { rpc: { getThreadWatch: () => activeSummary } },
    );
    await waitFor(() => {
      expect(screen.getByTestId("ship-thread-bar")).toBeTruthy();
      expect(screen.getByText("PeakBot/pmzbot#42")).toBeTruthy();
      expect(screen.getByText("Review: APPROVE")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Open in Ship" }));
    expect(slotActive.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "ship",
      options: { subPath: "w_active" },
    });
  });
});
