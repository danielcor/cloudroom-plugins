import { createHmac, timingSafeEqual } from "node:crypto";

export const SUPPORTED_GITHUB_WEBHOOK_EVENTS: ReadonlySet<string> = new Set([
  "pull_request",
  "check_run",
  "check_suite",
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
]);

/**
 * Verify GitHub `X-Hub-Signature-256` (`sha256=<hex>`) using constant-time comparison.
 */
export function verifyGitHubWebhookSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  const trimmedSecret = secret.trim();
  if (!trimmedSecret || !signatureHeader) return false;
  if (!signatureHeader.startsWith("sha256=")) return false;

  const providedHex = signatureHeader.slice("sha256=".length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(providedHex)) return false;

  const expectedHex = createHmac("sha256", trimmedSecret).update(rawBody).digest("hex");
  const providedBuf = Buffer.from(providedHex, "utf8");
  const expectedBuf = Buffer.from(expectedHex, "utf8");
  if (providedBuf.length !== expectedBuf.length) return false;

  return timingSafeEqual(providedBuf, expectedBuf);
}
