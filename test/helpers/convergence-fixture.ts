import { parseCanonicalCommitRecord, type CanonicalCommitRecord } from "../../src/domain/commit-record";
import { parseTransaction } from "../../src/domain/transaction";
import { applyTransaction } from "../../src/domain/transitions";

const CREATED_AT = "2026-09-08T00:00:00.000Z";

export function commitFixture(projectId: string, through: number): CanonicalCommitRecord[] {
  if (!Number.isInteger(through) || through < 0) {
    throw new Error("fixture_revision_must_be_a_non_negative_integer");
  }

  const records: CanonicalCommitRecord[] = [];
  let state = null;

  for (let revision = 1; revision <= through; revision += 1) {
    const transaction = parseTransaction({
      schema_version: "1.0",
      transaction_id: `TXN-CONVERGENCE-${projectId}-${revision}`,
      project_id: projectId,
      base_revision: revision - 1,
      created_at: CREATED_AT,
      operation: revision === 1 ? "project.create" : "research.add",
      payload: revision === 1
        ? {
            name: "Synthetic convergence",
            slug: "synthetic-convergence",
            aliases: [],
            objective: "Fault-proof convergence"
          }
        : {
            research_id: `RES-CONV${String(revision).padStart(4, "0")}`,
            title: `Observation ${revision}`,
            body: "Synthetic convergence evidence"
          }
    });
    const result = applyTransaction(state, transaction);
    if (result.kind !== "commit") {
      throw new Error(`fixture_transition_failed:${result.kind}`);
    }
    state = result.state;
    records.push(parseCanonicalCommitRecord({
      schema_version: "1.0",
      project_id: projectId,
      previous_revision: revision - 1,
      new_revision: revision,
      transaction,
      state: result.state,
      event: result.event,
      receipt: {
        schema_version: "1.0",
        transaction_id: transaction.transaction_id,
        project_id: projectId,
        status: "committed",
        previous_revision: revision - 1,
        new_revision: revision,
        event_id: result.event.event_id,
        committed_at: CREATED_AT
      }
    }));
  }

  return records;
}
