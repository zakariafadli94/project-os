# MutationGate Ephemeral Operator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the GitHub-stored ingress-token dependency with a short-lived, resolution-only Cloudflare Worker secret that Project OS can create, use, revoke, and audit without human secret handling.

**Architecture:** The Worker keeps `INGRESS_TOKEN` unchanged and adds an optional `MUTATION_GATE_OPERATOR_TOKEN` accepted only by the public candidate-resolution route. The GitHub Actions repair workflow generates a timestamped random token, installs it with existing Cloudflare deployment credentials, executes governed candidate rejects, then deletes and verifies revocation in `always()` cleanup. An owner-only exact-title issue event provides a connector-accessible launch surface while `workflow_dispatch` remains available.

**Tech Stack:** TypeScript, Cloudflare Workers/Durable Objects, Vitest, GitHub Actions YAML, Node.js 22, Wrangler 4.x.

**Spec:** `docs/superpowers/specs/2026-08-28-mutationgate-ephemeral-operator-design.md`

## Global Constraints

- Preserve `INGRESS_TOKEN` unchanged and never expose its value.
- `MUTATION_GATE_OPERATOR_TOKEN` authorizes only `POST /v1/mutation-candidates/resolve`.
- Operator token maximum age is 15 minutes, with at most 60 seconds future clock skew.
- Use existing GitHub Actions `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; do not add another persistent GitHub secret.
- Use `wrangler secret bulk` so omitted Worker secrets remain untouched.
- Cleanup must run on success or failure, remove only `MUTATION_GATE_OPERATOR_TOKEN`, health-check production, and verify the removed token returns HTTP 401.
- No direct Dropbox writes.
- No repair execution is part of the code-change PR; the eight candidate rejects occur only after merge/deploy and a fresh final repair gate.

---

### Task 1: Resolution-only ephemeral authentication

**Files:**
- Modify: `src/env.ts`
- Modify: `src/index-mutation-gate.ts`
- Test: `test/mutation-candidate-resolution.spec.ts`

**Interfaces:**
- Consumes: existing `Env.INGRESS_TOKEN` and public `/v1/mutation-candidates/resolve` route.
- Produces: optional `Env.MUTATION_GATE_OPERATOR_TOKEN?: string` and authorization that accepts a current operator token only on the resolution route.

- [ ] **Step 1: Write failing runtime tests**

Extend the public-ingress test so it proves all of the following before implementation:

```ts
const now = Date.now();
const currentOperatorToken = `${now}.${"a".repeat(64)}`;
const expiredOperatorToken = `${now - 16 * 60_000}.${"b".repeat(64)}`;
const operatorEnv = {
  ...testEnv,
  MUTATION_GATE_OPERATOR_TOKEN: currentOperatorToken
} as Env;
```

Assertions:
- the existing `INGRESS_TOKEN` still commits a candidate reject;
- `currentOperatorToken` also authenticates the candidate-resolution route;
- an expired configured token receives 401;
- `Bearer undefined` receives 401 when no operator token is configured;
- the operator token receives 401 on `POST /v1/transactions`, proving it has no general ingress authority.

- [ ] **Step 2: Run the targeted test and verify RED**

Run through CI after committing the test-only change. Expected: failure because `Env`/authorization do not yet support `MUTATION_GATE_OPERATOR_TOKEN`.

- [ ] **Step 3: Implement minimal runtime support**

In `src/env.ts` add:

```ts
MUTATION_GATE_OPERATOR_TOKEN?: string;
```

In `src/index-mutation-gate.ts`, keep the existing ingress-token comparison and add a separate operator-token branch:

```ts
const OPERATOR_TOKEN_TTL_MS = 15 * 60_000;
const OPERATOR_TOKEN_FUTURE_SKEW_MS = 60_000;

function authorizedResolution(request: Request, env: Env, now = Date.now()): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization) return false;
  if (secureStringEqual(authorization, `Bearer ${env.INGRESS_TOKEN}`)) return true;

  const token = env.MUTATION_GATE_OPERATOR_TOKEN;
  if (!token || !validOperatorToken(token, now)) return false;
  return secureStringEqual(authorization, `Bearer ${token}`);
}

function validOperatorToken(token: string, now: number): boolean {
  const separator = token.indexOf(".");
  if (separator <= 0) return false;
  const issuedAt = Number(token.slice(0, separator));
  if (!Number.isSafeInteger(issuedAt)) return false;
  if (issuedAt > now + OPERATOR_TOKEN_FUTURE_SKEW_MS) return false;
  return now - issuedAt <= OPERATOR_TOKEN_TTL_MS;
}
```

Use `authorizedResolution` only in the candidate-resolution route. Do not modify `baseWorker` ingress authorization.

- [ ] **Step 4: Run targeted tests and verify GREEN**

Expected: all candidate-resolution tests pass, including route isolation and expiry.

- [ ] **Step 5: Commit Task 1**

Commit runtime + tests with a message equivalent to `feat: add ephemeral MutationGate operator auth`.

---

### Task 2: Self-contained operator workflow

**Files:**
- Modify: `.github/workflows/mutation-candidate-reject.yml`
- Modify: `scripts/check-mutation-gate-repair-workflow.mjs`

**Interfaces:**
- Consumes: existing Cloudflare repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, Wrangler config for `project-os-guard`, and the runtime token boundary from Task 1.
- Produces: a workflow that creates/revokes the operator token itself and can be launched via `workflow_dispatch` or an owner-only exact-title issue event.

- [ ] **Step 1: Tighten the static workflow contract first**

Update `scripts/check-mutation-gate-repair-workflow.mjs` so the current workflow fails the check unless it contains all required controls:

```js
forbid(/PROJECT_OS_INGRESS_TOKEN/, "persistent GitHub ingress-token dependency");
requireText("CLOUDFLARE_API_TOKEN", "existing Cloudflare API credential");
requireText("CLOUDFLARE_ACCOUNT_ID", "existing Cloudflare account credential");
requireText("MUTATION_GATE_OPERATOR_TOKEN", "ephemeral Worker operator secret");
requireText("wrangler secret bulk", "non-interactive Worker secret lifecycle");
requireText("::add-mask::", "GitHub log masking");
requireText("if: always()", "unconditional cleanup path");
requireText("HTTP 401", "post-cleanup revocation verification");
requireText("issues:", "connector-accessible explicit operator trigger");
requireText("github.repository_owner", "owner-only issue trigger guard");
```

Continue requiring manual `workflow_dispatch`, exact eight repair candidate IDs, governed endpoint, committed/reject checks, explicit confirmation input, and prohibition of direct Dropbox access. Continue forbidding `push` and `pull_request` triggers.

- [ ] **Step 2: Run `npm run check` through CI and verify RED**

Expected: the static contract fails against the existing workflow because it still depends on `PROJECT_OS_INGRESS_TOKEN` and lacks token lifecycle/cleanup controls.

- [ ] **Step 3: Implement the workflow token lifecycle**

Keep the current validation and deterministic reject loop, but replace the static GitHub ingress secret with these steps:

1. checkout + setup Node 22 + `npm install` so the pinned project Wrangler is used;
2. validate Cloudflare credentials and operator request;
3. generate `OPERATOR_TOKEN` as `<Date.now()>.<64 hex random chars>`, immediately emit `::add-mask::<token>`, and persist only to `$GITHUB_ENV`;
4. install it non-interactively:

```bash
node -e 'process.stdout.write(JSON.stringify({MUTATION_GATE_OPERATOR_TOKEN: process.env.OPERATOR_TOKEN}))' \
  | npx wrangler secret bulk
```

5. health-check `PROJECT_OS_URL/health` before resolution calls;
6. run the existing eight candidate rejects using `Authorization: Bearer $OPERATOR_TOKEN`;
7. cleanup with `if: always()` using:

```bash
printf '%s' '{"MUTATION_GATE_OPERATOR_TOKEN":null}' | npx wrangler secret bulk
```

8. health-check after cleanup;
9. probe `POST /v1/mutation-candidates/resolve` with the removed token and `{}` and require HTTP 401. Any other status fails cleanup verification.

For the connector-accessible trigger add:

```yaml
on:
  workflow_dispatch: ...
  issues:
    types: [opened]
```

The job may run for `workflow_dispatch`, or for an issue only when:

```yaml
github.event_name == 'issues' &&
github.actor == github.repository_owner &&
github.event.issue.title == '[operator] MutationGate PRJ-0003 reject repair'
```

For the issue path, bind `PRJ-0003`, the exact eight hard-coded IDs, and confirmation=true. Other issues must skip the job.

- [ ] **Step 4: Run `npm run check` and verify GREEN**

Expected: static contract passes and all existing 439+ tests remain green.

- [ ] **Step 5: Commit Task 2**

Commit workflow + checker with a message equivalent to `feat: self-provision MutationGate operator token`.

---

### Task 3: Full CI, exact-diff review, and merge gate

**Files:**
- Review all changed files from Tasks 1-2 plus the accepted spec/plan.

**Interfaces:**
- Produces: a merge-ready PR; does not execute PRJ-0003 repair.

- [ ] **Step 1: Run full CI on the exact head**

Required green gates:
- `npm run check`;
- `npm run test:persistence-high-risk`;
- `npx wrangler deploy --dry-run`.

- [ ] **Step 2: Review exact PR diff**

Verify:
- no persistent operator token or token value appears anywhere;
- `INGRESS_TOKEN` behavior is unchanged;
- operator token is referenced only by `src/env.ts`, `src/index-mutation-gate.ts`, tests/checker, and the repair workflow;
- no Dropbox mutation path was added;
- no `push`/`pull_request` trigger was added to the repair workflow;
- issue-trigger path is owner-only and exact-title scoped.

- [ ] **Step 3: Present merge/deploy gate**

Because merging to `main` triggers the existing production deploy workflow, present the exact tested head, changed-file list, CI results, and automatic production-deploy consequence. Do not merge without explicit user approval.

- [ ] **Step 4: After approved merge, verify production deployment**

Confirm the merge commit on `main`, CI success, Worker deployment success, Worker version ID, and production `{"status":"ok"}` health response.

- [ ] **Step 5: Stop before repair execution**

Refresh PRJ-0003 canonical state and the eight candidate records. Present the exact eight `candidate.reject` terminal mutation plan and obtain the final repair gate before creating the owner-only control issue that launches the workflow.
