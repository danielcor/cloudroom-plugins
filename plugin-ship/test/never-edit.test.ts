import { describe, expect, it } from "vitest";
import {
  isNeverEditPath,
  isSecretFilename,
  normalizePathForCheck,
  stripInvisible,
} from "../src/safety/never-edit.js";

describe("never-edit and secret filename guards", () => {
  it("normalizes slashes, invisible chars, case, and trailing dots", () => {
    expect(normalizePathForCheck(".GitHub\\Workflows\\CI.yml.")).toBe(".github/workflows/ci.yml");
    expect(normalizePathForCheck("./.GitHub/Workflows/CI.yml.")).toBe(".github/workflows/ci.yml");
    expect(stripInvisible("a\u200Bb\u202Ec\uFEFF")).toBe("abc");
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
      ".env copy",
      ".env.local (copy)",
      "packages/api/.env.local",
      "packages/api/.env.local (copy)",
      ".en\u200Bv",
      ".en\u200Bv.local (copy)",
      ".git-credentials",
      "sub/.git-credentials",
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

  it("detects secret filenames across backup suffixes, temp names, and Unicode confusables", () => {
    const secrets = [
      ".env",
      ".env.bak",
      ".env_old",
      ".env.copy",
      ".env copy",
      ".env.local (copy)",
      "packages/api/.env.local (copy)",
      ".env.example.bak",
      ".env.tmp.1234abcd",
      ".\u0435nv", // Cyrillic 'е'
      ".\u0415nv", // uppercase Cyrillic 'Е'
      ".\u0395nv", // uppercase Greek 'Ε'
      "\u0410uth.json", // uppercase Cyrillic 'А'
      ".\u0435nv.local (copy)",
      "%2eenv",
      "\uFF0Eenv", // Fullwidth '.'
      ".git-credentials",
      "sub/.git-credentials",
      ".git-credentials.bak",
      "gcp-key.json",
      "gcp-key.json.backup",
      "firebase-adminsdk-abc123.json",
      "token.json",
      "token.json.old",
      "token.json" + ".bak".repeat(7),
      "token.json.bak .bak",
      "auth.json",
      "auth.json.bak",
      "auth.json" + ".bak".repeat(12),
      "auth.json.bak.tmp.1234abcd",
      "password.txt",
      "password.txt.orig",
      ".vscode/sftp.json",
      ".vscode/sftp.json.copy",
      "sub/.vscode/sftp.json.bak",
      ".anthropic/credentials/oauth.json",
      ".anthropic/credentials/oauth.json.bak",
      ".anthropic/credentials/oauth.json.tmp.1234abcd",
      ".claude.json",
      "deploy.pem",
      "private.key",
      "id_ed25519",
      "id_ed25519.bak",
    ];
    for (const p of secrets) {
      expect(isSecretFilename(p), p).toBe(true);
    }

    expect(isSecretFilename(".env.example")).toBe(false);
    expect(isSecretFilename(".claude/settings.json")).toBe(false);
    expect(isSecretFilename(".mcp.json")).toBe(false);
    expect(isSecretFilename("src/auth/login.ts")).toBe(false);
  });

  it("catches literal credential paths with %2e%2e and filenames containing newlines (S4/S5)", () => {
    const blocked = [
      ".anthropic/credentials/%2e%2e/session.json",
      ".anthropic/credentials/%2e%2e/session.json.bak",
      ".\u0430nthropic/credentials/%2e%2e/session.json",
      "local\nbackup.pem",
      "local\nbackup.pem.bak",
      "my\nprivate.key",
      "foo\nfirebase-adminsdk-1.json",
      ".claude.json.\n1",
      ".anthropic/credentials/sub\nname/oauth.json",
    ];
    for (const p of blocked) {
      expect(isSecretFilename(p), p).toBe(true);
    }

    expect(isSecretFilename("src/%2e%2e/login.ts")).toBe(false);
    expect(isSecretFilename("src/local\nbackup.ts")).toBe(false);
  });

  it("blocks POSIX filenames containing literal backslashes (S14)", () => {
    for (const p of [".env.local\\backup", "sub/.env.local\\backup", ".env\\local"]) {
      expect(isNeverEditPath(p), `never-edit:${p}`).toBe(true);
      expect(isSecretFilename(p), `secret:${p}`).toBe(true);
    }
    for (const p of [".env.local\\backup.bak", ".\u0435nv.local\\backup"]) {
      expect(isSecretFilename(p), `secret-variant:${p}`).toBe(true);
    }
    for (const p of ["src/foo\\bar.ts", "foo\\bar/.env.example"]) {
      expect(isNeverEditPath(p), `allow-never:${p}`).toBe(false);
      expect(isSecretFilename(p), `allow-secret:${p}`).toBe(false);
    }
  });
});
