// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import type { ShipStatus, WatchRecord } from "../src/contract.js";
import { PublishConfirmCard } from "../src/ui/PublishConfirmCard.js";
import { ShipPage } from "../src/ui/ShipPage.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Ship app & PublishConfirmCard", () => {
  it("registers ship navPanel and ship-publish-confirm pendingInteraction slot", async () => {
    const app = await loadPluginApp(() => import("../app.js"));
    expect(app.navPanels.map((p) => [p.id, p.path, p.title])).toEqual([["ship", "ship", "Ship"]]);
    expect(app.pendingInteractions.map((p) => p.id)).toEqual(["ship-publish-confirm"]);
  });

  it("enforces 3.5s Allow dwell, shows public repo warning, submits edited values, and allows immediate cancel", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T12:00:00.000Z"));

    const submit = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const props: PluginPendingInteractionProps = {
      interaction: {
        id: "int_1",
        threadId: "thr_1",
        title: "Confirm Ship & Publish PR",
        createdAt: Date.now(),
        expiresAt: null,
        payload: {
          repoSlug: "acme/public-lib",
          isPrivate: false,
          remote: "origin",
          targetBranch: "ship/fix",
          createBranch: true,
          baseBranch: "main",
          filesToStage: ["src/index.ts"],
          aheadCount: 0,
          existingPrNumber: null,
          existingPrUrl: null,
          commitMessage: "ship: update src/index.ts",
          prTitle: "Update index",
          prBody: "## Summary\n\n- Update index",
          draft: false,
          warnings: [{ code: "create_branch_from_default", message: "Creating new branch ship/fix." }],
          dwellMs: 3500,
        },
      },
      submit,
      cancel,
    };

    renderSlot({ component: PublishConfirmCard }, props);

    expect(screen.getByRole("alert").textContent).toContain("public repository");
    expect(screen.getByText("Creating new branch ship/fix.")).toBeTruthy();

    const allowBtn = screen.getByRole("button", { name: /Allow & Publish/i }) as HTMLButtonElement;
    const cancelBtn = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;

    expect(allowBtn.disabled).toBe(true);
    expect(cancelBtn.disabled).toBe(false);

    // Still locked at 3400ms.
    await act(async () => {
      vi.advanceTimersByTime(3400);
    });
    expect(allowBtn.disabled).toBe(true);
    expect(allowBtn.textContent).toContain("1s");

    // Unlocked at >= 3500ms.
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(allowBtn.disabled).toBe(false);
    expect(allowBtn.textContent).toBe("Allow & Publish");

    fireEvent.change(screen.getByLabelText("PR title"), { target: { value: "Custom Ship Title" } });
    fireEvent.change(screen.getByLabelText("Commit message"), { target: { value: "ship: custom commit" } });
    fireEvent.click(screen.getByLabelText("Open as draft"));

    await act(async () => {
      fireEvent.click(allowBtn);
    });
    expect(submit).toHaveBeenCalledWith({
      approved: true,
      prTitle: "Custom Ship Title",
      prBody: "## Summary\n\n- Update index",
      commitMessage: "ship: custom commit",
      draft: true,
    });

    // Separate render verifies Cancel works immediately without waiting for dwell.
    cleanup();
    renderSlot({ component: PublishConfirmCard }, props);
    const immediateCancel = screen.getByRole("button", { name: "Cancel" });
    await act(async () => {
      fireEvent.click(immediateCancel);
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("renders ShipPage watches table, calls controlWatch RPC, and reloads on realtime watch events", async () => {
    let watches: WatchRecord[] = [
      {
        id: "w_1",
        projectId: "proj_1",
        hostId: "host_1",
        worktreePath: "/tmp/repo",
        repo: "danielcor/cloudroom-plugins",
        prNumber: 12,
        headBranch: "feat/ship",
        headRemote: "origin",
        baseBranch: "main",
        baseRemote: "origin",
        authorLogin: "danielcor",
        state: "watching",
        lastHeadSha: "abcdef1234567890abcdef1234567890abcdef12",
        startedAt: 1000,
        expiresAt: 9000,
        lastWokeAt: null,
        workerThreadId: null,
        stopReason: null,
      },
    ];
    const controlCalls: Array<{ id: string; action: string }> = [];
    const statusPayload: ShipStatus = {
      pluginVersion: "0.1.0",
      botConfigured: true,
      botLogin: "ship-bot",
      defaultReviewMode: "triad",
      defaultReviewEffort: "high",
      pollIntervalSeconds: 120,
      watchMaxDays: 7,
      defaultMaxPushesPerCause: 3,
      repoCount: 1,
      activeWatchCount: 1,
    };

    const slot = renderSlot(
      { component: ShipPage },
      { subPath: "" },
      {
        rpc: {
          status: () => statusPayload,
          listWatches: () => watches,
          controlWatch: (rawInput: unknown) => {
            const input = rawInput as { id: string; action: "stop" | "pause" | "resume" };
            controlCalls.push(input);
            watches = watches.map((w) =>
              w.id === input.id
                ? {
                    ...w,
                    state: input.action === "pause" ? "paused" : input.action === "resume" ? "watching" : "stopped",
                  }
                : w,
            );
            return watches.find((w) => w.id === input.id)!;
          },
        },
      },
    );

    await waitFor(() => {
      expect(screen.getByText("danielcor/cloudroom-plugins#12")).toBeTruthy();
      expect(screen.getByText("watching")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    });
    expect(controlCalls).toContainEqual({ id: "w_1", action: "pause" });
    await waitFor(() => expect(screen.getByText("paused")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    });
    expect(controlCalls).toContainEqual({ id: "w_1", action: "resume" });
    await waitFor(() => expect(screen.getByText("watching")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    expect(controlCalls).toContainEqual({ id: "w_1", action: "stop" });
    await waitFor(() => expect(screen.getByText("stopped")).toBeTruthy());

    // Push a realtime watch update and confirm ShipPage refreshes cleanly.
    watches = [
      ...watches,
      {
        ...watches[0]!,
        id: "w_2",
        prNumber: 99,
        state: "ready",
      },
    ];
    await slot.behavior.emitRealtime("watches", { type: "watch.created", watchId: "w_2" });
    await waitFor(() => expect(screen.getByText("danielcor/cloudroom-plugins#99")).toBeTruthy());
  });
});
