import { z } from "zod";
import { assertManagedRelativePath } from "../domain/managed-document";
import { sha256Text } from "./hash";

export type InputIntakePhase =
  | "DETECTED"
  | "SNAPSHOTTED"
  | "REFERENCE_COMMITTED"
  | "SOURCE_REMOVED"
  | "COMPLETE"
  | "DUPLICATE_CLEANED"
  | "WITHDRAWN"
  | "CONFLICT";

export interface InputIntakeRecord {
  schema_version: "1.0";
  intake_id: string;
  project_id: string;
  phase: InputIntakePhase;
  source: {
    provider_id: string;
    object_id: string;
    revision_token: string;
    integrity_hash: { algorithm: string; value: string };
    size: number;
    provider_path: string;
    relative_input_path: string;
  };
  detected_at: string;
  updated_at: string;
}

const phaseSchema = z.enum([
  "DETECTED",
  "SNAPSHOTTED",
  "REFERENCE_COMMITTED",
  "SOURCE_REMOVED",
  "COMPLETE",
  "DUPLICATE_CLEANED",
  "WITHDRAWN",
  "CONFLICT"
]);
const projectIdSchema = z.string().regex(/^PRJ-[0-9]{4,}$/);
const intakeIdSchema = z.string().regex(/^INTAKE-[A-F0-9]{24}$/);
const timestampSchema = z.string().datetime({ offset: true });
const boundedToken = z.string().min(1).max(512);

const recordSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  intake_id: intakeIdSchema,
  project_id: projectIdSchema,
  phase: phaseSchema,
  source: z.strictObject({
    provider_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    object_id: boundedToken,
    revision_token: boundedToken,
    integrity_hash: z.strictObject({
      algorithm: z.string().min(1).max(128),
      value: boundedToken
    }),
    size: z.number().int().nonnegative().safe(),
    provider_path: z.string().min(1).max(2048),
    relative_input_path: z.string()
  }),
  detected_at: timestampSchema,
  updated_at: timestampSchema
}).superRefine((value, ctx) => {
  try {
    assertAbsoluteProviderPath(value.source.provider_path);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      path: ["source", "provider_path"],
      message: error instanceof Error ? error.message : String(error)
    });
  }
  try {
    assertManagedRelativePath(value.source.relative_input_path);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      path: ["source", "relative_input_path"],
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

const TERMINAL = new Set<InputIntakePhase>([
  "COMPLETE",
  "DUPLICATE_CLEANED",
  "WITHDRAWN",
  "CONFLICT"
]);

const ALLOWED_TRANSITIONS: Record<InputIntakePhase, ReadonlySet<InputIntakePhase>> = {
  DETECTED: new Set(["SNAPSHOTTED", "WITHDRAWN", "CONFLICT"]),
  SNAPSHOTTED: new Set(["REFERENCE_COMMITTED", "DUPLICATE_CLEANED", "WITHDRAWN", "CONFLICT"]),
  REFERENCE_COMMITTED: new Set(["SOURCE_REMOVED", "COMPLETE", "CONFLICT"]),
  SOURCE_REMOVED: new Set(["COMPLETE", "DUPLICATE_CLEANED", "WITHDRAWN", "CONFLICT"]),
  COMPLETE: new Set(),
  DUPLICATE_CLEANED: new Set(),
  WITHDRAWN: new Set(),
  CONFLICT: new Set()
};

export async function inputIntakeIdFor(input: {
  projectId: string;
  providerId: string;
  objectId: string;
  revisionToken: string;
}): Promise<string> {
  const projectId = projectIdSchema.parse(input.projectId);
  const providerId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).parse(input.providerId);
  const objectId = boundedToken.parse(input.objectId);
  const revisionToken = boundedToken.parse(input.revisionToken);
  const digest = await sha256Text(`${projectId}\n${providerId}\n${objectId}\n${revisionToken}`);
  return `INTAKE-${digest.slice(0, 24).toUpperCase()}`;
}

export function parseInputIntakeRecord(input: unknown): InputIntakeRecord {
  return recordSchema.parse(input);
}

export function nextInputIntakeRecord(
  recordInput: InputIntakeRecord,
  phaseInput: InputIntakePhase,
  updatedAtInput: string
): InputIntakeRecord {
  const record = parseInputIntakeRecord(recordInput);
  const phase = phaseSchema.parse(phaseInput);
  const updatedAt = timestampSchema.parse(updatedAtInput);

  if (TERMINAL.has(record.phase)) {
    throw new Error(`Input intake phase ${record.phase} is terminal`);
  }
  if (!ALLOWED_TRANSITIONS[record.phase].has(phase)) {
    throw new Error(`Invalid input intake transition: ${record.phase} -> ${phase}`);
  }

  return parseInputIntakeRecord({ ...record, phase, updated_at: updatedAt });
}

function assertAbsoluteProviderPath(value: string): void {
  if (!value.startsWith("/") || value.includes("//") || /[\u0000-\u001F\u007F\\]/.test(value)) {
    throw new Error(`Unsafe provider path: ${value}`);
  }
  const segments = value.split("/").slice(1);
  if (segments.length === 0 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe provider path: ${value}`);
  }
}
