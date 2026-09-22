import { expect, it } from "vitest";
import type { MutationContext } from "../src/admission/mutation-context";
import type { Transaction } from "../src/domain/transaction";
import type { Env } from "../src/env";
import { resolveInboxTransactionContext } from "../src/inbox/runtime";

const transaction: Transaction = {
  schema_version: "1.0",
  transaction_id: "TXN-INBOX-CONTEXT-0001",
  project_id: "PRJ-0003",
  base_revision: 337,
  created_at: "2026-09-22T18:05:00.000Z",
  operation: "research.add",
  payload: {
    research_id: "RES-INBOXCONTEXT0001",
    title: "Inbox admission context",
    body: "The server supplies a fresh context for the official inbox.",
    source: "test"
  }
};

const issued: MutationContext = {
  actor: { actor_id: "ingress", authority: "ingress_token" },
  project_id: "PRJ-0003",
  canonical_revision: 337,
  state_hash: "a".repeat(64),
  observed_at: "2026-09-22T18:05:00.000Z",
  expiry: "2026-09-22T18:10:00.000Z",
  token: "payload.signature"
};

const projectCreate: Transaction = {
  schema_version: "1.0",
  transaction_id: "TXN-INBOX-CONTEXT-CREATE-0001",
  project_id: "PRJ-AUTO",
  base_revision: 0,
  created_at: "2026-09-22T18:05:00.000Z",
  operation: "project.create",
  payload: {
    name: "Inbox context",
    slug: "inbox-context",
    aliases: [],
    objective: "Project creation is admitted by RegistryGuard."
  }
};

it("obtains a fresh server context before executing a raw official-inbox transaction", async () => {
  const requests: Request[] = [];
  const env = {
    INGRESS_TOKEN: "ingress-token",
    PROJECT_GUARD: {
      getByName: (projectId: string) => ({
        fetch: async (request: Request | string, init?: RequestInit) => {
          const resolved = request instanceof Request ? request : new Request(request, init);
          requests.push(resolved);
          expect(projectId).toBe("PRJ-0003");
          return Response.json({ context: issued });
        }
      })
    }
  } as unknown as Env;

  // Legacy inbox entries omit the envelope field rather than serializing null.
  await expect(resolveInboxTransactionContext(env, transaction)).resolves.toEqual(issued);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("https://project-guard.internal/mutation-context?include_state=false");
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer ingress-token");
});

it("keeps an already signed inbox envelope unchanged", async () => {
  const env = {
    INGRESS_TOKEN: "ingress-token",
    PROJECT_GUARD: {
      getByName: () => ({
        fetch: async () => { throw new Error("unexpected fresh-context read"); }
      })
    }
  } as unknown as Env;

  await expect(resolveInboxTransactionContext(env, transaction, issued)).resolves.toBe(issued);
});

it("does not request a project context for registry-allocated project creation", async () => {
  const env = {
    INGRESS_TOKEN: "ingress-token",
    PROJECT_GUARD: {
      getByName: () => ({
        fetch: async () => { throw new Error("project.create must not query ProjectGuard"); }
      })
    }
  } as unknown as Env;

  await expect(resolveInboxTransactionContext(env, projectCreate, null)).resolves.toBeNull();
});
