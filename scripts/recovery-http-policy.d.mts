export type ReadinessDecision = "ready" | "retry" | "fail";
export type RevocationDecision = "revoked" | "retry";
export type PostcheckDecision = "ready" | "retry" | "fail";

export function classifyReadinessResponse(status: number, bodyText: string): ReadinessDecision;
export function classifyRevocationResponse(status: number): RevocationDecision;
export function classifyPostcheckResponse(status: number): PostcheckDecision;
