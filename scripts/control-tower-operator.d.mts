export type OperatorInput = {
  kind: "transaction" | "document" | "artifact";
  project_id: string;
  request: string;
};

export type OperatorReceipt = {
  status: string;
  project_id: string;
  request_id: string;
};

export type OperatorPorts = {
  generateToken(): string;
  captureBaseDeployment(): Promise<{ version_id: string; percentage: number }>;
  createOperatorVersion(input: { token: string }): Promise<string>;
  attachZeroTrafficVersion(input: { baseVersionId: string; operatorVersionId: string }): Promise<void>;
  health(input: { overrideVersionId?: string }): Promise<{ status: string; worker_version_id: string }>;
  fetchContext(input: { projectId: string; token: string; operatorVersionId: string; correlationId: string; signal: AbortSignal }): Promise<{ project_id: string; [key: string]: unknown }>;
  submit(input: {
    kind: OperatorInput["kind"];
    projectId: string;
    request: string;
    context: { project_id: string; [key: string]: unknown };
    token: string;
    operatorVersionId: string;
    correlationId: string;
    signal: AbortSignal;
  }): Promise<OperatorReceipt>;
  restoreBaseDeployment(input: { versionId: string }): Promise<void>;
  tokenStatusOnBase(input: { token: string }): Promise<number>;
};

export type SanitizedOperatorResult = {
  status: "committed" | "unknown" | "not_submitted";
  project_id: string;
  request_id: string;
  base_version_id?: string;
  code?: string;
  failed_boundary?: "context" | "submission";
  recovery?: { preserve_request_id: true; check_status_before_retry: boolean };
};

export function createCloudflarePorts(options: {
  accountId: string;
  apiToken: string;
  workerName: string;
  projectOsUrl: string;
  fetch: (request: Request) => Promise<Response>;
  runCommand: (command: string, args: string[]) => Promise<string>;
}): Pick<OperatorPorts, "captureBaseDeployment" | "restoreBaseDeployment">;

export function runOperatorSubmission(input: OperatorInput, ports: Partial<OperatorPorts>): Promise<SanitizedOperatorResult>;
