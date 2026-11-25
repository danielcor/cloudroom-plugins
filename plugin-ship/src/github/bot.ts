import { validateCommentText } from "../safety/outbound-text.js";
import { findSecrets } from "../safety/secrets.js";

export interface GitHubBotClientOptions {
  token: string;
  botLogin?: string;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
}

export interface CheckRunSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string | null;
}

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface ReviewInlineCommentInput {
  path: string;
  line: number;
  side?: "LEFT" | "RIGHT";
  body: string;
}

export type CommitStatusState = "error" | "failure" | "pending" | "success";

function redactToken(text: string, token: string): string {
  if (!token) return text;
  let out = text.split(token).join("[REDACTED]");
  const encoded = encodeURIComponent(token);
  if (encoded !== token) {
    out = out.split(encoded).join("[REDACTED]");
  }
  return out;
}

function splitRepoSlug(repo: string): { owner: string; name: string } {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repository slug "${repo}"`);
  }
  return { owner: parts[0], name: parts[1] };
}

/**
 * Dedicated GitHub REST/GraphQL client authenticating solely with the configured
 * Ship bot PAT so PR reviews, Commit Statuses, and approvals do not run as the PR author.
 */
export class GitHubBotClient {
  readonly botLogin: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;

  constructor(opts: GitHubBotClientOptions) {
    this.token = opts.token.trim();
    this.botLogin = (opts.botLogin ?? "").trim();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBaseUrl = (opts.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/u, "");
  }

  private async requestJson<T>(method: string, path: string, body?: unknown, allow404 = false): Promise<{ status: number; data: T | null }> {
    if (!this.token) {
      throw new Error("GitHub bot token is not configured.");
    }
    const url = `${this.apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "cloudroom-plugin-ship",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (allow404 && res.status === 404) {
      return { status: 404, data: null };
    }

    const rawText = await res.text();
    if (!res.ok) {
      const safeDetail = redactToken(rawText.slice(0, 400), this.token);
      throw new Error(`GitHub bot API ${method} ${path} failed (${res.status}): ${safeDetail}`);
    }
    if (!rawText) {
      return { status: res.status, data: null };
    }
    return { status: res.status, data: JSON.parse(rawText) as T };
  }

  async getViewerLogin(): Promise<{ login: string; id: number }> {
    const { data } = await this.requestJson<{ login: string; id: number }>("GET", "/user");
    if (!data?.login) {
      throw new Error("GitHub /user response did not include login.");
    }
    return { login: data.login, id: data.id };
  }

  async getCollaboratorPermission(repo: string, username: string): Promise<string> {
    const { owner, name } = splitRepoSlug(repo);
    const { status, data } = await this.requestJson<{ permission?: string }>(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/collaborators/${encodeURIComponent(username)}/permission`,
      undefined,
      true,
    );
    if (status === 404 || !data?.permission) return "none";
    return data.permission.toLowerCase();
  }

  async getCheckRuns(repo: string, ref: string): Promise<CheckRunSummary[]> {
    const { owner, name } = splitRepoSlug(repo);
    const { data } = await this.requestJson<{
      check_runs?: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        html_url?: string | null;
      }>;
    }>(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
    );
    return (data?.check_runs ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion ?? null,
      htmlUrl: r.html_url ?? null,
    }));
  }

  async postIssueComment(repo: string, prNumber: number, body: string): Promise<{ id: number; url: string }> {
    const valid = validateCommentText(body);
    if (!valid.ok) {
      throw new Error(`Refused to post PR comment: ${valid.reason}`);
    }
    const { owner, name } = splitRepoSlug(repo);
    const { data } = await this.requestJson<{ id: number; html_url?: string }>(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${prNumber}/comments`,
      { body },
    );
    return { id: data?.id ?? 0, url: data?.html_url ?? "" };
  }

  async postReviewReply(repo: string, prNumber: number, commentId: number, body: string): Promise<{ id: number; url: string }> {
    const valid = validateCommentText(body);
    if (!valid.ok) {
      throw new Error(`Refused to post review reply: ${valid.reason}`);
    }
    const { owner, name } = splitRepoSlug(repo);
    const { data } = await this.requestJson<{ id: number; html_url?: string }>(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${prNumber}/comments/${commentId}/replies`,
      { body },
    );
    return { id: data?.id ?? 0, url: data?.html_url ?? "" };
  }

  async submitReview(
    repo: string,
    prNumber: number,
    input: {
      commitId: string;
      event: ReviewEvent;
      body?: string;
      comments?: ReviewInlineCommentInput[];
    },
  ): Promise<{ id: number; state: string }> {
    if (input.body !== undefined && input.body !== "") {
      const valid = validateCommentText(input.body);
      if (!valid.ok) {
        throw new Error(`Refused to submit PR review: ${valid.reason}`);
      }
    }
    for (const c of input.comments ?? []) {
      const valid = validateCommentText(c.body, { requireMarker: false });
      if (!valid.ok) {
        throw new Error(`Refused inline review comment on ${c.path}: ${valid.reason}`);
      }
    }

    const { owner, name } = splitRepoSlug(repo);
    const { data } = await this.requestJson<{ id: number; state?: string }>(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${prNumber}/reviews`,
      {
        commit_id: input.commitId,
        event: input.event,
        ...(input.body ? { body: input.body } : {}),
        ...(input.comments && input.comments.length > 0
          ? {
              comments: input.comments.map((c) => ({
                path: c.path,
                line: c.line,
                side: c.side ?? "RIGHT",
                body: c.body,
              })),
            }
          : {}),
      },
    );
    return { id: data?.id ?? 0, state: data?.state ?? input.event };
  }

  async postCommitStatus(
    repo: string,
    sha: string,
    input: {
      state: CommitStatusState;
      context: string;
      description: string;
      targetUrl?: string;
    },
  ): Promise<{ id: number; state: string }> {
    const secretHits = findSecrets(input.description);
    if (secretHits.length > 0) {
      throw new Error(`Refused to post commit status: potential secret detected (${secretHits[0]!.kind})`);
    }
    const { owner, name } = splitRepoSlug(repo);
    const { data } = await this.requestJson<{ id: number; state?: string }>(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/statuses/${encodeURIComponent(sha)}`,
      {
        state: input.state,
        context: input.context,
        description: input.description.slice(0, 140),
        ...(input.targetUrl ? { target_url: input.targetUrl } : {}),
      },
    );
    return { id: data?.id ?? 0, state: data?.state ?? input.state };
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const { data } = await this.requestJson<{ data?: T; errors?: Array<{ message?: string }> }>(
      "POST",
      "/graphql",
      { query, variables },
    );
    if (data?.errors && data.errors.length > 0) {
      throw new Error(`GitHub GraphQL error: ${data.errors.map((e) => e.message ?? "unknown").join("; ")}`);
    }
    if (data?.data === undefined) {
      throw new Error("GitHub GraphQL response missing data.");
    }
    return data.data;
  }
}
