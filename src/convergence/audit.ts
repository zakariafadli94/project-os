export interface AuditCursor {
  started_at: string;
  cursor: string | null;
  completed_at: string | null;
}

export function advanceAuditCursor(
  current: AuditCursor | null,
  nextCursor: string | null,
  now: string
): AuditCursor {
  return {
    started_at: current?.started_at ?? now,
    cursor: nextCursor,
    completed_at: nextCursor === null ? now : null
  };
}

export function withAuditCursor(progress: Progress, name: string, cursor: AuditCursor): Progress {
  return { ...progress, cursors: { ...progress.cursors, [`audit:${name}`]: JSON.stringify(cursor) } };
}

export function auditCursorFromProgress(progress: Progress, name: string): AuditCursor | null {
  const raw = progress.cursors[`audit:${name}`];
  if (raw === null || raw === undefined) return null;
  try {
    const value = JSON.parse(raw) as Partial<AuditCursor>;
    if (typeof value.started_at !== "string" || !isNullableText(value.cursor) || !isNullableText(value.completed_at)) return null;
    return { started_at: value.started_at, cursor: value.cursor, completed_at: value.completed_at };
  } catch {
    return null;
  }
}

function isNullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function chooseQueue(
  last: "machine" | "human",
  machinePending: boolean,
  humanPending: boolean
): "machine" | "human" | null {
  if (machinePending && humanPending) return last === "machine" ? "human" : "machine";
  if (machinePending) return "machine";
  if (humanPending) return "human";
  return null;
}

export function parkActive(progress: Progress): Progress {
  if (Object.values(progress.effects).some((effect) => effect.state === "prepared" || effect.state === "uncertain")) {
    throw new Error("inflight_effects_not_drained");
  }
  if (!progress.active) return progress;
  return {
    ...progress,
    active: null,
    parked: [...progress.parked, progress.active]
  };
}
import type { Progress } from "./contract";
