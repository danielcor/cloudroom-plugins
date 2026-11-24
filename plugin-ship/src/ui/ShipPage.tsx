import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { ShipRpcContract, ShipStatus, WatchRecord } from "../contract.js";

const TERMINAL_STATES = new Set(["stopped", "merged", "closed"]);

export function ShipPage(_props: PluginNavPanelProps) {
  const rpc = useRpc<ShipRpcContract>();
  const [status, setStatus] = useState<ShipStatus | null>(null);
  const [watches, setWatches] = useState<WatchRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [s, w] = await Promise.all([
        rpc.call("status", {}),
        rpc.call("listWatches", { limit: 100 }),
      ]);
      setStatus(s);
      setWatches(w);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Ship status.");
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useRealtime("watches", () => {
    void reload();
  });

  async function handleControl(id: string, action: "stop" | "pause" | "resume") {
    setBusyId(id);
    setError(null);
    try {
      await rpc.call("controlWatch", { id, action });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} watch.`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div data-testid="ship-page" style={{ display: "grid", gap: "16px", padding: "16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
        <div>
          <h1 style={{ margin: 0 }}>Ship PR Steward</h1>
          {status && (
            <div style={{ opacity: 0.75, fontSize: "13px" }}>
              v{status.pluginVersion} · Review: {status.defaultReviewMode} ({status.defaultReviewEffort}) · Poll:{" "}
              {status.pollIntervalSeconds}s · Active watches: {status.activeWatchCount} · Bot:{" "}
              {status.botConfigured ? status.botLogin || "configured" : "not configured"}
            </div>
          )}
        </div>
        <button type="button" onClick={() => void reload()} disabled={loading}>
          Refresh
        </button>
      </header>

      {error && (
        <div role="alert" style={{ padding: "8px 12px", border: "1px solid currentColor", borderRadius: "4px" }}>
          {error}
        </div>
      )}

      {loading && watches.length === 0 ? (
        <div>Loading watches…</div>
      ) : watches.length === 0 ? (
        <div data-testid="ship-empty-watches">
          No PR watches yet. Run <code>room-cli ship steward</code> in a pull request checkout to start watching.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
          <thead>
            <tr>
              <th>PR</th>
              <th>Branch</th>
              <th>State</th>
              <th>Head SHA</th>
              <th>Note</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {watches.map((w) => {
              const isTerminal = TERMINAL_STATES.has(w.state);
              const isBusy = busyId === w.id;
              return (
                <tr key={w.id} data-testid={`watch-row-${w.id}`}>
                  <td>
                    {w.repo}#{w.prNumber}
                  </td>
                  <td>
                    <code>{w.headBranch}</code> → <code>{w.baseBranch}</code>
                  </td>
                  <td>{w.state}</td>
                  <td>
                    <code>{w.lastHeadSha ? w.lastHeadSha.slice(0, 7) : "—"}</code>
                  </td>
                  <td>{w.stopReason ?? "—"}</td>
                  <td>
                    {!isTerminal && (
                      <div style={{ display: "flex", gap: "6px" }}>
                        {w.state === "paused" ? (
                          <button type="button" disabled={isBusy} onClick={() => void handleControl(w.id, "resume")}>
                            Resume
                          </button>
                        ) : (
                          <button type="button" disabled={isBusy} onClick={() => void handleControl(w.id, "pause")}>
                            Pause
                          </button>
                        )}
                        <button type="button" disabled={isBusy} onClick={() => void handleControl(w.id, "stop")}>
                          Stop
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
