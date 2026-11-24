import { useEffect, useRef, useState } from "react";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";

interface ParsedConfirmPayload {
  repoSlug: string;
  isPrivate: boolean;
  remote: string;
  targetBranch: string;
  createBranch: boolean;
  baseBranch: string;
  filesToStage: string[];
  aheadCount: number;
  existingPrNumber: number | null;
  existingPrUrl: string | null;
  commitMessage: string;
  prTitle: string;
  prBody: string;
  draft: boolean;
  warnings: Array<{ code: string; message: string }>;
  dwellMs: number;
}

const MIN_DWELL_MS = 3500;

function parseConfirmPayload(raw: unknown): ParsedConfirmPayload {
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const str = (key: string, fallback = ""): string => (typeof obj[key] === "string" ? (obj[key] as string) : fallback);
  const bool = (key: string, fallback = false): boolean =>
    typeof obj[key] === "boolean" ? (obj[key] as boolean) : fallback;
  const num = (key: string, fallback = 0): number =>
    typeof obj[key] === "number" && Number.isFinite(obj[key]) ? (obj[key] as number) : fallback;

  const filesToStage = Array.isArray(obj.filesToStage)
    ? obj.filesToStage.filter((x): x is string => typeof x === "string")
    : [];
  const warnings = Array.isArray(obj.warnings)
    ? obj.warnings
        .filter((w): w is { code: string; message: string } => {
          if (typeof w !== "object" || w === null) return false;
          const r = w as Record<string, unknown>;
          return typeof r.code === "string" && typeof r.message === "string";
        })
    : [];

  return {
    repoSlug: str("repoSlug", "unknown/repo"),
    isPrivate: bool("isPrivate", true),
    remote: str("remote", "origin"),
    targetBranch: str("targetBranch", ""),
    createBranch: bool("createBranch", false),
    baseBranch: str("baseBranch", "main"),
    filesToStage,
    aheadCount: num("aheadCount", 0),
    existingPrNumber: typeof obj.existingPrNumber === "number" ? obj.existingPrNumber : null,
    existingPrUrl: typeof obj.existingPrUrl === "string" ? obj.existingPrUrl : null,
    commitMessage: str("commitMessage", ""),
    prTitle: str("prTitle", ""),
    prBody: str("prBody", ""),
    draft: bool("draft", false),
    warnings,
    dwellMs: Math.max(MIN_DWELL_MS, num("dwellMs", MIN_DWELL_MS)),
  };
}

export function PublishConfirmCard({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const parsed = parseConfirmPayload(interaction.payload);
  const [commitMessage, setCommitMessage] = useState(parsed.commitMessage);
  const [prTitle, setPrTitle] = useState(parsed.prTitle);
  const [prBody, setPrBody] = useState(parsed.prBody);
  const [draft, setDraft] = useState(parsed.draft);
  const [remainingMs, setRemainingMs] = useState(parsed.dwellMs);
  const [submitting, setSubmitting] = useState(false);
  const mountTimeRef = useRef<number>(Date.now());

  useEffect(() => {
    mountTimeRef.current = Date.now();
    setRemainingMs(parsed.dwellMs);
    const id = setInterval(() => {
      const elapsed = Date.now() - mountTimeRef.current;
      const left = Math.max(0, parsed.dwellMs - elapsed);
      setRemainingMs(left);
      if (left === 0) clearInterval(id);
    }, 100);
    return () => clearInterval(id);
  }, [interaction.id, parsed.dwellMs]);

  const hasFilesToCommit = parsed.filesToStage.length > 0;
  const canSubmit =
    prTitle.trim().length > 0 &&
    prBody.trim().length > 0 &&
    (!hasFilesToCommit || commitMessage.trim().length > 0);

  async function handleAllow() {
    if (submitting || remainingMs > 0 || !canSubmit) return;
    setSubmitting(true);
    try {
      await submit({
        approved: true,
        prTitle: prTitle.trim(),
        prBody: prBody.trim(),
        commitMessage: hasFilesToCommit ? commitMessage.trim() : "",
        draft,
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await cancel();
    } finally {
      setSubmitting(false);
    }
  }

  const shownFiles = parsed.filesToStage.slice(0, 15);
  const hiddenCount = Math.max(0, parsed.filesToStage.length - shownFiles.length);
  const dwellSeconds = Math.ceil(remainingMs / 1000);

  return (
    <div data-testid="ship-publish-confirm-card" style={{ display: "grid", gap: "10px", padding: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
        <strong>Publish to GitHub: {parsed.repoSlug}</strong>
        <span>{parsed.isPrivate ? "Private repo" : "Public repo"}</span>
      </div>

      {!parsed.isPrivate && hasFilesToCommit && (
        <div role="alert" style={{ padding: "8px", border: "1px solid currentColor", borderRadius: "4px" }}>
          Warning: this is a <strong>public repository</strong>. Confirm you intend to commit and push {parsed.filesToStage.length} file(s).
        </div>
      )}

      <div>
        <span>
          Branch: <code>{parsed.targetBranch}</code> → <code>{parsed.baseBranch}</code> ({parsed.remote})
        </span>
        {parsed.createBranch && <span> · (new branch)</span>}
        {parsed.existingPrNumber !== null && <span> · Updating PR #{parsed.existingPrNumber}</span>}
      </div>

      {parsed.warnings.length > 0 && (
        <ul>
          {parsed.warnings.map((w) => (
            <li key={w.code}>{w.message}</li>
          ))}
        </ul>
      )}

      {hasFilesToCommit && (
        <div>
          <div>Files to stage &amp; commit ({parsed.filesToStage.length}):</div>
          <ul>
            {shownFiles.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
            {hiddenCount > 0 && <li>+{hiddenCount} more</li>}
          </ul>
        </div>
      )}

      {!hasFilesToCommit && (
        <div>
          Pushing {parsed.aheadCount} existing commit(s); working tree has no new file changes.
        </div>
      )}

      {hasFilesToCommit && (
        <label style={{ display: "grid", gap: "4px" }}>
          <span>Commit message</span>
          <input
            type="text"
            aria-label="Commit message"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
          />
        </label>
      )}

      <label style={{ display: "grid", gap: "4px" }}>
        <span>PR title</span>
        <input
          type="text"
          aria-label="PR title"
          value={prTitle}
          onChange={(e) => setPrTitle(e.target.value)}
        />
      </label>

      <label style={{ display: "grid", gap: "4px" }}>
        <span>PR description</span>
        <textarea
          rows={5}
          aria-label="PR description"
          value={prBody}
          onChange={(e) => setPrBody(e.target.value)}
        />
      </label>

      {parsed.existingPrNumber === null && (
        <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <input
            type="checkbox"
            checked={draft}
            onChange={(e) => setDraft(e.target.checked)}
          />
          <span>Open as draft</span>
        </label>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
        <button type="button" onClick={() => void handleCancel()} disabled={submitting}>
          Cancel
        </button>
        <button type="button" onClick={() => void handleAllow()} disabled={submitting || remainingMs > 0 || !canSubmit}>
          {remainingMs > 0 ? `Allow & Publish (${dwellSeconds}s…)` : "Allow & Publish"}
        </button>
      </div>
    </div>
  );
}
