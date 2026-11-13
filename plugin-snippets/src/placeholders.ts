// `{{name}}` and `{{name|default}}` placeholders. `\{{` is a literal `{{`.

export interface Placeholder {
  name: string;
  /** The first default written for this name, or null when none was. */
  default: string | null;
}

const TOKEN = /\\\{\{|\{\{([a-z][a-z0-9_]*)(?:\|([^{}]*))?\}\}/gu;

/** Unique placeholders in first-appearance order. A name used twice is asked once. */
export function parsePlaceholders(body: string): Placeholder[] {
  const seen = new Map<string, Placeholder>();
  for (const m of body.matchAll(TOKEN)) {
    const name = m[1];
    if (name === undefined) continue; // an escaped `\{{`
    const existing = seen.get(name);
    if (!existing) seen.set(name, { name, default: m[2] ?? null });
    else if (existing.default === null && m[2] !== undefined) existing.default = m[2];
  }
  return [...seen.values()];
}

/**
 * Fill placeholders. An empty or missing value takes that occurrence's
 * default; with no default the literal `{{name}}` stays so the gap is visible.
 */
export function fillPlaceholders(body: string, values: Readonly<Record<string, string>>): string {
  return body.replace(TOKEN, (whole, name: string | undefined, def: string | undefined) => {
    if (name === undefined) return "{{";
    const v = values[name];
    if (v !== undefined && v !== "") return v;
    if (def !== undefined) return def;
    return `{{${name}}}`;
  });
}
