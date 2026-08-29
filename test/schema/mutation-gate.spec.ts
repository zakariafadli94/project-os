import { describe, expect, it } from "vitest";
import { mutationCandidateIdFor } from "../../src/domain/mutation-gate";
import {
  encodeExternalMutationCandidateRecord,
  encodeMutationIntentRecord,
  readExternalMutationCandidateRecord,
  readMutationIntentRecord,
  type CurrentExternalMutationCandidateRecord,
  type CurrentMutationIntentRecord
} from "../../src/schema/mutation-gate";

const projectId = "PRJ-9009";
const intentId = "MUTINT-AAAAAAAAAAAAAAAAAAAAAAAA";
const requestId = "ART-SCHEMA-000001";
const candidateId = "MUTCAND-BBBBBBBBBBBBBBBBBBBBBBBB";
const providerFileId = "id:AbC_123-x";
const providerRev = "rev-schema-1";
const providerHash = "a".repeat(64);
const destinationPath = `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-schema/DELIVERABLES/report.md`;
const candidatePath = `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-schema/DELIVERABLES/external.md`;
const payloadPath = `/PROJECT_OS/.project-os/projects/${projectId}/mutation-gate/candidate-payloads/${candidateId}`;

function v1Intent(precondition: unknown = {
  kind: "existing",
  file_id: providerFileId,
  rev: providerRev,
  content_hash: providerHash,
  size: 42
}) {
  return {
    schema_version: "1.0",
    intent_id: intentId,
    project_id: projectId,
    kind: "artifact",
    request_id: requestId,
    request_sha256: "b".repeat(64),
    request_json: JSON.stringify({ request_id: requestId }),
    base_project_revision: 12,
    destination_path: destinationPath,
    provider_precondition: precondition,
    expected_content_sha256: "c".repeat(64),
    mode: "replace",
    recorded_at: "2026-08-29T00:30:00+01:00"
  };
}

function v1Candidate() {
  return {
    schema_version: "1.0",
    candidate_id: candidateId,
    project_id: projectId,
    source: "external_unverified",
    detection_source: "incremental",
    provider_path: candidatePath,
    provider_file_id: providerFileId,
    provider_rev: providerRev,
    provider_content_hash: providerHash,
    size: 42,
    immutable_payload_path: payloadPath,
    detected_at: "2026-08-29T00:31:00+01:00"
  };
}

describe("MutationGate schema codecs", () => {
  it("strictly reads V1 intent evidence and upcasts Dropbox preconditions to provider-neutral semantics", () => {
    const existing = readMutationIntentRecord(v1Intent());
    expect(existing.sourceVersion).toBe("1.0");
    expect(existing.record.provider_precondition).toEqual({
      kind: "existing",
      provider_id: "dropbox",
      object_id: providerFileId,
      revision_token: providerRev,
      integrity_hash: { algorithm: "dropbox-content-hash", value: providerHash },
      size: 42
    });

    const absent = readMutationIntentRecord(v1Intent({ kind: "absent" }));
    expect(absent.record.provider_precondition).toEqual({ kind: "absent", provider_id: "dropbox" });
  });

  it("writes V1 below provider_v2 and strict provider-neutral V2 at provider_v2", () => {
    const current = readMutationIntentRecord(v1Intent()).record;

    expect(encodeMutationIntentRecord(current, "core_v2")).toEqual(v1Intent());
    expect(encodeMutationIntentRecord(current, "provider_v2")).toEqual({
      ...v1Intent(),
      schema_version: "2.0",
      provider_precondition: {
        kind: "existing",
        provider_id: "dropbox",
        object_id: providerFileId,
        revision_token: providerRev,
        integrity_hash: { algorithm: "dropbox-content-hash", value: providerHash },
        size: 42
      }
    });

    expect(() => readMutationIntentRecord({
      ...v1Intent(),
      schema_version: "2.0",
      provider_precondition: {
        kind: "existing",
        provider_id: "dropbox",
        object_id: providerFileId,
        revision_token: providerRev,
        size: 42
      }
    })).toThrow();
  });

  it("upcasts V1 candidates and writes V2 candidates without changing Dropbox candidate identity inputs", async () => {
    const read = readExternalMutationCandidateRecord(v1Candidate());
    expect(read.sourceVersion).toBe("1.0");
    expect(read.record.provider).toEqual({
      provider_id: "dropbox",
      path: candidatePath,
      object_id: providerFileId,
      revision_token: providerRev,
      integrity_hash: { algorithm: "dropbox-content-hash", value: providerHash },
      size: 42
    });

    expect(await mutationCandidateIdFor({
      projectId,
      providerFileId,
      providerRev
    })).toBe(await mutationCandidateIdFor({
      projectId,
      providerFileId: read.record.provider.object_id,
      providerRev: read.record.provider.revision_token
    }));

    expect(encodeExternalMutationCandidateRecord(read.record, "provider_v2")).toEqual({
      schema_version: "2.0",
      candidate_id: candidateId,
      project_id: projectId,
      source: "external_unverified",
      detection_source: "incremental",
      provider: read.record.provider,
      immutable_payload_path: payloadPath,
      detected_at: "2026-08-29T00:31:00+01:00"
    });
  });

  it("round-trips strict V2 semantic records and rejects unknown future versions", () => {
    const intent = readMutationIntentRecord(v1Intent()).record as CurrentMutationIntentRecord;
    const candidate = readExternalMutationCandidateRecord(v1Candidate()).record as CurrentExternalMutationCandidateRecord;

    const v2Intent = encodeMutationIntentRecord(intent, "provider_v2");
    const v2Candidate = encodeExternalMutationCandidateRecord(candidate, "provider_v2");
    expect(readMutationIntentRecord(v2Intent).record).toEqual(intent);
    expect(readExternalMutationCandidateRecord(v2Candidate).record).toEqual(candidate);

    expect(() => readMutationIntentRecord({ ...v1Intent(), schema_version: "3.0" })).toThrow(/MutationIntent.*3\.0/i);
    expect(() => readExternalMutationCandidateRecord({ ...v1Candidate(), schema_version: "3.0" })).toThrow(/ExternalMutationCandidate.*3\.0/i);
  });
});
