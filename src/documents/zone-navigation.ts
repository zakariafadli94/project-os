import { z } from "zod";
import type { ExecutionAdmission } from "../execution/contract";
import { ExecutionJournal, executionHash, requiredRulePostchecks } from "../execution/journal";
import type { ProjectState } from "../domain/project-state";
import {
  navigationCoverageGapSchema,
  navigationIndexIdentitySchema,
  navigationInventoryEntrySchema,
  navigationReconcileSchema,
  navigationCatalogRebuildProgressSchema,
  navigationCatalogRebuildCertificateSchema,
  navigationCatalogManifestIdentitySchema,
  type NavigationCatalogRebuildCertificate,
  type NavigationCatalogRebuildProgress,
  type NavigationCatalogRebuildRequest,
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
import type { RuleVersion } from "../domain/rule-governance";
import { ZoneNavigationSources, zoneNavigationCatalogShardForResource, type CompactCatalogManifestIdentity } from "./zone-navigation-sources";

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
  verify_cursor: z.strictObject({ resource_id: z.string(), entry_hash: z.string().regex(/^[a-f0-9]{64}$/), cursor: z.string() }).nullable().optional(),
  source_count: z.number().int().nonnegative().safe(),
  source_ids: z.array(z.string()).default([]),
  published_index: navigationIndexIdentitySchema.nullable().default(null),
  coverage_gaps: z.array(z.object({ resource_id: z.string(), code: z.string() }).strict()),
  rendered_links: z.array(z.string()),
  generated_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  legacy_archive_ref: z.string().nullable(),
  valid_links_work: z.strictObject({
    check_id: z.string(),
    rule_ref: z.string(),
    snapshot_id: z.string(),
    index: navigationIndexIdentitySchema,
    next_page: z.number().int().nonnegative().safe(),
    next_entry: z.number().int().nonnegative().safe(),
    verified_count: z.number().int().nonnegative().safe(),
    target_evidence_refs: z.array(z.string().min(1))
  }).nullable().optional().default(null),
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
  verified_entries?: { resource_id: string; entry_hash: string; persisted: boolean }[];
  gaps: { resource_id: string; code: string }[];
}

function catalogRebuildShardMatchesSourceIds(sourceIds: readonly string[], shard: number, entries: readonly NavigationInventoryEntry[]): boolean {
  const expectedIds = sourceIds.filter((resourceId) => zoneNavigationCatalogShardForResource(resourceId) === shard);
  const actualIds = entries.map((entry) => entry.resource_id);
  const actualIdSet = new Set(actualIds);
  return new Set(expectedIds).size === expectedIds.length
    && actualIdSet.size === actualIds.length
    && expectedIds.length === actualIds.length
    && expectedIds.every((resourceId) => actualIdSet.has(resourceId));
}

export function zoneNavigationHeadPath(projectId: string, zone: NavigationZone): string {
  return `${machineDocumentRoot(projectId)}/navigation/${zone}/head.json`;
}

export class ZoneNavigationEngine {
  constructor(
    private readonly runtime: ProjectOsPersistenceRuntime,
    private readonly inventory: NavigationInventoryPort,
    private readonly postchecks?: NavigationPostcheckPort,
    private readonly postcheckRules: readonly RuleVersion[] = []
  ) {}

  async prepareCompactCatalogRebuild(
    rawRequest: NavigationCatalogRebuildRequest,
    state: ProjectState,
    admission: ExecutionAdmission,
    budget: SliceBudget
  ): Promise<{ status: "pending"; cursor: string | null } | { status: "prepared"; source_snapshot_id: string; source_count: number; shard_count: number } | { status: "conflict"; code: string }> {
    let request: NavigationCatalogRebuildRequest;
    try { request = navigationReconcileSchema.parse(rawRequest) as NavigationCatalogRebuildRequest; }
    catch { return { status: "conflict", code: "navigation_catalog_rebuild_request_invalid" }; }
    if (request.purpose !== "compact_catalog_rebuild" || request.expected_index !== null || !request.expected_catalog_manifest) return { status: "conflict", code: "navigation_catalog_rebuild_request_invalid" };
    const sourceGeneration = request.expected_source_generation;
    const requestHash = await executionHash(request);
    const journal = new ExecutionJournal(this.runtime, request.project_id, "document", request.request_id);
    const root = await journal.root();
    const progressPath = `${root}/navigation-catalog-rebuild-progress.json`;
    const pagesRoot = `${root}/navigation/catalog-rebuild/snapshot`;
    const sources = new ZoneNavigationSources(this.runtime);
    try {
      this.assertCatalogRebuildAdmission(request, state, admission, requestHash);
      let progress = navigationCatalogRebuildProgressSchema.safeParse(await this.readJson(progressPath, budget));
      let current = progress.success ? progress.data : null;
      if (current && (current.request_hash !== requestHash || current.project_id !== request.project_id || current.request_id !== request.request_id || current.zone !== request.zone || current.source_generation !== sourceGeneration)) {
        return { status: "conflict", code: "navigation_catalog_rebuild_request_conflict" };
      }
      if (!current) {
        const snapshot = await sources.beginCompactCatalogRebuild({
          project_id: request.project_id, zone: request.zone, request_id: request.request_id,
          expected_generation: sourceGeneration, expected_manifest: request.expected_catalog_manifest
        }, budget);
        current = navigationCatalogRebuildProgressSchema.parse({
          schema_version: "1.0", purpose: "compact_catalog_rebuild", project_id: request.project_id, request_id: request.request_id,
          request_hash: requestHash, zone: request.zone, source_generation: sourceGeneration,
          source_snapshot_id: snapshot.snapshot_id, cursor: null, page_count: 0, source_count: 0,
          shard_cursor: 0, shard_count: 0, verify_page: 0, verify_entry: 0, verify_cursor: null,
          stage_page: 0, staging_entries: [], staging_index_page: 0, staging_page_index: [], staging_index_complete: false,
          staged_shards: [], invalidated_manifest: null, chunk_evidence: [],
          status: "scanning", finalization_ref: null, coverage_gaps: []
        });
        await this.saveCatalogRebuildProgress(progressPath, current, null, budget);
      }
      if (current.status === "prepared" || current.status === "publishing" || current.status === "finalized") {
        return { status: "prepared", source_snapshot_id: current.source_snapshot_id!, source_count: current.source_count, shard_count: current.shard_count };
      }
      if (current.status === "conflict") return { status: "conflict", code: current.coverage_gaps[0]?.code ?? "navigation_catalog_rebuild_conflict" };

      while (current.status === "scanning") {
        if (!budget.canStartEffect(5)) return { status: "pending", cursor: current.cursor };
        const page = await this.inventory.listPage({ project_id: request.project_id, zone: request.zone, cursor: current.cursor, limit: PAGE_LIMIT, mode: "canonical_catalog_rebuild", budget });
        if (page.snapshot_id !== current.source_snapshot_id) return await this.catalogRebuildConflict(progressPath, current, "navigation_catalog_rebuild_snapshot_changed", budget);
        const entries = page.entries.map((entry) => navigationInventoryEntrySchema.parse(entry));
        const gaps = page.gaps.map((gap) => navigationCoverageGapSchema.parse(gap));
        if (gaps.length) {
          current.coverage_gaps.push(...gaps);
          current.status = "conflict";
          await this.saveCatalogRebuildProgress(progressPath, current, await this.token(progressPath, budget), budget);
          return { status: "conflict", code: gaps[0].code };
        }
        for (const entry of entries) this.assertEntry(entry, state, request.zone);
        const seen = new Set(current.source_ids ?? []);
        if (entries.some((entry) => seen.has(entry.resource_id)) || new Set(entries.map((entry) => entry.resource_id)).size !== entries.length) return await this.catalogRebuildConflict(progressPath, current, "navigation_catalog_rebuild_duplicate_source", budget);
        const pageRecord: SnapshotPage = { schema_version: "1.0", page: current.page_count, project_id: request.project_id, request_id: request.request_id, snapshot_id: page.snapshot_id, entries, verified_entries: page.verified_entries, gaps: [] };
        await this.immutableSnapshotPage(`${pagesRoot}/${current.page_count.toString().padStart(8, "0")}.json`, pageRecord, budget);
        current.cursor = page.next_cursor;
        current.page_count += 1;
        current.source_count += entries.length;
        current.source_ids = [...(current.source_ids ?? []), ...entries.map((entry) => entry.resource_id)];
        if (page.next_cursor === null) current.status = "verifying";
        current = await this.saveCatalogRebuildProgress(progressPath, current, await this.token(progressPath, budget), budget);
      }

      while (current.status === "verifying" && current.verify_page < current.page_count) {
        const pagePath = `${pagesRoot}/${current.verify_page.toString().padStart(8, "0")}.json`;
        const page = await this.readJson(pagePath, budget) as SnapshotPage | null;
        if (!page || page.snapshot_id !== current.source_snapshot_id) return await this.catalogRebuildConflict(progressPath, current, "navigation_catalog_rebuild_snapshot_page_invalid", budget);
        // Independent managed heads have no shared effects. Verify two exact
        // physical sources concurrently, then durably advance the cursor only
        // after both immutable proofs exist. A torn pair is safe to recheck.
        if (current.verify_entry === 0 && current.verify_cursor === null && page.entries.length === 1 && page.entries[0].resource_id.startsWith("head:")
          && current.verify_page + 1 < current.page_count && budget.canStartEffect(18)) {
          const nextPageNumber = current.verify_page + 1;
          const nextPage = await this.readJson(`${pagesRoot}/${nextPageNumber.toString().padStart(8, "0")}.json`, budget) as SnapshotPage | null;
          if (!nextPage || nextPage.snapshot_id !== current.source_snapshot_id) return await this.catalogRebuildConflict(progressPath, current, "navigation_catalog_rebuild_snapshot_page_invalid", budget);
          if (nextPage.entries.length === 1 && nextPage.entries[0].resource_id.startsWith("head:")) {
            const first = page.entries[0];
            const second = nextPage.entries[0];
            const firstPageNumber = current.verify_page;
            const snapshotId = current.source_snapshot_id;
            // Reserve enough provider calls and time to persist a fallback
            // cursor if two expensive physical checks cannot fit this slice.
            const pairBudget: SliceBudget = {
              get deadline_ms() { return budget.deadline_ms - 8_000; },
              get calls_left() { return Math.max(0, budget.calls_left - 4); },
              now: budget.now,
              signal: budget.signal,
              beforeHttp() {
                if (budget.calls_left <= 4 || budget.now() >= budget.deadline_ms - 8_000) throw new Error("slice_budget_exhausted");
                budget.beforeHttp();
              },
              canStartEffect(required) {
                return budget.calls_left >= required + 4 && budget.now() < budget.deadline_ms - 8_000 && !budget.signal.aborted;
              }
            };
            const verified = await Promise.allSettled([
              this.inventory.verifyEntry(first, pairBudget), this.inventory.verifyEntry(second, pairBudget)
            ]);
            const verificationError = verified.find((item) => item.status === "rejected");
            if (verificationError?.status === "rejected") {
              if (!isBudgetExhausted(verificationError.reason)) throw verificationError.reason;
              current.verify_cursor = "single-head";
              current = await this.saveCatalogRebuildProgress(progressPath, current, await this.token(progressPath, budget), budget);
              return { status: "pending", cursor: `verify:${current.verify_page}:0` };
            }
            if (verified.some((item) => item.status === "fulfilled" && !item.value)) return await this.catalogRebuildConflict(progressPath, current, "navigation_catalog_rebuild_physical_source_unverified", budget);
            const proofs = await Promise.allSettled([first, second].map((entry, index) => this.immutable(
              `${root}/navigation/catalog-rebuild/verified/${(firstPageNumber + index).toString().padStart(8, "0")}-00000000.json`,
              { schema_version: "1.0", project_id: request.project_id, request_id: request.request_id, snapshot_id: snapshotId, entry }, pairBudget
            )));
            const proofError = proofs.find((item) => item.status === "rejected");
            if (proofError?.status === "rejected") {
              if (!isBudgetExhausted(proofError.reason)) throw proofError.reason;
              current.verify_cursor = "single-head";
              current = await this.saveCatalogRebuildProgress(progressPath, current, await this.token(progressPath, budget), budget);
              return { status: "pending", cursor: `verify:${current.verify_page}:0` };
            }
            current.verify_page += 2;
            current = await this.saveCatalogRebuildProgress(progressPath, current, await this.token(progressPath, budget), budget);
            continue;
          }
        }
        while (current.verify_entry < page.entries.length) {
          if (!budget.canStartEffect(12)) return { status: "pending", cursor: `verify:${current.verify_page}:${current.verify_entry}` };
          const entry = page.entries[current.verify_entry];
          const verification = this.inventory.verifyEntryPage
            ? await this.inventory.verifyEntryPage(entry, current.verify_cursor, budget)
            : (await this.inventory.verifyEntry(entry, budget) ? { status: "verified" as const } : { status: "conflict" as const });
          if (verification.status === "conflict") return await this.catalogRebuildConflict(progressPath, current, "navigation_catalog_rebuild_physical_source_unverified", budget);
          if (verification.status === "pending") {
            current.verify_cursor = verification.cursor;
            current = await this.saveCatalogRebuildProgress(progressPath, current, await this.token(progressPath, budget), budget);
            return { status: "pending", cursor: `verify:${current.verify_page}:${current.verify_entry}` };
          }
          current.verify_cursor = null;
          const evidence = { schema_version: "1.0", project_id: request.project_id, request_id: request.request_id, snapshot_id: current.source_snapshot_id, entry };
          await this.immutable(`${root}/navigation/catalog-rebuild/verified/${current.verify_page.toString().padStart(8, "0")}-${current.verify_entry.toString().padStart(8, "0")}.json`, evidence, budget);
          current.verify_entry += 1;
          current = await this.saveCatalogRebuildProgress(progressPath, current, await this.token(progressPath, budget), budget);
        }
        current.verify_page += 1;
        current.verify_entry = 0;
        current = await this.saveCatalogRebuildProgress(progressPath, current, await this.token(progressPath, budget), budget);
      }
      if (current.status === "verifying") {
        if (!await this.inventory.verifySnapshot({ project_id: request.project_id, zone: request.zone, snapshot_id: current.source_snapshot_id!, budget })) return await this.catalogRebuildConflict(progressPath, current, "navigation_catalog_rebuild_snapshot_changed", budget);
        current.status = "staging";
        current.stage_page = 0;
        current.staging_entries = [];
        current.shard_cursor = 0;
        current.staged_shards = [];
        current = await this.saveCatalogRebuildProgress(progressPath, current, await this.token(progressPath, budget), budget);
      }

      const shards = [...new Set((current.source_ids ?? []).map(zoneNavigationCatalogShardForResource))].sort((left, right) => left - right);
      current.shard_count = shards.length;
      // Older progress files have no staging index. If one was partway through
      // a shard, finish that exact legacy cursor first; its accumulated entries
      // and page cursor remain authoritative until the shard is written.
      if (!current.staging_index_complete && current.staging_index_page === null
        && (current.stage_page > 0 || current.staging_entries.length > 0)
        && current.shard_cursor < shards.length) {
        const shard = shards[current.shard_cursor];
        while (current.stage_page < current.page_count) {
          if (!budget.canStartEffect(3)) return { status: "pending", cursor: `stage:${current.shard_cursor}:${current.stage_page}` };
          const page = await this.readJson(`${pagesRoot}/${current.stage_page.toString().padStart(8, "0")}.json`, budget) as SnapshotPage | null;
          if (!page || page.snapshot_id !== current.source_snapshot_id) return await this.catalogRebuildConflict(progressPath, current, "navigation_catalog_rebuild_snapshot_page_invalid", budget);
          current.staging_entries.push(...page.entries.filter((entry) => zoneNavigationCatalogShardForResource(entry.resource_id) === shard));
          if (current.staging_entries.length > 256) return await this.catalogRebuildConflict(progressPath, current, "navigation_compact_catalog_chunk_full", budget);
          current.stage_page += 1;
          current = await this.saveCatalogRebuildProgress(progressPath, current, await this.token(progressPath, budget), budget);
        }
        if (!catalogRebuildShardMatchesSourceIds(current.source_ids ?? [], shard, current.staging_entries)) {
          return await this.catalogRebuildConflict(progressPath, current, "navigation_catalog_rebuild_staging_source_set_mismatch", budget);
        }
        if (current.staging_entries.length) await sources.stageCompactCatalogRebuildShard({ project_id: request.project_id, zone: request.zone, request_id: request.request_id, snapshot_id: current.source_snapshot_id!, shard, entries: current.staging_entries }, budget);
        current.staged_shards.push(shard);
        current.shard_cursor += 1;
        current.stage_page = 0;
        current.staging_entries = [];
        current.staging_index_page = 0;
        current = await this.saveCatalogRebuildProgress(progressPath, current, await this.token(progressPath, budget), budget);
      }

      if (!current.staging_index_complete) {
        let indexPage = current.staging_index_page ?? 0;
        current.staging_index_page = indexPage;
        while (indexPage < current.page_count) {
          if (!budget.canStartEffect(3)) return { status: "pending", cursor: `stage-index:${indexPage}` };
          const pageNumber = indexPage;
          const page = await this.readJson(`${pagesRoot}/${pageNumber.toString().padStart(8, "0")}.json`, budget) as SnapshotPage | null;
          if (!page || page.snapshot_id !== current.source_snapshot_id) return await this.catalogRebuildConflict(progressPath, current, "navigation_catalog_rebuild_snapshot_page_invalid", budget);
          const pageShards = [...new Set(page.entries.map((entry) => zoneNavigationCatalogShardForResource(entry.resource_id)))].sort((left, right) => left - right);
          for (const shard of pageShards) {
            let indexed = current.staging_page_index.find((item) => item.shard === shard);
            if (!indexed) {
              indexed = { shard, pages: [] };
              current.staging_page_index.push(indexed);
              current.staging_page_index.sort((left, right) => left.shard - right.shard);
            }
            indexed.pages.push(pageNumber);
          }
          indexPage = pageNumber + 1;
          current.staging_index_page = indexPage;
          current = await this.saveCatalogRebuildProgress(progressPath, current, await this.token(progressPath, budget), budget);
        }
        current.staging_index_page = null;
        current.staging_index_complete = true;
        current = await this.saveCatalogRebuildProgress(progressPath, current, await this.token(progressPath, budget), budget);
      }

      while (current.status === "staging" && current.shard_cursor < shards.length) {
        const shard = shards[current.shard_cursor];
        const indexedPages = current.staging_page_index.find((item) => item.shard === shard)?.pages;
        if (!indexedPages?.length) return await this.catalogRebuildConflict(progressPath, current, "navigation_catalog_rebuild_staging_index_invalid", budget);
        while (current.stage_page < indexedPages.length) {
          if (!budget.canStartEffect(3)) return { status: "pending", cursor: `stage:${current.shard_cursor}:${current.stage_page}` };
          const pageNumber = indexedPages[current.stage_page];
          const page = await this.readJson(`${pagesRoot}/${pageNumber.toString().padStart(8, "0")}.json`, budget) as SnapshotPage | null;
          if (!page || page.snapshot_id !== current.source_snapshot_id) return await this.catalogRebuildConflict(progressPath, current, "navigation_catalog_rebuild_snapshot_page_invalid", budget);
          current.staging_entries.push(...page.entries.filter((entry) => zoneNavigationCatalogShardForResource(entry.resource_id) === shard));
          if (current.staging_entries.length > 256) return await this.catalogRebuildConflict(progressPath, current, "navigation_compact_catalog_chunk_full", budget);
          current.stage_page += 1;
          current = await this.saveCatalogRebuildProgress(progressPath, current, await this.token(progressPath, budget), budget);
        }
        if (!catalogRebuildShardMatchesSourceIds(current.source_ids ?? [], shard, current.staging_entries)) {
          return await this.catalogRebuildConflict(progressPath, current, "navigation_catalog_rebuild_staging_source_set_mismatch", budget);
        }
        if (current.staging_entries.length) await sources.stageCompactCatalogRebuildShard({ project_id: request.project_id, zone: request.zone, request_id: request.request_id, snapshot_id: current.source_snapshot_id!, shard, entries: current.staging_entries }, budget);
        current.staged_shards.push(shard);
        current.shard_cursor += 1;
        current.stage_page = 0;
        current.staging_entries = [];
        current = await this.saveCatalogRebuildProgress(progressPath, current, await this.token(progressPath, budget), budget);
      }
      if (current.status === "staging") {
        if (!await this.inventory.verifySnapshot({ project_id: request.project_id, zone: request.zone, snapshot_id: current.source_snapshot_id!, budget })) return await this.catalogRebuildConflict(progressPath, current, "navigation_catalog_rebuild_snapshot_changed", budget);
        const manifest = await sources.compactCatalogManifestIdentity(request.project_id, request.zone, budget);
        if (!manifest || canonicalJson(manifest) !== canonicalJson(request.expected_catalog_manifest)) return await this.catalogRebuildConflict(progressPath, current, "navigation_catalog_rebuild_manifest_conflict", budget);
        current.status = "prepared";
        current = await this.saveCatalogRebuildProgress(progressPath, current, await this.token(progressPath, budget), budget);
      }
      return current.status === "prepared"
        ? { status: "prepared", source_snapshot_id: current.source_snapshot_id!, source_count: current.source_count, shard_count: current.shard_count }
        : { status: "pending", cursor: current.cursor };
    } catch (error) {
      if (isBudgetExhausted(error)) return { status: "pending", cursor: null };
      if (error instanceof NavigationConflict) return { status: "conflict", code: error.code };
      if (error instanceof ProviderConflictError || error instanceof ProviderPreconditionFailedError) return { status: "conflict", code: "navigation_catalog_rebuild_provider_conflict" };
      throw error;
    }
  }

  async publishPreparedCompactCatalogRebuild(
    rawRequest: NavigationCatalogRebuildRequest,
    state: ProjectState,
    admission: ExecutionAdmission,
    snapshotId: string,
    budget: SliceBudget
  ): Promise<{ status: "pending"; cursor: string | null } | { status: "conflict"; code: string } | { status: "finalized"; certificate: NavigationCatalogRebuildCertificate }> {
    let request: NavigationCatalogRebuildRequest;
    try { request = navigationReconcileSchema.parse(rawRequest) as NavigationCatalogRebuildRequest; }
    catch { return { status: "conflict", code: "navigation_catalog_rebuild_request_invalid" }; }
    const requestHash = await executionHash(request);
    const journal = new ExecutionJournal(this.runtime, request.project_id, "document", request.request_id);
    const root = await journal.root();
    const progressPath = `${root}/navigation-catalog-rebuild-progress.json`;
    const certificatePath = `${root}/navigation/catalog-rebuild/finalizations/${requestHash}.json`;
    const sources = new ZoneNavigationSources(this.runtime);
    try {
      this.assertCatalogRebuildAdmission(request, state, admission, requestHash);
      const parsed = navigationCatalogRebuildProgressSchema.safeParse(await this.readJson(progressPath, budget));
      if (!parsed.success) {
        const held = await this.abandonOrHoldUnboundCatalogRebuild(sources, request, budget);
        if (held) return held;
        const release = await this.releaseCatalogRebuildFenceBeforeConflict(sources, request, budget);
        return release ?? { status: "conflict", code: "navigation_catalog_rebuild_progress_missing" };
      }
      let progress = parsed.data;
      if (progress.request_hash !== requestHash || progress.source_generation !== request.expected_source_generation
        || progress.source_snapshot_id !== snapshotId || progress.status === "scanning" || progress.status === "verifying" || progress.status === "staging") {
        const held = await this.abandonOrHoldUnboundCatalogRebuild(sources, request, budget);
        if (held) return held;
        return { status: "conflict", code: "navigation_catalog_rebuild_not_prepared" };
      }
      if (progress.coverage_gaps.length) {
        const release = await this.releaseCatalogRebuildFenceBeforeConflict(sources, request, budget);
        return release ?? { status: "conflict", code: progress.coverage_gaps[0].code };
      }
      if (progress.status === "conflict") {
        if (progress.invalidated_manifest) {
          const abandoned = await sources.abandonFailedCompactCatalogRebuild({
            project_id: request.project_id, zone: request.zone, request_id: request.request_id,
            expected_unready_manifest: progress.invalidated_manifest
          }, budget);
          if (abandoned.status === "pending") return { status: "pending", cursor: "abandon-rebuild" };
        }
        return { status: "conflict", code: "navigation_catalog_rebuild_conflict" };
      }
      if (progress.status === "finalized") {
        const cert = navigationCatalogRebuildCertificateSchema.safeParse(await this.readJson(certificatePath, budget));
        if (cert.success && progress.finalization_ref === certificatePath) {
          if (!await sources.releaseCompactCatalogRebuildFence(request.project_id, request.zone, request.request_id, budget)) {
            return { status: "pending", cursor: "release-fence" };
          }
          return { status: "finalized", certificate: cert.data };
        }
        return { status: "pending", cursor: "certificate-recovery" };
      }
      const shards = progress.staged_shards;
      if (shards.length !== progress.shard_count || shards.some((shard, i) => i > 0 && shards[i - 1] >= shard)) {
        return await this.catalogRebuildConflict(progressPath, progress, "navigation_catalog_rebuild_staging_incomplete", budget);
      }
      const publication = {
        project_id: request.project_id, zone: request.zone, request_id: request.request_id,
        expected_generation: request.expected_source_generation, expected_manifest: request.expected_catalog_manifest,
        snapshot_id: snapshotId, shards
      };
      if (progress.status === "prepared") {
        const invalidated = await sources.invalidateCompactCatalogRebuild(publication, budget);
        progress.invalidated_manifest = invalidated;
        progress.status = "publishing";
        progress.publish_cursor = 0;
        progress.verify_shard_cursor = 0;
        progress.post_publish_verify_cursor = 0;
        progress.chunk_evidence = [];
        progress = await this.saveCatalogRebuildProgress(progressPath, progress, await this.token(progressPath, budget), budget);
        return { status: "pending", cursor: "publish:0" };
      }
      if (!progress.invalidated_manifest) return await this.catalogRebuildConflict(progressPath, progress, "navigation_catalog_rebuild_manifest_invalidation_missing", budget);
      const invalidatedManifest = progress.invalidated_manifest;
      if (progress.post_publish_failure_count >= 6) {
        const abandoned = await sources.abandonFailedCompactCatalogRebuild({
          project_id: request.project_id, zone: request.zone, request_id: request.request_id,
          expected_unready_manifest: progress.invalidated_manifest
        }, budget);
        return abandoned.status === "pending"
          ? { status: "pending", cursor: "abandon-rebuild" }
          : { status: "conflict", code: "navigation_catalog_rebuild_integrity_failure_limit" };
      }
      // Recover an interruption after withdrawing a failed published manifest
      // but before the reset cursor was durably recorded.
      if (progress.publish_cursor >= shards.length) {
        const manifest = await sources.compactCatalogManifest(request.project_id, request.zone, budget);
        const identity = await sources.compactCatalogManifestIdentity(request.project_id, request.zone, budget);
        if (manifest?.ready_generation === null && manifest.rebuilding_request_id === request.request_id
          && identity && canonicalJson(identity) !== canonicalJson(progress.invalidated_manifest)) {
          progress.invalidated_manifest = identity;
          progress.publish_cursor = 0;
          progress.verify_shard_cursor = 0;
          progress.post_publish_verify_cursor = 0;
          progress.chunk_evidence = [];
          progress.post_publish_failure_count += 1;
          progress = await this.saveCatalogRebuildProgress(progressPath, progress, await this.token(progressPath, budget), budget);
          return { status: "pending", cursor: "republish:0" };
        }
      }
      while (progress.publish_cursor < shards.length) {
        if (!budget.canStartEffect(14)) return { status: "pending", cursor: `publish:${progress.publish_cursor}` };
        const shard = shards[progress.publish_cursor];
        const evidence = await sources.publishCompactCatalogRebuildShard({ ...publication, invalidated_manifest: invalidatedManifest, shard }, budget);
        progress.chunk_evidence = [...progress.chunk_evidence.filter((item) => item.shard !== shard), evidence].sort((a, b) => a.shard - b.shard);
        progress.publish_cursor += 1;
        progress = await this.saveCatalogRebuildProgress(progressPath, progress, await this.token(progressPath, budget), budget);
      }
      while (progress.verify_shard_cursor < shards.length) {
        // Two shards have independent, read-only physical proofs. Verify them
        // together, then checkpoint the pair; an interrupted pair is safe to
        // reread because neither verification publishes an effect.
        if (progress.verify_shard_cursor + 1 < shards.length && budget.canStartEffect(18)) {
          const pair = shards.slice(progress.verify_shard_cursor, progress.verify_shard_cursor + 2);
          const evidence = pair.map((shard) => progress.chunk_evidence.find((item) => item.shard === shard));
          if (evidence.some((item) => !item)) return await this.catalogRebuildConflict(progressPath, progress, "navigation_catalog_rebuild_chunk_evidence_missing", budget);
          const verified = await Promise.allSettled(pair.map((shard, index) => sources.verifyCompactCatalogRebuildShard({
            ...publication, invalidated_manifest: invalidatedManifest, shard, evidence: evidence[index]!
          }, budget)));
          const failed = verified.find((item) => item.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
          progress.verify_shard_cursor += 2;
          progress = await this.saveCatalogRebuildProgress(progressPath, progress, await this.token(progressPath, budget), budget);
          continue;
        }
        if (!budget.canStartEffect(12)) return { status: "pending", cursor: `verify-shard:${progress.verify_shard_cursor}` };
        const shard = shards[progress.verify_shard_cursor];
        const evidence = progress.chunk_evidence.find((item) => item.shard === shard);
        if (!evidence) return await this.catalogRebuildConflict(progressPath, progress, "navigation_catalog_rebuild_chunk_evidence_missing", budget);
        await sources.verifyCompactCatalogRebuildShard({ ...publication, invalidated_manifest: invalidatedManifest, shard, evidence }, budget);
        progress.verify_shard_cursor += 1;
        progress = await this.saveCatalogRebuildProgress(progressPath, progress, await this.token(progressPath, budget), budget);
      }
      if (progress.chunk_evidence.length !== shards.length || progress.coverage_gaps.length) {
        return await this.catalogRebuildConflict(progressPath, progress, "navigation_catalog_rebuild_chunk_evidence_incomplete", budget);
      }
      const published = await sources.publishCompactCatalogRebuildManifest({ ...publication, invalidated_manifest: invalidatedManifest, chunk_evidence: progress.chunk_evidence }, budget);
      while (progress.post_publish_verify_cursor < shards.length) {
        if (!budget.canStartEffect(14)) return { status: "pending", cursor: `post-publish-verify:${progress.post_publish_verify_cursor}` };
        const shard = shards[progress.post_publish_verify_cursor];
        const evidence = progress.chunk_evidence.find((item) => item.shard === shard);
        if (!evidence) return await this.catalogRebuildConflict(progressPath, progress, "navigation_catalog_rebuild_chunk_evidence_missing", budget);
        try {
          await sources.verifyPublishedCompactCatalogRebuildShard({ ...publication, invalidated_manifest: invalidatedManifest, shard, evidence }, budget);
        } catch (error) {
          if (isBudgetExhausted(error)) throw error;
          const withdrawn = await sources.invalidateFailedPublishedCompactCatalogRebuild({
            project_id: request.project_id, zone: request.zone, request_id: request.request_id,
            expected_final_manifest: published.identity
          }, budget);
          if (withdrawn.status === "pending") return { status: "pending", cursor: "withdraw-published-manifest" };
          progress.invalidated_manifest = withdrawn.identity;
          progress.publish_cursor = 0;
          progress.verify_shard_cursor = 0;
          progress.post_publish_verify_cursor = 0;
          progress.chunk_evidence = [];
          progress.post_publish_failure_count += 1;
          progress = await this.saveCatalogRebuildProgress(progressPath, progress, await this.token(progressPath, budget), budget);
          if (progress.post_publish_failure_count >= 6) {
            const abandoned = await sources.abandonFailedCompactCatalogRebuild({
              project_id: request.project_id, zone: request.zone, request_id: request.request_id,
              expected_unready_manifest: withdrawn.identity
            }, budget);
            return abandoned.status === "pending"
              ? { status: "pending", cursor: "abandon-rebuild" }
              : { status: "conflict", code: "navigation_catalog_rebuild_integrity_failure_limit" };
          }
          return { status: "pending", cursor: "republish:0" };
        }
        progress.post_publish_verify_cursor += 1;
        progress = await this.saveCatalogRebuildProgress(progressPath, progress, await this.token(progressPath, budget), budget);
      }
      const certificate = navigationCatalogRebuildCertificateSchema.parse({
        schema_version: "1.0", purpose: "compact_catalog_rebuild", project_id: request.project_id,
        request_id: request.request_id, request_hash: requestHash, zone: request.zone,
        source_generation: request.expected_source_generation, source_snapshot_id: snapshotId,
        source_count: progress.source_count, shards, expected_manifest: request.expected_catalog_manifest,
        published_manifest: published.identity, chunk_evidence: published.chunk_evidence, coverage_gaps: []
      });
      await this.immutable(certificatePath, certificate, budget);
      progress.status = "finalized";
      progress.finalization_ref = certificatePath;
      progress = await this.saveCatalogRebuildProgress(progressPath, progress, await this.token(progressPath, budget), budget);
      if (!await sources.releaseCompactCatalogRebuildFence(request.project_id, request.zone, request.request_id, budget)) {
        return { status: "pending", cursor: "release-fence" };
      }
      return { status: "finalized", certificate };
    } catch (error) {
      if (isBudgetExhausted(error)) return { status: "pending", cursor: null };
      const message = error instanceof Error ? error.message : "navigation_catalog_rebuild_failed";
      if (message === "navigation_catalog_rebuild_writer_fence_conflict") return { status: "pending", cursor: "writer-fence" };
      const held = await this.abandonOrHoldUnboundCatalogRebuild(sources, request, budget);
      if (held) return held;
      const release = await this.releaseCatalogRebuildFenceBeforeConflict(sources, request, budget);
      if (release) return release;
      if (error instanceof NavigationConflict) return { status: "conflict", code: error.code };
      if (error instanceof ProviderConflictError || error instanceof ProviderPreconditionFailedError) return { status: "conflict", code: "navigation_catalog_rebuild_provider_conflict" };
      if (message.startsWith("navigation_catalog_rebuild_")) return { status: "conflict", code: message };
      throw error;
    }
  }

  async reconcile(
    rawRequest: NavigationReconcileRequest,
    state: ProjectState,
    admission: ExecutionAdmission,
    budget: SliceBudget,
    options: { deferPublication?: boolean } = {}
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
      this.assertAdmission(request, state, admission, requestHash, indexPath, !options.deferPublication);
      const intent = await this.prepare(request, state, requestHash, indexPath, headPath, intentPath, progressPath, budget);
      if (intent.status === "conflict") return intent;
      let progress = intent.progress;
      if (progress.status === "publishing" && !options.deferPublication && progress.snapshot_id) {
        return this.publishPrepared(request, state, admission, budget, progress.snapshot_id);
      }
      if (progress.status === "adopting" && !progress.inventory_complete
        && progress.source_count === 0 && progress.source_ids.length === 0
        && progress.rendered_links.length === 0 && progress.verify_entry === 0
        && progress.verify_page < progress.page_count) {
        if (!budget.canStartEffect(2)) return { status: "pending", cursor: progress.cursor };
        progress.verify_page = progress.page_count;
        progress = await this.saveProgress(progressPath, progress, await this.token(progressPath, budget), budget);
      }
      const done = await this.resumeInventory(request, state, progress, progressPath, pagesRoot, budget);
      if (done.status === "pending" || done.status === "conflict") return done;
      progress = done.progress;
      if (progress.status === "finalized" && progress.receipt) {
        return { status: "finalized", receipt: zoneNavigationReceiptSchema.parse(progress.receipt) };
      }

      const verified = await this.verifyEntries(request, state, progress, progressPath, pagesRoot, verifiedRoot, budget);
      if (verified.status === "pending" || verified.status === "conflict") return verified;
      progress = verified.progress;
      if (this.inventory.completeSnapshot) {
        const completion = await this.inventory.completeSnapshot({ project_id: request.project_id, zone: request.zone, snapshot_id: progress.snapshot_id!, budget });
        if (completion === "pending") return { status: "pending", cursor: progress.cursor };
        if (typeof completion === "object") return completion;
        if (!completion) return { status: "conflict", code: "navigation_snapshot_changed" };
      }

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
      if (options.deferPublication) return { status: "prepared", source_snapshot_id: progress.snapshot_id! };

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
      const checks = await this.runPostchecks(request, state, admission, progress, progressPath, pagesRoot, budget);
      if (checks.status !== "ok") return checks;

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
      if (error instanceof Error && error.message === "navigation_listing_stalled") return { status: "conflict", code: "navigation_listing_stalled" };
      if (error instanceof ProviderPreconditionFailedError || error instanceof ProviderConflictError) return { status: "conflict", code: "navigation_provider_conflict" };
      if (error instanceof NavigationConflict) return { status: "conflict", code: error.code };
      throw error;
    }
  }

  /** Publish only a generation already prepared by the navigation worker. The
   * PG boundary uses this method while serialized; a forged/early workref must
   * never make PG perform an unbounded inventory scan. */
  async publishPrepared(
    rawRequest: NavigationReconcileRequest,
    state: ProjectState,
    admission: ExecutionAdmission,
    budget: SliceBudget,
    expectedSnapshotId: string
  ): Promise<ZoneNavigationResult> {
    const request = navigationReconcileSchema.parse(rawRequest);
    const requestHash = await executionHash(request);
    const root = await new ExecutionJournal(this.runtime, request.project_id, "document", request.request_id).root();
    const path = `${root}/navigation-progress.json`;
    const indexPath = this.indexPath(state, request.zone, request.expected_index?.basename ?? "00-CURRENT.md");
    const generatedPath = `${root}/navigation/generated-index.md`;
    const headPath = zoneNavigationHeadPath(request.project_id, request.zone);
    try {
      this.assertAdmission(request, state, admission, requestHash, indexPath);
      budget.beforeHttp();
      const raw = await this.runtime.objects.readText(path);
      if (raw === null) return { status: "conflict", code: "navigation_preparation_unavailable" };
      let progress = navigationProgressSchema.parse(JSON.parse(raw));
      if (progress.project_id !== request.project_id || progress.request_id !== request.request_id
        || progress.request_hash !== requestHash || !progress.inventory_complete
        || progress.verify_page < progress.page_count || progress.snapshot_id !== expectedSnapshotId
        || !progress.generated_sha256 || canonicalJson(progress) !== raw) {
        return { status: "conflict", code: "navigation_preparation_binding_mismatch" };
      }
      if (progress.status === "finalized" && progress.receipt) {
        const receipt = zoneNavigationReceiptSchema.parse(progress.receipt);
        if (receipt.project_id === request.project_id && receipt.request_id === request.request_id
          && receipt.zone === request.zone && receipt.source_snapshot_id === expectedSnapshotId) {
          return { status: "finalized", receipt };
        }
        return { status: "conflict", code: "navigation_preparation_binding_mismatch" };
      }
      if (progress.status !== "publishing") return { status: "conflict", code: "navigation_preparation_binding_mismatch" };

      // Publication resumes from the durable, already verified cursor. Calling
      // reconcile here would re-enter inventory and per-entry verification on
      // every PG callback, starving the bounded head publication forever.
      if (!await this.inventory.verifySnapshot({ project_id: request.project_id, zone: request.zone, snapshot_id: expectedSnapshotId, budget })) {
        return { status: "conflict", code: "navigation_snapshot_changed" };
      }
      const generated = await this.readText(generatedPath, budget);
      if (generated === null || await sha256Text(generated) !== progress.generated_sha256
        || generated !== this.render(request.zone, progress.rendered_links, progress.coverage_gaps)) {
        return { status: "conflict", code: "navigation_generated_input_changed" };
      }
      const sourcePath = this.indexPath(state, request.zone, progress.index_basename);
      const archive = await this.archiveSource(request, state, progress, sourcePath, budget);
      if (archive.status === "conflict") return archive;
      if (progress.legacy_archive_ref !== archive.ref) {
        progress.legacy_archive_ref = archive.ref;
        progress = await this.saveProgress(path, progress, await this.token(path, budget), budget);
      }

      let index: NavigationIndexIdentity;
      if (progress.published_index) {
        const observed = await this.observeIndex(sourcePath, budget);
        if (!observed || !sameIndexIdentity(observed.identity, progress.published_index) || observed.content !== generated) {
          return { status: "conflict", code: "navigation_index_changed" };
        }
        index = observed.identity;
      } else {
        const write = await this.publishIndex(sourcePath, generated, progress.expected_index, budget);
        if (write.status === "conflict") return write;
        index = write.identity;
        progress.published_index = index;
        progress = await this.saveProgress(path, progress, await this.token(path, budget), budget);
      }
      const checks = await this.runPostchecks(request, state, admission, progress, path, `${root}/navigation/snapshot`, budget);
      if (checks.status !== "ok") return checks;

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
      if (!await this.inventory.verifySnapshot({ project_id: request.project_id, zone: request.zone, snapshot_id: expectedSnapshotId, budget })) {
        return { status: "conflict", code: "navigation_snapshot_changed" };
      }
      const head = await this.publishHead(request, progress, index, finalizationRef, headPath, budget);
      if (head.status === "conflict") return head;
      const receipt = zoneNavigationReceiptSchema.parse({
        schema_version: "1.0", status: "committed", project_id: request.project_id,
        request_id: request.request_id, zone: request.zone, generation: progress.target_generation,
        head_ref: headPath, finalization_ref: finalizationRef, index,
        source_snapshot_id: progress.snapshot_id, source_count: progress.source_count,
        coverage_gaps: progress.coverage_gaps
      });
      progress.status = "finalized";
      progress.receipt = receipt;
      progress = await this.saveProgress(path, progress, await this.token(path, budget), budget);
      return { status: "finalized", receipt };
    } catch (error) {
      if (isBudgetExhausted(error)) return { status: "pending", cursor: null };
      if (error instanceof Error && error.message === "navigation_listing_stalled") return { status: "conflict", code: "navigation_listing_stalled" };
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
      verify_cursor: null,
      source_count: 0,
      source_ids: [],
      published_index: null,
      coverage_gaps: [],
      rendered_links: [],
      generated_sha256: null,
      legacy_archive_ref: null,
      valid_links_work: null,
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
      const verifiedEntries = page.verified_entries ?? [];
      for (const proof of verifiedEntries) {
        const matching = entries.find((entry) => entry.resource_id === proof.resource_id);
        if (!matching || !/^[a-f0-9]{64}$/.test(proof.entry_hash) || typeof proof.persisted !== "boolean" || await executionHash(matching) !== proof.entry_hash) {
          return { status: "conflict", code: "navigation_inventory_proof_invalid" };
        }
      }
      const savedPage: SnapshotPage = { schema_version: "1.0", page: progress.page_count, project_id: request.project_id, request_id: request.request_id, snapshot_id: page.snapshot_id, entries, ...(verifiedEntries.length ? { verified_entries: verifiedEntries } : {}), gaps };
      await this.immutableSnapshotPage(`${pagesRoot}/${progress.page_count.toString().padStart(8, "0")}.json`, savedPage, budget);
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

  private async immutableSnapshotPage(path: string, page: SnapshotPage, budget: SliceBudget): Promise<void> {
    try {
      await this.immutable(path, page, budget);
    } catch (error) {
      if (!(error instanceof NavigationConflict) || error.code !== "navigation_immutable_record_conflict") throw error;
      const raw = await this.readJson(path, budget);
      if (!raw || typeof raw !== "object") throw error;
      const existing = raw as Partial<SnapshotPage>;
      // An older process may have created this exact page before saving progress.
      // Preserve that immutable payload (including proof absence); verification below
      // will then use the conservative physical-check path for legacy pages.
      if (existing.schema_version !== page.schema_version || existing.page !== page.page ||
          existing.project_id !== page.project_id || existing.request_id !== page.request_id ||
          existing.snapshot_id !== page.snapshot_id || canonicalJson(existing.entries) !== canonicalJson(page.entries) ||
          canonicalJson(existing.gaps) !== canonicalJson(page.gaps)) throw error;
    }
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
        const entryHash = await executionHash(entry);
        const recordedProof = page.verified_entries?.find((item) => item.resource_id === entry.resource_id && item.entry_hash === entryHash);
        const hasUnresolvedGap = progress.coverage_gaps.some((gap) => gap.resource_id === entry.resource_id);
        // A persisted catalog proof may predate a dirty-head gap and describe
        // an older provider identity. Recheck that exact resource during this
        // request before letting it retire any prior gap.
        const proof = this.inventory.verificationIncludesPhysicalIntegrity && !hasUnresolvedGap ? recordedProof : undefined;
        if (!proof && this.inventory.verifyEntryPage) {
          const savedCursor = progress.verify_cursor?.resource_id === entry.resource_id && progress.verify_cursor.entry_hash === entryHash ? progress.verify_cursor.cursor : null;
          const verification = await this.inventory.verifyEntryPage(entry, savedCursor, budget);
          if (verification.status === "conflict") return { status: "conflict", code: "navigation_source_changed" };
          if (verification.status === "pending") {
            progress.verify_cursor = { resource_id: entry.resource_id, entry_hash: entryHash, cursor: verification.cursor };
            progress = await this.saveProgress(progressPath, progress, await this.token(progressPath, budget), budget);
            return { status: "pending", cursor: progress.cursor };
          }
          progress.verify_cursor = null;
        } else if (!proof && !await this.inventory.verifyEntry(entry, budget)) return { status: "conflict", code: "navigation_source_changed" };
        if (!proof && !this.inventory.verificationIncludesPhysicalIntegrity) await this.verifyPhysicalEntry(entry, budget);
        if ((!proof || !proof.persisted) && this.inventory.recordVerifiedEntry) await this.inventory.recordVerifiedEntry(entry, page.snapshot_id, budget);
        const evidence = { schema_version: "1.0", project_id: request.project_id, request_id: request.request_id, snapshot_id: page.snapshot_id, entry };
        await this.immutable(`${verifiedRoot}/${progress.source_count.toString().padStart(8, "0")}-${progress.verify_page.toString().padStart(8, "0")}-${progress.verify_entry.toString().padStart(8, "0")}.json`, evidence, budget);
        progress.rendered_links.push(renderLink(entry));
        // Old adopting runs may have persisted the same unresolved head gap on
        // several identical dirty cursors. Only a later exact inventory entry
        // that passes this physical verification can retire that mutable
        // warning; immutable snapshot pages remain historical evidence.
        progress.coverage_gaps = progress.coverage_gaps.filter((gap) => gap.resource_id !== entry.resource_id);
        progress.verify_entry += 1;
        progress.verify_cursor = null;
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

  private async verifyPhysicalEntry(entry: NavigationInventoryEntry, budget: SliceBudget): Promise<{ object_id: string; revision_token: string; content_sha256: string; size: number }> {
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
    const contentSha256 = bytes === null ? null : await sha256Bytes(bytes);
    if (bytes === null || bytes.byteLength !== entry.expected.size || !matchesEntryMetadata(after, entry) || after?.size !== entry.expected.size || before!.objectId !== after!.objectId || before!.revisionToken !== after!.revisionToken || contentSha256 !== entry.expected.content_sha256) throw new NavigationConflict("navigation_target_missing_or_changed");
    return { object_id: after!.objectId!, revision_token: after!.revisionToken!, content_sha256: contentSha256!, size: after!.size };
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

  private assertAdmission(request: NavigationReconcileRequest, state: ProjectState, admission: ExecutionAdmission, requestHash: string, indexPath: string, requirePostcheckAdapter = true): void {
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
    if (requirePostcheckAdapter && admission.deferred_rules?.length && !this.postchecks && admission.deferred_rules.some((reference) => {
      const checkId = `rule:${canonicalJson(reference)}`;
      return !this.validLinksRule(admission, checkId);
    })) throw new NavigationConflict("navigation_postchecks_unavailable");
  }

  private assertCatalogRebuildAdmission(request: NavigationCatalogRebuildRequest, state: ProjectState, admission: ExecutionAdmission, requestHash: string): void {
    const resourceId = `navigation:${request.zone}`;
    const manifestPath = `${machineDocumentRoot(request.project_id)}/navigation-sources/${request.zone}/catalog/compact/ready.json`;
    const resources = admission.resources?.filter((resource) => resource.resource_id === resourceId && resource.resource_type === "navigation"
      && resource.zone === request.zone && resource.version === String(request.expected_generation));
    const scopes = admission.resource_effect_scopes?.filter((scope) => scope.resource_id === resourceId
      && scope.resource_version === String(request.expected_generation) && scope.provider_id === this.runtime.providerId);
    const scope = scopes?.[0];
    if (state.project_id !== request.project_id || state.revision !== request.expected_project_revision
      || admission.project_id !== request.project_id || admission.request_id !== request.request_id
      || admission.kind !== "document" || admission.operation !== "navigation.reconcile" || admission.request_hash !== requestHash
      || admission.verdict !== "allow" || admission.project_revision !== request.expected_project_revision
      || resources?.length !== 1 || scopes?.length !== 1 || !scope
      || !scope.sources.some((source) => source.path === manifestPath)
      || !scope.destinations.some((destination) => destination.path === manifestPath)) {
      throw new NavigationConflict("navigation_catalog_rebuild_admission_binding_mismatch");
    }
  }

  private async saveCatalogRebuildProgress(path: string, progress: NavigationCatalogRebuildProgress, token: string | null, budget: SliceBudget): Promise<NavigationCatalogRebuildProgress> {
    const parsed = navigationCatalogRebuildProgressSchema.parse(progress);
    const content = canonicalJson(parsed);
    if (token === null) {
      await this.immutable(path, parsed, budget);
      return parsed;
    }
    budget.beforeHttp();
    await this.runtime.conditionalWrite.writeTextConditional(path, content, token);
    return parsed;
  }

  private async catalogRebuildConflict(path: string, progress: NavigationCatalogRebuildProgress, code: string, budget: SliceBudget): Promise<{ status: "pending"; cursor: string | null } | { status: "conflict"; code: string }> {
    if (progress.invalidated_manifest) {
      const abandoned = await new ZoneNavigationSources(this.runtime).abandonFailedCompactCatalogRebuild({
        project_id: progress.project_id, zone: progress.zone, request_id: progress.request_id,
        expected_unready_manifest: progress.invalidated_manifest
      }, budget);
      if (abandoned.status === "pending") return { status: "pending", cursor: "abandon-rebuild" };
    }
    progress.status = "conflict";
    progress.coverage_gaps.push({ resource_id: "catalog-rebuild", code });
    await this.saveCatalogRebuildProgress(path, progress, await this.token(path, budget), budget);
    return { status: "conflict", code };
  }

  private async abandonOrHoldUnboundCatalogRebuild(
    sources: ZoneNavigationSources,
    request: NavigationCatalogRebuildRequest,
    budget: SliceBudget
  ): Promise<{ status: "pending"; cursor: string | null } | null> {
    try {
      const manifest = await sources.compactCatalogManifest(request.project_id, request.zone, budget);
      if (manifest?.ready_generation === request.expected_source_generation) {
        const identity = await sources.compactCatalogManifestIdentity(request.project_id, request.zone, budget);
        if (!identity || canonicalJson(identity) !== canonicalJson(request.expected_catalog_manifest)) {
          if (!identity) return { status: "pending", cursor: "withdraw-published-manifest" };
          const withdrawn = await sources.invalidateFailedPublishedCompactCatalogRebuild({
            project_id: request.project_id, zone: request.zone, request_id: request.request_id,
            expected_final_manifest: identity
          }, budget);
          if (withdrawn.status === "pending") return { status: "pending", cursor: "withdraw-published-manifest" };
          const abandoned = await sources.abandonFailedCompactCatalogRebuild({
            project_id: request.project_id, zone: request.zone, request_id: request.request_id,
            expected_unready_manifest: withdrawn.identity
          }, budget);
          return abandoned.status === "pending" ? { status: "pending", cursor: "abandon-rebuild" } : null;
        }
        return null;
      }
      if (manifest?.ready_generation === null && manifest.rebuilding_request_id === request.request_id) {
        const identity = await sources.compactCatalogManifestIdentity(request.project_id, request.zone, budget);
        if (!identity) return { status: "pending", cursor: "abandon-rebuild" };
        const abandoned = await sources.abandonFailedCompactCatalogRebuild({
          project_id: request.project_id, zone: request.zone, request_id: request.request_id,
          expected_unready_manifest: identity
        }, budget);
        if (abandoned.status === "pending") return { status: "pending", cursor: "abandon-rebuild" };
      }
      return null;
    } catch {
      return { status: "pending", cursor: "abandon-rebuild" };
    }
  }

  private async releaseCatalogRebuildFenceBeforeConflict(
    sources: ZoneNavigationSources,
    binding: { project_id: string; zone: NavigationZone; request_id: string },
    budget: SliceBudget
  ): Promise<{ status: "pending"; cursor: string | null } | { status: "conflict"; code: string } | null> {
    try {
      const released = await sources.releaseCompactCatalogRebuildFence(binding.project_id, binding.zone, binding.request_id, budget);
      return released ? null : { status: "conflict", code: "navigation_catalog_rebuild_fence_owned_by_other_request" };
    } catch {
      return { status: "pending", cursor: "release-fence" };
    }
  }

  private async runPostchecks(
    request: NavigationReconcileRequest,
    state: ProjectState,
    admission: ExecutionAdmission,
    progress: NavigationProgress,
    progressPath: string,
    pagesRoot: string,
    budget: SliceBudget
  ): Promise<{ status: "ok"; records: unknown[] } | { status: "pending"; cursor: string | null } | { status: "conflict"; code: string }> {
    const records: NavigationProgress["postchecks"] = [...progress.postchecks];
    for (const checkId of requiredRulePostchecks(admission)) {
      const prior = records.find((record) => record.check_id === checkId);
      if (prior?.verdict === "allow") continue;
      if (prior?.verdict === "deny") {
        progress.status = "conflict";
        progress = await this.saveProgress(progressPath, progress, await this.token(progressPath, budget), budget);
        return { status: "conflict", code: "navigation_postcheck_denied" };
      }
      const rule = this.validLinksRule(admission, checkId);
      const result = rule
        ? await this.runValidLinksPostcheck(request, state, progress, pagesRoot, rule, progressPath, budget)
        : this.postchecks
          ? await this.postchecks.run({ request, admission, check_id: checkId, budget })
          : { verdict: "unavailable" as const, evidence_refs: [] };
      if (result.verdict === "pending") return { status: "pending", cursor: result.cursor };
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

  private validLinksRule(admission: ExecutionAdmission, checkId: string): RuleVersion | null {
    const reference = admission.deferred_rules?.find((candidate) => `rule:${canonicalJson(candidate)}` === checkId);
    if (!reference) return null;
    const rule = this.postcheckRules.find((candidate) => canonicalJson({ rule_id: candidate.rule_id, version: candidate.version, scope: candidate.scope }) === canonicalJson(reference));
    if (!rule || rule.check_id !== "valid_links" || rule.check_stage !== "post_execution" || rule.enforcement !== "automatic"
      || !rule.operations.includes("navigation.reconcile") || !["active", "superseded", "retired"].includes(rule.status)) return null;
    return rule;
  }

  private async runValidLinksPostcheck(
    request: NavigationReconcileRequest,
    state: ProjectState,
    progress: NavigationProgress,
    pagesRoot: string,
    rule: RuleVersion,
    progressPath: string,
    budget: SliceBudget
  ): Promise<{ verdict: "allow" | "deny" | "unavailable"; evidence_refs: string[] } | { verdict: "pending"; evidence_refs: []; cursor: string | null }> {
    try {
      if (!progress.published_index || !progress.generated_sha256 || !progress.snapshot_id || progress.coverage_gaps.length) {
        return { verdict: "deny", evidence_refs: [] };
      }
      if (progress.source_ids.length !== progress.source_count || progress.rendered_links.length !== progress.source_count) return { verdict: "deny", evidence_refs: [] };
      if (!await this.inventory.verifySnapshot({ project_id: request.project_id, zone: request.zone, snapshot_id: progress.snapshot_id, budget })) return { verdict: "deny", evidence_refs: [] };
      const indexPath = this.indexPath(state, request.zone, progress.index_basename);
      const observedIndex = await this.observeIndex(indexPath, budget);
      if (!observedIndex || !sameIndexIdentity(observedIndex.identity, progress.published_index)
        || observedIndex.identity.content_sha256 !== progress.generated_sha256
        || observedIndex.content !== this.render(request.zone, progress.rendered_links, progress.coverage_gaps)) {
        return { verdict: "deny", evidence_refs: [] };
      }
      const actualLinks = observedIndex.content.split("\n").filter((line) => line.startsWith("- ["));
      if (canonicalJson(actualLinks) !== canonicalJson(progress.rendered_links)) return { verdict: "deny", evidence_refs: [] };

      const ruleRef = { rule_id: rule.rule_id, version: rule.version, scope: rule.scope };
      const ruleBinding = canonicalJson(ruleRef);
      let work = progress.valid_links_work;
      if (work && (work.check_id !== "valid_links" || work.rule_ref !== ruleBinding || work.snapshot_id !== progress.snapshot_id
        || !sameIndexIdentity(work.index, progress.published_index))) return { verdict: "deny", evidence_refs: [] };
      if (!work) {
        work = {
          check_id: "valid_links", rule_ref: ruleBinding, snapshot_id: progress.snapshot_id,
          index: progress.published_index, next_page: 0, next_entry: 0, verified_count: 0, target_evidence_refs: []
        };
        progress.valid_links_work = work;
        if (!budget.canStartEffect(2)) return { verdict: "pending", evidence_refs: [], cursor: null };
        progress = await this.saveProgress(progressPath, progress, await this.token(progressPath, budget), budget);
      }
      let cachedPageNumber = -1;
      let cachedPage: SnapshotPage | null = null;
      while (work.next_page < progress.page_count) {
        if (!budget.canStartEffect(8)) {
          if (budget.canStartEffect(2)) progress = await this.saveProgress(progressPath, progress, await this.token(progressPath, budget), budget);
          return { verdict: "pending", evidence_refs: [], cursor: `${work.next_page}:${work.next_entry}` };
        }
        if (cachedPageNumber !== work.next_page) {
          const path = `${pagesRoot}/${work.next_page.toString().padStart(8, "0")}.json`;
          const raw = await this.readText(path, budget);
          if (raw === null) return { verdict: "unavailable", evidence_refs: [] };
          let page: SnapshotPage;
          try { page = JSON.parse(raw) as SnapshotPage; } catch { return { verdict: "deny", evidence_refs: [] }; }
          if (canonicalJson(page) !== raw || page.schema_version !== "1.0" || page.page !== work.next_page
            || page.project_id !== request.project_id || page.request_id !== request.request_id || page.snapshot_id !== progress.snapshot_id
            || !Array.isArray(page.entries) || !Array.isArray(page.gaps) || page.gaps.length) return { verdict: "deny", evidence_refs: [] };
          cachedPage = page;
          cachedPageNumber = work.next_page;
        }
        const page = cachedPage!;
        if (work.next_entry >= page.entries.length) {
          work.next_page += 1;
          work.next_entry = 0;
          progress.valid_links_work = work;
          if (!budget.canStartEffect(2)) return { verdict: "pending", evidence_refs: [], cursor: `${work.next_page}:0` };
          progress = await this.saveProgress(progressPath, progress, await this.token(progressPath, budget), budget);
          continue;
        }
        const parsed = navigationInventoryEntrySchema.safeParse(page.entries[work.next_entry]);
        if (!parsed.success) return { verdict: "deny", evidence_refs: [] };
        const entry = parsed.data;
        this.assertEntry(entry, state, request.zone);
        const offset = work.verified_count;
        if (offset >= progress.source_count || entry.resource_id !== progress.source_ids[offset]
          || renderLink(entry) !== progress.rendered_links[offset]) return { verdict: "deny", evidence_refs: [] };
        const targetEvidence = {
          schema_version: "1.0", check_id: "valid_links_target", project_id: request.project_id,
          request_id: request.request_id, request_hash: progress.request_hash, snapshot_id: progress.snapshot_id,
          rule: ruleRef, index: observedIndex.identity, offset,
          target: {
            resource_id: entry.resource_id, path: entry.path,
            object_id: entry.expected.object_id, revision_token: entry.expected.revision_token,
            content_sha256: entry.expected.content_sha256, size: entry.expected.size
          }
        };
        const targetRef = `${await new ExecutionJournal(this.runtime, request.project_id, "document", request.request_id).root()}/observations/navigation-valid-links-target-${offset}-${await executionHash(targetEvidence)}.json`;
        const persistedTargetEvidence = await this.readText(targetRef, budget);
        if (persistedTargetEvidence !== null) {
          if (persistedTargetEvidence !== canonicalJson(targetEvidence)) return { verdict: "deny", evidence_refs: [] };
        } else {
          const target = await this.verifyPhysicalEntry(entry, budget);
          if (target.object_id !== entry.expected.object_id || target.revision_token !== entry.expected.revision_token
            || target.content_sha256 !== entry.expected.content_sha256 || target.size !== entry.expected.size) return { verdict: "deny", evidence_refs: [] };
          await this.immutable(targetRef, targetEvidence, budget);
        }
        work.target_evidence_refs.push(targetRef);
        work.verified_count += 1;
        work.next_entry += 1;
        progress.valid_links_work = work;
        if (!budget.canStartEffect(2)) return { verdict: "pending", evidence_refs: [], cursor: `${work.next_page}:${work.next_entry}` };
        progress = await this.saveProgress(progressPath, progress, await this.token(progressPath, budget), budget);
      }
      if (work.verified_count !== progress.source_count || work.target_evidence_refs.length !== progress.source_count) return { verdict: "deny", evidence_refs: [] };
      const evidence = {
        schema_version: "1.0",
        check_id: "valid_links",
        project_id: request.project_id,
        request_id: request.request_id,
        request_hash: progress.request_hash,
        snapshot_id: progress.snapshot_id,
        rule: ruleRef,
        index: { path: indexPath, ...observedIndex.identity, size: observedIndex.bytes.byteLength },
        links: actualLinks,
        target_evidence_refs: work.target_evidence_refs
      };
      const ref = `${await new ExecutionJournal(this.runtime, request.project_id, "document", request.request_id).root()}/observations/navigation-valid-links-${await executionHash(evidence)}.json`;
      await this.immutable(ref, evidence, budget);
      return { verdict: "allow", evidence_refs: [ref] };
    } catch (error) {
      if (isBudgetExhausted(error)) throw error;
      if (error instanceof NavigationConflict && error.code === "navigation_target_missing_or_changed") return { verdict: "deny", evidence_refs: [] };
      return { verdict: "unavailable", evidence_refs: [] };
    }
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
