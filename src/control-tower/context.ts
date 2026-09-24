const SUMMARY_LIMIT = 24 * 1024;
const DETAIL_LIMIT = 16 * 1024;
const DETAIL_CHUNK_LIMIT = 4 * 1024;
const SUMMARY_TEXT_LIMIT = 256;
const TASK_PAGE_LIMIT = 50;
const ACTION_PAGE_LIMIT = 10;

export const DETAIL_FIELDS = {
  project: ["name", "slug", "objective"],
  phase: ["title", "objective", "next_actions"],
  task: ["title", "description", "blocked_reason", "result"]
} as const;

type EntityType = keyof typeof DETAIL_FIELDS;
type ContextRef = { entity_type: EntityType; entity_id: string; field: string; revision: number };
type ContextCursor = {
  v: 1; project_id: string; revision: number; phase_id: string | null;
  task_offset: number; objective_offset: number; action_offset: number;
};
type DetailCursor = {
  v: 1; project_id: string; revision: number; entity_type: EntityType; entity_id: string; field: string;
  item_offset: number; text_offset: number;
};
type Body = { context?: unknown; canonical_state?: Record<string, unknown> };

export function summarizeCanonicalContext(body: Body, projectId: string, token?: string): { value?: Record<string, unknown>; error?: Record<string, unknown> } {
  const binding = validateCanonicalBinding(body, projectId);
  if (binding.error) return { error: binding.error };
  const state = body.canonical_state!;
  const phases = objectValues(state.plan_phases);
  const tasks = objectValues(state.tasks)
    .filter((task) => task.status !== "completed" && task.status !== "cancelled")
    .sort((a, b) => compare(String(a.task_id ?? ""), String(b.task_id ?? "")));
  const revision = binding.revision!;
  const phaseId = typeof state.current_phase_id === "string" ? state.current_phase_id : null;
  const phase = phases.find((item) => item.phase_id === phaseId) ?? null;
  const cursor = token ? decode<ContextCursor>(token) : {
    v: 1 as const, project_id: projectId, revision, phase_id: phaseId,
    task_offset: 0, objective_offset: 0, action_offset: 0
  };
  if (!validSummaryCursor(cursor) || cursor.project_id !== projectId) return { error: cursorError() };
  if (cursor.revision !== revision || cursor.phase_id !== phaseId) {
    return { error: { status: "stale_cursor", code: "CONTEXT_CURSOR_STALE", current_revision: revision } };
  }
  const objective = typeof phase?.objective === "string" ? phase.objective : "";
  const actions = Array.isArray(phase?.next_actions) ? phase.next_actions.filter((item): item is string => typeof item === "string") : [];
  if (cursor.task_offset > tasks.length || cursor.objective_offset > objective.length || !safeStringOffset(objective, cursor.objective_offset) || cursor.action_offset > actions.length
    || (!phase && (cursor.objective_offset !== 0 || cursor.action_offset !== 0))) return { error: cursorError() };

  const objectivePage = utf8Prefix(objective.slice(cursor.objective_offset), DETAIL_CHUNK_LIMIT).text;
  const project = summarizeRecord(state, ["project_id", "name", "slug", "objective", "status", "revision", "current_phase_id"], "project", projectId, revision);
  const phaseIdentity = phase && typeof phase.phase_id === "string" ? phase.phase_id : null;
  const phaseSummary = phase && phaseIdentity !== null
    ? summarizeRecord(phase, ["phase_id", "title", "status", "created_at", "updated_at"], "phase", phaseIdentity, revision) : null;
  if (phaseSummary && phaseIdentity !== null) {
    phaseSummary.objective = objectivePage;
    phaseSummary.objective_offset = cursor.objective_offset;
    phaseSummary.objective_total_chars = objective.length;
    phaseSummary.objective_truncated = cursor.objective_offset + objectivePage.length < objective.length;
    if (phaseSummary.objective_truncated) addRef(phaseSummary, "objective", { entity_type: "phase", entity_id: phaseIdentity, field: "objective", revision });
    const actionPage = actions.slice(cursor.action_offset, cursor.action_offset + ACTION_PAGE_LIMIT);
    phaseSummary.next_actions = actionPage.map((action) => utf8Prefix(action, SUMMARY_TEXT_LIMIT).text);
    phaseSummary.next_actions_offset = cursor.action_offset;
    phaseSummary.next_actions_total = actions.length;
    phaseSummary.next_actions_truncated = cursor.action_offset + actionPage.length < actions.length;
    if (actionPage.some((action) => utf8Prefix(action, SUMMARY_TEXT_LIMIT).truncated) || phaseSummary.next_actions_truncated) {
      addRef(phaseSummary, "next_actions", { entity_type: "phase", entity_id: phaseIdentity, field: "next_actions", revision });
    }
  }
  const taskOffset = cursor.task_offset;
  let returned: Array<Record<string, unknown>> = [];
  let nextCursor: string | null = null;
  let selected: Record<string, unknown> | undefined;
  const maxTasks = Math.min(TASK_PAGE_LIMIT, tasks.length - taskOffset);
  for (let count = maxTasks; count >= 0; count--) {
    returned = tasks.slice(taskOffset, taskOffset + count).map((task) => summarizeRecord(
      task,
      ["task_id", "title", "status", "phase_id", "blocked_reason", "updated_at"],
      "task", String(task.task_id ?? ""), revision
    ));
    const more = taskOffset + returned.length < tasks.length || cursor.objective_offset + objectivePage.length < objective.length
      || cursor.action_offset + Math.min(ACTION_PAGE_LIMIT, actions.length - cursor.action_offset) < actions.length;
    nextCursor = more ? encode({ ...cursor, task_offset: taskOffset + returned.length,
      objective_offset: cursor.objective_offset + objectivePage.length,
      action_offset: cursor.action_offset + Math.min(ACTION_PAGE_LIMIT, actions.length - cursor.action_offset) }) : null;
    selected = withSerializedBytes(buildSummary(body.context, projectId, project, phaseSummary, returned, tasks.length, taskOffset, nextCursor, revision));
    if (byteLength(JSON.stringify(selected)) <= SUMMARY_LIMIT) break;
    selected = undefined;
  }
  if (!selected) return { error: { status: "unavailable", code: "CONTEXT_SIGNED_ENVELOPE_TOO_LARGE" } };
  if (returned.length === 0 && taskOffset < tasks.length) return { error: { status: "unavailable", code: "CONTEXT_TASK_ID_TOO_LARGE" } };
  return { value: selected };
}

function withSerializedBytes(value: Record<string, unknown>): Record<string, unknown> {
  let serializedBytes = 0;
  let measured = -1;
  for (let attempt = 0; attempt < 4; attempt++) {
    value.serialized_bytes = serializedBytes;
    measured = byteLength(JSON.stringify(value));
    if (measured === serializedBytes) return value;
    serializedBytes = measured;
  }
  value.serialized_bytes = serializedBytes;
  return value;
}

function buildSummary(context: unknown, projectId: string, project: Record<string, unknown>, phase: Record<string, unknown> | null,
  tasks: Array<Record<string, unknown>>, total: number, offset: number, cursor: string | null, revision: number): Record<string, unknown> {
  const truncatedFields = [project, ...(phase ? [phase] : []), ...tasks].flatMap((record) => Array.isArray(record.truncated_fields) ? record.truncated_fields : []);
  return {
    status: "ok", project_id: projectId, context,
    project, current_phase: phase,
    active_tasks: tasks, active_tasks_total: total, returned_count: tasks.length, active_tasks_offset: offset,
    active_tasks_truncated: offset + tasks.length < total, truncated_fields: truncatedFields,
    next_cursor: cursor, revision
  };
}

export function retrieveContextDetail(body: Body, projectId: string, input: {
  revision: number; entity_type: EntityType; entity_id: string; field: string; cursor?: string
}): { value?: Record<string, unknown>; error?: Record<string, unknown> } {
  const binding = validateCanonicalBinding(body, projectId);
  if (binding.error) return { error: binding.error };
  const state = body.canonical_state!;
  const revision = binding.revision!;
  if (input.revision !== revision) return { error: { status: "stale_cursor", code: "CONTEXT_CURSOR_STALE", current_revision: revision } };
  if (!(DETAIL_FIELDS[input.entity_type] as readonly string[]).includes(input.field)) return { error: { status: "invalid_field", code: "CONTEXT_DETAIL_FIELD_INVALID" } };
  const cursor = input.cursor ? decode<DetailCursor>(input.cursor) : {
    v: 1 as const, project_id: projectId, revision, entity_type: input.entity_type,
    entity_id: input.entity_id, field: input.field, item_offset: 0, text_offset: 0
  };
  if (!validDetailCursor(cursor) || cursor.project_id !== projectId
    || cursor.entity_type !== input.entity_type || cursor.entity_id !== input.entity_id || cursor.field !== input.field) return { error: cursorError() };
  if (cursor.revision !== revision) return { error: { status: "stale_cursor", code: "CONTEXT_CURSOR_STALE", current_revision: revision } };
  const entity = findEntity(state, projectId, input.entity_type, input.entity_id);
  if (!entity) return { error: { status: "not_found", code: "CONTEXT_DETAIL_NOT_FOUND" } };
  const raw = entity[input.field];
  if (raw === undefined || raw === null) return { value: { status: "ok", revision, entity_type: input.entity_type, entity_id: input.entity_id, field: input.field, value: null, next_cursor: null } };
  if (input.field === "next_actions" && Array.isArray(raw)) return detailActions(raw, projectId, revision, input, cursor);
  if (typeof raw !== "string") return { value: { status: "ok", revision, entity_type: input.entity_type, entity_id: input.entity_id, field: input.field, value: null, next_cursor: null } };
  if (cursor.item_offset !== 0 || cursor.text_offset > raw.length || !safeStringOffset(raw, cursor.text_offset)) return { error: cursorError() };
  let chunkLimit = DETAIL_CHUNK_LIMIT;
  for (let attempt = 0; attempt < 12; attempt++) {
    const page = utf8Prefix(raw.slice(cursor.text_offset), chunkLimit);
    const nextOffset = cursor.text_offset + page.text.length;
    const next = nextOffset < raw.length ? encode({ ...cursor, text_offset: nextOffset }) : null;
    const value = { status: "ok", revision, entity_type: input.entity_type, entity_id: input.entity_id,
      field: input.field, chunk: page.text, offset: cursor.text_offset, total_chars: raw.length, total_bytes: byteLength(raw), next_cursor: next };
    if (byteLength(JSON.stringify(value)) <= DETAIL_LIMIT) return { value };
    chunkLimit = Math.floor(chunkLimit / 2);
  }
  return { error: { status: "unavailable", code: "CONTEXT_DETAIL_PAGE_TOO_LARGE" } };
}

function detailActions(raw: unknown[], projectId: string, revision: number, input: { entity_type: EntityType; entity_id: string; field: string }, cursor: DetailCursor) {
  const actions = raw.filter((value): value is string => typeof value === "string");
  if (cursor.item_offset > actions.length || (cursor.item_offset === actions.length && cursor.text_offset !== 0)) return { error: cursorError() };
  if (cursor.item_offset === actions.length) return { value: { status: "ok", revision, entity_type: input.entity_type, entity_id: input.entity_id, field: input.field, items: [], next_cursor: null } };
  const item = actions[cursor.item_offset]!;
  if (cursor.text_offset > item.length || !safeStringOffset(item, cursor.text_offset)) return { error: cursorError() };
  let chunkLimit = DETAIL_CHUNK_LIMIT;
  for (let attempt = 0; attempt < 12; attempt++) {
    const page = utf8Prefix(item.slice(cursor.text_offset), chunkLimit);
    const textOffset = cursor.text_offset + page.text.length;
    const itemOffset = textOffset >= item.length ? cursor.item_offset + 1 : cursor.item_offset;
    const next = itemOffset < actions.length ? encode({ ...cursor, item_offset: itemOffset, text_offset: itemOffset === cursor.item_offset ? textOffset : 0 }) : null;
    const value = { status: "ok", revision, entity_type: input.entity_type, entity_id: input.entity_id,
      field: input.field, items: [{ index: cursor.item_offset, chunk: page.text, offset: cursor.text_offset, total_chars: item.length }], next_cursor: next };
    if (byteLength(JSON.stringify(value)) <= DETAIL_LIMIT) return { value };
    chunkLimit = Math.floor(chunkLimit / 2);
  }
  return { error: { status: "unavailable", code: "CONTEXT_DETAIL_PAGE_TOO_LARGE" } };
}

function findEntity(state: Record<string, unknown>, projectId: string, type: EntityType, id: string): Record<string, unknown> | null {
  if (type === "project") return (state.project_id === projectId && id === projectId) ? state : null;
  const collection = type === "phase" ? state.plan_phases : state.tasks;
  return objectValues(collection).find((record) => (type === "phase" ? record.phase_id : record.task_id) === id) ?? null;
}

function summarizeRecord(record: Record<string, unknown>, fields: string[], type: EntityType, id: string, revision: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== "string") { result[field] = value; continue; }
    const prefix = utf8Prefix(value, SUMMARY_TEXT_LIMIT);
    result[field] = prefix.text;
    if (prefix.truncated) addRef(result, field, { entity_type: type, entity_id: id, field, revision });
  }
  return result;
}

function addRef(record: Record<string, unknown>, field: string, ref: ContextRef): void {
  const refs = (record.detail_refs ?? {}) as Record<string, ContextRef>;
  refs[field] = ref;
  record.detail_refs = refs;
  const list = (record.truncated_fields ?? []) as ContextRef[];
  if (!list.some((item) => item.field === field && item.entity_id === ref.entity_id)) list.push(ref);
  record.truncated_fields = list;
}

function utf8Prefix(value: string, maxBytes: number): { text: string; truncated: boolean } {
  let result = "";
  let bytes = 0;
  for (const codePoint of value) {
    const size = byteLength(codePoint);
    if (bytes + size > maxBytes) break;
    result += codePoint;
    bytes += size;
  }
  return { text: result, truncated: result.length < value.length };
}

function objectValues(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.values(value).filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry));
}

function validateCanonicalBinding(body: Body, projectId: string): { revision?: number; error?: Record<string, unknown> } {
  const state = body?.canonical_state;
  const context = body?.context;
  if (!state || typeof state !== "object" || Array.isArray(state) || !context || typeof context !== "object" || Array.isArray(context)) {
    return { error: { status: "unavailable", code: "CONTEXT_CANONICAL_UNAVAILABLE" } };
  }
  if (state.project_id !== projectId || (context as Record<string, unknown>).project_id !== projectId) {
    return { error: { status: "unavailable", code: "CONTEXT_PROJECT_BINDING_MISMATCH" } };
  }
  const stateRevision = safeRevision(state.revision);
  const signedRevision = contextRevision(context);
  if (stateRevision === null || signedRevision === null) return { error: { status: "unavailable", code: "CONTEXT_CANONICAL_UNAVAILABLE" } };
  if (stateRevision !== signedRevision) return { error: { status: "unavailable", code: "CONTEXT_REVISION_MISMATCH" } };
  return { revision: stateRevision };
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function safeRevision(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function contextRevision(value: unknown): number | null { return value && typeof value === "object" ? safeRevision((value as Record<string, unknown>).canonical_revision) : null; }
function cursorError() { return { status: "invalid_cursor", code: "CONTEXT_CURSOR_INVALID" }; }

function encode(value: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decode<T>(value: string): T | null {
  if (value.length > 1_024 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return parsed && typeof parsed === "object" ? parsed as T : null;
  } catch { return null; }
}

function validSummaryCursor(value: ContextCursor | null): value is ContextCursor {
  return !!value && value.v === 1 && typeof value.project_id === "string" && Number.isSafeInteger(value.revision)
    && (typeof value.phase_id === "string" || value.phase_id === null) && safeOffset(value.task_offset)
    && safeOffset(value.objective_offset) && safeOffset(value.action_offset);
}

function validDetailCursor(value: DetailCursor | null): value is DetailCursor {
  return !!value && value.v === 1 && typeof value.project_id === "string" && Number.isSafeInteger(value.revision)
    && (value.entity_type === "project" || value.entity_type === "phase" || value.entity_type === "task")
    && typeof value.entity_id === "string" && typeof value.field === "string"
    && safeOffset(value.item_offset) && safeOffset(value.text_offset);
}

function safeOffset(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function safeStringOffset(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return true;
  const previous = value.charCodeAt(offset - 1);
  const current = value.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff);
}
