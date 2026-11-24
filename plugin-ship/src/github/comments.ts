import { countInvisible, stripInvisible } from "../safety/never-edit.js";

export const MAX_COMMENT_BYTES = 4096;
export const MAX_TOTAL_COMMENT_BYTES = 40_960;
export const MAX_COMMENT_ITEMS = 100;
export const MAX_UNIQUE_COMMENTERS = 30;
export const STEWARD_COLLISION_LABEL_PREFIXES = ["claude-pr-steward-", "claude-ship-"] as const;
export const TRUSTED_COLLABORATOR_PERMISSIONS = new Set(["admin", "maintain", "write"]);

export function findCollisionLabels(labels: readonly string[]): string[] {
  return labels.filter((label) => {
    const lower = label.toLowerCase();
    return STEWARD_COLLISION_LABEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
  });
}

/**
 * Strip blockquote lines (`> ...`) outside fenced code blocks so quoted untrusted
 * instructions cannot ride inside a trusted maintainer's reply.
 */
export function stripBlockquotes(body: string): string {
  const lines = body.split(/\r?\n/u);
  const kept: string[] = [];
  let fence: { char: string; len: number } | null = null;

  for (const line of lines) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch) {
      const seq = fenceMatch[1]!;
      if (!fence) {
        fence = { char: seq[0]!, len: seq.length };
      } else if (fence.char === seq[0] && seq.length >= fence.len && /^ {0,3}(?:`+|~+)[ \t]*$/u.test(line)) {
        fence = null;
      }
      kept.push(line);
      continue;
    }

    if (!fence && /^\s*>/u.test(line)) {
      continue;
    }
    kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

const LEADING_SHIP_MARKER_RE = /^(<!-- cloudroom-ship(?: reviewed=[0-9a-f]{40})? -->(?:\r?\n|$))/u;

/**
 * Strip invisible/bidi characters and non-marker HTML comments (which hide prompt
 * injections in GitHub Markdown rendering). Preserves a single leading Ship marker.
 */
export function sanitizeHiddenMarkup(body: string): { text: string; mayHide: boolean } {
  const hasInvisible = countInvisible(body) > 0;
  const visible = stripInvisible(body);
  const markerMatch = LEADING_SHIP_MARKER_RE.exec(visible);
  const marker = markerMatch ? markerMatch[1]! : "";
  const rest = visible.slice(marker.length);
  const hasHiddenComment = /<!--/u.test(rest);
  const cleanedRest = rest
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<!--[\s\S]*$/gu, "");

  return {
    text: `${marker}${cleanedRest}`,
    mayHide: hasInvisible || hasHiddenComment,
  };
}

/** Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting surrogate pairs. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: "", truncated: text.length > 0 };
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  const suffix = "\n… [truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const budget = maxBytes > suffixBytes ? maxBytes - suffixBytes : maxBytes;
  const useSuffix = maxBytes > suffixBytes;

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    let candidate = text.slice(0, mid);
    const lastCode = candidate.charCodeAt(candidate.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      candidate = candidate.slice(0, -1);
    }
    if (Buffer.byteLength(candidate, "utf8") <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  let cut = text.slice(0, lo);
  if (cut.length > 0) {
    const lastCode = cut.charCodeAt(cut.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      cut = cut.slice(0, -1);
    }
  }
  return {
    text: useSuffix ? `${cut}${suffix}` : cut,
    truncated: true,
  };
}

export interface RawPrCommentItem {
  id: string;
  kind: "issue_comment" | "review" | "review_comment";
  authorLogin: string | null;
  body: string;
  createdAt: string;
  path?: string | null;
  line?: number | null;
  reviewId?: string | null;
  inReplyToId?: string | null;
  isMinimized?: boolean;
  authorAssociation?: string | null;
}

export interface RawPrDiscussion {
  pr: {
    number: number;
    url: string;
    title: string;
    body: string;
    state: string;
    isDraft: boolean;
    headRefName: string;
    headRefOid: string;
    baseRefName: string;
    baseRefOid: string;
    authorLogin: string;
    labels: string[];
    mergeStateStatus: string;
  };
  comments: RawPrCommentItem[];
}

export interface TrustedPrComment {
  id: string;
  kind: "issue_comment" | "review" | "review_comment";
  authorLogin: string;
  body: string;
  createdAt: string;
  path: string | null;
  line: number | null;
  reviewId: string | null;
  inReplyToId: string | null;
  mayHide: boolean;
  truncated: boolean;
  trustReason: "author" | "trusted_bot" | "collaborator";
}

export interface FilteredPrDiscussion {
  pr: {
    number: number;
    url: string;
    title: string;
    body: string;
    mayHideBody: boolean;
    state: string;
    isDraft: boolean;
    headRefName: string;
    headRefOid: string;
    baseRefName: string;
    baseRefOid: string;
    authorLogin: string;
    labels: string[];
    mergeStateStatus: string;
  };
  items: TrustedPrComment[];
  excludedCount: number;
  truncatedCount: number;
  droppedForBudgetCount: number;
  collisionLabels: string[];
}

export interface FilterCommentsInput {
  discussion: RawPrDiscussion;
  collaboratorPermissions: Record<string, string>;
  trustedBots?: readonly string[];
  authorLogin?: string | null;
}

function normalizeBotKey(login: string): string {
  return login.trim().toLowerCase().replace(/\[bot\]$/u, "");
}

function normalizePermissionMap(perms: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(perms)) {
    map.set(k.trim().toLowerCase(), v.trim().toLowerCase());
  }
  return map;
}

/**
 * Filter, sanitize, and budget-cap PR discussion items according to Ship's collaborator trust boundary.
 */
export function filterTrustedPrComments(input: FilterCommentsInput): FilteredPrDiscussion {
  const { discussion, trustedBots = [], authorLogin } = input;
  const prAuthorLower = discussion.pr.authorLogin.trim().toLowerCase();
  const explicitAuthorLower = authorLogin?.trim().toLowerCase() || "";
  const trustedBotKeys = new Set(trustedBots.map(normalizeBotKey).filter(Boolean));
  const perms = normalizePermissionMap(input.collaboratorPermissions);
  const collisionLabels = findCollisionLabels(discussion.pr.labels);

  const sanitizedPrBody = sanitizeHiddenMarkup(discussion.pr.body ?? "");
  const strippedPrBody = truncateUtf8(stripBlockquotes(sanitizedPrBody.text), MAX_COMMENT_BYTES);

  const items: TrustedPrComment[] = [];
  let excludedCount = 0;
  let truncatedCount = 0;
  let droppedForBudgetCount = 0;
  let totalBytes = 0;

  for (const raw of discussion.comments) {
    if (raw.isMinimized) continue;

    const login = raw.authorLogin?.trim() ?? "";
    const loginLower = login.toLowerCase();
    if (!loginLower) {
      excludedCount += 1;
      continue;
    }

    let trustReason: TrustedPrComment["trustReason"] | null = null;
    if (loginLower === prAuthorLower || (explicitAuthorLower !== "" && loginLower === explicitAuthorLower)) {
      trustReason = "author";
    } else if (trustedBotKeys.has(normalizeBotKey(loginLower))) {
      trustReason = "trusted_bot";
    } else {
      const perm = perms.get(loginLower);
      if (perm && TRUSTED_COLLABORATOR_PERMISSIONS.has(perm)) {
        trustReason = "collaborator";
      }
    }

    if (!trustReason) {
      excludedCount += 1;
      continue;
    }

    const sanitized = sanitizeHiddenMarkup(raw.body ?? "");
    const stripped = stripBlockquotes(sanitized.text);
    const bounded = truncateUtf8(stripped, MAX_COMMENT_BYTES);

    if (items.length >= MAX_COMMENT_ITEMS) {
      droppedForBudgetCount += 1;
      continue;
    }

    const itemBytes = Buffer.byteLength(bounded.text, "utf8");
    if (totalBytes + itemBytes > MAX_TOTAL_COMMENT_BYTES) {
      const remaining = MAX_TOTAL_COMMENT_BYTES - totalBytes;
      if (remaining < 64) {
        droppedForBudgetCount += 1;
        continue;
      }
      const squeezed = truncateUtf8(bounded.text, remaining);
      totalBytes += Buffer.byteLength(squeezed.text, "utf8");
      if (squeezed.truncated) truncatedCount += 1;
      items.push({
        id: raw.id,
        kind: raw.kind,
        authorLogin: login,
        body: squeezed.text,
        createdAt: raw.createdAt,
        path: raw.path ?? null,
        line: raw.line ?? null,
        reviewId: raw.reviewId ?? null,
        inReplyToId: raw.inReplyToId ?? null,
        mayHide: sanitized.mayHide,
        truncated: true,
        trustReason,
      });
      continue;
    }

    totalBytes += itemBytes;
    if (bounded.truncated) truncatedCount += 1;

    items.push({
      id: raw.id,
      kind: raw.kind,
      authorLogin: login,
      body: bounded.text,
      createdAt: raw.createdAt,
      path: raw.path ?? null,
      line: raw.line ?? null,
      reviewId: raw.reviewId ?? null,
      inReplyToId: raw.inReplyToId ?? null,
      mayHide: sanitized.mayHide,
      truncated: bounded.truncated,
      trustReason,
    });
  }

  return {
    pr: {
      number: discussion.pr.number,
      url: discussion.pr.url,
      title: discussion.pr.title,
      body: strippedPrBody.text,
      mayHideBody: sanitizedPrBody.mayHide,
      state: discussion.pr.state,
      isDraft: discussion.pr.isDraft,
      headRefName: discussion.pr.headRefName,
      headRefOid: discussion.pr.headRefOid,
      baseRefName: discussion.pr.baseRefName,
      baseRefOid: discussion.pr.baseRefOid,
      authorLogin: discussion.pr.authorLogin,
      labels: discussion.pr.labels,
      mergeStateStatus: discussion.pr.mergeStateStatus,
    },
    items,
    excludedCount,
    truncatedCount,
    droppedForBudgetCount,
    collisionLabels,
  };
}

export const PR_DISCUSSION_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      url
      title
      body
      state
      isDraft
      headRefName
      headRefOid
      baseRefName
      baseRefOid
      mergeStateStatus
      author { login }
      labels(first: 50) { nodes { name } }
      comments(last: 100) {
        nodes {
          id
          body
          createdAt
          isMinimized
          authorAssociation
          author { login }
        }
      }
      reviews(last: 100) {
        nodes {
          id
          body
          createdAt
          isMinimized
          authorAssociation
          author { login }
        }
      }
      reviewThreads(last: 100) {
        nodes {
          comments(last: 50) {
            nodes {
              id
              body
              createdAt
              path
              line
              isMinimized
              authorAssociation
              pullRequestReview { id }
              replyTo { id }
              author { login }
            }
          }
        }
      }
    }
  }
}`;

interface PrDiscussionGraphqlData {
  repository?: {
    pullRequest?: {
      number: number;
      url: string;
      title: string;
      body: string;
      state: string;
      isDraft: boolean;
      headRefName: string;
      headRefOid: string;
      baseRefName: string;
      baseRefOid: string;
      mergeStateStatus?: string;
      author?: { login?: string | null } | null;
      labels?: { nodes?: Array<{ name?: string | null } | null> | null } | null;
      comments?: {
        nodes?: Array<{
          id: string;
          body: string;
          createdAt: string;
          isMinimized?: boolean;
          authorAssociation?: string | null;
          author?: { login?: string | null } | null;
        } | null> | null;
      } | null;
      reviews?: {
        nodes?: Array<{
          id: string;
          body: string;
          createdAt: string;
          isMinimized?: boolean;
          authorAssociation?: string | null;
          author?: { login?: string | null } | null;
        } | null> | null;
      } | null;
      reviewThreads?: {
        nodes?: Array<{
          comments?: {
            nodes?: Array<{
              id: string;
              body: string;
              createdAt: string;
              path?: string | null;
              line?: number | null;
              isMinimized?: boolean;
              authorAssociation?: string | null;
              pullRequestReview?: { id?: string | null } | null;
              replyTo?: { id?: string | null } | null;
              author?: { login?: string | null } | null;
            } | null> | null;
          } | null;
        } | null> | null;
      } | null;
    } | null;
  } | null;
}

export async function fetchPrDiscussion(opts: {
  repo: string;
  prNumber: number;
  trustedBots?: readonly string[];
  authorLogin?: string | null;
  runGraphql: (query: string, variables: { owner: string; name: string; number: number }) => Promise<PrDiscussionGraphqlData>;
  fetchCollaboratorPermission: (repo: string, username: string) => Promise<string>;
}): Promise<FilteredPrDiscussion> {
  const [owner, name] = opts.repo.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid repository slug "${opts.repo}"`);
  }

  const data = await opts.runGraphql(PR_DISCUSSION_GRAPHQL_QUERY, {
    owner,
    name,
    number: opts.prNumber,
  });
  const pr = data.repository?.pullRequest;
  if (!pr) {
    throw new Error(`Pull request ${opts.repo}#${opts.prNumber} not found`);
  }

  const comments: RawPrCommentItem[] = [];
  for (const c of pr.comments?.nodes ?? []) {
    if (!c) continue;
    comments.push({
      id: c.id,
      kind: "issue_comment",
      authorLogin: c.author?.login ?? null,
      body: c.body ?? "",
      createdAt: c.createdAt,
      isMinimized: c.isMinimized,
      authorAssociation: c.authorAssociation,
    });
  }
  for (const r of pr.reviews?.nodes ?? []) {
    if (!r || !r.body?.trim()) continue;
    comments.push({
      id: r.id,
      kind: "review",
      authorLogin: r.author?.login ?? null,
      body: r.body,
      createdAt: r.createdAt,
      isMinimized: r.isMinimized,
      authorAssociation: r.authorAssociation,
    });
  }
  const seenThreadCommentIds = new Set<string>();
  for (const thread of pr.reviewThreads?.nodes ?? []) {
    for (const tc of thread?.comments?.nodes ?? []) {
      if (!tc || seenThreadCommentIds.has(tc.id)) continue;
      seenThreadCommentIds.add(tc.id);
      comments.push({
        id: tc.id,
        kind: "review_comment",
        authorLogin: tc.author?.login ?? null,
        body: tc.body ?? "",
        createdAt: tc.createdAt,
        path: tc.path ?? null,
        line: tc.line ?? null,
        reviewId: tc.pullRequestReview?.id ?? null,
        inReplyToId: tc.replyTo?.id ?? null,
        isMinimized: tc.isMinimized,
        authorAssociation: tc.authorAssociation,
      });
    }
  }

  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const prAuthorLower = (pr.author?.login ?? "").trim().toLowerCase();
  const extraAuthorLower = opts.authorLogin?.trim().toLowerCase() ?? "";
  const trustedBotKeys = new Set((opts.trustedBots ?? []).map(normalizeBotKey).filter(Boolean));
  const uniqueUnknownLogins: string[] = [];
  const seenUnknownLower = new Set<string>();

  for (const c of comments) {
    if (c.isMinimized) continue;
    const login = c.authorLogin?.trim() ?? "";
    const lower = login.toLowerCase();
    if (!lower) continue;
    if (lower === prAuthorLower || (extraAuthorLower !== "" && lower === extraAuthorLower)) continue;
    if (trustedBotKeys.has(normalizeBotKey(lower))) continue;
    if (seenUnknownLower.has(lower)) continue;
    seenUnknownLower.add(lower);
    if (uniqueUnknownLogins.length < MAX_UNIQUE_COMMENTERS) {
      uniqueUnknownLogins.push(login);
    }
  }

  const collaboratorPermissions: Record<string, string> = {};
  const entries = await Promise.all(
    uniqueUnknownLogins.map(async (login) => {
      const perm = await opts.fetchCollaboratorPermission(opts.repo, login).catch(() => "none");
      return [login, perm] as const;
    }),
  );
  for (const [login, perm] of entries) {
    collaboratorPermissions[login] = perm;
  }

  return filterTrustedPrComments({
    discussion: {
      pr: {
        number: pr.number,
        url: pr.url,
        title: pr.title,
        body: pr.body ?? "",
        state: pr.state,
        isDraft: Boolean(pr.isDraft),
        headRefName: pr.headRefName,
        headRefOid: pr.headRefOid,
        baseRefName: pr.baseRefName,
        baseRefOid: pr.baseRefOid,
        authorLogin: pr.author?.login ?? "",
        labels: (pr.labels?.nodes ?? []).map((l) => l?.name ?? "").filter(Boolean),
        mergeStateStatus: pr.mergeStateStatus ?? "UNKNOWN",
      },
      comments,
    },
    collaboratorPermissions,
    trustedBots: opts.trustedBots,
    authorLogin: opts.authorLogin,
  });
}
