// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useComposer, type PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ListResult } from "../src/contract.js";
import { toView } from "../src/model.js";
import { bridge, ComposerBridge } from "../src/ui/bridge.js";
import { SnippetsPage } from "../src/ui/SnippetsPage.js";

const view = (id: string, scope: "global" | "project", content: string) =>
  toView({ id, scope, path: `/${scope}/${id}.md`, content, sha256: `sha-${id}`, modifiedAtMs: null });

const LIST: ListResult = {
  global: { dir: "/g", error: null },
  project: { id: "proj_1", name: "cloudroom-plugins", dir: "/repo/.cloudroom/snippets", error: null },
  snippets: [
    view("worker-brief", "project", "---\ntitle: Worker brief\ntags: delegate\norder: 10\n---\nWORKER BRIEF"),
    view("review-pr", "global", "---\ntitle: Review this PR\ntags: review, git\norder: 10\n---\nReview {{target}} for {{focus|correctness}}."),
    view("bash-header", "global", "---\ntitle: Bash strict header\norder: 20\n---\nset -euo pipefail"),
  ],
};

function rpc(extra: Record<string, (input: never) => unknown> = {}) {
  return {
    list: () => LIST,
    projects: () => [{ id: "proj_1", name: "cloudroom-plugins" }],
    threadProject: () => ({ projectId: "proj_1" }),
    ...extra,
  };
}

beforeEach(() => bridge.reset());
afterEach(() => {
  cleanup();
  bridge.reset();
});

describe("app registrations", () => {
  it("adds the Snippets page, the + row and a bare bridge banner, and no popup or command", async () => {
    const app = await loadPluginApp(() => import("../app.js"));
    expect(app.navPanels.map((p) => [p.id, p.path, p.title])).toEqual([["snippets", "snippets", "Snippets"]]);
    const [c] = app.composerCustomizations;
    expect(c!.plusMenu!.map((i) => i.label)).toEqual(["Insert snippet…"]);
    expect(c!.banners!.map((b) => [b.id, b.chrome])).toEqual([["bridge", "bare"]]);
    expect(c!.experimental_popups).toBeUndefined();
  });
});

describe("composer bridge", () => {
  let handle: PluginComposerApi;
  function Mounted() {
    handle = useComposer();
    return <ComposerBridge />;
  }

  it("the + row opens the picker page for the composer that asked", async () => {
    const app = await loadPluginApp(() => import("../app.js"));
    const slot = renderSlot({ component: Mounted }, {}, { composer: { scope: { kind: "thread", threadId: "thr_1" }, text: "Before we merge:" } });
    await act(async () => {
      await app.composerCustomizations[0]!.plusMenu![0]!.run({ composer: handle });
    });
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "snippets", options: { subPath: "pick" } }]);
    expect(bridge.get().target).toEqual({ key: handle.key, scope: { kind: "thread", threadId: "thr_1" } });
    expect(bridge.get().openRequest).toBeNull();
  });

  it("appends queued text as its own paragraph when the composer is back, and never submits", async () => {
    const slot = renderSlot({ component: Mounted }, {}, { composer: { scope: { kind: "thread", threadId: "thr_1" }, text: "Before we merge:" } });
    await act(async () => bridge.queueInsert("some-other-composer", "nope"));
    expect(slot.inspection.composer.text).toBe("Before we merge:");
    await act(async () => bridge.queueInsert(handle.key, "Review PR #128."));
    expect(slot.inspection.composer.text).toBe("Before we merge:\n\nReview PR #128.");
    expect(bridge.get().pending).toBeNull();
    expect(slot.inspection.composer.submits).toEqual([]);
    expect(slot.inspection.composer.focusCount).toBeGreaterThan(0);
  });
});

describe("picker", () => {
  it("fills placeholders and queues the text for the target thread, then goes back to it", async () => {
    bridge.setTarget({ key: "thread-composer-key", scope: { kind: "thread", threadId: "thr_1" } });
    const slot = renderSlot({ component: SnippetsPage }, { subPath: "pick" }, { rpc: rpc() });
    const search = await slot.findByLabelText("Search snippets");
    await waitFor(() => expect(within(slot.getByRole("listbox", { name: "Snippets" })).getAllByRole("option")).toHaveLength(3));
    fireEvent.change(search, { target: { value: "rev" } });
    expect(within(slot.getByRole("listbox", { name: "Snippets" })).getAllByRole("option")[0]!.textContent).toContain("Review this PR");
    fireEvent.keyDown(search, { key: "Enter" });
    const field = slot.getByPlaceholderText("left as {{target}} if empty");
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "PR #128" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(bridge.get().pending).toEqual({ key: "thread-composer-key", text: "Review PR #128 for correctness." });
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId: "thr_1" });
  });

  it("writes straight into the one composer on screen when no target was picked", async () => {
    const slot = renderSlot({ component: SnippetsPage }, { subPath: "pick" }, { rpc: rpc(), composer: { text: "" } });
    const search = await slot.findByLabelText("Search snippets");
    await waitFor(() => expect(within(slot.getByRole("listbox", { name: "Snippets" })).getAllByRole("option")).toHaveLength(3));
    fireEvent.change(search, { target: { value: "bash" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(slot.inspection.composer.text).toBe("set -euo pipefail");
  });
});

describe("table", () => {
  it("deletes with an Undo that restores the same id and order", async () => {
    const calls: unknown[] = [];
    const slot = renderSlot(
      { component: SnippetsPage },
      { subPath: "" },
      {
        rpc: rpc({
          remove: (input) => (calls.push(["remove", input]), { outcome: "removed" }),
          create: (input) => (calls.push(["create", input]), { outcome: "saved", snippet: LIST.snippets[2] }),
        }),
        context: { projectId: "proj_1", threadId: null },
      },
    );
    fireEvent.click(await slot.findByLabelText("Delete Bash strict header"));
    fireEvent.click(await slot.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toEqual(["remove", { scope: "global", projectId: "proj_1", id: "bash-header", expectedSha256: "sha-bash-header" }]);
    expect(calls[1]).toEqual([
      "create",
      { scope: "global", projectId: "proj_1", title: "Bash strict header", tags: [], body: "set -euo pipefail", id: "bash-header", order: 20 },
    ]);
  });

  it("Alt+↓ moves a row within its scope", async () => {
    const calls: unknown[] = [];
    const slot = renderSlot(
      { component: SnippetsPage },
      { subPath: "" },
      { rpc: rpc({ move: (input) => (calls.push(input), { outcome: "moved", writes: 1 }) }), context: { projectId: "proj_1", threadId: null } },
    );
    const row = (await slot.findByText("Review this PR")).closest("tr")!;
    fireEvent.keyDown(row, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(calls).toEqual([{ scope: "global", projectId: "proj_1", id: "review-pr", toIndex: 1 }]));
  });

  it("edits a title in place and saves on Enter", async () => {
    const calls: unknown[] = [];
    const slot = renderSlot(
      { component: SnippetsPage },
      { subPath: "" },
      { rpc: rpc({ save: (input) => (calls.push(input), { outcome: "saved", snippet: LIST.snippets[1] }) }), context: { projectId: "proj_1", threadId: null } },
    );
    fireEvent.click(await slot.findByText("Review this PR"));
    const input = slot.getByLabelText("Title", { selector: "td input" });
    fireEvent.change(input, { target: { value: "Review a PR" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ scope: "global", id: "review-pr", expectedSha256: "sha-review-pr", title: "Review a PR", tags: ["review", "git"] });
  });

  it("shows a save blocked by the secret scan and keeps the text", async () => {
    const slot = renderSlot(
      { component: SnippetsPage },
      { subPath: "" },
      {
        rpc: rpc({ save: () => ({ outcome: "blocked", reasons: ["Looks like a secret (GitHub token on body line 1)."] }) }),
        context: { projectId: "proj_1", threadId: null },
      },
    );
    fireEvent.click((await slot.findByText("Bash strict header")).closest("tr")!.querySelector(".snip-preview")!);
    const body = slot.getByLabelText("Body") as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: "token here" } });
    fireEvent.blur(body);
    expect(await slot.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Not saved: Looks like a secret"));
    expect(body.value).toBe("token here");
  });
});
