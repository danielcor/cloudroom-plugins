### Task 1: Provider declaration and registration

**Files:**
- Create: `plugin-qoder/package.json`
- Create: `plugin-qoder/tsconfig.json`
- Create: `plugin-qoder/src/declaration.ts`
- Create: `plugin-qoder/server.ts`
- Create: `plugin-qoder/icons/qoder.svg`
- Create: `plugin-qoder/test/server.test.ts`

**Interfaces:**
- Consumes: `bb.providers.register` and `bb.settings.define` from the existing Plugin SDK, following `plugin-muse/server.ts`.
- Produces: `QODER_PROVIDER_ID`, `DEFAULT_QODER_COMMAND`, `qoderLaunchSpec(command: string): AcpLaunchSpec`, `qoderProviderDeclaration(command: string): PluginProviderDeclaration`, and default async `qoderProviderPlugin(bb: BbPluginApi): Promise<void>`.

- [ ] **Step 1: Create the branch and write the failing registration tests**

Create `feat/qoder-provider` from `origin/main`, carrying only the design/plan documents. In `test/server.test.ts`, add tests named:
- `registers Qoder through generic ACP with the exact launch contract`: assert provider id, display name, both permission modes, native reasoning, generic dialect, fallback model, `maintenance.usage === false`, and the exact launch spec including `--acp`, no `modelCli`, and both permission flag arrays.
- `uses the command setting and an empty one falls back to the absolute Qoder wrapper`: assert custom command and `/home/danielcor/.qoder/entry/qoder`.
- `replaces and disposes the registration without leaking resources`: assert reload leaves one current registration and disposal removes it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd plugin-qoder && npm ci && npx vitest run test/server.test.ts`
Expected: FAIL because `server.ts` and `src/declaration.ts` do not exist.

- [ ] **Step 3: Implement the package, declaration, registration, and icon**

Use `plugin-muse` only as the structural template. `qoderLaunchSpec` returns `{ displayName: "Qoder", command: command.trim() || DEFAULT_QODER_COMMAND, args: ["--acp"], env: {}, nativeReasoning: { configId: "reasoning_effort", supportedLevels: ["low", "medium", "high"], defaultLevel: "high" }, permissionCli: { workspaceWrite: ["--permission-mode", "default"], full: ["--permission-mode", "bypass_permissions"] } }`.
`qoderProviderDeclaration` sets generic ACP options, host-scoped dynamic models with the single Qwen fallback, and only the documented capabilities. `qoderProviderPlugin` defines the command setting, replaces registration on change, and disposes it on plugin disposal. Use a monochrome SVG icon and no frontend manifest entry.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd plugin-qoder && npx vitest run test/server.test.ts`
Expected: all registration tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin-qoder docs/superpowers
 git commit -m "feat(qoder): declare ACP provider and registration"
```

