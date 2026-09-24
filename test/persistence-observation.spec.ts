import { describe, expect, it } from "vitest";
import { persistenceObservation, requestDigest } from "../src/persistence/observation";

const identity = { project_id: "PRJ-0003", kind: "transaction" as const, request_id: "TXN-OBSERVATION-0001", correlation_id: "test", observed_at: "2026-09-24T10:00:00Z" };
describe("persistence observations", () => {
  it("never equates committed with finalized", () => {
    const result = persistenceObservation({ ...identity, receipt: { status: "committed" }, execution: { status: "finalizing" }, durable_intent: true, next_attempt_at: "2026-09-24T10:00:01Z" });
    expect(result).toMatchObject({ status: "finalizing", receipt_status: "committed", terminal: false, recovery: { owner: "system", state: "scheduled", requires_new_approval: false } });
  });
  it("does not infer absence from missing local evidence", () => {
    expect(persistenceObservation(identity)).toMatchObject({ status: "unknown", terminal: false });
    expect(persistenceObservation({ ...identity, absence_verified: true })).toMatchObject({ status: "not_received", recovery: { action: "retry_same_request" } });
  });
  it("requires receipt and certificate evidence before finality", () => {
    expect(persistenceObservation({ ...identity, execution: { status: "finalized", terminal: true } }).status).toBe("unknown");
    expect(persistenceObservation({ ...identity, receipt: { status: "committed" }, execution: { status: "finalized", terminal: true, finalization_ref: "certificate" } })).toMatchObject({ status: "finalized", terminal: true, recovery: { action: "none" } });
  });
  it("makes unsent and stopped work explicit without inventing approval", () => {
    expect(persistenceObservation({ ...identity, not_submitted: true })).toMatchObject({ status: "not_submitted", recovery: { durable_intent: false, action: "retry_same_request" } });
    expect(persistenceObservation({ ...identity, durable_intent: true, blocked: true })).toMatchObject({ recovery: { state: "blocked", owner: "operator", requires_new_approval: false } });
  });
  it("hashes equivalent object key order identically", async () => {
    expect(await requestDigest({ a: 1, b: 2 })).toBe(await requestDigest({ b: 2, a: 1 }));
    expect(await requestDigest({ a: 2 })).not.toBe(await requestDigest({ a: 1 }));
  });
});
