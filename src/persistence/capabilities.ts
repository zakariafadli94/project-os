import { deploymentIdentity, type VersionMetadataLike } from "../deployment/identity";

/** Describes deployed routes, not successful probes or a client's tool mount. */
export function persistenceCapabilities(
  env: { CF_VERSION_METADATA?: VersionMetadataLike },
  authorized: { read: boolean; mutate: boolean } | null = null
) {
  const supported = {
    canonical_read: true,
    typed_transactions: true,
    governed_documents: true,
    governed_artifacts: true,
    receipt_tracking: true,
    finalization_tracking: true,
    fallback_ingress: true
  };
  return {
    ...supported,
    protocol_version: "2.0",
    deployment_sha: deploymentIdentity(env).git_sha,
    server_supported: supported,
    authorized,
    callable_in_this_session: null,
    runtime_readiness: "not_probed",
    fallback: { supported_families: ["transaction", "project_context"], requires_authorized_encrypted_transport: true },
    missing_client_capability: {
      code: "PROJECT_OS_CONNECTOR_UNAVAILABLE", status: "not_submitted",
      action: "check_callable_tools_and_authorized_transport",
      preserve_original_request: true, requires_new_approval: false
    }
  };
}
