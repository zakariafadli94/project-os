import { z } from "zod";
import type { ExecutionAdmission } from "../execution/contract";
import { ExecutionJournal, executionHash, requiredRulePostchecks } from "../execution/journal";
import type { ProjectState } from "../domain/project-state";
import {
  navigationCoverageGapSchema,
  navigationIndexIdentitySchema,
  navigationInventoryEntrySchema,
  navigationReconcileSchema,
  zoneNavigationHeadSchema,
  zoneNavigationReceiptSchema,
  type NavigationIndexIdentity,
  type NavigationInventoryEntry,
  type NavigationInventoryPort,
  type NavigationPostcheckPort,
  type NavigationReconcileRequest,
  type NavigationZone,
  type ZoneNavigationHead,
  type ZoneNavigationReceipt,
  type ZoneNavigationResult
} from "../domain/zone-navigation";
import type { SliceBudget } from "../convergence/contract";
import { sha256Text } from "./hash";
import { canonicalJson } from "../rules/contract";
import { machineDocumentRoot, workspaceProjectRoot } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../persistence/provider/contract";
import { ProviderConflictError, ProviderPreconditionFailedError } from "../persistence/provider/errors";

const PAGE_LIMIT = 8;
const navigationProgressSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  project_id: z.string(),
  request_id: z.string(),
  request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  target_generation: z.number().int().positive().safe(),
  index_basename: z.enum(["00-CURRENT-INDEX.md", "00-CURRENT.md"]),
  expected_index: navigationIndexIdentitySchema.nullable(),
  head_revision_token: z.string().nullable(),
  cursor: z.string().nullable(),
  page_count: z.number().int().nonnegative().safe(),
  inventory_complete: z.boolean(),
  snapshot_id: z.string().nullable(),
  verify_page: z.number().int().nonnegative().safe(),
  verify_entry: z.number().int().nonnegative().safe(),
  source_count: z.number().int().nonnegative().safe(),
  source_ids: z.array(z.string()).default([]),
  published_index: navigationIndexIdentitySchema.nullable().default(null),
  coverage_gaps: z.array(z.object({ resource_id: z.string(), code: z.string() }).strict()),
  rendered_links: z.array(z.string()),
  generated_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  legacy_archive_ref: z.string().nullable(),
  status: z.enum(["adopting", "publishing", "finalized", "conflict"]),
  receipt: z.unknown().nullable(),
  postchecks: z.array(z.object({ check_id: z.string(), verdict: z.enum(["allow", "deny", "unavailable"]), evidence_refs: z.array(z.string()) }).strict())
});
type NavigationProgress = z.infer<typeof navigationProgressSchema>;

interface SnapshotPage {
  schema_version: "1.0";
  page: number;
  project_id: string;
  request_id: string;
  snapshot_id: string;
  entries: NavigationInventoryEntry[];
  gaps: { resource_id: string; code: string }[];
}

export function zoneNavigationHeadPath(projectId: string, zone: NavigationZone): string {
  return `${machineDocumentRoot(projectId)}/navigation/${zone}/head.json`;
}

export class ZoneNavigationEngine {
  constructor(
    private readonly runtime: ProjectOsPersistenceRuntime,
    private readonly inventory: NavigationInventoryPort,
    private readonly postchecks?: NavigationPostcheckPort
  ) {}

  async reconcile(
    rawRequest: NavigationReconcileRequest,
    state: ProjectState,
    admission: ExecutionAdmission,
    budget: SliceBudget
  ): Promise<ZoneNavigationResult> {
    const request = navigationReconcileSchema.parse(rawRequest);
    const requestHash = await executionHash(request);
    const indexPath = this.indexPath(state, request.zone, request.expected_index?.basename ?? "00-CURRENT.md");
    const journal = new ExecutionJournal(this.runtime, request.project_id, "document", request.request_id);
      const root = await journal.root();
    const intentPath = `${root}/navigation-intention.json`;
    const progressPath = `${root}/navigation-progress.json`;
    const pagesRoot = `${root}/navigation/snapshot`;
    const verifiedRoot = `${root}/navigation/verified`;
    const generatedPath = `${root}/navigation/generated-index.md`;
    const headPath = zoneNavigationHeadPath(request.project_id, request.zone);

    try {
      this.assertAdmission(request, state, admission, requestHash, indexPath);
      const intent = await this.prepare(request, state, requestHash, indexPath, headPath, intentPath, progressPath, budget);
      if (intent.status === "conflict") return intent;
      let progress = intent.progress;
      const done = await this.resumeInventory(request, state, progress, progressPath, pagesRoot, budget);
      if (done.status === "pending" || done.status === "conflict") return done;
      progress = done.progress;
      if (progress.status === "finalized" && progress.receipt) {
        return { status: "finalized", receipt: zoneNavigationReceiptSchema.parse(progress.receipt) };
      }

      const verified = await this.verifyEntries(request, state, progress, progressPath, pagesRoot, verifiedRoot, budget);
      if (verified.status === "pending" || verified.status === "conflict") return verified;
      progress = verified.progress;

      const generated = this.render(request.zone, progress.rendered_links, progress.coverage_gaps);
      const generatedHash = await sha256Text(generated);
      if (progress.generated_sha256 && progress.generated_sha256 !== generatedHash) return { status: "conflict", code: "navigation_generated_input_changed" };
      await this.immutable(generatedPath, generated, budget);
      progress.generated_sha256 = generatedHash;
      progress.status = "publishing";
      progress = await this.saveProgress(progressPath, progress, await this.token(progressPath, budget), budget);

      if (!await this.inventory.verifySnapshot({ project_id: request.project_id, zone: request.zone, snapshot_id: progress.snapshot_id!, budget })) {
        return { status: "conflict", code: "navigation_snapshot_changed" };
      }

      const sourcePath = this.indexPath(state, request.zone, progress.index_basename);
      const archiveRef = await this.archiveSource(request, state, progress, sourcePath, budget);
      if (archiveRef.status === "conflict") return archiveRef;
      progress.legacy_archive_ref = archiveRef.ref;
      progress = await this.saveProgress(progressPath, progress, await this.token(progressPath, budget), budget);

      const write = await this.publishIndex(sourcePath, generated, progress.expected_index, budget);
      if (write.status === "conflict") return write;
      const index = write.identity;
      progress.published_index = index;
      progress = await this.saveProgress(progressPath, progress, await this.token(progressPath, budget), budget);
      const checks = await this.runPostchecks(request, admission, progress, progressPath, budget);
      if (checks.status === "conflict") return checks;

      const certificate = {
        schema_version: "1.0",
        project_id: request.project_id,
        request_id: request.request_id,
        request_hash: requestHash,
        zone: request.zone,
        generation: progress.target_generation,
        index,
        legacy_archive_ref: progress.legacy_archive_ref,
        source_snapshot_id: progress.snapshot_id,
        source_count: progress.source_count,
        coverage_gaps: progress.coverage_gaps,
        postchecks: checks.records,
        generated_content_sha256: progress.generated_sha256
      };
      const finalizationRef = `${root}/navigation/finalizations/${await executionHash(certificate)}.json`;
      await this.immutable(finalizationRef, certificate, budget);
      // Source writes observed during publication may invalidate the inventory
      // after the pre-write snapshot check. Recheck at the head boundary so a
      // stale index can never become the zone's current navigation generation.
      if (!await this.inventory.verifySnapshot({ project_id: request.project_id, zone: request.zone, snapshot_id: progress.snapshot_id!, budget })) {
        return { status: "conflict", code: "navigation_snapshot_changed" };
      }
      const head = await this.publishHead(request, progress, index, finalizationRef, headPath, budget);
      if (head.status === "conflict") return head;
      const receipt = zoneNavigationReceiptSchema.parse({
        schema_version: "1.0",
        status: "committed",
        project_id: request.project_id,
        request_id: request.request_id,
        zone: request.zone,
        generation: progress.target_generation,
        head_ref: headPath,
        finalization_ref: finalizationRef,
        index,
        source_snapshot_id: progress.snapshot_id,
        source_count: progress.source_count,
        coverage_gaps: progress.coverage_gaps
      });
      progress.status = "finalized";
      progress.receipt = receipt;
      await this.saveProgress(progressPath, progress, await this.token(progressPath, budget), budget);
      return { status: "finalized", receipt };
    } catch (error) {
      if (isBudgetExhausted(error)) {
        return { status: "pending", cursor: null };
      }
      if (error instanceof ProviderPreconditionFailedError || error instanceof ProviderConflictError) return { status: "conflict", code: "navigation_provider_conflict" };
      if (error instanceof NavigationConflict) return { status: "conflict", code: error.code };
      throw error;
    }
  }

  private async prepare(
    request: NavigationReconcileRequest,
    state: ProjectState,
    requestHash: string,
    indexPath: string,
    headPath: string,
    intentPath: string,
    progressPath: string,
    budget: SliceBudget
  ): Promise<{ status: "ready"; progress: NavigationProgress } | { status: "conflict"; code: string }> {
    const existingIntent = await this.readJson(intentPath, budget);
    const savedProgress = await this.readProgress(progressPath, budget);
    if (existingIntent !== null) {
      if (!isRecord(existingIntent) || existingIntent.request_hash !== requestHash || canonicalJson(existingIntent.request) !== canonicalJson(request)) return { status: "conflict", code: "navigation_request_id_conflict" };
      if (!savedProgress) {
        const recovered = navigationProgressSchema.safeParse(existingIntent.initial_progress);
        if (!recovered.success || recovered.data.request_hash !== requestHash || recovered.data.request_id !== request.request_id || recovered.data.project_id !== request.project_id) throw new NavigationConflict("navigation_progress_missing");
        await this.immutable(progressPath, recovered.data, budget);
        return { status: "ready", progress: recovered.data };
      }
      if (savedProgress.status === "finalized" && savedProgress.receipt) return { status: "ready", progress: savedProgress };
      return { status: "ready", progress: savedProgress };
    }
    if (savedProgress) throw new NavigationConflict("navigation_intention_missing");

    const names = ["00-CURRENT-INDEX.md", "00-CURRENT.md"] as const;
    const observations: ({ identity: NavigationIndexIdentity; content: string } | null)[] = [];
    for (const basename of names) observations.push(await this.observeIndex(this.indexPath(state, request.zone, basename), budget));
    if (observations[0] && observations[1]) return { status: "conflict", code: "navigation_index_name_conflict" };
    const observed = observations[0] ?? observations[1] ?? null;
    if (request.expected_index === null ? observed !== null : !sameIndexIdentity(observed?.identity ?? null, request.expected_index)) {
      return { status: "conflict", code: "navigation_index_identity_conflict" };
    }
    const existingHead = await this.readHead(headPath, request.project_id, request.zone, budget);
    if (existingHead && (existingHead.head.generation !== request.expected_generation || !sameIndexIdentity(existingHead.head.index, request.expected_index))) return { status: "conflict", code: "navigation_generation_conflict" };
    if (!existingHead && request.expected_generation !== 0) return { status: "conflict", code: "navigation_generation_conflict" };
    const indexBasename = observed?.identity.basename ?? "00-CURRENT.md";
    const targetGeneration = request.expected_generation + 1;
    const progress: NavigationProgress = {
      schema_version: "1.0",
      project_id: request.project_id,
      request_id: request.request_id,
      request_hash: requestHash,
      target_generation: targetGeneration,
      index_basename: indexBasename,
      expected_index: observed?.identity ?? null,
      head_revision_token: existingHead?.token ?? null,
      cursor: null,
      page_count: 0,
      inventory_complete: false,
      snapshot_id: null,
      verify_page: 0,
      verify_entry: 0,
      source_count: 0,
      source_ids: [],
      published_index: null,
      coverage_gaps: [],
      rendered_links: [],
      generated_sha256: null,
      legacy_archive_ref: null,
      status: "adopting",
      receipt: null,
      postchecks: []
    };
    await this.immutable(intentPath, { schema_version: "1.0", request, request_hash: requestHash, target_generation: targetGeneration, initial_progress: progress }, budget);
    await this.immutable(progressPath, progress, budget);
    return { status: "ready", progress };
  }

  private async resumeInventory(
    request: NavigationReconcileRequest,
    state: ProjectState,
    initial: NavigationProgress,
    progressPath: string,
    pagesRoot: string,
    budget: SliceBudget
  ): Promise<{ status: "pending"; cursor: string | null } | { status: "conflict"; code: string } | { status: "done"; progress: NavigationProgress }> {
    let progress = initial;
    while (!progress.inventory_complete) {
      if (!budget.canStartEffect(4)) return { status: "pending", cursor: progress.cursor };
      const page = await this.inventory.listPage({ project_id: request.project_id, zone: request.zone, cursor: progress.cursor, limit: PAGE_LIMIT, budget });
      if (!page.snapshot_id || (progress.snapshot_id && progress.snapshot_id !== page.snapshot_id)) return { status: "conflict", code: "navigation_snapshot_changed" };
      const entries = page.entries.map((value) => navigationInventoryEntrySchema.parse(value));
      const gaps = page.gaps.map((value) => navigationCoverageGapSchema.parse(value));
      for (const entry of entries) this.assertEntry(entry, state, request.zone);
      const seen = new Set(progress.source_ids);
      if (entries.some((entry) => seen.has(entry.resource_id)) || new Set(entries.map((entry) => entry.resource_id)).size !== entries.length) return { status: "conflict", code: "navigation_duplicate_source" };
      const savedPage: SnapshotPage = { schema_version: "1.0", page: progress.page_count, project_id: request.project_id, request_id: request.request_id, snapshot_id: page.snapshot_id, entries, gaps };
      await this.immutable(`${pagesRoot}/${progress.page_count.toString().padStart(8, "0")}.json`, savedPage, budget);
      progress.cursor = page.next_cursor;
      progress.snapshot_id = page.snapshot_id;
      progress.page_count += 1;
      progress.source_count += entries.length;
      progress.source_ids.push(...entries.map((entry) => entry.resource_id));
      progress.coverage_gaps.push(...gaps);
      progress.inventory_complete = page.next_cursor === null;
      progress = await this.saveProgress(progressPath, progress, await this.token(progressPath, budget), budget);
    }
    if (!progress.snapshot_id) return { status: "conflict", code: "navigation_snapshot_changed" };
    return { status: "done", progress };
  }

  private async verifyEntries(
    request: NavigationReconcileRequest,
    state: ProjectState,
    initial: NavigationProgress,
    progressPath: string,
    pagesRoot: string,
    verifiedRoot: string,
    budget: SliceBudget
  ): Promise<{ status: "pending"; cursor: string | null } | { status: "conflict"; code: string } | { status: "done"; progress: NavigationProgress }> {
    let progress = initial;
    while (progress.verify_page < progress.page_count) {
      const pagePath = `${pagesRoot}/${progress.verify_page.toString().padStart(8, "0")}.json`;
      const page = await this.readJson(pagePath, budget) as SnapshotPage | null;
      if (!page || page.snapshot_id !== progress.snapshot_id) return { status: "conflict", code: "navigation_snapshot_page_invalid" };
      while (progress.verify_entry < page.entries.length) {
        if (!budget.canStartEffect(9)) return { status: "pending", cursor: progress.cursor };
        const entry = page.entries[progress.verify_entry];
        if (!await this.inventory.verifyEntry(entry, budget)) return { status: "conflict", code: "navigation_source_changed" };
        await this.verifyPhysicalEntry(entry, budget);
        const evidence = { schema_version: "1.0", project_id: request.project_id, request_id: request.request_id, snapshot_id: page.snapshot_id, entry };
        await this.immutable(`${verifiedRoot}/${progress.source_count.toString().padStart(8, "0")}-${progress.verify_page.toString().padStart(8, "0")}-${progress.verify_entry.toString().padStart(8, "0")}.json`, evidence, budget);
        progress.rendered_links.push(renderLink(entry));
        progress.verify_entry += 1;
        progress = await this.saveProgress(progressPath, progress, await this.token(progressPath, budget), budget);
      }
      progress.verify_page += 1;
      progress.verify_entry = 0;
      progress = await this.saveProgress(progressPath, progress, await this.token(progressPath, budget), budget);
    }
    return { status: "done", progress };
  }

  private async archiveSource(
    request: NavigationReconcileRequest,
    state: ProjectState,
    progress: NavigationProgress,
    sourcePath: string,
    budget: SliceBudget
  ): Promise<{ status: "ok"; ref: string | null } | { status: "conflict"; code: string }> {
    if (!progress.expected_index) return { status: "ok", ref: null };
    const expected = progress.expected_index;
    if (progress.legacy_archive_ref) {
      const archived = await this.readExactBytes(progress.legacy_archive_ref, budget);
      if (!archived || await sha256Bytes(archived) !== expected.content_sha256) return { status: "conflict", code: "navigation_archive_unverified" };
      return { status: "ok", ref: progress.legacy_archive_ref };
    }
    const observed = await this.observeIndex(sourcePath, budget);
    if (!sameIndexIdentity(observed?.identity ?? null, expected)) return { status: "conflict", code: "navigation_index_changed" };
    if (!observed?.exact_bytes || !observed.bytes || observed.content === null) return { status: "conflict", code: "navigation_archive_bytes_unavailable" };
    const archiveRoot = `${workspaceProjectRoot(request.project_id, state.slug)}/ARCHIVES/NAVIGATION/${request.zone}`;
    const name = `${archiveRoot}/${progress.target_generation}-${expected.content_sha256}.md`;
    await this.immutableExactText(name, observed.content, observed.bytes, budget);
    const archiveMeta = await this.metadata(name, budget);
    const archived = await this.readExactBytes(name, budget);
    if (!archiveMeta?.objectId || !archiveMeta.revisionToken || !archived || await sha256Bytes(archived) !== expected.content_sha256 || !sameBytes(archived, observed.bytes)) return { status: "conflict", code: "navigation_archive_unverified" };
    const evidence = `${archiveRoot}/${progress.target_generation}-${expected.content_sha256}.evidence.json`;
    await this.immutable(evidence, { schema_version: "1.0", project_id: request.project_id, request_id: request.request_id, zone: request.zone, source_path: sourcePath, source_identity: expected, archive_path: name, archive_identity: { object_id: archiveMeta.objectId, revision_token: archiveMeta.revisionToken, content_sha256: expected.content_sha256 } }, budget);
    return { status: "ok", ref: name };
  }

  private async publishIndex(
    path: string,
    content: string,
    expected: NavigationIndexIdentity | null,
    budget: SliceBudget
  ): Promise<{ status: "ok"; identity: NavigationIndexIdentity } | { status: "conflict"; code: string }> {
    const current = await this.observeIndex(path, budget);
    if (!sameIndexIdentity(current?.identity ?? null, expected)) {
      // A retry may observe the exact output from a prior interrupted write.
      if (current && current.content === content) return { status: "ok", identity: current.identity };
      return { status: "conflict", code: "navigation_index_changed" };
    }
    if (expected) {
      budget.beforeHttp();
      await this.runtime.conditionalWrite.writeTextConditional(path, content, expected.revision_token);
    } else {
      budget.beforeHttp();
      await this.runtime.objects.createText(path, content);
    }
    const written = await this.observeIndex(path, budget);
    if (!written || written.content !== content) return { status: "conflict", code: "navigation_index_postcheck_failed" };
    return { status: "ok", identity: written.identity };
  }

  private async publishHead(
    request: NavigationReconcileRequest,
    progress: NavigationProgress,
    index: NavigationIndexIdentity,
    finalizationRef: string,
    path: string,
    budget: SliceBudget
  ): Promise<{ status: "ok" } | { status: "conflict"; code: string }> {
    const previous = await this.readHead(path, request.project_id, request.zone, budget);
    if (previous && previous.head.generation === progress.target_generation && previous.head.source_request_id === request.request_id && sameIndexIdentity(previous.head.index, index)) return { status: "ok" };
    if ((previous?.head.generation ?? 0) !== request.expected_generation || (previous?.token ?? null) !== progress.head_revision_token) return { status: "conflict", code: "navigation_head_changed" };
    const head: ZoneNavigationHead = zoneNavigationHeadSchema.parse({
      schema_version: "1.0", project_id: request.project_id, zone: request.zone,
      generation: progress.target_generation, source_request_id: request.request_id,
      index, finalization_ref: finalizationRef, source_snapshot_id: progress.snapshot_id, source_count: progress.source_count,
      coverage_gaps: progress.coverage_gaps
    });
    try {
      if (previous) {
        budget.beforeHttp();
        await this.runtime.conditionalWrite.writeTextConditional(path, canonicalJson(head), previous.token);
      } else {
        budget.beforeHttp();
        await this.runtime.objects.createText(path, canonicalJson(head));
      }
    } catch (error) {
      if (error instanceof ProviderConflictError || error instanceof ProviderPreconditionFailedError) return { status: "conflict", code: "navigation_head_changed" };
      throw error;
    }
    const observed = await this.readHead(path, request.project_id, request.zone, budget);
    if (!observed || canonicalJson(observed.head) !== canonicalJson(head)) return { status: "conflict", code: "navigation_head_postcheck_failed" };
    return { status: "ok" };
  }

  private async verifyPhysicalEntry(entry: NavigationInventoryEntry, budget: SliceBudget): Promise<void> {
    const before = await this.metadata(entry.path, budget);
    if (!matchesEntryMetadata(before, entry) || before?.size !== entry.expected.size) throw new NavigationConflict("navigation_target_missing_or_changed");
    let bytes: Uint8Array | null = null;
    if (this.runtime.objects.readBytes) {
      budget.beforeHttp();
      bytes = await this.runtime.objects.readBytes(entry.path, Math.max(1, entry.expected.size));
    }
    if (bytes === null) {
      const content = await this.readText(entry.path, budget);
      bytes = content === null ? null : new TextEncoder().encode(content);
    }
    const after = await this.metadata(entry.path, budget);
    if (bytes === null || bytes.byteLength !== entry.expected.size || !matchesEntryMetadata(after, entry) || after?.size !== entry.expected.size || before!.objectId !== after!.objectId || before!.revisionToken !== after!.revisionToken || await sha256Bytes(bytes) !== entry.expected.content_sha256) throw new NavigationConflict("navigation_target_missing_or_changed");
  }

  private async observeIndex(path: string, budget: SliceBudget): Promise<{ identity: NavigationIndexIdentity; content: string; bytes: Uint8Array; exact_bytes: boolean } | null> {
    const before = await this.metadata(path, budget);
    if (!before) return null;
    if (!before.objectId || !before.revisionToken) throw new NavigationConflict("navigation_index_identity_unavailable");
    let bytes: Uint8Array | null = null;
    let exactBytes = false;
    if (this.runtime.objects.readBytes) {
      budget.beforeHttp();
      bytes = await this.runtime.objects.readBytes(path, Math.max(1, before.size));
      exactBytes = bytes !== null;
    }
    if (!bytes) {
      const text = await this.readText(path, budget);
      bytes = text === null ? null : new TextEncoder().encode(text);
    }
    let content: string | null = null;
    try {
      content = bytes ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) : null;
      if (content !== null && !sameBytes(new TextEncoder().encode(content), bytes!)) content = null;
    } catch {
      content = null;
    }
    const after = await this.metadata(path, budget);
    if (content === null || !bytes || bytes.byteLength !== before.size || after?.objectId !== before.objectId || after?.revisionToken !== before.revisionToken || await sha256Bytes(bytes) !== before.integrityHash?.value && before.integrityHash?.algorithm === "sha256") throw new NavigationConflict("navigation_index_unstable");
    return { identity: { basename: path.split("/").at(-1) as NavigationIndexIdentity["basename"], object_id: before.objectId, revision_token: before.revisionToken, content_sha256: await sha256Bytes(bytes) }, content, bytes, exact_bytes: exactBytes };
  }

  private async readExactBytes(path: string, budget: SliceBudget): Promise<Uint8Array | null> {
    if (!this.runtime.objects.readBytes) return null;
    const metadata = await this.metadata(path, budget);
    if (!metadata) return null;
    budget.beforeHttp();
    const bytes = await this.runtime.objects.readBytes(path, Math.max(1, metadata.size));
    const after = await this.metadata(path, budget);
    if (!bytes || bytes.byteLength !== metadata.size || after?.objectId !== metadata.objectId || after?.revisionToken !== metadata.revisionToken) return null;
    return bytes;
  }

  private async readHead(path: string, projectId: string, zone: NavigationZone, budget: SliceBudget): Promise<{ head: ZoneNavigationHead; token: string } | null> {
    const before = await this.metadata(path, budget);
    if (!before) return null;
    if (!before.revisionToken) throw new NavigationConflict("navigation_head_token_unavailable");
    const raw = await this.readText(path, budget);
    const after = await this.metadata(path, budget);
    if (raw === null || after?.revisionToken !== before.revisionToken) throw new NavigationConflict("navigation_head_unstable");
    const head = zoneNavigationHeadSchema.parse(JSON.parse(raw));
    if (head.project_id !== projectId || head.zone !== zone) throw new NavigationConflict("navigation_head_binding_mismatch");
    return { head, token: before.revisionToken };
  }

  private async readProgress(path: string, budget?: SliceBudget): Promise<NavigationProgress | null> {
    const raw = budget ? await this.readText(path, budget) : await this.runtime.objects.readText(path);
    return raw === null ? null : navigationProgressSchema.parse(JSON.parse(raw));
  }

  private async readJson(path: string, budget: SliceBudget): Promise<unknown | null> {
    const raw = await this.readText(path, budget);
    return raw === null ? null : JSON.parse(raw);
  }

  private async immutable(path: string, value: unknown, budget: SliceBudget): Promise<void> {
    const content = typeof value === "string" ? value : canonicalJson(value);
    try {
      budget.beforeHttp();
      await this.runtime.objects.createText(path, content);
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existing = await this.readText(path, budget);
      if (existing !== content) throw new NavigationConflict("navigation_immutable_record_conflict");
    }
  }

  private async immutableExactText(path: string, content: string, expectedBytes: Uint8Array, budget: SliceBudget): Promise<void> {
    try {
      budget.beforeHttp();
      await this.runtime.objects.createText(path, content);
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existing = await this.readExactBytes(path, budget);
      if (!existing || !sameBytes(existing, expectedBytes)) throw new NavigationConflict("navigation_immutable_record_conflict");
    }
  }

  private async saveProgress(path: string, progress: NavigationProgress, token: string | null, budget: SliceBudget): Promise<NavigationProgress> {
    const content = canonicalJson(navigationProgressSchema.parse(progress));
    if (token === null) {
      await this.immutable(path, progress, budget);
      return progress;
    }
    budget.beforeHttp();
    await this.runtime.conditionalWrite.writeTextConditional(path, content, token);
    return progress;
  }

  private async token(path: string, budget: SliceBudget): Promise<string | null> {
    const metadata = await this.metadata(path, budget);
    return metadata?.revisionToken ?? null;
  }

  private async metadata(path: string, budget: SliceBudget): Promise<ProviderObjectMetadata | null> {
    budget.beforeHttp();
    return this.runtime.objects.getMetadata(path);
  }

  private async readText(path: string, budget: SliceBudget): Promise<string | null> {
    budget.beforeHttp();
    return this.runtime.objects.readText(path);
  }

  private indexPath(state: ProjectState, zone: NavigationZone, basename: string): string {
    return `${workspaceProjectRoot(state.project_id, state.slug)}/${zone}/${basename}`;
  }

  private assertEntry(entry: NavigationInventoryEntry, state: ProjectState, zone: NavigationZone): void {
    const expectedPath = `${workspaceProjectRoot(state.project_id, state.slug)}/${zone}/${entry.logical_path}`;
    if (entry.project_id !== state.project_id || entry.zone !== zone || entry.path !== expectedPath || entry.path === this.indexPath(state, zone, "00-CURRENT.md") || entry.path === this.indexPath(state, zone, "00-CURRENT-INDEX.md")) throw new NavigationConflict("navigation_entry_out_of_scope");
  }

  private assertAdmission(request: NavigationReconcileRequest, state: ProjectState, admission: ExecutionAdmission, requestHash: string, indexPath: string): void {
    const resourceId = `navigation:${request.zone}`;
    const resource = admission.resources?.filter((candidate) => candidate.resource_id === resourceId && candidate.resource_type === "navigation" && candidate.zone === request.zone && candidate.version === String(request.expected_generation));
    const scope = admission.resource_effect_scopes?.find((candidate) => candidate.resource_id === resourceId && candidate.resource_version === String(request.expected_generation) && candidate.provider_id === this.runtime.providerId);
    const address = scope?.destinations?.find((candidate) => candidate.path === indexPath && candidate.logical_path === `${request.zone}/${request.expected_index?.basename ?? "00-CURRENT.md"}`);
    const sourcePath = request.expected_index ? this.indexPath(state, request.zone, request.expected_index.basename) : null;
    const source = scope?.sources?.find((candidate) => candidate.path === sourcePath
      && candidate.logical_path === `${request.zone}/${request.expected_index?.basename}`);
    const archivePath = request.expected_index
      ? `${workspaceProjectRoot(state.project_id, state.slug)}/ARCHIVES/NAVIGATION/${request.zone}/${request.expected_generation + 1}-${request.expected_index.content_sha256}.md`
      : null;
    const archive = scope?.preservation_copies?.find((candidate) => candidate.path === archivePath
      && candidate.logical_path === `ARCHIVES/NAVIGATION/${request.zone}/${request.expected_generation + 1}-${request.expected_index?.content_sha256}.md`);
    if (state.project_id !== request.project_id || state.revision !== request.expected_project_revision || admission.project_id !== request.project_id || admission.request_id !== request.request_id || admission.kind !== "document" || admission.operation !== "navigation.reconcile" || admission.request_hash !== requestHash || admission.verdict !== "allow" || admission.project_revision !== request.expected_project_revision || resource?.length !== 1 || !scope || !address || scope.destinations.length !== 1 || scope.sources.length !== (sourcePath ? 1 : 0) || (sourcePath && !source) || scope.preservation_copies.length !== (archivePath ? 1 : 0) || (archivePath && !archive)) throw new NavigationConflict("navigation_admission_binding_mismatch");
    if (admission.deferred_rules?.length && !this.postchecks) throw new NavigationConflict("navigation_postchecks_unavailable");
  }

  private async runPostchecks(
    request: NavigationReconcileRequest,
    admission: ExecutionAdmission,
    progress: NavigationProgress,
    progressPath: string,
    budget: SliceBudget
  ): Promise<{ status: "ok"; records: unknown[] } | { status: "conflict"; code: string }> {
    const records: NavigationProgress["postchecks"] = [...progress.postchecks];
    for (const checkId of requiredRulePostchecks(admission)) {
      const prior = records.find((record) => record.check_id === checkId);
      if (prior?.verdict === "allow") continue;
      if (prior?.verdict === "deny") {
        progress.status = "conflict";
        progress = await this.saveProgress(progressPath, progress, await this.token(progressPath, budget), budget);
        return { status: "conflict", code: "navigation_postcheck_denied" };
      }
      if (!this.postchecks) return { status: "conflict", code: "navigation_postchecks_unavailable" };
      const result = await this.postchecks.run({ request, admission, check_id: checkId, budget });
      const verdict = result.verdict === "allow" && result.evidence_refs.length && result.evidence_refs.every((ref) => typeof ref === "string" && !!ref)
        ? "allow"
        : result.verdict === "deny" ? "deny" : "unavailable";
      const record = { check_id: checkId, verdict, evidence_refs: result.evidence_refs.filter((ref) => typeof ref === "string" && !!ref) } as const;
      const existingIndex = records.findIndex((candidate) => candidate.check_id === checkId);
      if (existingIndex === -1) records.push(record);
      else records[existingIndex] = record;
      progress.postchecks = records;
      if (verdict !== "allow") progress.status = "conflict";
      progress = await this.saveProgress(progressPath, progress, await this.token(progressPath, budget), budget);
      if (verdict === "deny") return { status: "conflict", code: "navigation_postcheck_denied" };
      if (verdict === "unavailable") return { status: "conflict", code: "navigation_postcheck_unavailable" };
    }
    return { status: "ok", records };
  }

  private render(zone: NavigationZone, links: string[], gaps: { resource_id: string; code: string }[]): string {
    const rendered = [
      `# ${zone} navigation`,
      "",
      "> Stage location does not imply acceptance or current business direction.",
      "",
      "## Canonical active references",
      "",
      ...(links.length ? links : ["- No verified canonical references were found."])
    ];
    if (gaps.length) rendered.push("", "## Coverage gaps", "", ...gaps.map((gap) => `- ${escapeMarkdown(gap.resource_id)}: ${escapeMarkdown(gap.code)}`));
    return `${rendered.join("\n")}\n`;
  }
}

function renderLink(entry: NavigationInventoryEntry): string {
  const path = entry.logical_path.split("/").map(encodeURIComponent).join("/");
  return `- [${escapeMarkdown(entry.logical_path)}](./${path})`;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!|<>]/g, "\\$&").replace(/[\r\n]/g, " ");
}

function sameIndexIdentity(left: NavigationIndexIdentity | null, right: NavigationIndexIdentity | null): boolean {
  return left === null ? right === null : right !== null
    && left.basename === right.basename && left.object_id === right.object_id
    && left.revision_token === right.revision_token && left.content_sha256 === right.content_sha256;
}

function matchesEntryMetadata(metadata: ProviderObjectMetadata | null, entry: NavigationInventoryEntry): boolean {
  return !!metadata && metadata.objectId === entry.expected.object_id && metadata.revisionToken === entry.expected.revision_token;
}

function isBudgetExhausted(error: unknown): boolean {
  return error instanceof Error && error.message.includes("slice_budget_exhausted");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class NavigationConflict extends Error {
  constructor(readonly code: string) { super(code); }
}
