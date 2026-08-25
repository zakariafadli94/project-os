export * from "./repository-core";

import type { ArtifactWriteRequest } from "../domain/artifact-write";
import type { ProjectState } from "../domain/project-state";
import type { DropboxTransport } from "./client";
import type { LayoutMode } from "./layout";
import { ProjectRepository as CoreProjectRepository } from "./repository-core";

export class ProjectRepository extends CoreProjectRepository {
  constructor(
    private readonly rawTransport: DropboxTransport,
    private readonly repositoryMode: LayoutMode = "legacy"
  ) {
    super(rawTransport, repositoryMode);
  }

  override async writeArtifact(state: ProjectState, request: ArtifactWriteRequest): Promise<"written" | "idempotent"> {
    if (this.repositoryMode !== "legacy") {
      const { LegacyArtifactDocumentWriter } = await import("../documents/legacy-artifact");
      const managed = await new LegacyArtifactDocumentWriter(this.rawTransport).writeIfManaged(state, request);
      if (managed !== null) return managed;
    }
    return super.writeArtifact(state, request);
  }
}
