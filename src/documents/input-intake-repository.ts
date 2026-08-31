import { z } from "zod";
import {
  machineInputIntakePath,
  machineInputIntakeSourceBindingPath
} from "../persistence/layout";
import type { ObjectPersistence } from "../persistence/provider/contract";
import { ProviderConflictError } from "../persistence/provider/errors";
import { sha256Text } from "./hash";
import {
  nextInputIntakeRecord,
  parseInputIntakeRecord,
  type InputIntakePhase,
  type InputIntakeRecord
} from "./input-intake";

export interface InputIntakeSourceBinding {
  schema_version: "1.0";
  project_id: string;
  provider_id: string;
  source_path: string;
  intake_id: string;
  revision_token: string;
}

export class InputIntakeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputIntakeConflictError";
  }
}

const sourceBindingSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  project_id: z.string().regex(/^PRJ-[0-9]{4,}$/),
  provider_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  source_path: z.string().min(1).max(2048),
  intake_id: z.string().regex(/^INTAKE-[A-F0-9]{24}$/),
  revision_token: z.string().min(1).max(512)
}).superRefine((value, ctx) => {
  try {
    assertAbsoluteProviderPath(value.source_path);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      path: ["source_path"],
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

export class InputIntakeRepository {
  constructor(private readonly objects: ObjectPersistence) {}

  async read(projectId: string, intakeId: string): Promise<InputIntakeRecord | null> {
    const raw = await this.objects.readText(machineInputIntakePath(projectId, intakeId));
    if (raw === null) return null;
    const record = parseInputIntakeRecord(JSON.parse(raw));
    if (record.project_id !== projectId || record.intake_id !== intakeId) {
      throw new InputIntakeConflictError(`Input intake binding mismatch for ${projectId}/${intakeId}`);
    }
    return record;
  }

  async create(recordInput: InputIntakeRecord): Promise<InputIntakeRecord> {
    const record = parseInputIntakeRecord(recordInput);
    const path = machineInputIntakePath(record.project_id, record.intake_id);
    const content = pretty(record);
    try {
      await this.objects.createText(path, content);
      return record;
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existing = await this.read(record.project_id, record.intake_id);
      if (!existing) throw error;
      if (pretty(existing) !== content) {
        throw new InputIntakeConflictError(`Input intake id is already bound to different evidence: ${record.intake_id}`);
      }
      return existing;
    }
  }

  async advance(
    projectId: string,
    intakeId: string,
    phase: InputIntakePhase,
    updatedAt: string
  ): Promise<InputIntakeRecord> {
    const current = await this.read(projectId, intakeId);
    if (!current) throw new Error(`Input intake not found: ${projectId}/${intakeId}`);

    if (current.phase === phase) {
      if (current.updated_at === updatedAt) return current;
      throw new InputIntakeConflictError(
        `Input intake phase ${phase} already persisted with different transition evidence: ${intakeId}`
      );
    }

    const next = nextInputIntakeRecord(current, phase, updatedAt);
    await this.objects.upsertText(machineInputIntakePath(projectId, intakeId), pretty(next));
    return next;
  }

  async bindSourcePath(
    recordInput: InputIntakeRecord,
    options: { expectedIntakeId?: string } = {}
  ): Promise<InputIntakeSourceBinding> {
    const record = parseInputIntakeRecord(recordInput);
    const durable = await this.read(record.project_id, record.intake_id);
    if (!durable || pretty(durable) !== pretty(record)) {
      throw new InputIntakeConflictError(`Source-path binding requires the exact durable intake record: ${record.intake_id}`);
    }

    const binding = sourceBindingSchema.parse({
      schema_version: "1.0",
      project_id: record.project_id,
      provider_id: record.source.provider_id,
      source_path: record.source.provider_path,
      intake_id: record.intake_id,
      revision_token: record.source.revision_token
    });
    const path = await this.sourceBindingPath(binding.project_id, binding.provider_id, binding.source_path);
    const existing = await this.readSourcePathBinding(
      binding.project_id,
      binding.provider_id,
      binding.source_path
    );

    if (!existing) {
      if (options.expectedIntakeId !== undefined) {
        throw new InputIntakeConflictError(
          `Input intake source binding expected ${options.expectedIntakeId} but no binding exists`
        );
      }
      try {
        await this.objects.createText(path, pretty(binding));
        return binding;
      } catch (error) {
        if (!(error instanceof ProviderConflictError)) throw error;
        const raced = await this.readSourcePathBinding(
          binding.project_id,
          binding.provider_id,
          binding.source_path
        );
        if (!raced) throw error;
        if (sameBinding(raced, binding)) return raced;
        throw new InputIntakeConflictError(`Input intake source binding changed concurrently: ${binding.source_path}`);
      }
    }

    if (sameBinding(existing, binding)) return existing;
    if (options.expectedIntakeId === undefined || options.expectedIntakeId !== existing.intake_id) {
      throw new InputIntakeConflictError(
        `Input intake source binding conflict for ${binding.source_path}: current=${existing.intake_id}`
      );
    }

    await this.objects.upsertText(path, pretty(binding));
    return binding;
  }

  async readSourcePathBinding(
    projectId: string,
    providerId: string,
    sourcePath: string
  ): Promise<InputIntakeSourceBinding | null> {
    const normalizedProviderId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).parse(providerId);
    assertAbsoluteProviderPath(sourcePath);
    const path = await this.sourceBindingPath(projectId, normalizedProviderId, sourcePath);
    const raw = await this.objects.readText(path);
    if (raw === null) return null;
    const binding = sourceBindingSchema.parse(JSON.parse(raw));
    if (
      binding.project_id !== projectId
      || binding.provider_id !== normalizedProviderId
      || binding.source_path !== sourcePath
    ) {
      throw new InputIntakeConflictError(`Input intake source binding identity mismatch: ${sourcePath}`);
    }
    return binding;
  }

  private async sourceBindingPath(projectId: string, providerId: string, sourcePath: string): Promise<string> {
    const hash = await sha256Text(`${providerId}\n${sourcePath}`);
    return machineInputIntakeSourceBindingPath(projectId, hash);
  }
}

function sameBinding(left: InputIntakeSourceBinding, right: InputIntakeSourceBinding): boolean {
  return left.schema_version === right.schema_version
    && left.project_id === right.project_id
    && left.provider_id === right.provider_id
    && left.source_path === right.source_path
    && left.intake_id === right.intake_id
    && left.revision_token === right.revision_token;
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

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
