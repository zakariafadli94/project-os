import { expect, it } from "vitest";
import { persistenceCapabilities } from "../src/persistence/capabilities";
import { createControlTowerServer } from "../src/control-tower/mcp";

it("separates server support, authorization and unobservable client tools", () => {
  const result = persistenceCapabilities({ CF_VERSION_METADATA: { id: "version", tag: `git-${"b".repeat(40)}` } }, { read: true, mutate: false });
  expect(result).toMatchObject({
    protocol_version: "2.0", deployment_sha: "b".repeat(40),
    server_supported: { canonical_read: true, typed_transactions: true, governed_documents: true, governed_artifacts: true },
    authorized: { read: true, mutate: false }, callable_in_this_session: null,
    runtime_readiness: "not_probed"
  });
  // The server cannot observe client tool mounting, so it must not claim
  // a missing connector when this very tool has just been called.
  expect(result).not.toHaveProperty("missing_client_capability");
  expect(JSON.stringify(result)).not.toContain("Bearer");
});

it("discovers capabilities without loading canonical project content", async () => {
  const owner = { getByName: () => { throw new Error("must_not_load_project"); } } as unknown as DurableObjectNamespace;
  const server = createControlTowerServer({ PROJECT_GUARD: owner, REGISTRY_GUARD: owner }, { read: true, mutate: false }) as unknown as {
    _registeredTools: Record<string, { handler(input: unknown): Promise<{ content: Array<{ text: string }> }> }>
  };
  const result = await server._registeredTools.project_os_get_capabilities!.handler({});
  const manifest = JSON.parse(result.content[0]!.text);
  expect(manifest).toMatchObject({
    callable_in_this_session: null,
    runtime_readiness: "not_probed",
    server_supported: { typed_transactions: true },
    authorized: { read: true, mutate: false }
  });
  expect(manifest).not.toHaveProperty("missing_client_capability");
});
