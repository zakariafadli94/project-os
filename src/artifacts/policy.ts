import { isStagedArtifactWriteRequest, type ArtifactWriteRequest } from "../domain/artifact-write";

export interface BinaryArtifactPolicyEnv {
  PROJECT_OS_BINARY_ARTIFACT_INGRESS_MODE?: string;
  PROJECT_OS_BINARY_ARTIFACT_MAX_BYTES?: string;
}
export interface BinaryArtifactPolicy {
  enabled: boolean;
  maxBytes: number;
}

export interface BinaryArtifactPolicyViolation {
  code: "BINARY_ARTIFACT_INGRESS_DISABLED" | "BINARY_ARTIFACT_TOO_LARGE";
  message: string;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export function parseBinaryArtifactPolicy(env: BinaryArtifactPolicyEnv): BinaryArtifactPolicy {
  const mode = env.PROJECT_OS_BINARY_ARTIFACT_INGRESS_MODE;
  if (mode !== undefined && mode !== "" && mode !== "on" && mode !== "off") {
    throw new Error(`Invalid PROJECT_OS_BINARY_ARTIFACT_INGRESS_MODE: ${mode}`);
  }
  const rawMax = env.PROJECT_OS_BINARY_ARTIFACT_MAX_BYTES;
  const maxBytes = rawMax === undefined || rawMax === "" ? DEFAULT_MAX_BYTES : Number(rawMax);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`Invalid PROJECT_OS_BINARY_ARTIFACT_MAX_BYTES: ${rawMax}`);
  }
  return { enabled: mode === "on", maxBytes };
}

export function binaryArtifactPolicyViolation(
  env: BinaryArtifactPolicyEnv,
  request: ArtifactWriteRequest
): BinaryArtifactPolicyViolation | null {
  if (!isStagedArtifactWriteRequest(request)) return null;
  const policy = parseBinaryArtifactPolicy(env);
  if (!policy.enabled) {
    return {
      code: "BINARY_ARTIFACT_INGRESS_DISABLED",
      message: "Staged binary artifact ingress is disabled"
    };
  }
  if (request.source.size > policy.maxBytes) {
    return {
      code: "BINARY_ARTIFACT_TOO_LARGE",
      message: `Staged artifact size ${request.source.size} exceeds ${policy.maxBytes} bytes`
    };
  }
  return null;
}
