// A small subsequence matcher. Fields are weighted title > tags > id > body;
// every query word must match some field. Ties keep the manual order.

export interface Searchable {
  title: string;
  tags: readonly string[];
  id: string;
  body: string;
}

const WEIGHTS = { title: 4, tags: 3, id: 2, body: 1 } as const;

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Score `query` against `text`, or null when it is not a subsequence. Case-insensitive. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q === "") return 0;
  const at = t.indexOf(q);
  if (at !== -1) {
    // A substring beats any scattered match; a word-start substring beats a mid-word one.
    return 100 + q.length * 3 + (isWordChar(t[at - 1]) ? 0 : 20) - Math.min(at, 50) * 0.1;
  }
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    score += 1;
    if (found === prev + 1) score += 3;
    if (!isWordChar(t[found - 1])) score += 2;
    prev = found;
    ti = found + 1;
  }
  return score - Math.min(prev - q.length, 50) * 0.05;
}

export function scoreItem(query: string, item: Searchable): number | null {
  const words = query.trim().split(/\s+/u).filter(Boolean);
  let total = 0;
  for (const w of words) {
    let best: number | null = null;
    const consider = (s: number | null, weight: number) => {
      if (s !== null && (best === null || s * weight > best)) best = s * weight;
    };
    consider(fuzzyScore(w, item.title), WEIGHTS.title);
    for (const tag of item.tags) consider(fuzzyScore(w, tag), WEIGHTS.tags);
    consider(fuzzyScore(w, item.id), WEIGHTS.id);
    consider(fuzzyScore(w, item.body), WEIGHTS.body);
    if (best === null) return null;
    total += best;
  }
  return total;
}

/** Matching items, best first; equal scores keep their input order. */
export function rank<T extends Searchable>(items: readonly T[], query: string): T[] {
  if (query.trim() === "") return [...items];
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const score = scoreItem(query, item);
    if (score !== null) scored.push({ item, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.item);
}
