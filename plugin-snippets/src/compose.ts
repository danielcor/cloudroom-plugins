// The text an Insert writes, and how it joins the draft already there.
import { fillPlaceholders } from "./placeholders.js";
import { stripInvisible } from "./secrets.js";

/** Fill placeholders, then strip invisible and direction-changing characters. */
export function prepareInsert(body: string, values: Readonly<Record<string, string>>): string {
  return stripInvisible(fillPlaceholders(body, values));
}

/** Append `snippet` to `current` as its own paragraph (a blank line between). */
export function appendParagraph(current: string, snippet: string): string {
  const base = current.replace(/\s+$/u, "");
  return base === "" ? snippet : `${base}\n\n${snippet}`;
}
