import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ShipRpcContract, WatchDetail as WatchDetailData } from "../contract.js";
import {
  formatShortTime,
  summarizeAuditDetail,
  verdictTone,
  watchStateTone,
} from "./badge-helpers.js";

const TERMINAL_STATES = new Set(["stopped", "merged", "closed"]);

export interface WatchDetailProps {
  watchId: string;
  onClose: () => void;
  onControl: (id: string, action: "stop" | "pause" | "resume") => Promise<void>;
  busyId: string | null;
}

export function WatchDetail({ watchId, onClose, onControl, busyId }: WatchDetailProps) {
  const rpc = useRpc<ShipRpcContract>();
  const [detail, setDetail] = useState<WatchDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await rpc.call("getWatchDetail", { id: watchId });
      setDetail(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load watch details.");
    } finally {
      setLoading(false);
    }
  }, [rpc, watchId]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime("watches", () => {
    void load();
  });

  if (loading && !detail) {
    return (
      <aside className="ship-inspector" data-testid="watch-detail-drawer" aria-label="Watch inspector">
        <div className="ship-ins-hdr">
          <div className="ship-ins-title">Loading watch…</div>
          <button type="button" className="ship-btn is-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </aside>
    );
  }

  if (error || !detail) {
    return (
      <aside className="ship-inspector" data-testid="watch-detail-drawer" aria-label="Watch inspector">
        <div className="ship-ins-hdr">
          <div className="ship-ins-title">Watch details unavailable</div>
          <button type="button" className="ship-btn is-sm" onClick={onClose}>
            Close
          </button>
        </div>
        {error && <div className="ship-banner-err">{error}</div>}
      </aside>
    );
  }

  const { watch, budgets, latestReview, findings, latestApproval, audits } = detail;
  const isTerminal = TERMINAL_STATES.has(watch.state);
  const isBusy = busyId === watch.id;
  const totalPushes = Object.values(budgets.causePushCounts).reduce((acc, n) => acc + n, 0);

  return (
    <aside className="ship-inspector" data-testid="watch-detail-drawer" aria-label="Watch inspector">
      <div className="ship-ins-hdr">
        <div>
          <div className="ship-ins-title">
            {watch.repo}#{watch.prNumber}
          </div>
          <div className="ship-ins-sub">
            <span className="ship-mono">{watch.headBranch}</span> →{" "}
            <span className="ship-mono">{watch.baseBranch}</span> ·{" "}
            <span className="ship-mono">{watch.lastHeadSha ? watch.lastHeadSha.slice(0, 7) : "—"}</span>
          </div>
        </div>
        <div className="ship-actions-row">
          <span className={`ship-pill ${watchStateTone(watch.state)}`}>
            <span className="ship-dot" />
            {watch.state}
          </span>
          <button type="button" className="ship-btn is-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {watch.stopReason && (
        <div className="ship-banner-warn" data-testid="watch-detail-reason">
          <strong>Status note:</strong> {watch.stopReason}
        </div>
      )}

      {!isTerminal && (
        <div className="ship-actions-row">
          {watch.state === "paused" ? (
            <button
              type="button"
              className="ship-btn is-sm"
              disabled={isBusy}
              onClick={() => void onControl(watch.id, "resume")}
            >
              Resume watch
            </button>
          ) : (
            <button
              type="button"
              className="ship-btn is-sm"
              disabled={isBusy}
              onClick={() => void onControl(watch.id, "pause")}
            >
              Pause watch
            </button>
          )}
          <button
            type="button"
            className="ship-btn is-sm is-danger"
            disabled={isBusy}
            onClick={() => void onControl(watch.id, "stop")}
          >
            Stop watch
          </button>
        </div>
      )}

      <div className="ship-stat-grid" data-testid="watch-detail-budgets">
        <div className="ship-stat-box">
          <div className="ship-stat-lbl">Pushes</div>
          <div className="ship-stat-val">
            {totalPushes} / {budgets.maxPushesPerCause} max
          </div>
        </div>
        <div className="ship-stat-box">
          <div className="ship-stat-lbl">Behind</div>
          <div className="ship-stat-val">
            {budgets.behindMergesCount} / {budgets.maxBehindMerges}
          </div>
        </div>
        <div className="ship-stat-box">
          <div className="ship-stat-lbl">Reruns</div>
          <div className="ship-stat-val">{budgets.rerunJobIds.length} jobs</div>
        </div>
        <div className="ship-stat-box">
          <div className="ship-stat-lbl">Tamper pins</div>
          <div className="ship-stat-val">{budgets.pinsCount} verified</div>
        </div>
      </div>

      <section className="ship-card" data-testid="watch-detail-review">
        <div className="ship-card-hdr">
          <span>Latest Review</span>
          {latestReview ? (
            <span className={`ship-pill ${verdictTone(latestReview.verdict)}`}>
              {latestReview.verdict}
            </span>
          ) : (
            <span className="ship-dim">none yet</span>
          )}
        </div>
        {latestReview ? (
          <>
            <div className="ship-dim" style={{ fontSize: "12px" }}>
              Mode: {latestReview.mode} · Round {latestReview.round} · Seats: {latestReview.seats.length}
              {latestReview.meanScore !== null ? ` · Score ${latestReview.meanScore.toFixed(1)}/10` : ""}
            </div>
            {findings.length === 0 ? (
              <div className="ship-dim" style={{ fontSize: "12px" }}>
                Zero findings on HEAD {latestReview.headSha.slice(0, 7)}.
              </div>
            ) : (
              findings.slice(0, 8).map((f) => (
                <div key={f.id} className="ship-finding">
                  <span className="ship-finding-sev">{f.severity.toUpperCase()}</span>
                  <span className="ship-mono">
                    {f.file}
                    {f.line ? `:${f.line}` : ""}
                  </span>{" "}
                  — {f.claim}
                </div>
              ))
            )}
          </>
        ) : (
          <div className="ship-dim" style={{ fontSize: "12px" }}>
            Run <code>room-cli ship review</code> to evaluate committed changes.
          </div>
        )}
      </section>

      <section className="ship-card" data-testid="watch-detail-approvals">
        <div className="ship-card-hdr">
          <span>Approvals &amp; Container Gate</span>
          {latestApproval ? (
            <span className={`ship-pill ${verdictTone(latestApproval.verdict)}`}>
              {latestApproval.verdict} ({latestApproval.mode})
            </span>
          ) : (
            <span className="ship-dim">not evaluated</span>
          )}
        </div>
        {latestApproval ? (
          <div className="ship-dim" style={{ fontSize: "12px" }}>
            Seats required: {latestApproval.requiredSeats} · Rules:{" "}
            {latestApproval.matchedRuleIds.join(", ") || "default_action"} · Status:{" "}
            {latestApproval.statusPosted ? "posted" : "local"}
          </div>
        ) : (
          <div className="ship-dim" style={{ fontSize: "12px" }}>
            Run <code>room-cli ship approvals check {watch.prNumber}</code> to evaluate default-branch policy and sandbox gate receipts.
          </div>
        )}
      </section>

      <section className="ship-card" data-testid="watch-detail-audit">
        <div className="ship-card-hdr">
          <span>Audit Trail</span>
          <span className="ship-dim">{audits.length} events</span>
        </div>
        {audits.length === 0 ? (
          <div className="ship-dim" style={{ fontSize: "12px" }}>
            No audit events recorded for this watch.
          </div>
        ) : (
          <div className="ship-audit-list">
            {audits.slice(0, 12).map((a) => (
              <div key={a.id} className="ship-audit-row">
                <span className="ship-mono ship-dim">{formatShortTime(a.ts)}</span>
                <span className="ship-mono" style={{ fontWeight: 600 }}>
                  {a.action}
                </span>
                <span className="ship-dim">{summarizeAuditDetail(a.detailJson) || a.outcome}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}
