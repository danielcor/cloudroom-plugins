import type Database from "better-sqlite3";
import type {
  ApprovalsMode,
  AuditEntry,
  AutoStewardMode,
  RepoConfig,
  ReviewEffort,
  ReviewMode,
  WatchRecord,
} from "./contract.js";

/**
 * Append-only SQLite migrations executed through `bb.storage.migrate`.
 * Never reorder or edit shipped statements; append new entries at the end.
 */
export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS repos (
    repo TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    review_mode TEXT NOT NULL DEFAULT 'triad',
    review_effort TEXT NOT NULL DEFAULT 'high',
    auto_steward TEXT NOT NULL DEFAULT 'manual',
    approvals_mode TEXT NOT NULL DEFAULT 'observe',
    allow_dev_automerge INTEGER NOT NULL DEFAULT 0,
    trusted_bots_json TEXT NOT NULL DEFAULT '[]',
    max_pushes_per_cause INTEGER NOT NULL DEFAULT 3,
    max_review_rounds INTEGER NOT NULL DEFAULT 4,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS watches (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    host_id TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    head_branch TEXT NOT NULL,
    head_remote TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    base_remote TEXT NOT NULL,
    author_login TEXT NOT NULL,
    state TEXT NOT NULL,
    last_head_sha TEXT,
    last_state_hash TEXT,
    last_woke_at INTEGER,
    started_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    worker_thread_id TEXT,
    pins_json TEXT NOT NULL DEFAULT '{}',
    bots_json TEXT NOT NULL DEFAULT '[]',
    seen_comments_json TEXT NOT NULL DEFAULT '[]',
    cause_push_counts_json TEXT NOT NULL DEFAULT '{}',
    rerun_job_ids_json TEXT NOT NULL DEFAULT '[]',
    behind_merges_count INTEGER NOT NULL DEFAULT 0,
    stop_reason TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_watches_state ON watches(state)`,
  `CREATE INDEX IF NOT EXISTS idx_watches_repo_pr ON watches(repo, pr_number)`,
  `CREATE TABLE IF NOT EXISTS review_runs (
    id TEXT PRIMARY KEY,
    watch_id TEXT,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    mode TEXT NOT NULL,
    round INTEGER NOT NULL,
    seats_json TEXT NOT NULL DEFAULT '[]',
    verdict TEXT NOT NULL,
    mean_score REAL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS review_findings (
    id TEXT PRIMARY KEY,
    review_run_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    file TEXT NOT NULL,
    line INTEGER,
    claim TEXT NOT NULL,
    raisers_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    resolution_sha TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS approval_runs (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    policy_sha TEXT NOT NULL,
    mode TEXT NOT NULL,
    verdict_json TEXT NOT NULL,
    classifier_cache_json TEXT NOT NULL DEFAULT '{}',
    status_posted INTEGER NOT NULL DEFAULT 0,
    review_posted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watch_id TEXT,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    outcome TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_watch_ts ON audit_log(watch_id, ts DESC)`,
];

export interface RepoUpsertPatch {
  repo: string;
  enabled?: boolean;
  reviewMode?: ReviewMode;
  reviewEffort?: ReviewEffort;
  autoSteward?: AutoStewardMode;
  approvalsMode?: ApprovalsMode;
  allowDevAutomerge?: boolean;
  trustedBots?: string[];
  maxPushesPerCause?: number;
  maxReviewRounds?: number;
}

export interface RepoDefaults {
  reviewMode: ReviewMode;
  reviewEffort: ReviewEffort;
  maxPushesPerCause: number;
}

interface RepoRow {
  repo: string;
  enabled: number;
  review_mode: ReviewMode;
  review_effort: ReviewEffort;
  auto_steward: AutoStewardMode;
  approvals_mode: ApprovalsMode;
  allow_dev_automerge: number;
  trusted_bots_json: string;
  max_pushes_per_cause: number;
  max_review_rounds: number;
  updated_at: number;
}

interface WatchRow {
  id: string;
  project_id: string | null;
  host_id: string;
  worktree_path: string;
  repo: string;
  pr_number: number;
  head_branch: string;
  head_remote: string;
  base_branch: string;
  base_remote: string;
  author_login: string;
  state: string;
  last_head_sha: string | null;
  started_at: number;
  expires_at: number;
  last_woke_at: number | null;
  worker_thread_id: string | null;
  stop_reason: string | null;
}

interface AuditRow {
  id: number;
  watch_id: string | null;
  ts: number;
  actor: string;
  action: string;
  outcome: string;
  detail_json: string;
}

function toRepoConfig(row: RepoRow): RepoConfig {
  let trustedBots: string[] = [];
  try {
    const parsed = JSON.parse(row.trusted_bots_json);
    if (Array.isArray(parsed)) trustedBots = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    trustedBots = [];
  }
  return {
    repo: row.repo,
    enabled: row.enabled !== 0,
    reviewMode: row.review_mode,
    reviewEffort: row.review_effort,
    autoSteward: row.auto_steward,
    approvalsMode: row.approvals_mode,
    allowDevAutomerge: row.allow_dev_automerge !== 0,
    trustedBots,
    maxPushesPerCause: row.max_pushes_per_cause,
    maxReviewRounds: row.max_review_rounds,
    updatedAt: row.updated_at,
  };
}

function toWatchRecord(row: WatchRow): WatchRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    hostId: row.host_id,
    worktreePath: row.worktree_path,
    repo: row.repo,
    prNumber: row.pr_number,
    headBranch: row.head_branch,
    headRemote: row.head_remote,
    baseBranch: row.base_branch,
    baseRemote: row.base_remote,
    authorLogin: row.author_login,
    state: row.state,
    lastHeadSha: row.last_head_sha,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    lastWokeAt: row.last_woke_at,
    workerThreadId: row.worker_thread_id,
    stopReason: row.stop_reason,
  };
}

export class ShipStore {
  constructor(private readonly db: Database.Database) {}

  getRepo(repo: string): RepoConfig | null {
    const row = this.db.prepare("SELECT * FROM repos WHERE repo = ?").get(repo) as RepoRow | undefined;
    return row ? toRepoConfig(row) : null;
  }

  listRepos(): RepoConfig[] {
    const rows = this.db.prepare("SELECT * FROM repos ORDER BY repo ASC").all() as RepoRow[];
    return rows.map(toRepoConfig);
  }

  upsertRepo(patch: RepoUpsertPatch, defaults: RepoDefaults, nowMs = Date.now()): RepoConfig {
    const current = this.getRepo(patch.repo);
    const next: RepoConfig = {
      repo: patch.repo,
      enabled: patch.enabled ?? current?.enabled ?? true,
      reviewMode: patch.reviewMode ?? current?.reviewMode ?? defaults.reviewMode,
      reviewEffort: patch.reviewEffort ?? current?.reviewEffort ?? defaults.reviewEffort,
      autoSteward: patch.autoSteward ?? current?.autoSteward ?? "manual",
      approvalsMode: patch.approvalsMode ?? current?.approvalsMode ?? "observe",
      allowDevAutomerge: patch.allowDevAutomerge ?? current?.allowDevAutomerge ?? false,
      trustedBots: patch.trustedBots ?? current?.trustedBots ?? [],
      maxPushesPerCause: patch.maxPushesPerCause ?? current?.maxPushesPerCause ?? defaults.maxPushesPerCause,
      maxReviewRounds: patch.maxReviewRounds ?? current?.maxReviewRounds ?? 4,
      updatedAt: nowMs,
    };

    this.db
      .prepare(
        `INSERT INTO repos (
          repo, enabled, review_mode, review_effort, auto_steward, approvals_mode,
          allow_dev_automerge, trusted_bots_json, max_pushes_per_cause, max_review_rounds, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo) DO UPDATE SET
          enabled = excluded.enabled,
          review_mode = excluded.review_mode,
          review_effort = excluded.review_effort,
          auto_steward = excluded.auto_steward,
          approvals_mode = excluded.approvals_mode,
          allow_dev_automerge = excluded.allow_dev_automerge,
          trusted_bots_json = excluded.trusted_bots_json,
          max_pushes_per_cause = excluded.max_pushes_per_cause,
          max_review_rounds = excluded.max_review_rounds,
          updated_at = excluded.updated_at`,
      )
      .run(
        next.repo,
        next.enabled ? 1 : 0,
        next.reviewMode,
        next.reviewEffort,
        next.autoSteward,
        next.approvalsMode,
        next.allowDevAutomerge ? 1 : 0,
        JSON.stringify(next.trustedBots),
        next.maxPushesPerCause,
        next.maxReviewRounds,
        next.updatedAt,
      );

    return next;
  }

  countRepos(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM repos").get() as { cnt: number };
    return row.cnt;
  }

  countActiveWatches(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM watches WHERE state NOT IN ('stopped', 'merged', 'closed')")
      .get() as { cnt: number };
    return row.cnt;
  }

  listWatches(opts: { state?: string; limit?: number } = {}): WatchRecord[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = opts.state
      ? (this.db
          .prepare("SELECT * FROM watches WHERE state = ? ORDER BY started_at DESC LIMIT ?")
          .all(opts.state, limit) as WatchRow[])
      : (this.db.prepare("SELECT * FROM watches ORDER BY started_at DESC LIMIT ?").all(limit) as WatchRow[]);
    return rows.map(toWatchRecord);
  }

  appendAudit(entry: {
    watchId?: string | null;
    ts?: number;
    actor: string;
    action: string;
    outcome: string;
    detail?: Record<string, unknown>;
  }): number {
    const info = this.db
      .prepare(
        "INSERT INTO audit_log (watch_id, ts, actor, action, outcome, detail_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.watchId ?? null,
        entry.ts ?? Date.now(),
        entry.actor,
        entry.action,
        entry.outcome,
        JSON.stringify(entry.detail ?? {}),
      );
    return Number(info.lastInsertRowid);
  }

  listAudit(opts: { watchId?: string; limit?: number } = {}): AuditEntry[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = opts.watchId
      ? (this.db
          .prepare("SELECT * FROM audit_log WHERE watch_id = ? ORDER BY ts DESC, id DESC LIMIT ?")
          .all(opts.watchId, limit) as AuditRow[])
      : (this.db.prepare("SELECT * FROM audit_log ORDER BY ts DESC, id DESC LIMIT ?").all(limit) as AuditRow[]);
    return rows.map((r) => ({
      id: r.id,
      watchId: r.watch_id,
      ts: r.ts,
      actor: r.actor,
      action: r.action,
      outcome: r.outcome,
      detailJson: r.detail_json,
    }));
  }
}
