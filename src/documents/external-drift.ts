import type { ProjectState } from "../domain/project-state";
import type { ExecutionAdmission, ExecutionPlan, ExecutionProgress, ExecutionStep, ExpectedSource } from "../execution/contract";
import { workspaceProjectRoot } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderChangeEntry, ProviderObjectMetadata } from "../persistence/provider/contract";
import { canonicalJson, type RuleResource } from "../rules/contract";
import { ExecutionJournal, executionHash } from "../execution/journal";
import { DocumentLedgerRepository } from "./repository";
import { packageResourceVersion, type PackageNavigation, type PackageRef } from "../domain/document-package";
import { sha256Text } from "./hash";

export type PackageDriftStatus = "expected_reconciled" | "unexpected_conflict" | "obsolete";

export interface PackageDriftObservation {
  handled: boolean;
  status?: PackageDriftStatus;
  code?: string;
  resource?: RuleResource;
  request_id?: string;
}

interface ExecutionEvidence {
  admitted: { admission: ExecutionAdmission; plan: ExecutionPlan };
  progress: ExecutionProgress;
}

interface PackageDriftCandidate {
  ref: PackageRef;
  resource: RuleResource;
  request_id: string;
  finalized: ExecutionEvidence;
  prepared: ExecutionEvidence | null;
}

/**
 * Read-only classifier for provider events in package-owned paths. It trusts
 * only a finalized L4 plan plus its immutable observations; it never infers
 * an expected move from paths, names, timestamps, or matching bytes alone.
 */
export class PackageExternalDriftObserver {
  private readonly repository: DocumentLedgerRepository;

  constructor(private readonly runtime: ProjectOsPersistenceRuntime) {
    this.repository = new DocumentLedgerRepository(runtime);
  }

  async observe(state: ProjectState, change: ProviderChangeEntry): Promise<PackageDriftObservation> {
    const packagePath = this.isPackagePath(state, change.path);
    let navigation: PackageNavigation;
    try {
      navigation = await this.repository.readCanonicalPackageNavigationForAudit(state.project_id);
    } catch {
      if (!packagePath) return { handled: false };
      return {
        handled: true,
        status: "unexpected_conflict",
        code: change.kind === "deleted" ? "PACKAGE_UNEXPECTED_DISAPPEARANCE" : "PACKAGE_NAVIGATION_UNAVAILABLE"
      };
    }
    const candidates = await this.candidates(state.project_id, navigation);
    const matched = await Promise.all(candidates.map(async (candidate) => ({
      candidate,
      result: await this.matchFinalizedStep(candidate, change)
    })));
    const exact = matched.filter((value) => value.result !== null);
    if (exact.length === 1) {
      const { candidate, result } = exact[0];
      return {
        handled: true,
        status: result === "expected" ? "expected_reconciled" : "unexpected_conflict",
        code: result === "expected"
          ? (change.kind === "deleted" ? "PACKAGE_EXPECTED_DELETE" : "PACKAGE_EXPECTED_WRITE")
          : (change.kind === "deleted" ? "PACKAGE_UNEXPECTED_DISAPPEARANCE" : "PACKAGE_EXPECTED_EFFECT_DIVERGED"),
        resource: candidate.resource,
        request_id: candidate.request_id
      };
    }

    if (!packagePath) return { handled: false };
    const resource = this.resourceForExactPackagePath(navigation, state, change.path);
    return {
      handled: true,
      status: "unexpected_conflict",
      code: change.kind === "deleted" ? "PACKAGE_UNEXPECTED_DISAPPEARANCE" : "PACKAGE_UNEXPECTED_MUTATION",
      ...(resource ? { resource } : {}),
      ...(exact.length > 1 ? { request_id: exact[0].candidate.request_id } : {})
    };
  }

  private async matchFinalizedStep(
    candidate: PackageDriftCandidate,
    change: ProviderChangeEntry
  ): Promise<"expected" | "stale" | null> {
    for (const step of candidate.finalized.admitted.plan.steps) {
      const completed = candidate.finalized.progress.completed_steps.find((entry) => entry.step_id === step.step_id);
      if (!completed || step.resource_id !== candidate.resource.resource_id || step.expected_version !== candidate.resource.version) continue;
      const removal = step.action;
      if (removal.kind === "delete_if_unchanged" && removal.source.path === change.path) {
        const prepared = candidate.prepared;
        const copy = prepared?.admitted.plan.steps.find((entry) => entry.action.kind === "copy_if_unchanged"
          && sameSource(entry.action.source, removal.source)
          && entry.action.destination.path === removal.verified_copy.path
          && entry.action.destination.logical_path === removal.verified_copy.logical_path
          && entry.action.desired.content_sha256 === removal.verified_copy.expected.content_sha256);
        const preparedCompleted = copy && prepared!.progress.completed_steps.some((entry) => entry.step_id === copy.step_id);
        const receiptProvesDelete = await this.hasFinalDeleteReceipt(candidate, step);
        return change.kind === "deleted" && preparedCompleted && receiptProvesDelete ? "expected" : "stale";
      }
    }
    for (const step of candidate.prepared?.admitted.plan.steps ?? []) {
      const completed = candidate.prepared!.progress.completed_steps.find((entry) => entry.step_id === step.step_id);
      if (!completed || step.resource_id !== candidate.resource.resource_id || step.expected_version !== candidate.resource.version
        || step.action.kind !== "copy_if_unchanged" || step.action.destination.path !== change.path) continue;
      if (change.kind !== "file") return "stale";
      const actual = change.metadata ?? await this.runtime.objects.getMetadata(change.path);
      if (!actual || !(await this.matchesCompletedDestination(actual, completed.evidence_refs))) return "stale";
      return "expected";
    }
    return null;
  }

  private async hasFinalDeleteReceipt(candidate: PackageDriftCandidate, step: ExecutionStep): Promise<boolean> {
    if (step.action.kind !== "delete_if_unchanged") return false;
    const journal = new ExecutionJournal(this.runtime, candidate.finalized.admitted.admission.project_id, "document", candidate.request_id);
    const raw = await this.runtime.objects.readText(`${await journal.root()}/effects/${await executionHash(step)}.json`);
    if (raw === null) return false;
    try {
      const receipt = JSON.parse(raw) as { step_hash?: string; destination_identity?: string };
      const expectedDestination = canonicalJson({
        path: step.action.verified_copy.path,
        logical_path: step.action.verified_copy.logical_path,
        state: "present",
        identity: step.action.verified_copy.expected
      });
      return receipt.step_hash === await executionHash(step) && receipt.destination_identity === expectedDestination;
    } catch {
      return false;
    }
  }

  private async candidates(projectId: string, navigation: PackageNavigation): Promise<PackageDriftCandidate[]> {
    const candidates: PackageDriftCandidate[] = [];
    for (const head of Object.values(navigation)) {
      if (!head) continue;
      const finalized = await this.repository.readPackageExecutionEvidence(projectId, "document", head.source_request_id) as ExecutionEvidence;
      const entry = head.packages.find((value) => finalized.admitted.admission.resources.some((resource) =>
        resource.resource_type === "package"
        && resource.resource_id === value.ref.package_id
        && resource.version === packageResourceVersion(value.ref)
        && resource.zone === head.zone
      ));
      if (!entry) continue;
      const resource = finalized.admitted.admission.resources.find((value) =>
        value.resource_type === "package"
        && value.resource_id === entry.ref.package_id
        && value.version === packageResourceVersion(entry.ref)
        && value.zone === head.zone
      );
      if (!resource) continue;
      let prepared: ExecutionEvidence | null = null;
      try {
        prepared = await this.repository.readPackageExecutionEvidence(projectId, "document-package-prepare", head.source_request_id) as ExecutionEvidence;
      } catch {
        // A final journal without its immutable prepare counterpart cannot authorize a change-feed event.
      }
      candidates.push({ ref: entry.ref, resource, request_id: head.source_request_id, finalized, prepared });
    }
    return candidates;
  }

  private async matchesCompletedDestination(
    metadata: ProviderObjectMetadata,
    evidenceRefs: readonly string[]
  ): Promise<boolean> {
    if (!metadata.objectId || !metadata.revisionToken || !metadata.integrityHash) return false;
    for (const ref of evidenceRefs) {
      const raw = await this.runtime.objects.readText(ref);
      if (raw === null) continue;
      try {
        const record = JSON.parse(raw) as { destination?: { state?: string; identity?: { object_id?: string; revision_token?: string; content_sha256?: string } } };
        const identity = record.destination?.state === "present" ? record.destination.identity : undefined;
        if (identity
          && identity.object_id === metadata.objectId
          && identity.revision_token === metadata.revisionToken
          && identity.content_sha256 === await this.sha256ObservedBytes(metadata)) return true;
      } catch {
        // Immutable evidence that cannot be decoded cannot authorize repair.
      }
    }
    return false;
  }

  private async sha256ObservedBytes(metadata: ProviderObjectMetadata): Promise<string | null> {
    const before = await this.runtime.objects.getMetadata(metadata.path);
    if (!before || before.objectId !== metadata.objectId || before.revisionToken !== metadata.revisionToken) return null;
    const bytes = await this.runtime.objects.readBytes?.(metadata.path, before.size + 1);
    const text = bytes ? null : await this.runtime.objects.readText(metadata.path);
    const data = bytes ?? (text === null ? null : new TextEncoder().encode(text));
    const after = await this.runtime.objects.getMetadata(metadata.path);
    if (!data || data.length !== before.size || after?.objectId !== before.objectId || after?.revisionToken !== before.revisionToken) return null;
    return sha256Bytes(data);
  }

  private resourceForExactPackagePath(navigation: PackageNavigation, state: ProjectState, path: string): RuleResource | undefined {
    const parsed = this.packagePath(state, path);
    if (!parsed) return undefined;
    const entry = navigation[parsed.zone]?.packages.find((value) =>
      value.ref.package_id === parsed.package_id && value.ref.version === parsed.version
    );
    return entry ? {
      resource_id: entry.ref.package_id,
      resource_type: "package",
      zone: parsed.zone,
      version: packageResourceVersion(entry.ref)
    } : undefined;
  }

  private packagePath(state: ProjectState, path: string): { zone: "WORKING" | "REVIEW" | "DELIVERABLES"; package_id: string; version: number } | null {
    const root = `${workspaceProjectRoot(state.project_id, state.slug)}/`;
    if (!path.startsWith(root)) return null;
    const relative = path.slice(root.length);
    const visible = /^(WORKING|REVIEW|DELIVERABLES)\/PACKAGES\/(PKG-[A-F0-9]{64})\/([1-9][0-9]*)\//.exec(relative);
    const archive = /^ARCHIVES\/PACKAGES\/(PKG-[A-F0-9]{64})\/([1-9][0-9]*)\/(WORKING|REVIEW|DELIVERABLES)\//.exec(relative);
    const match = visible ?? archive;
    if (!match) return null;
    return {
      zone: (visible ? visible[1] : archive![3]) as "WORKING" | "REVIEW" | "DELIVERABLES",
      package_id: match[visible ? 2 : 1],
      version: Number(match[visible ? 3 : 2])
    };
  }

  private isPackagePath(state: ProjectState, path: string): boolean {
    const root = `${workspaceProjectRoot(state.project_id, state.slug)}/`;
    if (!path.startsWith(root)) return false;
    const relative = path.slice(root.length);
    return /^(?:WORKING|REVIEW|DELIVERABLES)\/(?:CURRENT\.md|PACKAGES\/PKG-[A-F0-9]{64}\/[1-9][0-9]*\/)|^ARCHIVES\/PACKAGES\/PKG-[A-F0-9]{64}\/[1-9][0-9]*\/(?:WORKING|REVIEW|DELIVERABLES)\//.test(relative);
  }
}

function sameSource(left: ExpectedSource, right: ExpectedSource): boolean {
  return left.path === right.path
    && left.logical_path === right.logical_path
    && left.expected.object_id === right.expected.object_id
    && left.expected.revision_token === right.expected.revision_token
    && left.expected.content_sha256 === right.expected.content_sha256;
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
