export type ShipBadgeTone = "is-ok" | "is-warn" | "is-err" | "is-info" | "is-neu";

export function watchStateTone(state: string): ShipBadgeTone {
  switch (state) {
    case "ready":
    case "merged":
      return "is-ok";
    case "needs_human":
    case "paused":
    case "waking":
      return "is-warn";
    case "stopped":
    case "closed":
      return "is-err";
    case "working":
    case "watching":
      return "is-info";
    default:
      return "is-neu";
  }
}

export function verdictTone(verdict: string | null | undefined): ShipBadgeTone {
  const norm = (verdict ?? "").toUpperCase();
  if (norm === "APPROVE") return "is-ok";
  if (norm === "REQUEST_CHANGES") return "is-err";
  if (norm === "COMMENT") return "is-warn";
  return "is-neu";
}

export function formatShortTime(ts: number): string {
  try {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  } catch {
    return "—";
  }
}

export function summarizeAuditDetail(detailJson: string): string {
  try {
    const parsed = JSON.parse(detailJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return "";
    const parts: string[] = [];
    for (const [k, v] of Object.entries(parsed)) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        parts.push(`${k}=${String(v)}`);
      }
      if (parts.length >= 3) break;
    }
    return parts.join(" · ");
  } catch {
    return "";
  }
}
