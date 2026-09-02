import type { Env } from "../env";
import type { SearchIndexProjectStatus } from "./contract";

interface RegistryProject {
  project_id: string;
}

interface SearchSyncStatus {
  project_id: string;
  canonical_revision_requested: number;
  canonical_revision_indexed: number;
  document_generation_requested: number;
  document_generation_indexed: number;
  last_error?: string | null;
}

export interface SearchFleetReconcileSummary {
  scanned: number;
  scheduled: number;
  current: number;
  rebuilding: number;
  failed: number;
}

export async function reconcileSearchIndexes(env: Env): Promise<SearchFleetReconcileSummary> {
  const registryStub = env.REGISTRY_GUARD.getByName("global");
  const registryResponse = await registryStub.fetch("https://registry-guard.internal/registry", { method: "GET" });
  if (!registryResponse.ok) {
    throw new Error(`RegistryGuard search reconcile returned ${registryResponse.status}`);
  }

  const registry = await registryResponse.json<{ projects: RegistryProject[] }>();
  const searchIndex = env.SEARCH_INDEX_GUARD.getByName("global");
  const summary: SearchFleetReconcileSummary = {
    scanned: registry.projects.length,
    scheduled: 0,
    current: 0,
    rebuilding: 0,
    failed: 0
  };

  let cursor = 0;
  const workerCount = Math.min(4, registry.projects.length);
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= registry.projects.length) return;

      const projectId = registry.projects[index].project_id;
      try {
        const indexResponse = await searchIndex.fetch(
          `https://search-index.internal/status?project_id=${encodeURIComponent(projectId)}`,
          { method: "GET" }
        );
        if (!indexResponse.ok) throw new Error(`SearchIndexGuard returned ${indexResponse.status}`);
        const indexed = await indexResponse.json<SearchIndexProjectStatus>();
        const missingHead = indexed.active_generation === null;

        const projectGuard = env.PROJECT_GUARD.getByName(projectId);
        const reconcileResponse = await projectGuard.fetch(
          "https://project-guard.internal/reconcile-search",
          missingHead
            ? {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ force_full: true })
              }
            : { method: "POST" }
        );
        if (!reconcileResponse.ok) throw new Error(`ProjectGuard returned ${reconcileResponse.status}`);
        const source = await reconcileResponse.json<SearchSyncStatus>();

        const rebuilding = indexed.rebuild_state === "rebuilding" || indexed.freshness === "rebuilding";
        const canonicalLag = source.canonical_revision_requested > source.canonical_revision_indexed
          || indexed.canonical_revision_indexed < source.canonical_revision_requested;
        const documentLag = source.document_generation_requested > source.document_generation_indexed
          || indexed.document_generation_indexed < source.document_generation_requested;
        const lagging = missingHead || canonicalLag || documentLag;
        const failed = lagging && Boolean(source.last_error || indexed.last_error || indexed.freshness === "failed");

        if (rebuilding) summary.rebuilding += 1;
        else if (failed) summary.failed += 1;
        else if (lagging) summary.scheduled += 1;
        else summary.current += 1;
      } catch (error) {
        summary.failed += 1;
        console.error("Project OS search reconcile failed", {
          project_id: projectId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return summary;
}
