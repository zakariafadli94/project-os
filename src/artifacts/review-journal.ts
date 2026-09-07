import { parseArtifactWriteRequest, type ArtifactWriteReceipt, type ReviewCandidateRequest } from "../domain/artifact-write";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../persistence/provider/contract";
import { ProviderConflictError } from "../persistence/provider/errors";
import { machineArtifactReceiptPath } from "../persistence/layout";
import { MutationIntentConflictError } from "../mutation-gate/repository";
import { reviewReceiptMatchesObservation } from "./review-receipt";

type Observation = NonNullable<ArtifactWriteReceipt["final_observation"]>;
export class ReviewCandidateJournal {
  constructor(private readonly runtime: ProjectOsPersistenceRuntime) {}
  private path(request: ReviewCandidateRequest, kind: "observations" | "terminals"): string {
    return machineArtifactReceiptPath(request.request_id).replace("/receipts/", `/review-${kind}/`);
  }
  async recordObservation(request: ReviewCandidateRequest, metadata: ProviderObjectMetadata): Promise<void> {
    if (!metadata.objectId || !metadata.revisionToken || !metadata.integrityHash) throw new Error("Missing final review evidence");
    const observation: Observation = {provider_id:this.runtime.providerId,path:metadata.path,object_id:metadata.objectId,revision_token:metadata.revisionToken,size:metadata.size,integrity:metadata.integrityHash};
    await this.add(this.path(request,"observations"), JSON.stringify(observation));
  }
  async observation(request: ReviewCandidateRequest): Promise<Observation> {
    const raw = await this.runtime.objects.readText(this.path(request,"observations"));
    if (!raw) throw new Error("Missing frozen review observation");
    const observation = JSON.parse(raw) as Observation;
    const current = await this.runtime.objects.getMetadata(observation.path);
    const receipt = {request_id:request.request_id,project_id:request.project_id,relative_path:request.relative_path,content_sha256:request.content_sha256,status:"committed",operation:"REVIEW_CANDIDATE",accepted:false,published:false,final_observation:observation};
    if (!current || !reviewReceiptMatchesObservation(receipt,request,current,this.runtime.providerId)) throw new Error("Final review observation changed before receipt");
    return observation;
  }
  async recordTerminal(request: ReviewCandidateRequest, receipt: ArtifactWriteReceipt): Promise<void> {
    await this.add(this.path(request,"terminals"), JSON.stringify({request,receipt}));
  }
  async terminal(request: ReviewCandidateRequest): Promise<ArtifactWriteReceipt | null> {
    const raw = await this.runtime.objects.readText(this.path(request,"terminals"));
    if (raw === null) return null;
    const record = JSON.parse(raw) as {request:unknown;receipt:ArtifactWriteReceipt};
    if (JSON.stringify(parseArtifactWriteRequest(record.request)) !== JSON.stringify(request)) throw new MutationIntentConflictError(request.request_id);
    const receipt = record.receipt;
    if (!receipt || receipt.request_id !== request.request_id || receipt.project_id !== request.project_id || receipt.content_sha256 !== request.content_sha256 || receipt.relative_path !== request.relative_path || receipt.operation !== "REVIEW_CANDIDATE" || receipt.accepted !== false || receipt.published !== false || !["committed","conflict","rejected"].includes(receipt.status)) throw new Error("Invalid review terminal record");
    return receipt;
  }
  private async add(path: string, content: string): Promise<void> {
    try { await this.runtime.objects.createText(path,content); }
    catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      if (await this.runtime.objects.readText(path) !== content) throw new Error("Conflicting immutable review evidence");
    }
  }
}
