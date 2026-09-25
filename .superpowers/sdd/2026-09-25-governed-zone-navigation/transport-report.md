# Bounded submission deadline correction — implementation report

## Result

Control Tower submissions now use independent boundary budgets. Mutation-context retrieval (including its JSON body) remains bounded at 10,000 ms. Once valid context has arrived, one submission budget of 40,000 ms covers the single POST and response JSON body. `project.create` skips context and receives the same 40,000 ms submission budget. Reads remain bounded at 10,000 ms.

The context elapsed-time check prevents a response that is processed after its deadline from starting a POST, even if the timeout callback itself was delayed. Each phase clears its timer. Timeout or other failure still aborts the shared signal and preserves the existing `not_submitted` versus `unknown`, recovery, sanitization, and single-request behavior.

## TDD and verification

- RED command: `/Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run test/control-tower-artifact.spec.ts`
- RED result: failed as expected, 3 tests failed and 18 passed. A transaction completing after 30 seconds incorrectly returned `unknown`; body parsing and create had already timed out at 10 seconds.
- Focused GREEN command: `/Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run test/control-tower-artifact.spec.ts test/control-tower-transport.spec.ts`
- Focused GREEN result: 2 files passed, 24 tests passed.
- Control Tower regression command: `/Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run test/control-tower-*.spec.ts`
- Control Tower regression result: 9 files passed, 65 tests passed. Includes the 10-second read deadline, late-context no-POST case, single POST and response-body timeout, and create timeout/status recovery.
- Typecheck command: `/Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/typescript/bin/tsc --noEmit`
- Typecheck result: passed (exit 0).
- Diff check: `git diff --check` passed (exit 0).

The repository-wide suite was left to the principal run as instructed.

## Files

- `src/control-tower/mcp.ts`
- `test/control-tower-artifact.spec.ts`
- `.superpowers/sdd/2026-09-25-governed-zone-navigation/transport-report.md`

## Concerns

No implementation concerns identified. No production action, replay, or full suite was run. Existing unrelated documentation/evidence changes and untracked `worker-configuration.d.ts` were preserved and excluded from the commit.
