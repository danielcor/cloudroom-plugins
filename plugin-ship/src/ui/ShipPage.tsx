import { useCallback, useEffect, useMemo, useState } from "react";
import { useRealtime, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type {
  ShipRpcContract,
  ShipStatus,
  VerifyBotOutput,
  WatchRecord,
} from "../contract.js";
import { RepoSettings } from "./RepoSettings.js";
import { WatchDetail } from "./WatchDetail.js";
import { watchStateTone } from "./badge-helpers.js";

const TERMINAL_STATES = new Set(["stopped", "merged", "closed"]);

type DashboardTab = "watches" | "repos" | "setup";
type WatchFilter = "all" | "active" | "needs_human";

export function ShipPage({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<ShipRpcContract>();
  const [status, setStatus] = useState<ShipStatus | null>(null);
  const [watches, setWatches] = useState<WatchRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<DashboardTab>("watches");
  const [filter, setFilter] = useState<WatchFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedWatchId, setSelectedWatchId] = useState<string | null>(null);

  // Inline "+ Watch PR" modal state
  const [showWatchModal, setShowWatchModal] = useState(false);
  const [watchRepo, setWatchRepo] = useState("");
  const [watchPrNum, setWatchPrNum] = useState("");
  const [watchBaseBranch, setWatchBaseBranch] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(true);
  const [startingWatch, setStartingWatch] = useState(false);

  // Setup tab bot verifier state
  const [verifyingBot, setVerifyingBot] = useState(false);
  const [botVerifyResult, setBotVerifyResult] = useState<VerifyBotOutput | null>(null);

  useEffect(() => {
    const clean = (subPath ?? "").trim();
    if (!clean) return;
    if (clean === "repos") {
      setActiveTab("repos");
      return;
    }
    if (clean === "setup") {
      setActiveTab("setup");
      return;
    }
    try {
      setSelectedWatchId(decodeURIComponent(clean));
    } catch {
      setSelectedWatchId(clean);
    }
    setActiveTab("watches");
  }, [subPath]);

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

  async function handleStartWatch(e: React.FormEvent) {
    e.preventDefault();
    const prNumber = Number.parseInt(watchPrNum.trim(), 10);
    if (!watchRepo.trim() || !Number.isFinite(prNumber) || prNumber <= 0) {
      setError("Enter a valid repository (owner/repo) and PR number.");
      return;
    }
    setStartingWatch(true);
    setError(null);
    try {
      const res = await rpc.call("startWatch", {
        repo: watchRepo.trim(),
        prNumber,
        ...(watchBaseBranch.trim() ? { baseBranch: watchBaseBranch.trim() } : {}),
        acceptTerms,
      });
      setShowWatchModal(false);
      setWatchRepo("");
      setWatchPrNum("");
      setWatchBaseBranch("");
      setSelectedWatchId(res.watch.id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start watch.");
    } finally {
      setStartingWatch(false);
    }
  }

  async function handleVerifyBot() {
    setVerifyingBot(true);
    setError(null);
    try {
      const res = await rpc.call("verifyBot", {});
      setBotVerifyResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to verify bot token.");
    } finally {
      setVerifyingBot(false);
    }
  }

  const filteredWatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return watches.filter((w) => {
      if (filter === "active" && TERMINAL_STATES.has(w.state)) return false;
      if (filter === "needs_human" && w.state !== "needs_human") return false;
      if (!q) return true;
      return (
        w.repo.toLowerCase().includes(q) ||
        w.headBranch.toLowerCase().includes(q) ||
        w.baseBranch.toLowerCase().includes(q) ||
        String(w.prNumber).includes(q)
      );
    });
  }, [filter, searchQuery, watches]);

  const activeCount = useMemo(
    () => watches.filter((w) => !TERMINAL_STATES.has(w.state)).length,
    [watches],
  );
  const needsHumanCount = useMemo(
    () => watches.filter((w) => w.state === "needs_human").length,
    [watches],
  );

  return (
    <div className="ship-root" data-testid="ship-page">
      <header className="ship-subhdr">
        <div className="ship-title-block">
          <h1>Ship PR Steward</h1>
          {status && (
            <div className="ship-subline">
              v{status.pluginVersion} · Review: {status.defaultReviewMode} ({status.defaultReviewEffort}) · Poll:{" "}
              {status.pollIntervalSeconds}s · Active watches: {status.activeWatchCount} · Bot:{" "}
              {status.botConfigured ? status.botLogin || "configured" : "not configured"}
            </div>
          )}
        </div>

        <nav className="ship-tabs" role="tablist" aria-label="Ship sections">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "watches"}
            className={`ship-tab${activeTab === "watches" ? " is-active" : ""}`}
            onClick={() => setActiveTab("watches")}
          >
            Watches <span className="ship-cnt">{watches.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "repos"}
            className={`ship-tab${activeTab === "repos" ? " is-active" : ""}`}
            onClick={() => setActiveTab("repos")}
          >
            Repos <span className="ship-cnt">{status?.repoCount ?? 0}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "setup"}
            className={`ship-tab${activeTab === "setup" ? " is-active" : ""}`}
            onClick={() => setActiveTab("setup")}
          >
            Setup &amp; Commands
          </button>
        </nav>

        <div className="ship-spacer" />

        {status && (
          <span className={`ship-pill ${status.botConfigured ? "is-ok" : "is-warn"}`}>
            <span className="ship-dot" />
            {status.botConfigured ? `Bot: ${status.botLogin || "configured"}` : "Bot not set"}
          </span>
        )}

        <button
          type="button"
          className="ship-btn is-primary"
          onClick={() => {
            setActiveTab("watches");
            setShowWatchModal((v) => !v);
          }}
        >
          + Watch PR
        </button>

        <button type="button" className="ship-btn" onClick={() => void reload()} disabled={loading}>
          Refresh
        </button>
      </header>

      {activeTab === "watches" && (
        <div className="ship-guide-strip" data-testid="ship-guide-strip">
          <span className="ship-guide-item">
            <span className="ship-cmd-pill">/ship</span> Publish &amp; review
          </span>
          <span className="ship-dim">·</span>
          <span className="ship-guide-item">
            <span className="ship-cmd-pill">/steward</span> Watch PR cleanly
          </span>
          <span className="ship-dim">·</span>
          <span className="ship-guide-item">
            <span className="ship-cmd-pill">/ship-approvals</span> Policy &amp; dev auto-merge
          </span>
          <span className="ship-dim">·</span>
          <span className="ship-guide-item">
            <span className="ship-cmd-pill">room-cli ship gate run</span> Container merge-guard
          </span>
        </div>
      )}

      {error && (
        <div role="alert" className="ship-banner-err">
          {error}
        </div>
      )}

      {showWatchModal && activeTab === "watches" && (
        <form
          onSubmit={(e) => void handleStartWatch(e)}
          className="ship-modal-card"
          data-testid="watch-pr-modal"
        >
          <div className="ship-card-hdr">
            <span>Start Watching a Pull Request</span>
            <button type="button" className="ship-btn is-sm" onClick={() => setShowWatchModal(false)}>
              Cancel
            </button>
          </div>
          <div className="ship-form-grid">
            <label className="ship-field">
              <span className="ship-field-label">Repository</span>
              <input
                type="text"
                className="ship-input"
                aria-label="Watch repository"
                placeholder="owner/repo"
                value={watchRepo}
                onChange={(e) => setWatchRepo(e.target.value)}
              />
            </label>
            <label className="ship-field">
              <span className="ship-field-label">PR number</span>
              <input
                type="number"
                min={1}
                className="ship-input"
                aria-label="Watch PR number"
                placeholder="42"
                value={watchPrNum}
                onChange={(e) => setWatchPrNum(e.target.value)}
              />
            </label>
            <label className="ship-field">
              <span className="ship-field-label">Base branch (optional)</span>
              <input
                type="text"
                className="ship-input"
                aria-label="Watch base branch"
                placeholder="dev or main"
                value={watchBaseBranch}
                onChange={(e) => setWatchBaseBranch(e.target.value)}
              />
            </label>
            <label className="ship-chk-row" style={{ alignSelf: "end" }}>
              <input
                type="checkbox"
                checked={acceptTerms}
                onChange={(e) => setAcceptTerms(e.target.checked)}
              />
              <span>Accept PR Steward autonomous watch terms</span>
            </label>
          </div>
          <div className="ship-actions-row">
            <button type="submit" className="ship-btn is-primary" disabled={startingWatch}>
              {startingWatch ? "Starting…" : "Start Watch"}
            </button>
          </div>
        </form>
      )}

      {activeTab === "watches" && (
        <div className="ship-body">
          <div className="ship-pane-left">
            <div className="ship-toolbar">
              <div className="ship-seg" role="group" aria-label="Filter watches">
                <button
                  type="button"
                  className={`ship-seg-btn${filter === "all" ? " is-active" : ""}`}
                  onClick={() => setFilter("all")}
                >
                  All ({watches.length})
                </button>
                <button
                  type="button"
                  className={`ship-seg-btn${filter === "active" ? " is-active" : ""}`}
                  onClick={() => setFilter("active")}
                >
                  Active ({activeCount})
                </button>
                <button
                  type="button"
                  className={`ship-seg-btn${filter === "needs_human" ? " is-active" : ""}`}
                  onClick={() => setFilter("needs_human")}
                >
                  Needs Human ({needsHumanCount})
                </button>
              </div>
              <input
                type="search"
                className="ship-input ship-input-sm"
                aria-label="Search watches"
                placeholder="Filter by repo, branch, or PR #"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            {loading && watches.length === 0 ? (
              <div>Loading watches…</div>
            ) : filteredWatches.length === 0 ? (
              <div data-testid="ship-empty-watches">
                No PR watches yet. Run <code>room-cli ship steward</code> in a pull request checkout to start watching.
              </div>
            ) : (
              <table className="ship-table">
                <thead>
                  <tr>
                    <th>PR</th>
                    <th>Branch</th>
                    <th>State</th>
                    <th>Head SHA</th>
                    <th>Note</th>
                    <th className="ship-actions-cell">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredWatches.map((w) => {
                    const isTerminal = TERMINAL_STATES.has(w.state);
                    const isBusy = busyId === w.id;
                    const isSelected = selectedWatchId === w.id;
                    return (
                      <tr
                        key={w.id}
                        data-testid={`watch-row-${w.id}`}
                        className={`ship-row-clickable${isSelected ? " ship-row-selected" : ""}`}
                        onClick={() => setSelectedWatchId(w.id)}
                      >
                        <td>{w.repo}#{w.prNumber}</td>
                        <td>
                          <code>{w.headBranch}</code> → <code>{w.baseBranch}</code>
                        </td>
                        <td>
                          <span className={`ship-pill ${watchStateTone(w.state)}`}>
                            <span className="ship-dot" />
                            {w.state}
                          </span>
                        </td>
                        <td>
                          <code>{w.lastHeadSha ? w.lastHeadSha.slice(0, 7) : "—"}</code>
                        </td>
                        <td className="ship-dim">{w.stopReason ?? "—"}</td>
                        <td
                          className="ship-actions-cell"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {!isTerminal && (
                            <div className="ship-actions-row">
                              {w.state === "paused" ? (
                                <button
                                  type="button"
                                  className="ship-btn is-sm"
                                  disabled={isBusy}
                                  onClick={() => void handleControl(w.id, "resume")}
                                >
                                  Resume
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="ship-btn is-sm"
                                  disabled={isBusy}
                                  onClick={() => void handleControl(w.id, "pause")}
                                >
                                  Pause
                                </button>
                              )}
                              <button
                                type="button"
                                className="ship-btn is-sm is-danger"
                                disabled={isBusy}
                                onClick={() => void handleControl(w.id, "stop")}
                              >
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

          {selectedWatchId && (
            <WatchDetail
              watchId={selectedWatchId}
              onClose={() => setSelectedWatchId(null)}
              onControl={handleControl}
              busyId={busyId}
            />
          )}
        </div>
      )}

      {activeTab === "repos" && <RepoSettings />}

      {activeTab === "setup" && (
        <div className="ship-pane-left" data-testid="ship-setup-tab">
          <div className="ship-card">
            <div className="ship-card-hdr">
              <span>Dual-Identity GitHub Bot Configuration</span>
              <button
                type="button"
                className="ship-btn is-sm is-primary"
                disabled={verifyingBot}
                onClick={() => void handleVerifyBot()}
              >
                {verifyingBot ? "Verifying…" : "Verify bot"}
              </button>
            </div>
            <div className="ship-dim">
              Author push/PR actions run via your personal <code>gh</code> identity; Ship reviews, Commit Statuses, and Approvals post strictly under <code>botToken</code>.
            </div>
            <pre className="ship-code-cmd">
              room-cli plugin config ship set botLogin "&lt;bot-username&gt;"{"\n"}
              room-cli plugin config ship set botToken "&lt;fine-grained-pat&gt;"{"\n"}
              room-cli ship bot-verify --json
            </pre>
            {botVerifyResult && (
              <div
                data-testid="bot-verify-result"
                className={`ship-pill ${botVerifyResult.ok ? "is-ok" : "is-err"}`}
                style={{ width: "fit-content" }}
              >
                {botVerifyResult.ok
                  ? `Verified as ${botVerifyResult.login} (id ${botVerifyResult.viewerId})`
                  : botVerifyResult.error || "Bot verification failed"}
              </div>
            )}
          </div>

          <div className="ship-card" data-testid="setup-webhook-card">
            <div className="ship-card-hdr">
              <span>Optional HMAC-SHA256 GitHub Webhook</span>
              <span className={`ship-pill ${status?.webhookConfigured ? "is-ok" : "is-neu"}`}>
                {status?.webhookConfigured ? "configured" : "polling only"}
              </span>
            </div>
            <div className="ship-dim">
              Set <code>webhookSecret</code> to enable instant wakeups (on{" "}
              <code>pull_request</code>, <code>check_run</code>, <code>check_suite</code>,{" "}
              <code>issue_comment</code>, <code>pull_request_review</code>) without waiting for the 120s poll interval.
            </div>
            <pre className="ship-code-cmd">
              Endpoint: {status?.webhookPath ?? "/api/v1/plugins/ship/http/webhook/github"}
              {"\n"}
              room-cli plugin config ship set webhookSecret "&lt;random-hmac-secret&gt;"
            </pre>
          </div>

          <div className="ship-card" data-testid="setup-container-gates-card">
            <div className="ship-card-hdr">
              <span>Container Merge-Guard Gates</span>
              <span className="ship-pill is-info">cloudroom-sandbox-gates</span>
            </div>
            <div className="ship-dim">
              Runs repo-owned container merge-guard gates exclusively inside Cloudroom Cloud sandboxes (or ephemeral <code>--cloud</code> child threads) and emits exact-SHA <code>Gate receipt</code> blocks plus deterministic conflict-only <code>merge-eligibility.sh</code> checks.
            </div>
            <pre className="ship-code-cmd">
              room-cli ship gate inspect --json{"\n"}
              room-cli ship gate eligibility &lt;pr&gt; --policy conflict-only --json{"\n"}
              room-cli ship gate run --cloud --mode smoke --json
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
