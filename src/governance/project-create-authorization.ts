import type {
  ProjectCreateAuthorizationReceipt,
  ProjectCreateAuthorizationRecord
} from "../domain/project-governance";
import {
  parseProjectCreateAuthorizationReceipt,
  parseProjectCreateAuthorizationRecord
} from "../schema/project-governance";
import type { GovernanceRepository } from "./repository";

const MAX_AUTHORIZATION_WINDOW_MS = 30 * 60_000;

export class ProjectCreateAuthorizationIdempotencyError extends Error {
  readonly code = "PROJECT_CREATE_AUTHORIZATION_IDEMPOTENCY_MISMATCH" as const;

  constructor(public readonly authorizationId: string) {
    super(`Project-create authorization ${authorizationId} already exists with different content`);
    this.name = "ProjectCreateAuthorizationIdempotencyError";
  }
}

export function validateProjectCreateAuthorizationWindow(issuedAt: string, expiresAt: string): void {
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) {
    throw new Error("Project-create authorization timestamps must be valid ISO timestamps");
  }
  if (expires <= issued) {
    throw new Error("Project-create authorization expires_at must be after issued_at");
  }
  if (expires - issued > MAX_AUTHORIZATION_WINDOW_MS) {
    throw new Error("Project-create authorization validity cannot exceed 30 minutes");
  }
}

export async function issueProjectCreateAuthorization(
  repository: GovernanceRepository,
  input: ProjectCreateAuthorizationRecord
): Promise<ProjectCreateAuthorizationReceipt> {
  const record = parseProjectCreateAuthorizationRecord(input);
  validateProjectCreateAuthorizationWindow(record.issued_at, record.expires_at);

  const existing = await repository.readProjectCreateAuthorization(record.authorization_id);
  if (existing && canonical(existing) !== canonical(record)) {
    throw new ProjectCreateAuthorizationIdempotencyError(record.authorization_id);
  }

  const receipt = parseProjectCreateAuthorizationReceipt({
    schema_version: "1.0",
    authorization_id: record.authorization_id,
    status: "issued",
    issued_at: record.issued_at,
    expires_at: record.expires_at
  });

  if (!existing) await repository.writeProjectCreateAuthorization(record);
  const existingReceipt = await repository.readProjectCreateAuthorizationReceipt(record.authorization_id);
  if (existingReceipt) {
    if (canonical(existingReceipt) !== canonical(receipt)) {
      throw new Error(`Immutable project-create authorization receipt conflict: ${record.authorization_id}`);
    }
    return existingReceipt;
  }
  await repository.writeProjectCreateAuthorizationReceipt(receipt);
  return receipt;
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}
