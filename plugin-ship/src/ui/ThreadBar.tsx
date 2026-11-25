import { useCallback, useEffect, useState } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRpc,
  type ExperimentalThreadHeaderRowProps,
} from "@get-bb/plugin-sdk/app";
import type { ShipRpcContract, ThreadWatchSummary } from "../contract.js";
import { verdictTone, watchStateTone } from "./badge-helpers.js";

export function ThreadBar({ threadId, projectId }: ExperimentalThreadHeaderRowProps) {
  const rpc = useRpc<ShipRpcContract>();
  const navigate = useBbNavigate();
  const [summary, setSummary] = useState<ThreadWatchSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await rpc.call("getThreadWatch", { threadId, projectId });
      setSummary(res);
    } catch {
      setSummary(null);
    }
  }, [projectId, rpc, threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime("watches", () => {
    void load();
  });

  const watch = summary?.watch ?? null;
  if (!watch) return null;

  return (
    <div className="ship-thread-bar" data-testid="ship-thread-bar">
      <div className="ship-thread-bar-left">
        <strong>Ship Steward</strong>
        <span className="ship-mono">
          {watch.repo}#{watch.prNumber}
        </span>
        <span className="ship-dim ship-mono">
          {watch.headBranch} → {watch.baseBranch}
        </span>
        <span className={`ship-pill ${watchStateTone(watch.state)}`}>
          <span className="ship-dot" />
          {watch.state}
        </span>
        {watch.lastHeadSha && (
          <span className="ship-mono ship-dim">{watch.lastHeadSha.slice(0, 7)}</span>
        )}
        {summary?.latestReviewVerdict && (
          <span className={`ship-pill ${verdictTone(summary.latestReviewVerdict)}`}>
            Review: {summary.latestReviewVerdict}
          </span>
        )}
        {summary?.latestApprovalVerdict && (
          <span className={`ship-pill ${verdictTone(summary.latestApprovalVerdict)}`}>
            Approvals: {summary.latestApprovalVerdict}
          </span>
        )}
      </div>

      <button
        type="button"
        className="ship-btn is-sm"
        onClick={() => navigate.toPluginPanel("ship", { subPath: watch.id })}
      >
        Open in Ship
      </button>
    </div>
  );
}
