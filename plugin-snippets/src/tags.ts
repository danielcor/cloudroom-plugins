// Tags as written in frontmatter: `a, b` or `[a, b]`, lowercased, without repeats.
// Its own module so the app bundle can use it without the server-only secret scan.
export function parseTags(raw: string): string[] {
  const inner = raw.trim().replace(/^\[(.*)\]$/su, "$1");
  const tags: string[] = [];
  for (const part of inner.split(",")) {
    const t = part.trim().replace(/^["']|["']$/gu, "").toLowerCase();
    if (t !== "" && !tags.includes(t)) tags.push(t);
  }
  return tags;
}
