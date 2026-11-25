import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type {
  ApprovalsMode,
  AutoStewardMode,
  RepoConfig,
  ReviewEffort,
  ReviewMode,
  ShipRpcContract,
} from "../contract.js";

const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;

export function RepoSettings() {
  const rpc = useRpc<ShipRpcContract>();
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [newRepoSlug, setNewRepoSlug] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Editable policy form state for selected repo
  const [reviewMode, setReviewMode] = useState<ReviewMode>("triad");
  const [reviewEffort, setReviewEffort] = useState<ReviewEffort>("high");
  const [autoSteward, setAutoSteward] = useState<AutoStewardMode>("manual");
  const [approvalsMode, setApprovalsMode] = useState<ApprovalsMode>("observe");
  const [maxPushesPerCause, setMaxPushesPerCause] = useState(3);
  const [maxReviewRounds, setMaxReviewRounds] = useState(4);
  const [trustedBotsText, setTrustedBotsText] = useState("");
  const [allowDevAutomerge, setAllowDevAutomerge] = useState(false);

  const hydrateForm = useCallback((cfg: RepoConfig) => {
    setReviewMode(cfg.reviewMode);
    setReviewEffort(cfg.reviewEffort);
    setAutoSteward(cfg.autoSteward);
    setApprovalsMode(cfg.approvalsMode);
    setMaxPushesPerCause(cfg.maxPushesPerCause);
    setMaxReviewRounds(cfg.maxReviewRounds);
    setTrustedBotsText(cfg.trustedBots.join(", "));
    setAllowDevAutomerge(cfg.allowDevAutomerge);
  }, []);

  const loadRepos = useCallback(async () => {
    try {
      const list = await rpc.call("listRepos", {});
      setRepos(list);
      setError(null);
      if (list.length > 0) {
        const current = list.find((r) => r.repo === selectedRepo) ?? list[0]!;
        setSelectedRepo(current.repo);
        hydrateForm(current);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load repositories.");
    } finally {
      setLoading(false);
    }
  }, [hydrateForm, rpc, selectedRepo]);

  useEffect(() => {
    void loadRepos();
  }, [loadRepos]);

  function selectRepoRow(cfg: RepoConfig) {
    setSelectedRepo(cfg.repo);
    setNotice(null);
    hydrateForm(cfg);
  }

  async function handleAddRepo(e: React.FormEvent) {
    e.preventDefault();
    const slug = newRepoSlug.trim();
    if (!REPO_SLUG_RE.test(slug)) {
      setError("Repository must use owner/repo format.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await rpc.call("upsertRepo", { repo: slug });
      setNewRepoSlug("");
      setSelectedRepo(created.repo);
      hydrateForm(created);
      await loadRepos();
      setNotice(`Added policy for ${created.repo}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add repository.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedRepo) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const trustedBots = trustedBotsText
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const updated = await rpc.call("upsertRepo", {
        repo: selectedRepo,
        reviewMode,
        reviewEffort,
        autoSteward,
        approvalsMode,
        maxPushesPerCause: Math.min(20, Math.max(1, Number(maxPushesPerCause) || 3)),
        maxReviewRounds: Math.min(10, Math.max(1, Number(maxReviewRounds) || 4)),
        trustedBots,
        allowDevAutomerge,
      });
      hydrateForm(updated);
      await loadRepos();
      setNotice(`Saved policy for ${updated.repo}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save repository policy.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ship-body" data-testid="ship-repos-tab">
      <div className="ship-pane-left">
        <form onSubmit={(e) => void handleAddRepo(e)} className="ship-toolbar">
          <input
            type="text"
            className="ship-input ship-input-sm"
            aria-label="New repository owner/repo"
            placeholder="owner/repo"
            value={newRepoSlug}
            onChange={(e) => setNewRepoSlug(e.target.value)}
          />
          <button type="submit" className="ship-btn is-primary" disabled={saving}>
            + Add Repo
          </button>
        </form>

        {error && <div className="ship-banner-err">{error}</div>}
        {notice && (
          <div className="ship-pill is-ok" style={{ width: "fit-content" }}>
            {notice}
          </div>
        )}

        {loading && repos.length === 0 ? (
          <div className="ship-dim">Loading repository policies…</div>
        ) : repos.length === 0 ? (
          <div className="ship-dim" data-testid="ship-empty-repos">
            No repositories configured yet. Add an <code>owner/repo</code> above to customize review, steward, and approvals policies.
          </div>
        ) : (
          <table className="ship-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>Review</th>
                <th>Steward</th>
                <th>Approvals</th>
                <th>Dev Auto-Merge</th>
              </tr>
            </thead>
            <tbody>
              {repos.map((r) => (
                <tr
                  key={r.repo}
                  data-testid={`repo-row-${r.repo}`}
                  className={`ship-row-clickable${selectedRepo === r.repo ? " ship-row-selected" : ""}`}
                  onClick={() => selectRepoRow(r)}
                >
                  <td>
                    <span className="ship-mono">{r.repo}</span>
                  </td>
                  <td>
                    {r.reviewMode} ({r.reviewEffort})
                  </td>
                  <td>{r.autoSteward}</td>
                  <td>{r.approvalsMode}</td>
                  <td>
                    {r.allowDevAutomerge ? (
                      <span className="ship-pill is-ok">dev only</span>
                    ) : (
                      <span className="ship-pill is-neu">off</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selectedRepo && (
        <aside className="ship-inspector" data-testid="repo-policy-editor">
          <div className="ship-ins-hdr">
            <div>
              <div className="ship-ins-title">Policy Editor</div>
              <div className="ship-ins-sub ship-mono">{selectedRepo}</div>
            </div>
          </div>

          <form onSubmit={(e) => void handleSave(e)} className="ship-form-grid">
            <label className="ship-field">
              <span className="ship-field-label">Review mode</span>
              <select
                className="ship-select"
                aria-label="Review mode"
                value={reviewMode}
                onChange={(e) => setReviewMode(e.target.value as ReviewMode)}
              >
                <option value="triad">triad</option>
                <option value="sol-loop">sol-loop</option>
                <option value="single">single</option>
              </select>
            </label>

            <label className="ship-field">
              <span className="ship-field-label">Review effort</span>
              <select
                className="ship-select"
                aria-label="Review effort"
                value={reviewEffort}
                onChange={(e) => setReviewEffort(e.target.value as ReviewEffort)}
              >
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="max">max</option>
              </select>
            </label>

            <label className="ship-field">
              <span className="ship-field-label">Auto Steward</span>
              <select
                className="ship-select"
                aria-label="Auto Steward"
                value={autoSteward}
                onChange={(e) => setAutoSteward(e.target.value as AutoStewardMode)}
              >
                <option value="manual">manual</option>
                <option value="auto">auto</option>
              </select>
            </label>

            <label className="ship-field">
              <span className="ship-field-label">Approvals mode</span>
              <select
                className="ship-select"
                aria-label="Approvals mode"
                value={approvalsMode}
                onChange={(e) => setApprovalsMode(e.target.value as ApprovalsMode)}
              >
                <option value="off">off</option>
                <option value="observe">observe</option>
                <option value="enforce">enforce</option>
              </select>
            </label>

            <label className="ship-field">
              <span className="ship-field-label">Max pushes / cause</span>
              <input
                type="number"
                min={1}
                max={20}
                className="ship-input"
                aria-label="Max pushes per cause"
                value={maxPushesPerCause}
                onChange={(e) => setMaxPushesPerCause(Number(e.target.value))}
              />
            </label>

            <label className="ship-field">
              <span className="ship-field-label">Max review rounds</span>
              <input
                type="number"
                min={1}
                max={10}
                className="ship-input"
                aria-label="Max review rounds"
                value={maxReviewRounds}
                onChange={(e) => setMaxReviewRounds(Number(e.target.value))}
              />
            </label>

            <label className="ship-field is-full">
              <span className="ship-field-label">Trusted bots (comma-separated)</span>
              <input
                type="text"
                className="ship-input"
                aria-label="Trusted bots"
                placeholder="coderabbitai, claude-ship-bot"
                value={trustedBotsText}
                onChange={(e) => setTrustedBotsText(e.target.value)}
              />
            </label>

            <label className="ship-chk-row is-full">
              <input
                type="checkbox"
                aria-label="Allow dev-only auto-merge"
                checked={allowDevAutomerge}
                onChange={(e) => setAllowDevAutomerge(e.target.checked)}
              />
              <span>
                <strong>Allow dev-only auto-merge</strong>
                <div className="ship-dim" style={{ fontSize: "11.5px", marginTop: "2px" }}>
                  Hard-blocked on main, master, beta, prod, and release branches. Requires clean Ship APPROVE review, green CI or exact-SHA Gate receipt, and 0 required human seats.
                </div>
              </span>
            </label>

            <div className="ship-field is-full">
              <button type="submit" className="ship-btn is-primary" disabled={saving}>
                {saving ? "Saving…" : "Save policy"}
              </button>
            </div>
          </form>
        </aside>
      )}
    </div>
  );
}
