import { describe, expect, it } from "vitest";
import {
  countInvisible,
  isNeverEditPath,
  isProtectedMergePath,
  isSecretFilename,
  markInvisible,
  normalizePathForCheck,
  stripInvisible,
} from "../src/safety/never-edit.js";

describe("never-edit and secret filename guards", () => {
  it("normalizes slashes, invisible chars, case, and trailing dots", () => {
    expect(normalizePathForCheck(".GitHub\\Workflows\\CI.yml.")).toBe(".github/workflows/ci.yml");
    expect(normalizePathForCheck("./.GitHub/Workflows/CI.yml.")).toBe(".github/workflows/ci.yml");
    expect(stripInvisible("a\u200Bb\u202Ec\uFEFF")).toBe("abc");
    expect(countInvisible("a\u200Bb\u200Dc")).toBe(2);
    expect(markInvisible("x\u200By")).toBe("x⟦U+200B⟧y");
  });

  it("blocks CI, hook, agent instruction, build wrapper, and env files", () => {
    const blocked = [
      ".github/workflows/release.yml",
      ".GITHUB\\workflows\\test.yaml",
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".claude/skills/steward/SKILL.md",
      ".mcp.json",
      ".husky/pre-commit",
      ".githooks/pre-push",
      "CODEOWNERS",
      "docs/CODEOWNERS",
      "CLAUDE.md",
      "CLAUDE.local.md",
      "AGENTS.md",
      "GEMINI.md",
      "REVIEW.md",
      "SECURITY.md",
      "CLAUDE-SECURITY.md",
      ".cursorrules",
      "gradlew",
      "mvnw.cmd",
      ".npmrc",
      "bunfig.toml",
      ".env",
      ".env.production",
      "packages/api/.env.local",
      ".en\u200Bv",
      ".env. ",
      "src/../.github/workflows/ci.yml",
    ];
    for (const p of blocked) {
      expect(isNeverEditPath(p), p).toBe(true);
    }
  });

  it("allows normal source files and explicit env templates", () => {
    const allowed = [
      "src/index.ts",
      "README.md",
      "package.json",
      ".env.example",
      ".env.sample",
      ".env.template",
      ".env.local.example",
      "docs/review-notes.md",
    ];
    for (const p of allowed) {
      expect(isNeverEditPath(p), p).toBe(false);
    }
  });

  it("identifies unconditional merge-blocking paths", () => {
    expect(isProtectedMergePath(".claude/settings.json")).toBe(true);
    expect(isProtectedMergePath("apps/web/.claude/settings.local.json")).toBe(true);
    expect(isProtectedMergePath(".mcp.json")).toBe(true);
    expect(isProtectedMergePath(".claude/scheduled_tasks.json")).toBe(true);
    expect(isProtectedMergePath(".claude/loop.md")).toBe(true);
    expect(isProtectedMergePath(".claude/skills/code-review/SKILL.md")).toBe(true);
    expect(isProtectedMergePath(".claude/commands/code-review.md")).toBe(true);
    expect(isProtectedMergePath(".github/workflows/ci.yml")).toBe(false);
  });

  it("detects secret filenames across backup suffixes, temp names, and Unicode confusables", () => {
    const secrets = [
      ".env",
      ".env.bak",
      ".env_old",
      ".env.copy",
      ".env.tmp.1234abcd",
      ".\u0435nv", // Cyrillic 'е'
      "%2eenv",
      "\uFF0Eenv", // Fullwidth '.'
      "gcp-key.json",
      "firebase-adminsdk-abc123.json",
      "token.json",
      "auth.json",
      "password.txt",
      ".vscode/sftp.json",
      ".anthropic/credentials/oauth.json",
      ".claude.json",
      "deploy.pem",
      "private.key",
      "id_ed25519",
    ];
    for (const p of secrets) {
      expect(isSecretFilename(p), p).toBe(true);
    }

    expect(isSecretFilename(".env.example")).toBe(false);
    expect(isSecretFilename(".claude/settings.json")).toBe(false);
    expect(isSecretFilename(".mcp.json")).toBe(false);
    expect(isSecretFilename("src/auth/login.ts")).toBe(false);
  });
});
