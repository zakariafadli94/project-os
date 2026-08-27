export const PROJECT_OS_ROOT = "/PROJECT_OS";

const PROJECT_ID_RE = /^PRJ-[0-9]{4,}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EVENT_ID_RE = /^EVT-[0-9]{6,}$/;
const DECISION_ID_RE = /^DEC-[A-Z0-9]{4,}$/;
const STABLE_ID_RE = /^[A-Z]+-[A-Z0-9]{4,}$/;
const TRANSACTION_ID_RE = /^TXN-[A-Z0-9-]{10,}$/;

export function assertSafeProjectId(value: string): string {
  if (!PROJECT_ID_RE.test(value)) throw new Error(`Unsafe project id: ${value}`);
  return value;
}

export function assertSafeSlug(value: string): string {
  if (!SLUG_RE.test(value)) throw new Error(`Unsafe project slug: ${value}`);
  return value;
}

function assertMatch(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new Error(`Unsafe ${label}: ${value}`);
  return value;
}

export function assertSafeEventId(value: string): string {
  return assertMatch(value, EVENT_ID_RE, "event id");
}

export function assertSafeStableId(value: string): string {
  return assertMatch(value, STABLE_ID_RE, "stable id");
}

export function assertSafeTransactionId(value: string): string {
  return assertMatch(value, TRANSACTION_ID_RE, "transaction id");
}

export function projectRoot(projectId: string, slug: string): string {
  return `${PROJECT_OS_ROOT}/PROJECTS/${assertSafeProjectId(projectId)}-${assertSafeSlug(slug)}`;
}

export function projectFile(projectId: string, slug: string, filename: "PROJECT.md" | "STATE.md" | "PLAN.md" | "HANDOFF.md"): string {
  return `${projectRoot(projectId, slug)}/${filename}`;
}

export function manifestPath(projectId: string, slug: string): string {
  return `${projectRoot(projectId, slug)}/.system/manifest.json`;
}

export function eventPath(projectId: string, slug: string, eventId: string): string {
  return `${projectRoot(projectId, slug)}/.system/events/${assertSafeEventId(eventId)}.json`;
}

export function decisionPath(projectId: string, slug: string, decisionId: string): string {
  return `${projectRoot(projectId, slug)}/DECISIONS/${assertMatch(decisionId, DECISION_ID_RE, "decision id")}.md`;
}

export function transactionPath(status: "committed" | "rejected" | "conflicts", transactionId: string): string {
  const id = assertSafeTransactionId(transactionId);
  return `${PROJECT_OS_ROOT}/TRANSACTIONS/${status}/${id}.json`;
}

export function receiptPath(transactionId: string): string {
  const id = assertSafeTransactionId(transactionId);
  return `${PROJECT_OS_ROOT}/RECEIPTS/${id}.json`;
}

export function registryJsonPath(): string {
  return `${PROJECT_OS_ROOT}/SYSTEM/PROJECT_REGISTRY.json`;
}

export function registryMarkdownPath(): string {
  return `${PROJECT_OS_ROOT}/SYSTEM/PROJECT_INDEX.md`;
}
