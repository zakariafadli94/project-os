# Global active-project convergence rollout evidence — 2026-09-11

## Operator decision

The operator explicitly authorized a complete rollout to every project whose canonical registry lifecycle is active, without retaining a project-by-project canary. Human-facing alert delivery remains deferred and non-blocking. Durable incidents, retries, runtime metrics, signed mutation-context admission, transaction-only canonical writes and committed-receipt rules remain unchanged.

## Registry scope

An authenticated read-only mutation-context inventory returned:

| Project | Lifecycle | Canonical revision | Writer decision |
|---|---:|---:|---|
| PRJ-0001 | archived | 2 | excluded |
| PRJ-0002 | active | 169 | repair |
| PRJ-0003 | active | 267 | repair |
| PRJ-0004 | archived | 19 | excluded |
| PRJ-0005 | archived | 7 | excluded |
| PRJ-0006 | archived | 2 | excluded |
| PRJ-0007 | active | 33 | repair |
| PRJ-0008 | active | 3 | repair |

## Regression and capacity correction

The production investigation found that repeated target registration could consume the bounded slice before useful repair, one-record discovery could materialize an intermediate target unnecessarily, and a satisfied request could remain in the convergence journal. The permanent correction transports the newest ledger target into the external journal, coalesces superseded human work, uses production-specific discovery/final-verification batch limits, preserves the broader deterministic test envelope, and closes stale human obligations only behind a current immutable projection-v3 head.

## Verified gates

- Focused regression set: 10 files, 99 tests passed.
- Complete post-merge suite at code SHA `b77a90a9ea653c597040f144b80fe10ac14f462c`: 207 files, 1,035 tests passed.
- Generated Cloudflare types and TypeScript no-emit check: exit 0; the generated untracked type file was removed after review.
- `git diff --check`: exit 0.
- Cloudflare bundle-only dry run: 1,788.03 KiB, 302.88 KiB gzip, exited before upload.
- Production before the final global configuration already reported PRJ-0002 at 169/PV3, PRJ-0003 at 267/PV3 and PRJ-0007 at 33/PV3, each with no active/requested target, no blocked error, no pending final verification, no pending obligation and no alarm. PRJ-0008 separately reported 3/PV3 with the same empty pending state.

## Final integration and production proof

- GitHub pull request #180 passed CI run `34546449751`, including the complete test, repository policy, persistence, recovery and Cloudflare dry-run gates.
- GitHub merged the reviewed release as `4f4ff59e397a0a6bfbbaf85501bd090f4b46ebd9`.
- Project Guard was deployed from the identical tree with tag `git-4f4ff59e397a0a6bfbbaf85501bd090f4b46ebd9` and the explicit active-project map `{PRJ-0002, PRJ-0003, PRJ-0007, PRJ-0008}: repair`.
- Production health returned the exact merged SHA and tag.
- A post-deployment materialization completed at PRJ-0002 revision 169, PRJ-0003 revision 267, PRJ-0007 revision 33 and PRJ-0008 revision 3.
- The final authenticated status read found, for every active project, canonical revision equal to head revision, projection version 3, no requested or active target, no blocked error, zero pending final verification, no pending obligation, no alarm, and a verified human handoff.

No canonical business revision was introduced by the rollout.

Independent code review found and closed three activation defects before the final gate: provider head deletion could be hidden by a stale local ledger, deferred notification configuration also suppressed durable incident persistence, and the production fleet retained archived IDs from an older pending page. Fresh provider generation binding, durable incident retention, and active-scope fleet pruning now have direct regression coverage. The final re-review reported no remaining critical or important issue.
