# PRJ-0002 Ephemeral INPUT Recovery Operator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the guarded recovery workflow process `PRJ-0002` without storing or rotating the persistent production ingress secret in GitHub.

**Architecture:** Add a recovery-only, time-bounded operator credential to the production entrypoint and install it only in a zero-traffic Worker version created by the workflow. The workflow targets that version explicitly, validates recovery and `remaining=0`, then unconditionally restores the authoritative production deployment and proves revocation.

**Tech Stack:** TypeScript, Cloudflare Workers and version overrides, GitHub Actions YAML, Vitest, Node.js static contract checks.

**Spec:** `docs/superpowers/specs/2026-09-07-prj-0002-ephemeral-input-recovery-operator-design.md`

## Global Constraints

- Do not read, rotate, overwrite, or expose the persistent `INGRESS_TOKEN`.
- Normal production traffic remains on the captured base Worker version at 100% throughout the operator window.
- The ephemeral credential authorizes only `POST /v1/admin/recover-inputs` and `GET /v1/admin/input-recovery-status`.
- Recovery remains limited to one exact `PRJ-xxxx` supplied through guarded manual dispatch.
- Cleanup runs unconditionally and independently verifies base restoration and token revocation.
- No merge, permanent deployment, or production recovery occurs during branch implementation.

---

### Task 1: Recovery-only runtime authorization

**Files:**
- Modify: `src/env.ts`
- Modify: `src/index-mutation-gate.ts`
- Test: `test/admin-recover-inputs.spec.ts`

**Interfaces:**
- Consumes: existing `INGRESS_TOKEN`, `secureStringEqual`, recovery admin routes, and timestamped operator-token format.
- Produces: optional `Env.INPUT_RECOVERY_OPERATOR_TOKEN` and recovery-only authorization for the two admin recovery routes.

- [ ] **Step 1: Write failing authorization-isolation tests**

Add helpers that build an environment with `INPUT_RECOVERY_OPERATOR_TOKEN`, plus tests proving that a fresh timestamped recovery token:

```ts
const recoveryOperatorToken = `${Date.now()}.recovery-operator-secret`;
const recoveryEnv = {
  ...testEnv,
  INPUT_RECOVERY_OPERATOR_TOKEN: recoveryOperatorToken,
} as Env;
```

is accepted by both recovery routes, but receives HTTP 401 on `/v1/mutation-candidates/resolve` and `/v1/transactions`. Add expired and future-skew cases that receive HTTP 401 from recovery routes.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run test/admin-recover-inputs.spec.ts
```

Expected: failure because recovery endpoints still accept only `INGRESS_TOKEN` and `Env` lacks the recovery token.

- [ ] **Step 3: Add the minimal recovery-only credential**

Add to `Env`:

```ts
INPUT_RECOVERY_OPERATOR_TOKEN?: string;
```

Replace `authorizedIngress` only on the two recovery routes with `authorizedRecovery`. Implement it as:

```ts
function authorizedRecovery(request: Request, env: Env, now = Date.now()): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization) return false;
  if (typeof env.INGRESS_TOKEN === "string" && env.INGRESS_TOKEN.length > 0
      && secureStringEqual(authorization, `Bearer ${env.INGRESS_TOKEN}`)) return true;
  const token = env.INPUT_RECOVERY_OPERATOR_TOKEN;
  return Boolean(token && validOperatorToken(token, now)
    && secureStringEqual(authorization, `Bearer ${token}`));
}
```

Keep `authorizedResolution` and `MUTATION_GATE_OPERATOR_TOKEN` unchanged.

- [ ] **Step 4: Run focused API tests and verify GREEN**

Run:

```bash
npx vitest run test/admin-recover-inputs.spec.ts test/mutation-gate-operator-auth.spec.ts
```

Expected: all tests pass, including isolation from MutationGate and general ingress.

- [ ] **Step 5: Commit the runtime authorization change**

```bash
git add src/env.ts src/index-mutation-gate.ts test/admin-recover-inputs.spec.ts
git commit -m "feat: add ephemeral input recovery authorization"
```

---

### Task 2: Zero-traffic recovery workflow

**Files:**
- Modify: `.github/workflows/recover-inputs.yml`
- Test: `test/recover-inputs-workflow.spec.ts`
- Test: `scripts/check-recover-inputs-workflow.mjs`

**Interfaces:**
- Consumes: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, Worker name `project-os-guard`, health deployment identity, and `INPUT_RECOVERY_OPERATOR_TOKEN` from Task 1.
- Produces: a temporary zero-traffic Worker version, version-pinned recovery calls, sanitized recovery summary, `remaining=0` proof, and unconditional cleanup proof.

- [ ] **Step 1: Rewrite workflow tests to define the secure operator lifecycle**

Require the workflow source to contain:

```ts
expect(source).toContain("INPUT_RECOVERY_OPERATOR_TOKEN");
expect(source).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}");
expect(source).toContain("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
expect(source).toContain("Cloudflare-Workers-Version-Overrides");
expect(source).toContain("@0%");
expect(source).toContain("if: always()");
expect(source).not.toContain("secrets.INGRESS_TOKEN");
```

Also require a shared production concurrency group, captured base at 100%, Git-attributed health, masked token, bounded retries, explicit `PRJ-xxxx`, sanitized counters, restoration to base at 100%, override removal, and HTTP 401 revocation verification.

- [ ] **Step 2: Run workflow contracts and verify RED**

Run:

```bash
node scripts/check-recover-inputs-workflow.mjs
npx vitest run test/recover-inputs-workflow.spec.ts
```

Expected: failure because the current workflow depends on the missing persistent GitHub ingress secret and has no operator-version lifecycle.

- [ ] **Step 3: Implement the zero-traffic operator lifecycle**

Adapt the proven lifecycle from `.github/workflows/mutation-candidate-reject.yml`:

```yaml
env:
  WORKER_NAME: project-os-guard
  CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

Add checkout, Node setup, dependency installation, captured base deployment validation, Git-attributed health validation, random timestamped token generation with `::add-mask::`, `wrangler versions upload --secrets-file`, 100%/0% deployment attachment, normal-traffic identity verification, and version-override readiness. Send both recovery calls with:

```yaml
--header "Authorization: Bearer $OPERATOR_TOKEN"
--header "Cloudflare-Workers-Version-Overrides: $WORKER_NAME=\"$OPERATOR_VERSION_ID\""
```

Implement `if: always()` cleanup that restores only `$BASE_VERSION_ID@100%`, verifies health convergence, proves the override no longer reaches the operator version, and proves the token receives HTTP 401 on normal traffic.

- [ ] **Step 4: Strengthen the static checker**

Parse the YAML structure and reject missing or broadened gates. Assert exactly the expected GitHub secret expressions, no `INGRESS_TOKEN`, no direct Dropbox API path, no unbounded loop, no raw token output, and an unconditional cleanup step containing all three cleanup proofs.

- [ ] **Step 5: Run workflow tests and verify GREEN**

Run:

```bash
node scripts/check-recover-inputs-workflow.mjs
npx vitest run test/recover-inputs-workflow.spec.ts
```

Expected: both contract layers pass.

- [ ] **Step 6: Commit the workflow lifecycle change**

```bash
git add .github/workflows/recover-inputs.yml test/recover-inputs-workflow.spec.ts scripts/check-recover-inputs-workflow.mjs
git commit -m "fix: use ephemeral operator for input recovery"
```

---

### Task 3: Full verification and PR preparation

**Files:**
- Verify all files changed in Tasks 1 and 2.
- Update the design or implementation plan only if verification exposes a documented contradiction.

**Interfaces:**
- Consumes: completed runtime and workflow changes.
- Produces: a reviewable branch with reproducible verification evidence.

- [ ] **Step 1: Run focused security tests**

```bash
npx vitest run test/admin-recover-inputs.spec.ts test/mutation-gate-operator-auth.spec.ts test/recover-inputs-workflow.spec.ts
node scripts/check-recover-inputs-workflow.mjs
```

Expected: all pass.

- [ ] **Step 2: Run the complete repository checks**

```bash
npm run check
```

Expected: type generation, typecheck, static gates, targeted suites, and the full Vitest suite all pass.

- [ ] **Step 3: Verify deployment packaging without deploying**

```bash
npx wrangler deploy --dry-run
```

Expected: successful build and binding validation with no production deployment.

- [ ] **Step 4: Verify diff hygiene and scope**

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git status --short
```

Expected: no whitespace errors, only the planned specification, plan, runtime authorization, workflow, and tests are changed, and the tracked tree is clean.

- [ ] **Step 5: Request an independent read-only code review**

Provide the exact base SHA, head SHA, verification results, and the constraints: no merge, deployment, or recovery.

- [ ] **Step 6: Publish the branch and open a pull request**

Push `fix/prj-0002-ephemeral-recovery-operator`, open a PR against `main`, and monitor its CI to a terminal result. Do not merge or deploy.
