import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { continuityStatus, evaluateContinuity } from "../src/continuity/policy";
import worker from "../src/index";
import type { Env } from "../src/env";

const testEnv = env as unknown as Env;
const authorization = { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` };

const completeProofs = {
  user_workflow_unchanged: true,
  zero_downtime: true,
  project_isolation_proven: true,
  canonical_compatibility_proven: true,
  old_new_chat_compatibility_proven: true,
  stable_path_retained: true,
  rollback_proven: true,
  history_preserved: true,
  production_proof_complete: true
};

describe("continuity control plane", () => {
  it("exposes authenticated stable-by-default continuity status without changing user workflow", async () => {
    const unauthorized = await worker.fetch(new Request("https://example.com/v1/admin/continuity"), testEnv, createExecutionContext());
    expect(unauthorized.status).toBe(401);

    const response = await worker.fetch(new Request("https://example.com/v1/admin/continuity", {
      headers: authorization
    }), testEnv, createExecutionContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      contract_version: "1.0",
      mode: "stable",
      effective_path: "stable",
      candidate_available: false,
      ready_for_candidate: false,
      blockers: ["CANDIDATE_NOT_AVAILABLE"],
      user_workflow_change_required: false
    });
  });

  it("fails closed to stable for an unknown configured mode", () => {
    expect(continuityStatus("unexpected-mode")).toMatchObject({
      mode: "stable",
      effective_path: "stable",
      ready_for_candidate: false,
      user_workflow_change_required: false
    });
  });

  it("selects a candidate automatically only when every continuity proof is present", () => {
    expect(evaluateContinuity({
      mode: "automatic",
      candidate_available: true,
      proofs: completeProofs
    })).toEqual({
      contract_version: "1.0",
      mode: "automatic",
      effective_path: "candidate",
      candidate_available: true,
      ready_for_candidate: true,
      blockers: [],
      user_workflow_change_required: false
    });
  });

  it("fails closed to the stable path when rollback proof is missing", () => {
    expect(evaluateContinuity({
      mode: "automatic",
      candidate_available: true,
      proofs: { ...completeProofs, rollback_proven: false }
    })).toMatchObject({
      effective_path: "stable",
      ready_for_candidate: false,
      blockers: ["ROLLBACK_NOT_PROVEN"]
    });
  });

  it("blocks any candidate that requires a user workflow change", () => {
    expect(evaluateContinuity({
      mode: "automatic",
      candidate_available: true,
      proofs: { ...completeProofs, user_workflow_unchanged: false }
    })).toMatchObject({
      effective_path: "stable",
      ready_for_candidate: false,
      blockers: ["USER_WORKFLOW_CHANGE_REQUIRED"]
    });
  });

  it("forces the stable path in rollback mode even with complete candidate proofs", () => {
    expect(evaluateContinuity({
      mode: "rollback",
      candidate_available: true,
      proofs: completeProofs
    })).toMatchObject({
      effective_path: "stable",
      ready_for_candidate: true,
      blockers: []
    });
  });
});
