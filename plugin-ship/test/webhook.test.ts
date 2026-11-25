import { createHmac } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createShipPlugin } from "../server.js";
import type { StewardPoller } from "../src/steward/poller.js";
import { verifyGitHubWebhookSignature } from "../src/webhook.js";

const fakeHosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  for (const h of fakeHosts.splice(0)) await h.harness.dispose();
});

function signPayload(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("GitHub HMAC-SHA256 webhook verification & wakeup route", () => {
  it("verifies HMAC-SHA256 signatures in constant time and rejects invalid inputs", () => {
    const secret = ["whsec_", "ship_test_hmac_secret_987"].join("");
    const body = JSON.stringify({ action: "synchronize", number: 12 });
    const sig = signPayload(body, secret);

    expect(verifyGitHubWebhookSignature(body, sig, secret)).toBe(true);
    expect(verifyGitHubWebhookSignature(`${body} `, sig, secret)).toBe(false);
    expect(verifyGitHubWebhookSignature(body, sig.replace("sha256=", "sha1="), secret)).toBe(false);
    expect(verifyGitHubWebhookSignature(body, "sha256=not-hex", secret)).toBe(false);
    expect(verifyGitHubWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyGitHubWebhookSignature(body, sig, "")).toBe(false);
  });

  it("enforces fail-closed 503/401, ignores ping cleanly, and triggers poller on valid events", async () => {
    const secret = ["whsec_", "ship_live_secret_value_321"].join("");
    let discoverCalls = 0;

    // 1) Missing webhookSecret -> 503
    const hostUnset = createFakePluginHost({ pluginId: "ship" });
    fakeHosts.push(hostUnset);
    await createShipPlugin({ disableBackgroundPoller: true })(hostUnset.bb);

    const unsetStatus = (await hostUnset.harness.callRpc("status", {})) as {
      webhookConfigured: boolean;
      webhookPath: string;
    };
    expect(unsetStatus.webhookConfigured).toBe(false);
    expect(unsetStatus.webhookPath).toBe("/api/v1/plugins/ship/http/webhook/github");

    const res503 = await hostUnset.harness.fetchHttp("POST", "/webhook/github", {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "ping" },
      body: JSON.stringify({ zen: "hello" }),
    });
    expect(res503.status).toBe(503);

    // 2) Configured webhookSecret -> enforces HMAC + triggers poller
    let pollerRef: StewardPoller | undefined;
    const host = createFakePluginHost({
      pluginId: "ship",
      settings: { webhookSecret: secret },
    });
    fakeHosts.push(host);
    await createShipPlugin({
      disableBackgroundPoller: true,
      discoverRepoPrs: async () => {
        discoverCalls += 1;
        return [];
      },
      onPollerReady: (p) => {
        pollerRef = p;
      },
    })(host.bb);

    const status = (await host.harness.callRpc("status", {})) as Record<string, unknown>;
    expect(status.webhookConfigured).toBe(true);
    expect(JSON.stringify(status)).not.toContain(secret);

    // Missing/invalid signature -> 401 + audited rejection without leaking secret
    const badBody = JSON.stringify({ action: "opened" });
    const res401Missing = await host.harness.fetchHttp("POST", "/webhook/github", {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request" },
      body: badBody,
    });
    expect(res401Missing.status).toBe(401);

    const res401Bad = await host.harness.fetchHttp("POST", "/webhook/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
      },
      body: badBody,
    });
    expect(res401Bad.status).toBe(401);

    // Enable auto-steward repo so tickOnce runs discoverRepoPrs
    await host.harness.callRpc("upsertRepo", { repo: "acme/hook-demo", autoSteward: "auto" });

    // Valid ping -> 200 without triggering poller
    const pingBody = JSON.stringify({ zen: "pong" });
    const resPing = await host.harness.fetchHttp("POST", "/webhook/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": signPayload(pingBody, secret),
      },
      body: pingBody,
    });
    expect(resPing.status).toBe(200);
    expect(await resPing.json()).toEqual({ ok: true, event: "ping", triggered: false });
    expect(discoverCalls).toBe(0);

    // Valid pull_request event -> 202 + triggers poller tick
    const prBody = JSON.stringify({ action: "synchronize", number: 44 });
    const res202 = await host.harness.fetchHttp("POST", "/webhook/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signPayload(prBody, secret),
      },
      body: prBody,
    });
    expect(res202.status).toBe(202);
    expect(await res202.json()).toEqual({ ok: true, event: "pull_request", triggered: true });
    expect(pollerRef).toBeDefined();

    // Flush async tickOnce()
    await new Promise((r) => setTimeout(r, 25));
    expect(discoverCalls).toBeGreaterThanOrEqual(1);

    const audits = (await host.harness.callRpc("listAudit", { limit: 10 })) as Array<{ action: string; detailJson: string }>;
    expect(audits.some((a) => a.action === "webhook.received")).toBe(true);
    expect(audits.some((a) => a.action === "webhook.rejected")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(secret);
  });
});
