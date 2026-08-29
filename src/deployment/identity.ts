import type { Env } from "../env";

interface VersionMetadataLike {
  id?: unknown;
  tag?: unknown;
  timestamp?: unknown;
}

export interface DeploymentIdentity {
  worker_version_id: string | null;
  worker_version_tag: string | null;
  git_sha: string | null;
}

export function deploymentIdentity(env: Env): DeploymentIdentity {
  const metadata = (env as Env & { CF_VERSION_METADATA?: VersionMetadataLike }).CF_VERSION_METADATA;
  const workerVersionId = typeof metadata?.id === "string" && metadata.id.length > 0
    ? metadata.id
    : null;
  const workerVersionTag = typeof metadata?.tag === "string" && metadata.tag.length > 0
    ? metadata.tag
    : null;
  const match = workerVersionTag?.match(/^git-([a-f0-9]{40})$/i);

  return {
    worker_version_id: workerVersionId,
    worker_version_tag: workerVersionTag,
    git_sha: match ? match[1].toLowerCase() : null
  };
}
