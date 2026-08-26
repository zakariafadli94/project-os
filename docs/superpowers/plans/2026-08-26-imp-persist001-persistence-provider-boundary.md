# IMP-PERSIST001 — Persistence Provider Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a real provider-neutral runtime persistence boundary while keeping Dropbox as the only production provider and preserving every existing schema-1.0 persisted record, provider-derived identity, path, reliability behavior, MutationGate `observe` behavior, and Dropbox V1 compatibility contract.

**Architecture:** Project OS runtime consumers depend on `src/persistence/provider/*` contracts, neutral errors, explicit capability ports, and a prepared `ProjectOsPersistenceRuntime`. A Dropbox adapter maps the existing Dropbox API/client into those contracts, a neutral resilience decorator preserves current retry/recovery behavior, and a single production factory constructs the runtime per Worker/Durable Object composition context. Provider-shaped schema-1.0 managed-document and MutationGate evidence remains unchanged behind `src/persistence/compatibility/dropbox-v1-evidence.ts`; that seam knows the historical serialized Dropbox V1 contract but never imports Dropbox runtime client/transport/error/retry types.

**Tech Stack:** TypeScript 5.9, Cloudflare Workers/Durable Objects, Vitest 4.1 with `@cloudflare/vitest-pool-workers`, Zod 4.4, Dropbox HTTP API through the existing client implementation.

**Spec:** `docs/superpowers/specs/2026-08-26-imp-persist001-persistence-provider-boundary-design.md` at accepted design commit `6cd0673f38821cc50e060b62091c5ca47e70c067`.

## Global Constraints

- Dropbox remains the sole production persistence provider.
- Production layout remains `v2`.
- Continuity remains `stable`.
- MutationGate remains `observe`.
- No PRJ-0003 repair runs.
- No SCHEMA runtime runs.
- No schema version is bumped.
- No migration or upcaster is introduced.
- No provider selector or alternate provider is introduced.
- No local filesystem provider, PC bridge, or desktop daemon is introduced.
- No persisted `/PROJECT_OS/...` path value changes.
- Existing schema-1.0 `provider_file_id`, `provider_rev`, `provider_content_hash`, `provider_path`, provider preconditions, candidate records, regex contracts, and provider-derived IDs remain byte/semantic compatible.
- The neutral ordinary overwrite operation preserves current Dropbox `overwrite` **upsert** semantics: create when absent, replace when present.
- Conditional write remains true provider-side CAS; it must never be emulated with read-then-overwrite.
- Server-side copy remains provider-side; it must not silently degrade to download/re-upload for managed-document or MutationGate snapshots.
- Provider integrity evidence is algorithm/semantic-aware at runtime and is not treated as Project OS SHA-256.
- Retry budgets, jitter, and transient classification behavior remain equivalent to the current validated Dropbox runtime.
- Runtime implementation must be TDD-first, with a failing test before each behavior change.
- Runtime merge/deployment is a later gate; completing this plan locally/CI does not authorize production deployment.

---

## Target File Structure

The implementation should converge on this ownership shape:

```text
src/persistence/
  provider/
    contract.ts
    errors.ts
    capabilities.ts
    resilience.ts
  compatibility/
    dropbox-v1-evidence.ts
  providers/
    dropbox/
      client.ts
      adapter.ts
      error-mapping.ts
  production-factory.ts
  paths.ts
  layout.ts
  artifact-routing.ts
  repository-core.ts
  repository.ts
```

Dropbox-specific ingress remains outside this tree at `src/webhook/dropbox.ts`.

The old runtime files under `src/dropbox/` may temporarily re-export during intermediate commits if a task needs a compiling migration seam, but the final static boundary task removes all runtime imports from that namespace and deletes obsolete wrappers.

---

### Task 1: Define provider-neutral object, metadata, error, and capability contracts

**Files:**
- Create: `src/persistence/provider/contract.ts`
- Create: `src/persistence/provider/errors.ts`
- Create: `src/persistence/provider/capabilities.ts`
- Create: `test/persistence-provider-contract.spec.ts`

**Interfaces:**
- Produces: `ProviderIntegrityHash`, `ProviderObjectMetadata`, `ProviderEntry`, `ProviderChangeEntry`, `ProviderChangePage`, `ObjectPersistence`, `ConditionalWritePort`, `ServerSideCopyPort`, `IncrementalChangeFeedPort`, `ProviderEvidenceCapabilities`, `PersistenceRuntime`, `ProjectOsPersistenceRuntime`, `requireProjectOsPersistence`.
- Produces: `ProviderOperationError`, `ProviderConflictError`, `ProviderPreconditionFailedError`, `ProviderCursorResetError`, `ProviderCapabilityError`.
- Consumed by every later task.

- [ ] **Step 1: Write the failing contract/capability tests**

Create `test/persistence-provider-contract.spec.ts` with explicit capability validation and neutral metadata semantics:

```ts
import { describe, expect, it } from "vitest";
import { ProviderCapabilityError } from "../src/persistence/provider/errors";
import {
  requireProjectOsPersistence,
  type PersistenceRuntime,
  type ProviderObjectMetadata
} from "../src/persistence/provider/capabilities";

const metadata: ProviderObjectMetadata = {
  path: "/PROJECT_OS/example.txt",
  size: 3,
  objectId: "opaque-object-id",
  revisionToken: "opaque-revision",
  integrityHash: { algorithm: "example-hash", value: "abc123" }
};

describe("provider-neutral persistence contracts", () => {
  it("keeps provider identity and revision tokens opaque", () => {
    expect(metadata.objectId).toBe("opaque-object-id");
    expect(metadata.revisionToken).toBe("opaque-revision");
    expect(metadata.integrityHash).toEqual({ algorithm: "example-hash", value: "abc123" });
  });

  it("fails before mutation when a required capability is missing", () => {
    const runtime = {
      providerId: "test",
      objects: fakeObjects(),
      evidence: {
        stableObjectId: { semantics: "stable-through-move" },
        revisionToken: { semantics: "opaque-object-revision" },
        integrityHash: { semantics: "identified-algorithm" }
      }
    } satisfies PersistenceRuntime;

    expect(() => requireProjectOsPersistence(runtime)).toThrow(ProviderCapabilityError);
  });
});

function fakeObjects() {
  return {
    readText: async () => null,
    createText: async () => undefined,
    upsertText: async () => undefined,
    getMetadata: async () => null,
    listChildren: async () => [],
    move: async () => undefined,
    delete: async () => undefined
  };
}
```

- [ ] **Step 2: Run the test and verify it fails because the neutral modules do not exist**

Run:

```bash
npm test -- test/persistence-provider-contract.spec.ts
```

Expected: FAIL with module-resolution errors for `src/persistence/provider/*`.

- [ ] **Step 3: Implement the neutral metadata and object contract**

In `src/persistence/provider/contract.ts`, define these exact public shapes:

```ts
export interface ProviderIntegrityHash {
  algorithm: string;
  value: string;
}

export interface ProviderObjectMetadata {
  path: string;
  size: number;
  modifiedAt?: string;
  objectId?: string;
  revisionToken?: string;
  integrityHash?: ProviderIntegrityHash;
}

export interface ProviderEntry {
  kind: "file" | "folder" | "deleted";
  name: string;
  path?: string;
}

export interface ProviderChangeEntry {
  kind: "file" | "folder" | "deleted";
  name: string;
  path: string;
  metadata?: ProviderObjectMetadata;
}

export interface ProviderChangePage {
  entries: ProviderChangeEntry[];
  cursor: string;
}

export interface ObjectPersistence {
  readText(path: string): Promise<string | null>;
  createText(path: string, content: string): Promise<void>;
  upsertText(path: string, content: string): Promise<void>;
  getMetadata(path: string): Promise<ProviderObjectMetadata | null>;
  listChildren(path: string): Promise<ProviderEntry[]>;
  move(from: string, to: string): Promise<void>;
  delete(path: string): Promise<void>;
}

export interface ConditionalWritePort {
  writeTextConditional(
    path: string,
    content: string,
    expectedRevisionToken: string
  ): Promise<ProviderObjectMetadata>;
}

export interface ServerSideCopyPort {
  copyObject(from: string, to: string): Promise<ProviderObjectMetadata>;
}

export interface IncrementalChangeFeedPort {
  listChanges(input: { root?: string; cursor?: string }): Promise<ProviderChangePage>;
}
```

The distinction between `createText` and `upsertText` is mandatory: `createText` is create-only; `upsertText` preserves current `overwrite` create-or-replace behavior.

- [ ] **Step 4: Implement neutral errors**

In `src/persistence/provider/errors.ts`:

```ts
export interface ProviderDiagnostics {
  providerId: string;
  status?: number;
  requestId?: string | null;
  code?: string;
}

export class ProviderOperationError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly diagnostics?: ProviderDiagnostics
  ) {
    super(message);
    this.name = "ProviderOperationError";
  }
}

export class ProviderConflictError extends ProviderOperationError {
  constructor(message: string, diagnostics?: ProviderDiagnostics) {
    super(message, false, diagnostics);
    this.name = "ProviderConflictError";
  }
}

export class ProviderPreconditionFailedError extends ProviderOperationError {
  constructor(message: string, diagnostics?: ProviderDiagnostics) {
    super(message, false, diagnostics);
    this.name = "ProviderPreconditionFailedError";
  }
}

export class ProviderCursorResetError extends ProviderOperationError {
  constructor(message: string, diagnostics?: ProviderDiagnostics) {
    super(message, false, diagnostics);
    this.name = "ProviderCursorResetError";
  }
}

export class ProviderCapabilityError extends Error {
  constructor(public readonly capability: string) {
    super(`Persistence provider is missing required capability: ${capability}`);
    this.name = "ProviderCapabilityError";
  }
}
```

- [ ] **Step 5: Implement explicit capability ports and fail-fast binding**

In `src/persistence/provider/capabilities.ts`:

```ts
import type {
  ConditionalWritePort,
  IncrementalChangeFeedPort,
  ObjectPersistence,
  ServerSideCopyPort
} from "./contract";
import { ProviderCapabilityError } from "./errors";

export interface ProviderEvidenceCapabilities {
  stableObjectId: { semantics: "stable-through-move" };
  revisionToken: { semantics: "opaque-object-revision" };
  integrityHash: { semantics: "identified-algorithm" };
}

export interface PersistenceRuntime {
  providerId: string;
  objects: ObjectPersistence;
  conditionalWrite?: ConditionalWritePort;
  serverSideCopy?: ServerSideCopyPort;
  changeFeed?: IncrementalChangeFeedPort;
  evidence?: Partial<ProviderEvidenceCapabilities>;
}

export interface ProjectOsPersistenceRuntime {
  providerId: string;
  objects: ObjectPersistence;
  conditionalWrite: ConditionalWritePort;
  serverSideCopy: ServerSideCopyPort;
  changeFeed: IncrementalChangeFeedPort;
  evidence: ProviderEvidenceCapabilities;
}

export function requireProjectOsPersistence(runtime: PersistenceRuntime): ProjectOsPersistenceRuntime {
  if (!runtime.conditionalWrite) throw new ProviderCapabilityError("conditional-write");
  if (!runtime.serverSideCopy) throw new ProviderCapabilityError("server-side-copy");
  if (!runtime.changeFeed) throw new ProviderCapabilityError("incremental-change-feed");
  if (!runtime.evidence?.stableObjectId) throw new ProviderCapabilityError("stable-object-id");
  if (!runtime.evidence.revisionToken) throw new ProviderCapabilityError("revision-token");
  if (!runtime.evidence.integrityHash) throw new ProviderCapabilityError("integrity-hash");
  return runtime as ProjectOsPersistenceRuntime;
}
```

Only composition code may call `requireProjectOsPersistence`. Business services must receive the already-validated runtime or a narrower port, never probe optional methods themselves.

- [ ] **Step 6: Run the focused test**

Run:

```bash
npm test -- test/persistence-provider-contract.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS; no production files use the new contracts yet.

- [ ] **Step 8: Commit**

```bash
git add src/persistence/provider test/persistence-provider-contract.spec.ts
git commit -m "feat: define provider-neutral persistence contracts"
```

---

### Task 2: Port resilience/retry and move recovery to provider-neutral errors

**Files:**
- Create: `src/persistence/provider/resilience.ts`
- Create: `test/provider-resilience.spec.ts`
- Reference only: `src/dropbox/resilient-transport.ts`
- Reference only: `src/dropbox/retry.ts`

**Interfaces:**
- Consumes: `PersistenceRuntime`, `ProjectOsPersistenceRuntime`, neutral provider errors from Task 1.
- Produces: `withProviderResilience(runtime, options)`.
- Later production factory wraps the raw Dropbox adapter with this function exactly once.

- [ ] **Step 1: Write failing retry and recovery tests**

Create `test/provider-resilience.spec.ts` covering retryable vs terminal errors and current idempotent file-move conflict recovery:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  ProviderConflictError,
  ProviderOperationError
} from "../src/persistence/provider/errors";
import { withProviderResilience } from "../src/persistence/provider/resilience";
import type { PersistenceRuntime } from "../src/persistence/provider/capabilities";

it("retries only errors classified retryable by the provider", async () => {
  let attempts = 0;
  const runtime = runtimeWith({
    readText: async () => {
      attempts += 1;
      if (attempts < 3) throw new ProviderOperationError("temporary", true);
      return "ok";
    }
  });
  const resilient = withProviderResilience(runtime, {
    maxAttempts: 5,
    baseDelayMs: 1,
    sleep: vi.fn(async () => undefined),
    random: () => 0
  });

  await expect(resilient.objects.readText("/x")).resolves.toBe("ok");
  expect(attempts).toBe(3);
});

it("does not retry terminal provider failures", async () => {
  let attempts = 0;
  const runtime = runtimeWith({
    readText: async () => {
      attempts += 1;
      throw new ProviderOperationError("terminal", false);
    }
  });
  const resilient = withProviderResilience(runtime, { maxAttempts: 5, sleep: async () => undefined });

  await expect(resilient.objects.readText("/x")).rejects.toThrow("terminal");
  expect(attempts).toBe(1);
});

it("preserves idempotent file move recovery after a destination conflict", async () => {
  const files = new Map([["/from", "same"], ["/to", "same"]]);
  const runtime = runtimeWith({
    move: async () => { throw new ProviderConflictError("destination exists"); },
    readText: async (path) => files.get(path) ?? null,
    delete: async (path) => { files.delete(path); }
  });
  const resilient = withProviderResilience(runtime, { maxAttempts: 1 });

  await resilient.objects.move("/from", "/to");
  expect(files.has("/from")).toBe(false);
  expect(files.get("/to")).toBe("same");
});
```

Include a local `runtimeWith` helper that supplies no-op/default neutral ports and evidence.

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test -- test/provider-resilience.spec.ts
```

Expected: FAIL because `withProviderResilience` does not exist.

- [ ] **Step 3: Implement neutral retry**

In `src/persistence/provider/resilience.ts`, port the current validated attempt count/backoff/jitter values without Dropbox status parsing:

```ts
export interface ProviderResilienceOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}
```

The retry helper catches only `ProviderOperationError`; it retries only when `error.retryable === true`. Preserve defaults `maxAttempts=5`, `baseDelayMs=250`, and current `+ up to 50% jitter` behavior.

- [ ] **Step 4: Wrap every object/capability port without changing capability presence**

`withProviderResilience(runtime, options)` must return a new `PersistenceRuntime` whose base object methods and any present capability ports call the shared retry helper. It must preserve `runtime.providerId` and `runtime.evidence` unchanged.

Do not infer or add missing capabilities in the resilience layer.

- [ ] **Step 5: Port current file-move conflict recovery behind neutral errors**

For `objects.move(from, to)`, preserve the current sequence:

```text
try provider move
on ProviderConflictError:
  try read source text
  if source absent -> success
  read destination text
  if destination == source -> delete source -> success
  if destination exists with different content -> rethrow original conflict
  else create destination
       on raced ProviderConflictError verify destination == source
       delete source
```

If source/destination cannot be read as text (for example a folder move), rethrow the original provider conflict so the higher-level archive consistency logic remains authoritative.

- [ ] **Step 6: Run focused tests**

```bash
npm test -- test/provider-resilience.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/persistence/provider/resilience.ts test/provider-resilience.spec.ts
git commit -m "feat: add provider-neutral persistence resilience"
```

---

### Task 3: Build the Dropbox adapter and authoritative production factory

**Files:**
- Create: `src/persistence/providers/dropbox/client.ts` from current `src/dropbox/client.ts`
- Create: `src/persistence/providers/dropbox/error-mapping.ts`
- Create: `src/persistence/providers/dropbox/adapter.ts`
- Create: `src/persistence/production-factory.ts`
- Create: `test/dropbox-provider-adapter.spec.ts`
- Update later/delete: `src/dropbox/client.ts`, `src/dropbox/retry.ts`, `src/dropbox/resilient-transport.ts`
- Reference: `src/env.ts`

**Interfaces:**
- Consumes: neutral contracts/errors/capabilities/resilience from Tasks 1–2.
- Produces: raw `DropboxClient` internal to provider adapter, `createDropboxPersistence`, `createProductionPersistence(env)` returning `ProjectOsPersistenceRuntime`.

- [ ] **Step 1: Write failing adapter mapping tests**

Create `test/dropbox-provider-adapter.spec.ts` with a fake raw Dropbox API transport and assert exact neutral mapping:

```ts
it("maps Dropbox metadata to opaque provider-neutral metadata", async () => {
  const raw = fakeDropbox({
    metadata: {
      id: "id:ABC_123",
      path: "/PROJECT_OS/x.txt",
      rev: "015abc",
      content_hash: "a".repeat(64),
      size: 42,
      server_modified: "2026-08-26T10:00:00Z"
    }
  });
  const runtime = createDropboxPersistence(raw);

  await expect(runtime.objects.getMetadata("/PROJECT_OS/x.txt")).resolves.toEqual({
    path: "/PROJECT_OS/x.txt",
    size: 42,
    modifiedAt: "2026-08-26T10:00:00Z",
    objectId: "id:ABC_123",
    revisionToken: "015abc",
    integrityHash: {
      algorithm: "dropbox-content-hash",
      value: "a".repeat(64)
    }
  });
});
```

Add tests that:
- Dropbox ordinary upload `mode="add"` maps to `objects.createText`;
- Dropbox ordinary upload `mode="overwrite"` maps to neutral `objects.upsertText`;
- Dropbox `DropboxConflictError` maps to `ProviderConflictError` for create/move/copy/delete conflicts;
- Dropbox conditional-upload conflict maps to `ProviderPreconditionFailedError`, not generic conflict;
- Dropbox cursor reset maps to `ProviderCursorResetError`;
- status `429/500/502/503/504` and response bodies containing `too_many_write_operations`/`internal_error` map to `ProviderOperationError(retryable=true)`;
- non-transient API failures map to `ProviderOperationError(retryable=false)`;
- change entries map deleted/file/folder tags and neutral metadata correctly.

- [ ] **Step 2: Run the focused adapter test and verify it fails**

```bash
npm test -- test/dropbox-provider-adapter.spec.ts
```

Expected: FAIL because Dropbox provider modules do not exist.

- [ ] **Step 3: Move the raw Dropbox API client without changing HTTP behavior**

Move the current contents of `src/dropbox/client.ts` into `src/persistence/providers/dropbox/client.ts` as the raw provider-specific implementation. Provider-specific classes/types may remain here, including raw Dropbox metadata and API errors.

Do not change endpoints, OAuth behavior, parent-folder creation, `strict_conflict`, move/copy/delete semantics, list pagination, or cursor reset detection in this step.

- [ ] **Step 4: Implement provider-specific error mapping**

Create `src/persistence/providers/dropbox/error-mapping.ts` with one mapping function:

```ts
export function mapDropboxError(
  error: unknown,
  operation: "create" | "upsert" | "conditional-write" | "read" | "metadata" | "list" | "move" | "copy" | "delete" | "changes"
): Error
```

Rules:
- `DropboxCursorResetError` -> `ProviderCursorResetError`.
- `DropboxConflictError` during `conditional-write` -> `ProviderPreconditionFailedError`.
- Other `DropboxConflictError` -> `ProviderConflictError`.
- `DropboxApiError` -> `ProviderOperationError` with `retryable` using the current exact transient rule.
- Non-Dropbox errors pass through unchanged.

Keep provider diagnostics opaque to Core but include `providerId: "dropbox"`, status, request ID where available.

- [ ] **Step 5: Implement the Dropbox adapter**

Create `src/persistence/providers/dropbox/adapter.ts` and export:

```ts
export const DROPBOX_PROVIDER_ID = "dropbox";
export const DROPBOX_INTEGRITY_ALGORITHM = "dropbox-content-hash";

export function createDropboxPersistence(raw: DropboxTransport): PersistenceRuntime;
```

The returned runtime must expose all six capabilities. Map raw metadata to neutral metadata through one helper; no business module may need raw `DropboxFileMetadata` afterward.

- [ ] **Step 6: Implement the production factory**

Create `src/persistence/production-factory.ts`:

```ts
import type { Env } from "../env";
import { requireProjectOsPersistence, type ProjectOsPersistenceRuntime } from "./provider/capabilities";
import { withProviderResilience } from "./provider/resilience";
import { DropboxClient } from "./providers/dropbox/client";
import { createDropboxPersistence } from "./providers/dropbox/adapter";

export function createProductionPersistence(env: Env): ProjectOsPersistenceRuntime {
  const raw = new DropboxClient({
    appKey: env.DROPBOX_APP_KEY,
    appSecret: env.DROPBOX_APP_SECRET,
    refreshToken: env.DROPBOX_REFRESH_TOKEN
  });
  return requireProjectOsPersistence(withProviderResilience(createDropboxPersistence(raw)));
}
```

Do not add a provider environment variable or switch.

- [ ] **Step 7: Run adapter and resilience tests**

```bash
npm test -- test/dropbox-provider-adapter.spec.ts test/provider-resilience.spec.ts test/persistence-provider-contract.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Run existing Dropbox low-level regression tests against the moved raw client**

Update test imports only as required, then run:

```bash
npm test -- test/dropbox-client-parent-folders.spec.ts test/dropbox-read-failclosed.spec.ts test/dropbox-read-resilience.spec.ts test/dropbox-retry.spec.ts test/resilient-dropbox-transport.spec.ts
```

At this intermediate stage, if the legacy resilient-wrapper tests cannot yet target the neutral layer cleanly, keep temporary compatibility re-exports and defer deletion to Task 9. Behavior must remain green.

- [ ] **Step 9: Commit**

```bash
git add src/persistence/providers src/persistence/production-factory.ts test/dropbox-provider-adapter.spec.ts test/dropbox-*.spec.ts test/resilient-dropbox-transport.spec.ts
git commit -m "feat: adapt Dropbox to provider-neutral persistence"
```

---

### Task 4: Move provider-independent paths, layout, artifact routing, and repositories out of `src/dropbox`

**Files:**
- Create/move: `src/persistence/paths.ts`
- Create/move: `src/persistence/layout.ts`
- Create/move: `src/persistence/artifact-routing.ts`
- Create/move: `src/persistence/repository-core.ts`
- Create/move: `src/persistence/repository.ts`
- Modify imports across: `src/render/*`, `src/migration/workspace-v2.ts`, `src/materialization/*`, `src/documents/*`, `src/mutation-gate/*`, `src/durable/*`, `src/index.ts`
- Update tests importing old path/layout/repository modules.

**Interfaces:**
- Consumes: `ObjectPersistence`, `ProviderConflictError`, and prepared runtime where MutationGate/managed-document integration requires it.
- Produces: provider-independent Project OS path/layout/repository modules with byte-identical path outputs.

- [ ] **Step 1: Strengthen path/layout golden tests before moving files**

Extend `test/dropbox-paths.spec.ts` and `test/workspace-layout.spec.ts` (rename later if desired) with exact-string assertions for representative legacy and V2 values:

```ts
expect(machineStatePath("PRJ-0002")).toBe("/PROJECT_OS/.project-os/projects/PRJ-0002/state.json");
expect(machineCommitRecordPath("PRJ-0002", 94)).toBe("/PROJECT_OS/.project-os/projects/PRJ-0002/commits/REV-000094.json");
expect(workspaceProjectRoot("PRJ-0002", "project-os")).toBe("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os");
expect(archiveProjectRoot("PRJ-0002", "project-os")).toBe("/PROJECT_OS/ARCHIVE/PROJECTS/PRJ-0002-project-os");
expect(receiptPath("TXN-EXAMPLE-000001")).toBe("/PROJECT_OS/RECEIPTS/TXN-EXAMPLE-000001.json");
```

- [ ] **Step 2: Run path/layout tests before the move**

```bash
npm test -- test/dropbox-paths.spec.ts test/workspace-layout.spec.ts test/artifact-routing.spec.ts
```

Expected: PASS on the old modules.

- [ ] **Step 3: Move files without changing implementation behavior**

Move the current implementations into `src/persistence/{paths,layout,artifact-routing}.ts`. Update internal imports only. Do not edit path constants or normalization rules while moving.

- [ ] **Step 4: Refactor `ProjectRepository` to the neutral object contract**

In `src/persistence/repository-core.ts`:
- constructor receives `ObjectPersistence` directly;
- remove construction of `ResilientDropboxTransport`;
- `upload(..., "add")` -> `createText(...)`;
- `upload(..., "overwrite")` -> `upsertText(...)`;
- `download(...)` -> `readText(...)`;
- `listFolder(...)` -> `listChildren(...)`;
- catch `ProviderConflictError`, never `DropboxConflictError`.

Preserve `safeAdd` behavior exactly:

```ts
private async safeAdd(path: string, content: string): Promise<void> {
  try {
    await this.objects.createText(path, content);
  } catch (error) {
    if (!(error instanceof ProviderConflictError)) throw error;
    const existing = await this.objects.readText(path);
    if (existing !== content) {
      throw new Error(`Immutable persistence path conflict with different content: ${path}`);
    }
  }
}
```

The exact user-facing error string may retain existing wording where tests rely on it; do not intentionally change status/error vocabulary in this package.

- [ ] **Step 5: Refactor the MutationGate-aware repository wrapper**

In `src/persistence/repository.ts`, accept a prepared `ProjectOsPersistenceRuntime`. Pass `runtime.objects` to the Core repository and pass the prepared runtime into MutationGate/managed-document services. Remove `rawTransport` and all direct Dropbox types.

- [ ] **Step 6: Update imports repo-wide for moved path/layout/routing/repository modules**

This is a source-ownership move only. Avoid opportunistic business-logic changes.

- [ ] **Step 7: Run path/repository regression tests**

```bash
npm test -- test/dropbox-paths.spec.ts test/workspace-layout.spec.ts test/artifact-routing.spec.ts test/dropbox-repository.spec.ts test/commit-repository.spec.ts test/v2-boundaries.spec.ts
```

Expected: PASS with identical persisted paths and repository semantics.

- [ ] **Step 8: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/persistence src/render src/migration src/materialization src/documents src/mutation-gate src/durable src/index.ts test
git commit -m "refactor: move Project OS persistence ownership out of Dropbox"
```

---

### Task 5: Migrate canonical repository consumers, inbox processing, and materialization to neutral persistence

**Files:**
- Modify: `src/index.ts`
- Modify: `src/materialization/writer.ts`
- Modify: `src/materialization/coordinator.ts` as needed for constructor types
- Modify: `src/migration/workspace-v2.ts`
- Modify tests: `test/admin-process-inbox.spec.ts`, `test/inbox-*.spec.ts`, `test/materialization-*.spec.ts`, `test/commit-repository.spec.ts`

**Interfaces:**
- Consumes: `ProjectOsPersistenceRuntime` from factory, `ObjectPersistence`, neutral conflict errors.
- Produces: inbox/materialization code with no Dropbox runtime imports.

- [ ] **Step 1: Write/adjust focused tests so they assert neutral error behavior**

Update fake transports used by inbox/materialization tests to implement `ObjectPersistence` and throw `ProviderConflictError` for create races. Do not weaken assertions about idempotent terminal writes, no false receipts, projection recovery evidence, or critical-output verification.

Add one explicit inbox test proving a provider-neutral conflict follows the existing archive replay path:

```ts
it("treats a neutral destination conflict as idempotent only when archived content matches", async () => {
  // arrange source and terminal destination with identical bytes
  // inject ProviderConflictError from move
  // assert source cleanup succeeds and summary.failed remains 0
});
```

- [ ] **Step 2: Run the focused tests and verify failures show remaining Dropbox imports/types**

```bash
npm test -- test/admin-process-inbox.spec.ts test/inbox-isolation.spec.ts test/inbox-replay-cleanup.spec.ts test/materialization-writer.spec.ts
```

Expected: FAIL until runtime consumers are migrated.

- [ ] **Step 3: Replace Worker helper construction with `createProductionPersistence(env)`**

In `src/index.ts`, replace each direct `new DropboxClient(...)` + `new ResilientDropboxTransport(...)` sequence in:
- `materializeExistingProjects`;
- `migrateLegacyLedger`;
- `processInbox`;
- any other Worker/admin helper found during implementation.

Use one prepared runtime per helper invocation and pass `runtime.objects` or the full runtime as required.

- [ ] **Step 4: Refactor inbox helper signatures**

Use neutral signatures such as:

```ts
async function prepareTransactionInboxEntries(
  objects: ObjectPersistence,
  entries: ProviderEntry[]
): Promise<PreparedTransactionInboxEntry[]>;

async function processTransactionInbox(
  env: Env,
  objects: ObjectPersistence,
  mode: LayoutMode
): Promise<InboxProcessSummary>;
```

Replace `DropboxEntry` with `ProviderEntry`, `download` with `readText`, and conflict handling with `ProviderConflictError`.

- [ ] **Step 5: Refactor materialization writer**

`WorkspaceProjectionWriter` constructor becomes:

```ts
constructor(
  private readonly objects: ObjectPersistence,
  private readonly concurrency: number
)
```

Port `download/upload` calls to `readText/createText/upsertText`. `safeAdd` catches `ProviderConflictError`. Project OS SHA-256 logic in `materialization/hash.ts` remains unchanged and does not read provider integrity hashes.

- [ ] **Step 6: Run focused tests**

```bash
npm test -- test/admin-process-inbox.spec.ts test/inbox-isolation.spec.ts test/inbox-observability.spec.ts test/inbox-replay-cleanup.spec.ts test/materialization-writer.spec.ts test/materialization-faults.spec.ts test/materialization-reconcile.spec.ts test/commit-repository.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/materialization src/migration test/admin-process-inbox.spec.ts test/inbox-*.spec.ts test/materialization-*.spec.ts test/commit-repository.spec.ts
git commit -m "refactor: use neutral persistence in core runtime flows"
```

---

### Task 6: Add the Dropbox V1 schema compatibility seam and migrate managed documents

**Files:**
- Create: `src/persistence/compatibility/dropbox-v1-evidence.ts`
- Create: `test/dropbox-v1-compatibility.spec.ts`
- Modify: `src/documents/repository.ts`
- Modify: `src/documents/service.ts`
- Modify: `src/documents/change-coordinator.ts`
- Modify: `src/documents/bootstrap.ts`
- Modify: `src/documents/reconciler.ts`
- Modify: `src/documents/legacy-artifact.ts`
- Modify: `src/documents/legacy-artifact-provenance.ts`
- Modify: `src/documents/request-ledger.ts` as needed
- Preserve: `src/domain/managed-document.ts` persisted schema shapes and regexes.

**Interfaces:**
- Consumes: neutral `ProviderObjectMetadata`, prepared runtime, existing schema-1.0 domain record types.
- Produces: `DropboxV1Evidence`, `requireDropboxV1Evidence`, `toManagedProviderObservation`, `matchesDropboxV1Evidence` (or equivalently named exact helpers selected in this task and used consistently afterward).

- [ ] **Step 1: Write golden compatibility tests before changing managed-document code**

Create `test/dropbox-v1-compatibility.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  requireDropboxV1Evidence,
  toManagedProviderObservation
} from "../src/persistence/compatibility/dropbox-v1-evidence";

const metadata = {
  path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/WORKING/a.md",
  size: 12,
  objectId: "id:ABC_123",
  revisionToken: "015abc",
  integrityHash: { algorithm: "dropbox-content-hash", value: "a".repeat(64) }
};

it("serializes neutral Dropbox runtime evidence into the exact schema-1.0 fields", () => {
  expect(requireDropboxV1Evidence(metadata)).toEqual({
    file_id: "id:ABC_123",
    rev: "015abc",
    content_hash: "a".repeat(64),
    size: 12
  });
  expect(toManagedProviderObservation(metadata)).toEqual({
    path: metadata.path,
    file_id: "id:ABC_123",
    rev: "015abc",
    content_hash: "a".repeat(64),
    size: 12
  });
});
```

Add fail-closed tests for missing object ID, missing revision token, wrong hash algorithm, invalid Dropbox `id:` format, invalid 64-lowercase-hex content hash.

- [ ] **Step 2: Run the compatibility test and verify it fails**

```bash
npm test -- test/dropbox-v1-compatibility.spec.ts
```

Expected: FAIL because the seam does not exist.

- [ ] **Step 3: Implement the compatibility seam without importing Dropbox runtime modules**

`src/persistence/compatibility/dropbox-v1-evidence.ts` may import neutral provider metadata and persisted domain types, but must not import from `providers/dropbox/*` or legacy `dropbox/*` runtime files.

Use a local literal for the accepted runtime integrity semantic:

```ts
const DROPBOX_V1_HASH_ALGORITHM = "dropbox-content-hash";

export interface DropboxV1Evidence {
  file_id: string;
  rev: string;
  content_hash: string;
  size: number;
}
```

`requireDropboxV1Evidence(metadata)` validates the existing schema-1.0 regex/value assumptions and returns those exact legacy field names. It must not add `provider_kind` or an algorithm field to persisted records.

- [ ] **Step 4: Refactor `DocumentLedgerRepository`**

Constructor receives the prepared neutral runtime (or exact object/copy ports needed). Replace:
- `DropboxTransport` -> neutral ports;
- `DropboxFileMetadata` -> `ProviderObjectMetadata`;
- `copy` -> `runtime.serverSideCopy.copyObject`;
- `getMetadata` -> `runtime.objects.getMetadata`;
- `upload add/overwrite` -> `createText/upsertText`;
- `DropboxConflictError` -> `ProviderConflictError`.

For schema-1.0 provider-file binding/reference fingerprint logic, continue reading/writing the exact existing records.

- [ ] **Step 5: Refactor `ManagedDocumentService` with true neutral CAS**

Constructor accepts `ProjectOsPersistenceRuntime`; remove local resilient-wrapper creation.

`writeTextAtStage` must use:

```ts
const current = await runtime.objects.getMetadata(path);
const currentRevision = requireDropboxV1Evidence(current).rev;
return runtime.conditionalWrite.writeTextConditional(path, content, currentRevision);
```

Do not perform read-then-upsert as a replacement for CAS.

When creating version/head records, call the compatibility seam to fill exact `provider_file_id`, `provider_rev`, `provider_content_hash`, `provider_path`, and `ManagedProviderObservation` fields.

- [ ] **Step 6: Refactor managed-document moves/copies/change feed**

- lifecycle move operations -> `runtime.objects.move`;
- reopen/provider snapshot -> `runtime.serverSideCopy.copyObject`;
- change coordinator -> `runtime.changeFeed.listChanges({ cursor })` or `{ root }`;
- cursor reset -> catch `ProviderCursorResetError`;
- change metadata -> neutral `ProviderChangeEntry.metadata` or fallback `objects.getMetadata`.

The cursor key remains exactly `managed-document-change-cursor-v1`.

- [ ] **Step 7: Preserve managed-document schema and identity generation unchanged**

Do not modify the persisted schemas or these identity functions in `src/domain/managed-document.ts` except import-only refactors if unavoidable:
- `documentIdForProviderFile`;
- `externalVersionIdFor`;
- provider ID regex;
- provider revision constraints;
- provider content hash fields.

Add golden assertions around at least one existing document ID/version ID fixture so refactoring cannot silently alter them.

- [ ] **Step 8: Run managed-document regression**

```bash
npm test -- test/dropbox-v1-compatibility.spec.ts test/managed-document.spec.ts test/document-ledger.spec.ts test/document-lifecycle.spec.ts test/document-external-edits.spec.ts test/document-change-coordinator.spec.ts test/document-bootstrap.spec.ts test/document-head-recovery.spec.ts test/document-reference-reconcile.spec.ts test/dropbox-document-concurrency.spec.ts test/resilient-document-transport.spec.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/persistence/compatibility src/documents src/domain/managed-document.ts test/dropbox-v1-compatibility.spec.ts test/managed-document*.spec.ts test/document-*.spec.ts test/dropbox-document-concurrency.spec.ts test/resilient-document-transport.spec.ts
git commit -m "refactor: isolate Dropbox V1 managed-document evidence"
```

---

### Task 7: Migrate MutationGate provider plumbing while preserving schema-1.0 candidates and identities

**Files:**
- Modify: `src/mutation-gate/artifact-intent.ts`
- Modify: `src/mutation-gate/classifier.ts`
- Modify: `src/mutation-gate/repository.ts`
- Modify: `src/mutation-gate/service.ts`
- Modify: `src/mutation-gate/resolution-service.ts`
- Modify: `src/durable/project-guard-mutation-gate.ts` only for constructor/runtime types if needed
- Preserve: `src/domain/mutation-gate.ts` serialized schemas/ID generation.
- Modify tests: `test/mutation-gate-*.spec.ts`, `test/mutation-candidate-resolution.spec.ts`, `test/artifact-mutation-intent.spec.ts`.

**Interfaces:**
- Consumes: prepared neutral runtime and Dropbox V1 compatibility seam.
- Produces: MutationGate with no Dropbox runtime imports and byte/semantic-compatible schema-1.0 evidence.

- [ ] **Step 1: Add a golden candidate identity test before refactoring**

In `test/mutation-gate-domain.spec.ts`, pin an exact input/output for `mutationCandidateIdFor`:

```ts
it("preserves Dropbox V1 candidate identity derivation", async () => {
  await expect(mutationCandidateIdFor({
    projectId: "PRJ-0002",
    providerFileId: "id:ABC_123",
    providerRev: "015abc"
  })).resolves.toMatch(/^MUTCAND-[A-F0-9]{24}$/);
});
```

Use the currently produced exact ID as a literal expected value after running the baseline once; do not leave a regex-only assertion in the committed test.

- [ ] **Step 2: Run current MutationGate tests as a baseline**

```bash
npm test -- test/mutation-gate-domain.spec.ts test/mutation-gate-repository.spec.ts test/mutation-gate-classifier.spec.ts test/mutation-gate-candidate.spec.ts test/mutation-gate-faults.spec.ts test/mutation-gate-status.spec.ts test/mutation-candidate-resolution.spec.ts test/artifact-mutation-intent.spec.ts
```

Expected: PASS before refactoring.

- [ ] **Step 3: Refactor artifact mutation intent preparation**

`ArtifactMutationIntentService` receives `ProjectOsPersistenceRuntime` and uses `runtime.objects.getMetadata(destination.path)`. When metadata exists, convert it through `requireDropboxV1Evidence` to write the existing `provider_precondition` shape:

```ts
const evidence = requireDropboxV1Evidence(metadata);
return {
  kind: "existing",
  file_id: evidence.file_id,
  rev: evidence.rev,
  content_hash: evidence.content_hash,
  size: evidence.size
};
```

Do not change `MutationProviderPrecondition` schema.

- [ ] **Step 4: Refactor candidate capture/snapshot repository**

`MutationGateRepository.captureCandidate` accepts neutral metadata. Immediately derive legacy evidence through the compatibility seam for:
- `mutationCandidateIdFor` input;
- candidate `provider_file_id`;
- `provider_rev`;
- `provider_content_hash`;
- `size`.

Snapshot payload through `runtime.serverSideCopy.copyObject` and verify copied neutral metadata by converting it through the seam and comparing legacy content hash + size exactly as today.

Catch neutral `ProviderConflictError` for immutable-record races.

- [ ] **Step 5: Refactor classifier comparisons**

`MutationGateClassifier` receives neutral metadata. Compare current managed-document observations to current metadata through seam helpers rather than raw `.id/.rev/.content_hash` access.

Preserve existing classification order:

```text
strict-zone check
-> governed managed-document current check
-> matching in-flight artifact intent check
-> external candidate
```

Do not change baseline/cursor-reset ordering or `observe` policy.

- [ ] **Step 6: Refactor MutationGate service/change processing**

Use neutral change entries and metadata. Remove `DropboxChangeEntry`, `DropboxFileMetadata`, `DropboxTransport`, and `ResilientDropboxTransport` imports. `assertDestinationClear`, status checks, candidate capture, and list/status semantics remain unchanged.

- [ ] **Step 7: Run complete MutationGate regression**

```bash
npm test -- test/mutation-gate-acceptance.spec.ts test/mutation-gate-archived-mode.spec.ts test/mutation-gate-artifact-status.spec.ts test/mutation-gate-candidate.spec.ts test/mutation-gate-classifier.spec.ts test/mutation-gate-domain.spec.ts test/mutation-gate-faults.spec.ts test/mutation-gate-repository.spec.ts test/mutation-gate-status.spec.ts test/mutation-candidate-resolution.spec.ts test/artifact-mutation-intent.spec.ts
```

Expected: PASS with `mutation_gate_mode: "observe"` unchanged.

- [ ] **Step 8: Commit**

```bash
git add src/mutation-gate src/durable/project-guard-mutation-gate.ts src/domain/mutation-gate.ts test/mutation-gate-*.spec.ts test/mutation-candidate-resolution.spec.ts test/artifact-mutation-intent.spec.ts
git commit -m "refactor: use neutral persistence in MutationGate"
```

---

### Task 8: Centralize Worker and Durable Object construction through the production factory

**Files:**
- Modify: `src/durable/project-guard.ts`
- Modify: `src/durable/registry-guard.ts`
- Modify: `src/durable/project-guard-mutation-gate.ts`
- Modify: `src/index.ts`
- Modify: `src/index-mutation-gate.ts` only if imports/composition require it
- Modify relevant ProjectGuard/RegistryGuard integration tests.

**Interfaces:**
- Consumes: `createProductionPersistence(env)`.
- Produces: no direct `new DropboxClient(...)` outside the authoritative factory.

- [ ] **Step 1: Add a source-level temporary assertion for direct construction sites**

Before changing constructors, record the known direct construction sites with a search command in the execution notes:

```bash
grep -R "new DropboxClient" -n src
```

Expected baseline: hits in `src/index.ts`, `src/durable/project-guard.ts`, and `src/durable/registry-guard.ts` (plus only adapter/factory paths after earlier moves).

- [ ] **Step 2: Refactor `ProjectGuard` constructor**

Replace direct client creation with:

```ts
const persistence = createProductionPersistence(env);
this.repository = new ProjectRepository(persistence, this.layoutMode);
this.managedDocumentService = new ManagedDocumentService(persistence);
this.managedDocumentChanges = new ManagedDocumentChangeCoordinator(
  persistence,
  this.ctx.storage,
  parseMutationGateMode(env.PROJECT_OS_MUTATION_GATE_MODE)
);
this.managedDocumentRequests = new ManagedDocumentRequestLedger(persistence.objects);
```

Adjust actual constructor signatures consistently with Tasks 4–7.

`WorkspaceProjectionWriter` receives `persistence.objects`, not raw Dropbox.

- [ ] **Step 3: Refactor `RegistryGuard` constructor**

Use one prepared runtime from `createProductionPersistence(env)` and inject it into `ProjectRepository`. Registry behavior, allocator recovery, and project-create ordering do not change.

- [ ] **Step 4: Ensure Worker helpers reuse one runtime per composition function**

Within each helper call (`processInbox`, admin materialization/migration), construct once and pass downward. Do not call the production factory separately for each repository/service inside the same helper invocation.

- [ ] **Step 5: Run Durable Object and routing regressions**

```bash
npm test -- test/project-guard.spec.ts test/project-guard-recovery.spec.ts test/project-guard-commit-recovery.spec.ts test/project-guard-document.spec.ts test/project-guard-artifact.spec.ts test/registry-guard.spec.ts test/registry-guard-recovery.spec.ts test/registry-lifecycle-sync.spec.ts test/index.spec.ts test/admin-process-inbox.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Verify direct construction is centralized**

Run:

```bash
grep -R "new DropboxClient" -n src
```

Expected: only `src/persistence/production-factory.ts` (and no test files because scope is `src`).

- [ ] **Step 7: Commit**

```bash
git add src/durable src/index.ts src/index-mutation-gate.ts test/project-guard*.spec.ts test/registry*.spec.ts test/index.spec.ts test/admin-process-inbox.spec.ts
git commit -m "refactor: centralize production persistence construction"
```

---

### Task 9: Remove obsolete Dropbox runtime boundary, add static/golden gates, update docs, and run full verification

**Files:**
- Delete obsolete runtime files as applicable: `src/dropbox/client.ts`, `src/dropbox/resilient-transport.ts`, `src/dropbox/retry.ts`, `src/dropbox/layout.ts`, `src/dropbox/paths.ts`, `src/dropbox/artifact-routing.ts`, `src/dropbox/repository-core.ts`, `src/dropbox/repository.ts`
- Create: `scripts/check-persistence-boundary.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/deployment.md`
- Modify: `docs/managed-documents.md`
- Modify: `docs/mutation-gate.md`
- Add/modify compatibility tests as needed.

**Interfaces:**
- Consumes all prior tasks.
- Produces final source-level enforcement that Dropbox runtime names cannot leak back into Core.

- [ ] **Step 1: Add the static boundary script**

Create `scripts/check-persistence-boundary.mjs` using Node `fs/promises` and recursively scan `src/**/*.ts`.

Allow Dropbox runtime references only under:

```text
src/persistence/providers/dropbox/
src/persistence/production-factory.ts
src/webhook/dropbox.ts
```

The compatibility seam is allowed to contain the literal word `Dropbox` and historical field names but must not import runtime modules. Enforce that separately.

Reject Core files containing any of these runtime identifiers/import patterns:

```text
DropboxClient
DropboxTransport
DropboxConflictError
DropboxApiError
DropboxCursorResetError
ResilientDropboxTransport
from "./dropbox/client"
from "../dropbox/client"
from "./dropbox/retry"
from "../dropbox/retry"
```

Also reject `src/persistence/compatibility/dropbox-v1-evidence.ts` if it imports from `providers/dropbox/`.

A minimal structure:

```js
const allowedRuntimePrefixes = [
  "src/persistence/providers/dropbox/",
  "src/persistence/production-factory.ts",
  "src/webhook/dropbox.ts"
];

const forbiddenRuntimeTokens = [
  "DropboxClient",
  "DropboxTransport",
  "DropboxConflictError",
  "DropboxApiError",
  "DropboxCursorResetError",
  "ResilientDropboxTransport"
];
```

Print every violating file/token and exit `1`; print `Persistence boundary check passed` and exit `0` otherwise.

- [ ] **Step 2: Wire the static check into `npm run check`**

Update `package.json` scripts to include:

```json
"check:persistence-boundary": "node scripts/check-persistence-boundary.mjs",
"check": "npm run types && npm run typecheck && npm run check:persistence-boundary && npm test"
```

Do not change deploy behavior.

- [ ] **Step 3: Add final exact schema/path golden assertions**

Extend `test/dropbox-v1-compatibility.spec.ts` and existing MutationGate/document tests so representative JSON records are deep-equal to the old schema-1.0 shapes, with no new fields.

At minimum pin:
- one `ManagedProviderObservation`;
- one `DocumentVersionRecord` with provider fields;
- one `ProviderFileBindingRecord`;
- one `ReferenceFingerprintRecord`;
- one MutationGate `provider_precondition.kind="existing"`;
- one `ExternalMutationCandidateRecord`;
- exact candidate ID for fixed `(project_id, provider_file_id, provider_rev)` input;
- exact managed-document provider-derived ID/version fixture;
- representative V2 and legacy path strings.

- [ ] **Step 4: Delete legacy runtime wrappers and update remaining imports**

Delete obsolete `src/dropbox/*` runtime files after all consumers compile against `src/persistence/*`. Do not move or generalize `src/webhook/dropbox.ts`.

If temporary compatibility re-exports were added in earlier tasks, remove them now.

- [ ] **Step 5: Update operator/architecture documentation**

`README.md` must describe:
- provider-neutral runtime boundary;
- Dropbox-only production adapter;
- prepared capability profile;
- schema-1.0 Dropbox V1 compatibility seam;
- SCHEMA001 ownership of future durable provider generalization.

`docs/deployment.md` must state:
- no new provider env var;
- existing Dropbox secrets unchanged;
- production remains continuity `stable`, MutationGate `observe`;
- deployment validation must verify exact final PR head and schema-1.0 historical reads.

`docs/managed-documents.md` and `docs/mutation-gate.md` must distinguish neutral runtime evidence from unchanged serialized Dropbox V1 evidence. Do not document any new persisted field.

- [ ] **Step 6: Run static boundary check**

```bash
npm run check:persistence-boundary
```

Expected: `Persistence boundary check passed`.

- [ ] **Step 7: Run the complete test/type gate**

```bash
npm run check
```

Expected:
- Wrangler types generation passes;
- TypeScript typecheck passes;
- persistence boundary static check passes;
- entire Vitest suite passes.

- [ ] **Step 8: Run targeted high-risk regression again after the full suite**

```bash
npm test -- \
  test/commit-repository.spec.ts \
  test/project-guard-commit-recovery.spec.ts \
  test/registry-guard-recovery.spec.ts \
  test/inbox-isolation.spec.ts \
  test/inbox-replay-cleanup.spec.ts \
  test/materialization-faults.spec.ts \
  test/document-external-edits.spec.ts \
  test/dropbox-document-concurrency.spec.ts \
  test/mutation-gate-faults.spec.ts \
  test/mutation-gate-candidate.spec.ts \
  test/model-lifecycle-concurrency.spec.ts \
  test/project-guard-commit-compat.spec.ts
```

Expected: PASS.

- [ ] **Step 9: Verify forbidden scope did not enter the branch**

Run source searches:

```bash
grep -R "PROJECT_OS_PROVIDER" -n src docs package.json || true
grep -R "filesystem provider\|local filesystem provider\|S3 provider\|Google Drive provider\|SharePoint provider" -n src || true
grep -R "PROJECT_OS_MUTATION_GATE_MODE.*enforce" -n wrangler.jsonc src || true
```

Expected:
- no provider selector in runtime/config;
- no alternate/local provider implementation;
- production config still uses MutationGate `observe`.

Also inspect `git diff 946337526c8da541db00cd4ec5ff76207e6295a6...HEAD -- src/domain/managed-document.ts src/domain/mutation-gate.ts src/persistence/paths.ts src/persistence/layout.ts` and confirm schema/path changes are import/ownership-only unless explicitly covered by golden compatibility tests.

- [ ] **Step 10: Commit final cleanup/docs/gates**

```bash
git add -A
git commit -m "test: enforce IMP-PERSIST001 compatibility boundary"
```

- [ ] **Step 11: Record exact final implementation head for review, but do not merge or deploy**

Run:

```bash
git rev-parse HEAD
git status --short
git log --oneline 946337526c8da541db00cd4ec5ff76207e6295a6..HEAD
```

Expected:
- clean working tree;
- exact head SHA captured in review notes;
- runtime implementation remains on the PERSIST branch until separate review/merge authorization.

---

## Plan Self-Review Checklist

Before implementation begins, verify this plan against the accepted spec:

- [ ] Runtime contracts distinguish create-only from upsert/overwrite.
- [ ] Capabilities are explicit ports and fail-fast at composition, not optional-method checks inside business logic.
- [ ] Conditional write is true provider-side CAS.
- [ ] Server-side copy stays provider-side.
- [ ] Change-feed cursor reset maps to a neutral typed error.
- [ ] Stable object ID/revision/integrity evidence are opaque/semantic at runtime.
- [ ] Dropbox HTTP/status/retry parsing is confined to the Dropbox adapter.
- [ ] Neutral resilience preserves the current retry budget and move recovery.
- [ ] `createProductionPersistence(env)` is the only production Dropbox client construction site.
- [ ] Layout/path/routing/repository ownership moves out of `src/dropbox` with byte-identical paths.
- [ ] Managed-document schema-1.0 evidence is produced through the compatibility seam with unchanged fields/IDs.
- [ ] MutationGate preconditions/candidates/IDs are unchanged and mode remains `observe`.
- [ ] No provider selector, alternate provider, filesystem provider, migration, upcaster, schema bump, PRJ-0003 repair, or SCHEMA runtime is included.
- [ ] `npm run check` includes a static source-boundary gate plus the full existing test suite.
- [ ] Final implementation head is reviewed before any merge/deployment action.

## Execution Gate

This plan is a planning artifact only. Its existence does **not** authorize runtime implementation.

Before Task 1 is executed, the user must explicitly approve this implementation plan. After approval, execution should use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` task-by-task, with TDD and review checkpoints. Merge, deployment, MutationGate mode changes, PRJ-0003 repair, and SCHEMA runtime remain separate later gates.