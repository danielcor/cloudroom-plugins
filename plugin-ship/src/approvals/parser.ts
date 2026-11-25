import { createHash } from "node:crypto";
import YAML from "yaml";
import { z } from "zod";

const CLASSIFIER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const RULE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export const approvalActionSchema = z.enum(["approve", "comment", "request_changes"]);
export type ApprovalAction = z.infer<typeof approvalActionSchema>;

export const authorAssociationSchema = z.enum([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIMER",
  "FIRST_TIME_CONTRIBUTOR",
  "MANNEQUIN",
  "NONE",
]);

export const approvalWhenSchema = z
  .object({
    all_paths_match: z.array(z.string().min(1).max(300)).min(1).max(100).optional(),
    any_path_matches: z.array(z.string().min(1).max(300)).min(1).max(100).optional(),
    no_path_matches: z.array(z.string().min(1).max(300)).min(1).max(100).optional(),
    max_changed_files: z.number().int().min(0).max(10_000).optional(),
    max_changed_lines: z.number().int().min(0).max(1_000_000).optional(),
    base_branches: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
    authors: z.array(z.string().min(1).max(120)).min(1).max(100).optional(),
    author_associations: z.array(authorAssociationSchema).min(1).max(10).optional(),
    labels_include: z.array(z.string().min(1).max(120)).min(1).max(50).optional(),
    labels_exclude: z.array(z.string().min(1).max(120)).min(1).max(50).optional(),
    is_draft: z.boolean().optional(),
    ci_green: z.boolean().optional(),
    gate_receipt_pass: z.boolean().optional(),
    no_never_edit_paths: z.boolean().optional(),
  })
  .strict();

export type ApprovalWhen = z.infer<typeof approvalWhenSchema>;

export const approvalClassifierPredicateSchema = z
  .object({
    name: z.string().regex(CLASSIFIER_NAME_RE, "Invalid classifier name"),
    expect: z.string().min(1).max(64).default("pass"),
  })
  .strict();

export const approvalRuleSchema = z
  .object({
    id: z.string().regex(RULE_ID_RE, "Invalid rule id"),
    description: z.string().max(500).optional(),
    when: approvalWhenSchema.default({}),
    classifier: approvalClassifierPredicateSchema.optional(),
    action: approvalActionSchema,
    seats: z.number().int().min(0).max(10).default(0),
  })
  .strict();

export type ApprovalRule = z.infer<typeof approvalRuleSchema>;

export const approvalsPolicySchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["observe", "enforce"]).default("observe"),
    status_context: z.string().min(1).max(120).default("Cloudroom Ship / Approvals"),
    default_action: approvalActionSchema.default("comment"),
    rules: z.array(approvalRuleSchema).max(100),
  })
  .strict();

export type ApprovalsPolicy = z.infer<typeof approvalsPolicySchema>;

export const classifierDefSchema = z
  .object({
    version: z.literal(1),
    name: z.string().regex(CLASSIFIER_NAME_RE, "Invalid classifier name"),
    description: z.string().min(1).max(1000),
    prompt: z.string().min(1).max(16_000),
    outcomes: z.array(z.string().trim().min(1).max(64)).min(1).max(10).default(["pass", "fail"]),
    fail_closed: z.boolean().default(true),
  })
  .strict();

export type ClassifierDef = z.infer<typeof classifierDefSchema>;

export interface LoadedClassifier extends ClassifierDef {
  path: string;
  sha: string;
}

/**
 * Parse and validate `.claude/approvals.yml` (strictly version: 1, unique rule IDs).
 */
export function parseApprovalsPolicy(raw: string): ApprovalsPolicy {
  const doc = YAML.parse(raw);
  const parsed = approvalsPolicySchema.parse(doc);
  const seen = new Set<string>();
  for (const rule of parsed.rules) {
    if (seen.has(rule.id)) {
      throw new Error(`Duplicate approval rule id "${rule.id}" in .claude/approvals.yml.`);
    }
    seen.add(rule.id);
  }
  return parsed;
}

/**
 * Parse and validate a `.claude/classifiers/<name>/def.yml` classifier definition.
 */
export function parseClassifierDef(raw: string, expectedName?: string): ClassifierDef {
  const doc = YAML.parse(raw);
  const parsed = classifierDefSchema.parse(doc);
  if (expectedName && parsed.name !== expectedName) {
    throw new Error(
      `Classifier definition name "${parsed.name}" does not match directory name "${expectedName}".`,
    );
  }
  const uniqueOutcomes = new Set(parsed.outcomes.map((o) => o.toLowerCase()));
  if (uniqueOutcomes.size !== parsed.outcomes.length) {
    throw new Error(`Classifier "${parsed.name}" defines duplicate outcome labels.`);
  }
  return parsed;
}

/**
 * Load all default-branch classifier definitions and validate every rule reference.
 */
export function loadAndValidateClassifiers(
  policy: ApprovalsPolicy,
  sources: readonly { name: string; path: string; raw: string; sha: string }[],
): Map<string, LoadedClassifier> {
  const map = new Map<string, LoadedClassifier>();
  for (const src of sources) {
    if (!CLASSIFIER_NAME_RE.test(src.name)) {
      throw new Error(`Invalid classifier name "${src.name}" from "${src.path}".`);
    }
    if (map.has(src.name)) {
      throw new Error(`Duplicate classifier definition "${src.name}".`);
    }
    const def = parseClassifierDef(src.raw, src.name);
    map.set(src.name, { ...def, path: src.path, sha: src.sha });
  }

  for (const rule of policy.rules) {
    if (!rule.classifier) continue;
    const cls = map.get(rule.classifier.name);
    if (!cls) {
      throw new Error(
        `Approval rule "${rule.id}" references missing default-branch classifier "${rule.classifier.name}".`,
      );
    }
    const validExpect = cls.outcomes.some((o) => o.toLowerCase() === rule.classifier!.expect.toLowerCase());
    if (!validExpect) {
      throw new Error(
        `Approval rule "${rule.id}" expects outcome "${rule.classifier.expect}" which is not in classifier "${cls.name}" outcomes (${cls.outcomes.join(", ")}).`,
      );
    }
  }

  return map;
}

/**
 * Compute a deterministic SHA-256 over the parsed default-branch policy and classifier sources.
 */
export function computePolicyBundleSha(
  policyRaw: string,
  classifiers: readonly { path: string; sha: string }[],
): string {
  const h = createHash("sha256");
  h.update(policyRaw, "utf8");
  const sorted = [...classifiers].sort((a, b) => a.path.localeCompare(b.path));
  for (const c of sorted) {
    h.update(`\0${c.path}:${c.sha}`, "utf8");
  }
  return h.digest("hex");
}
