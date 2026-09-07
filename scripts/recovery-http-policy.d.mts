export type ReadinessDecision = "ready" | "retry" | "fail";
export type RevocationDecision = "revoked" | "retry";

export function classifyReadinessResponse(status: number, bodyText: string): ReadinessDecision;
export function classifyRevocationResponse(status: number): RevocationDecision;
