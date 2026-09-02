import type {
  ConditionalWritePort,
  DirectoryProvisioningPort,
  IncrementalChangeFeedPort,
  ObjectPersistence,
  ServerSideCopyPort
} from "./contract";
import { ProviderCapabilityError } from "./errors";

export interface ProviderEvidenceCapabilities {
  stableObjectId: { semantics: "stable-through-move" };
  revisionToken: { semantics: "opaque-object-revision" };
  integrityHash: { semantics: "identified-algorithm" };
}

export interface ProviderRequestDiagnosticsPort {
  beginOperation(operation: string): void;
}

export interface PersistenceRuntime {
  providerId: string;
  objects: ObjectPersistence;
  conditionalWrite?: ConditionalWritePort;
  serverSideCopy?: ServerSideCopyPort;
  changeFeed?: IncrementalChangeFeedPort;
  directoryProvisioning?: DirectoryProvisioningPort;
  diagnostics?: ProviderRequestDiagnosticsPort;
  evidence?: Partial<ProviderEvidenceCapabilities>;
}

export interface ProjectOsPersistenceRuntime {
  providerId: string;
  objects: ObjectPersistence;
  conditionalWrite: ConditionalWritePort;
  serverSideCopy: ServerSideCopyPort;
  changeFeed: IncrementalChangeFeedPort;
  directoryProvisioning?: DirectoryProvisioningPort;
  diagnostics?: ProviderRequestDiagnosticsPort;
  evidence: ProviderEvidenceCapabilities;
}

export function requireProjectOsPersistence(runtime: PersistenceRuntime): ProjectOsPersistenceRuntime {
  if (!runtime.conditionalWrite) throw new ProviderCapabilityError("conditional-write");
  if (!runtime.serverSideCopy) throw new ProviderCapabilityError("server-side-copy");
  if (!runtime.changeFeed) throw new ProviderCapabilityError("incremental-change-feed");
  if (!runtime.evidence?.stableObjectId) throw new ProviderCapabilityError("stable-object-id");
  if (!runtime.evidence.revisionToken) throw new ProviderCapabilityError("revision-token");
  if (!runtime.evidence.integrityHash) throw new ProviderCapabilityError("integrity-hash");
  return runtime as ProjectOsPersistenceRuntime;
}
