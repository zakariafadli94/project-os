export interface ProviderDiagnostics {
  providerId: string;
  status?: number;
  requestId?: string | null;
  code?: string;
  operation?: string;
}

export class ProviderOperationError extends Error {
  constructor(message: string, public readonly retryable: boolean, public readonly diagnostics?: ProviderDiagnostics) {
    super(message);
    this.name = "ProviderOperationError";
  }
}

export class ProviderConflictError extends ProviderOperationError {
  constructor(message: string, diagnostics?: ProviderDiagnostics) {
    super(message, false, diagnostics);
    this.name = "ProviderConflictError";
  }
}

export class ProviderPreconditionFailedError extends ProviderOperationError {
  constructor(message: string, diagnostics?: ProviderDiagnostics) {
    super(message, false, diagnostics);
    this.name = "ProviderPreconditionFailedError";
  }
}

export class ProviderCursorResetError extends ProviderOperationError {
  constructor(message: string, diagnostics?: ProviderDiagnostics) {
    super(message, false, diagnostics);
    this.name = "ProviderCursorResetError";
  }
}

export class ProviderCapabilityError extends Error {
  constructor(public readonly capability: string) {
    super(`Persistence provider is missing required capability: ${capability}`);
    this.name = "ProviderCapabilityError";
  }
}
