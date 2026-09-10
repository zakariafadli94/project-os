# Control Tower Governed Ingress Implementation Plan

> **For implementation:** REQUIRED SKILL: Use `superpowers:executing-plans` in this existing conversation and worktree. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore safe Project OS progress from Control Tower without exposing shared secrets or bypassing typed transactions, signed admission, ProjectGuard ownership, and committed receipts.

**Architecture:** First ship a reversible local operator bridge so the current Codex host can submit one governed request at a time. Then extract the existing HTTP routing into a shared admission service and expose four narrowly scoped tools from a separate OAuth-protected Cloudflare MCP Worker bound to the existing guard namespaces.

**Tech Stack:** TypeScript 5.9, Vitest 4, Zod 4, Cloudflare Workers/Durable Objects, Wrangler 4, Streamable HTTP MCP, `@cloudflare/workers-oauth-provider`, GitHub OAuth.

**Spec:** `docs/superpowers/specs/2026-09-10-control-tower-governed-ingress-design.md`

## Global Constraints

- Dropbox is canonical; never write canonical files directly.
- Every durable mutation uses an existing typed request and its authoritative guard.
- Report persistence only after a matching terminal `status: "committed"` receipt.
- Preserve `INGRESS_TOKEN`; never read, rotate, print, or send it to Control Tower.
- The emergency credential is random, masked, memory-only, and inaccessible after cleanup.
- The permanent MCP Worker authorizes only `zakaria.fadli.94@gmail.com`.
- PRJ-0003 is read-only until the existing convergence rollout gate passes.
- No new worktree and no automatic production deployment.

---

### Task 1: Emergency single-request operator bridge

**Files:**
- Create: `scripts/control-tower-operator.mjs`
- Create: `scripts/control-tower-operator.d.mts`
- Create: `test/control-tower-operator.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: current Wrangler OAuth session, active Worker deployment, `/health`, `/v1/projects/<id>/mutation-context`, and existing public typed ingress routes.
- Produces: `runOperatorSubmission(input, ports): Promise<SanitizedOperatorResult>` and CLI `npm run operator:submit -- --request <absolute-json-path>`.

- [ ] **Step 1: Write the failing operator lifecycle tests**

  Add fixtures for exactly one base version at 100%, a generated ephemeral token, a zero-traffic operator version, a successful context response, a committed document receipt, and an exact base-only cleanup response. Assert the token never appears in logs/result, normal health never leaves the captured base, the submitted envelope preserves exact request bytes/context, cleanup uses the REST deployment body below, and the final override resolves to base:

  ```json
  {
    "strategy": "percentage",
    "versions": [{ "version_id": "BASE_VERSION_ID", "percentage": 100 }],
    "annotations": { "workers/message": "Restore sole base after governed operator submission" }
  }
  ```

- [ ] **Step 2: Verify the test is red**

  Run:

  ```bash
  /Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run test/control-tower-operator.spec.ts
  ```

  Expected: FAIL because `scripts/control-tower-operator.mjs` does not exist.

- [ ] **Step 3: Implement the bounded operator lifecycle**

  Parse a strict request file containing only:

  ```ts
  type OperatorInput = {
    kind: "transaction" | "document" | "artifact";
    project_id: string;
    request: unknown;
  };
  ```

  Enforce 256 KiB maximum input, exact project binding, current parsers, one request only, and no unknown top-level keys. Capture the latest active deployment and require one exact 100% base version. Generate the token in memory, upload the current Git-attributed source as a zero-traffic version, attach it with base at 100%, target reads/writes with `Cloudflare-Workers-Version-Overrides`, fetch fresh context immediately before submission, and require the matching committed receipt.

  Cleanup must call `POST /accounts/<account>/workers/scripts/project-os-guard/deployments?force=true` with only the captured base version. Do not rely on `wrangler versions deploy BASE@100%`: the 2026-09-10 production probe demonstrated that Wrangler can retain an attached 0% version. After cleanup, prove normal `/health` returns the base, the old override returns the base, and the temporary credential is rejected on normal traffic.

- [ ] **Step 4: Verify green and secret redaction**

  Run the targeted test and scan output/code for token logging:

  ```bash
  /Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run test/control-tower-operator.spec.ts
  rg -n "console\.(log|error).*token|process\.stdout.*token" scripts/control-tower-operator.mjs test/control-tower-operator.spec.ts
  ```

  Expected: tests PASS; `rg` returns no unsafe log statement.

- [ ] **Step 5: Commit**

  ```bash
  git add package.json scripts/control-tower-operator.mjs scripts/control-tower-operator.d.mts test/control-tower-operator.spec.ts
  git commit -m "feat: add reversible governed operator submission"
  ```

### Task 2: Shared governed admission service

**Files:**
- Create: `src/admission/governed-submit.ts`
- Create: `test/governed-submit.spec.ts`
- Modify: `src/index-neutral.ts`
- Modify: `src/index-mutation-gate.ts`

**Interfaces:**
- Consumes: `Transaction`, `ManagedDocumentRequest`, `ArtifactWriteRequest`, `MutationContext`, ProjectGuard/RegistryGuard bindings, existing continuity and policy functions.
- Produces: `GovernedSubmission`, `GovernedSubmissionResult`, and `executeGovernedSubmission(env, submission, context)`.

- [ ] **Step 1: Write failing equivalence tests**

  Exercise transaction, `working.write`, artifact, `project.create`, admission failure, domain conflict, and exact replay through both the existing HTTP handler and the new service. Assert identical status/receipt bytes and zero new receipt on missing or stale context.

- [ ] **Step 2: Verify red**

  ```bash
  /Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run test/governed-submit.spec.ts test/mutation-context-transport.spec.ts
  ```

  Expected: FAIL on the missing `executeGovernedSubmission` export.

- [ ] **Step 3: Extract without changing behavior**

  Move only the existing route selection and guard delegation into `governed-submit.ts`. Keep parsing at the boundary, preserve `AdmissionError`, continuity/fallback identity, artifact policy, document replay ordering, and RegistryGuard allocation. Replace the three HTTP route bodies with calls to the service.

- [ ] **Step 4: Verify focused compatibility**

  ```bash
  /Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run test/governed-submit.spec.ts test/mutation-context-transport.spec.ts test/rollback-routing.spec.ts test/review-candidate-e2e.spec.ts test/registry-guard.spec.ts test/project-guard-direct-concurrency.spec.ts
  ```

  Expected: all PASS with byte-identical receipts.

- [ ] **Step 5: Commit**

  ```bash
  git add src/admission/governed-submit.ts src/index-neutral.ts src/index-mutation-gate.ts test/governed-submit.spec.ts
  git commit -m "refactor: share governed Project OS admission"
  ```

### Task 3: OAuth-protected Control Tower MCP Worker

**Files:**
- Create: `src/control-tower/index.ts`
- Create: `src/control-tower/auth.ts`
- Create: `src/control-tower/mcp.ts`
- Create: `wrangler.control-tower.jsonc`
- Create: `test/control-tower-auth.spec.ts`
- Create: `test/control-tower-mcp.spec.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `executeGovernedSubmission`, cross-script `PROJECT_GUARD` and `REGISTRY_GUARD` bindings to `project-os-guard`, OAuth user claims.
- Produces: Streamable HTTP `/mcp`, `/authorize`, `/callback`, `/token`, `/register`; scopes `project.read` and `project.mutate`.

- [ ] **Step 1: Add exact dependencies and failing auth tests**

  Add the versions verified on 2026-09-10: `agents@0.22.0`, `@modelcontextprotocol/sdk@1.30.0`, and `@cloudflare/workers-oauth-provider@0.10.3`. Test unauthenticated denial, wrong email denial, missing scope denial, allowed email/scope success, redirect URI exact-match, CSRF mismatch, expired OAuth state, and escaped client metadata.

- [ ] **Step 2: Verify red**

  ```bash
  /Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run test/control-tower-auth.spec.ts test/control-tower-mcp.spec.ts
  ```

  Expected: FAIL because the Control Tower Worker and handlers are absent.

- [ ] **Step 3: Implement OAuth and focused bindings**

  Use `OAuthProvider` and a stateless `createMcpHandler()` at `/mcp`. Store short-lived OAuth state in a dedicated KV binding `OAUTH_KV`; use `__Host-` secure cookies, exact redirect URI matching, CSP, and CSRF verification. Accept only the normalized GitHub email `zakaria.fadli.94@gmail.com`. Configure cross-script Durable Object bindings with `script_name: "project-os-guard"`; do not add Dropbox credentials or Project OS signing/ingress secrets to this Worker.

- [ ] **Step 4: Verify auth and no-secret boundary**

  ```bash
  /Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run test/control-tower-auth.spec.ts test/control-tower-mcp.spec.ts
  rg -n "INGRESS_TOKEN|MUTATION_CONTEXT_SIGNING_KEY|DROPBOX_" src/control-tower wrangler.control-tower.jsonc
  ```

  Expected: tests PASS; `rg` returns no secret dependency.

- [ ] **Step 5: Commit**

  ```bash
  git add package.json package-lock.json src/control-tower wrangler.control-tower.jsonc test/control-tower-auth.spec.ts test/control-tower-mcp.spec.ts
  git commit -m "feat: authenticate the Control Tower MCP bridge"
  ```

### Task 4: Goal-oriented Project OS tools and receipt recovery

**Files:**
- Modify: `src/control-tower/mcp.ts`
- Create: `src/control-tower/tools.ts`
- Create: `src/control-tower/sanitize.ts`
- Create: `test/control-tower-tools.spec.ts`

**Interfaces:**
- Consumes: authenticated principal/scopes, ProjectGuard read-only context route, `executeGovernedSubmission`.
- Produces: `project_os_get_context`, `project_os_submit_transaction`, `project_os_write_working_document`, `project_os_get_receipt`.

- [ ] **Step 1: Write failing tool tests**

  Cover fresh context acquisition, strict parsing, project/request mismatch, PRJ-AUTO creation, working document write, stale context, forged request ID, lost response followed by exact receipt recovery, exact replay, changed-payload replay, non-committed result, and sanitized output. Assert no tool accepts a token, provider path, internal URL, or arbitrary JSON operation.

- [ ] **Step 2: Verify red**

  ```bash
  /Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run test/control-tower-tools.spec.ts
  ```

  Expected: FAIL on missing tool registrations.

- [ ] **Step 3: Implement the four tools**

  Register explicit Zod schemas. Mutation tools fetch canonical context immediately before admission; `project.create` uses RegistryGuard allocation without a fictional context. Return only `status`, `project_id`, request identity, previous/new revision when present, event/version/document identifiers when present, and a stable error code. On ambiguous transport, call the exact read-only receipt lookup before deciding whether to retry the same request ID.

- [ ] **Step 4: Verify green**

  ```bash
  /Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run test/control-tower-tools.spec.ts test/governed-submit.spec.ts test/mutation-context-admission.spec.ts
  ```

  Expected: all PASS; no duplicate commit under lost response.

- [ ] **Step 5: Commit**

  ```bash
  git add src/control-tower/mcp.ts src/control-tower/tools.ts src/control-tower/sanitize.ts test/control-tower-tools.spec.ts
  git commit -m "feat: expose receipt-gated Project OS tools"
  ```

### Task 5: Deployment gates, Control Tower connection, and synthetic qualification

**Files:**
- Create: `.github/workflows/deploy-control-tower.yml`
- Create: `scripts/check-control-tower-deployment.mjs`
- Create: `test/control-tower-deployment.spec.ts`
- Modify: `package.json`
- Modify: `docs/deployment.md`
- Modify: `docs/continuity.md`

**Interfaces:**
- Consumes: exact merged Git SHA, Cloudflare deployment credentials, GitHub OAuth client ID/secret, cookie key, OAuth KV namespace.
- Produces: Git-attributed `project-os-control-tower` Worker, verified `/mcp` OAuth discovery, rollback command, and client connection URL.

- [ ] **Step 1: Write failing deployment-policy tests**

  Require manual dispatch, exact SHA confirmation, full CI before deployment, no Project OS secret in the MCP Worker, synthetic PRJ-0008 only, explicit rollback, and no PRJ-0003 mutation. Require post-deploy OAuth denial without login and successful authenticated tool listing for the allowed identity.

- [ ] **Step 2: Verify red**

  ```bash
  /Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run test/control-tower-deployment.spec.ts
  ```

  Expected: FAIL because the workflow/checker are absent.

- [ ] **Step 3: Implement workflow and documentation**

  Deploy only `wrangler.control-tower.jsonc`, tag `git-<sha>`, verify OAuth metadata and authenticated MCP initialization, then run read-only PRJ-0008 context. Document the one-time client connection to `https://project-os-control-tower.zakaria-fadli-94.workers.dev/mcp` and GitHub OAuth consent. Rollback disables or removes only the MCP route; the canonical Worker and inbox remain untouched.

- [ ] **Step 4: Run repository gates**

  ```bash
  /Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run test/control-tower-deployment.spec.ts test/control-tower-auth.spec.ts test/control-tower-mcp.spec.ts test/control-tower-tools.spec.ts
  /Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-control-tower-deployment.mjs
  /Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/typescript/bin/tsc --noEmit
  git diff --check
  ```

  Expected: all PASS and no whitespace error.

- [ ] **Step 5: Commit**

  ```bash
  git add .github/workflows/deploy-control-tower.yml scripts/check-control-tower-deployment.mjs test/control-tower-deployment.spec.ts package.json docs/deployment.md docs/continuity.md
  git commit -m "docs: gate Control Tower governed ingress deployment"
  ```

### Task 6: End-to-end proof and controlled project release

**Files:**
- Modify: `docs/deployment.md`
- Modify: `docs/continuity.md`

**Interfaces:**
- Consumes: merged and deployed exact MCP SHA, authenticated Control Tower client, PRJ-0008 synthetic canary, user-accepted PRJ-0007 C0.
- Produces: committed/replay evidence, rollback evidence, and an explicit release decision.

- [ ] **Step 1: Run complete local and CI qualification**

  ```bash
  /Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run
  /Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/typescript/bin/tsc --noEmit
  /Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/wrangler/bin/wrangler.js deploy --config wrangler.control-tower.jsonc --dry-run
  ```

  Expected: full suite, types, and dry-run PASS on the exact reviewed SHA.

- [ ] **Step 2: Prove PRJ-0008 mutation and replay**

  From the authenticated MCP client, create one explicitly named synthetic task on PRJ-0008, capture its committed receipt, replay the exact request and require the identical receipt, then reuse the ID with changed bytes and require rejection. Verify STATE/HANDOFF convergence and receipt lookup without a second revision.

- [ ] **Step 3: Prove rollback**

  Disable the MCP Worker route, confirm the MCP tools are unavailable, and verify `project-os-guard` health/public ingress/inbox are unchanged. Restore the same exact reviewed MCP version and repeat read-only PRJ-0008 context.

- [ ] **Step 4: Release normal projects**

  Mark the Control Tower channel available for existing projects only after the preceding proof. Submit PRJ-0007 C0 as `working.write` only after the Founder explicitly accepts that exact document; require its committed document receipt and visible working head. Keep PRJ-0003 read-only until the separate 24-hour convergence gate authorizes its repair.

- [ ] **Step 5: Record only observed evidence and commit**

  Add exact SHA, Worker version, OAuth identity result, PRJ-0008 request/receipt IDs, replay result, rollback result, and remaining PRJ-0003 gate to the deployment and continuity documents. Do not claim PRJ-0007 persistence without its actual committed receipt.

  ```bash
  git add docs/deployment.md docs/continuity.md
  git commit -m "docs: record Control Tower ingress qualification"
  ```

### Final gate

- [ ] Emergency operator path has unit tests and mandatory base-only cleanup.
- [ ] Permanent Control Tower path uses OAuth and no shared Project OS secret.
- [ ] Every mutation obtains fresh canonical context and a committed receipt.
- [ ] Exact replay and lost-response recovery are proven.
- [ ] PRJ-0008 passes read, mutation, replay, visibility, and rollback.
- [ ] Control Tower can invoke the tools after OAuth without local terminal access.
- [ ] PRJ-0007 C0 is written only after exact user acceptance.
- [ ] PRJ-0003 remains untouched until its independent convergence gate passes.
