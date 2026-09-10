# Project OS — Control Tower Governed Ingress Design

**Status:** Proposed rectification design generated from the Founder’s urgent request to unblock all projects on 2026-09-10; implementation evidence remains pending.

## Problem

Project Guard correctly requires authenticated ingress, a fresh signed mutation context, a typed request, and a terminal committed receipt. Control Tower currently has no durable authenticated client for that protocol. The zero-traffic operator experiment proved only that a privileged local session can read `GET /v1/projects/<project_id>/mutation-context`; it did not submit `working.write`, did not produce a committed receipt, and did not create a Control Tower channel.

The result is fail-closed but operationally unusable: project data remains safe, while normal project progress cannot be persisted from Control Tower.

## Decision

Deliver two sequential capabilities:

1. A local emergency operator bridge for the current Codex host. It creates a masked, short-lived, zero-traffic Worker version, obtains a fresh canonical context, submits one typed request, requires the expected committed receipt, then restores a single-version base deployment through the Cloudflare Deployments API and proves revocation. This is a temporary continuity mechanism, not the permanent Control Tower identity.
2. A dedicated OAuth-protected remote MCP Worker named `project-os-control-tower`. It exposes only goal-oriented Project OS tools, binds to the existing `ProjectGuard` and `RegistryGuard` namespaces across scripts, and invokes the same internal governed admission service as the public Worker. Control Tower receives OAuth scopes, never `INGRESS_TOKEN` or `MUTATION_CONTEXT_SIGNING_KEY`.

Cloudflare documents Streamable HTTP `/mcp` as the current remote MCP transport and OAuth 2.1 as the authorization model. The implementation uses `createMcpHandler()` for stateless tools, not the deprecated stateful MCP transport.

## Security and persistence invariants

- Dropbox remains canonical.
- Neither bridge writes canonical Markdown or provider paths directly.
- Every durable business mutation goes through an existing strict parser and ProjectGuard/RegistryGuard owner.
- Existing projects require a fresh signed mutation context obtained immediately before admission.
- The context is never refreshed after a stale rejection without rebuilding the request from freshly returned canonical state.
- A result is reported as persisted only after a terminal receipt with `status: "committed"` and matching request identity.
- Exact replay returns the original terminal receipt; a reused ID with different bytes fails closed.
- Project creation remains `project.create`, `project_id=PRJ-AUTO`, `base_revision=0`, owned by RegistryGuard.
- The MCP Worker accepts only the exact operator identity `zakaria.fadli.94@gmail.com` and scopes `project.read` or `project.mutate`.
- No generic Dropbox path, shell command, SQL, arbitrary internal URL, raw bearer token, or untyped JSON tool is exposed.
- Existing `INGRESS_TOKEN` behavior remains unchanged.
- PRJ-0003 remains excluded from real mutation until its convergence rollout gate is satisfied.
- Human alert delivery remains deferred and does not weaken authentication, receipts, audit evidence, or rollback.

## Interfaces

### Shared governed admission

`src/admission/governed-submit.ts` owns one provider-neutral internal interface:

```ts
export type GovernedSubmission =
  | { kind: "transaction"; request: Transaction }
  | { kind: "document"; request: ManagedDocumentRequest }
  | { kind: "artifact"; request: ArtifactWriteRequest };

export interface GovernedSubmissionResult {
  kind: GovernedSubmission["kind"];
  project_id: string;
  request_id: string;
  receipt: Receipt | ArtifactWriteReceipt | ManagedDocumentReceipt;
}

export async function executeGovernedSubmission(
  env: Env,
  submission: GovernedSubmission,
  context: MutationContext | null
): Promise<GovernedSubmissionResult>;
```

The existing HTTP routes and the MCP tools both call this service. It preserves ProjectGuard admission, continuity routing, artifact policy, document lifecycle, and RegistryGuard allocation.

### MCP tools

The permanent Worker exposes four tools:

- `project_os_get_context(project_id)` — read current canonical state and rendered STATE/HANDOFF; scope `project.read`.
- `project_os_submit_transaction(request)` — submit a strict typed transaction; scope `project.mutate`.
- `project_os_write_working_document(request)` — submit strict `working.write`; scope `project.mutate`.
- `project_os_get_receipt(project_id, request_id, kind)` — read terminal proof without causing an effect; scope `project.read`.

No tool accepts a bearer token. Mutation tools fetch a context internally and return a sanitized result containing identifiers, revisions, status, and error code but no canonical document body unless the caller requested the read tool.

## Failure behavior

- Authentication or scope failure: MCP authorization error; zero ProjectGuard call.
- Unknown project, incomplete canonical discovery, or unavailable provider: typed unavailable response; zero mutation.
- Missing, forged, expired, or stale context: fail closed with the existing 428/409/503 semantics.
- Timeout after effect: query the exact receipt before retry; never generate a second request ID.
- Receipt mismatch: block and record an authenticated audit event.
- Emergency bridge interruption: unconditional restoration to the captured single base version, then verify the temporary version override resolves to base and the ephemeral credential receives 401 on normal traffic.
- MCP outage: public ingress and Dropbox inbox remain unchanged; disabling the MCP Worker immediately removes the new channel without rolling back Project Guard.

## Qualification

Use synthetic PRJ-0008 first. Prove read, one typed mutation, committed receipt, exact replay, stale rejection, lost-response receipt recovery, OAuth denial, wrong-identity denial, and rollback. Only after these gates may an explicitly accepted PRJ-0007 C0 be submitted as `working.write`. PRJ-0003 is never used as the canary.
