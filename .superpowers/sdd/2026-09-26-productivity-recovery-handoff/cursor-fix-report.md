# Navigation inventory cursor-resume fix

## Scope

Fixed only persisted initial-head batch cursor resumption in
`src/documents/zone-navigation-inventory.ts`, with focused regression coverage
in `test/zone-navigation-inventory.spec.ts`. No production or canonical state
was accessed or changed.

## Evidence

Before the implementation change, the focused red run was:

```text
node_modules/.bin/vitest run test/zone-navigation-inventory.spec.ts -t "resumes an older persisted empty batch cursor|fetches the continuation after all saved batch entries" --reporter=dot
```

Result: 2 failed, 25 skipped. In both cases the provider listing was never
called (`received` was `null`), confirming that an empty saved batch re-emitted
its cursor instead of resuming the provider continuation.

After the fix:

```text
node_modules/.bin/vitest run test/zone-navigation-inventory.spec.ts --reporter=dot
```

Result: 1 file passed, 28/28 tests passed.

```text
node_modules/.bin/tsc --noEmit
```

Result: exit 0.

```text
git diff --check
```

Result: exit 0.

## Change

When a persisted batch has no remaining entries but retains a provider cursor,
the adapter now calls `listPage` from that saved provider cursor using the
saved listing limit. It checks that the returned continuation differs from
the actual cursor supplied to the provider and fails closed with
`navigation_listing_stalled` otherwise. Nonempty saved batches are consumed
before the next provider fetch; legacy raw provider cursors retain the
existing limit-1 continuation behavior.

Tests cover an older persisted empty batch cursor, a consumed saved batch
with continuation, and a provider cursor that fails to advance.

## Limitations

The full suite was not run for this bounded fix. The principal reported a
separate existing full-suite failure at `test/execution-guard.spec.ts:1223`
and is diagnosing it independently.

## Commit

Fix and regression tests: `64a9d9201c724d786c4d4606249b347bf9750061`
