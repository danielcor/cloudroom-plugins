// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { PublishConfirmCard } from "../src/ui/PublishConfirmCard.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Ship app & PublishConfirmCard", () => {
  it("registers ship-publish-confirm pendingInteraction slot", async () => {
    const app = await loadPluginApp(() => import("../app.js"));
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
});
