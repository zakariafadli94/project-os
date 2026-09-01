export type ManagedDocumentIdentityConflictCode =
  | "PROJECT_IDENTITY_MISMATCH"
  | "DOCUMENT_IDENTITY_MISMATCH";

export class ManagedDocumentIdentityConflictError extends Error {
  readonly code: ManagedDocumentIdentityConflictCode;
  readonly field: "project_id" | "document_id";
  readonly expected: string;
  readonly actual: string;

  constructor(
    code: ManagedDocumentIdentityConflictCode,
    field: "project_id" | "document_id",
    expected: string,
    actual: string
  ) {
    super(`Managed document ${field} mismatch: expected ${expected}, got ${actual}`);
    this.name = "ManagedDocumentIdentityConflictError";
    this.code = code;
    this.field = field;
    this.expected = expected;
    this.actual = actual;
  }
}

export interface ManagedMarkdownIdentity {
  projectId: string;
  documentId: string;
  logicalPath: string;
}

export interface VisibleManagedMarkdownIdentity {
  projectId?: string;
  documentId?: string;
}

export function enforceManagedMarkdownIdentity(
  content: string,
  identity: ManagedMarkdownIdentity
): string {
  if (!isMarkdownPath(identity.logicalPath)) return content;

  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const frontmatter = readFrontmatter(content, newline);
  if (!frontmatter) {
    return [
      "---",
      `project_id: ${identity.projectId}`,
      `document_id: ${identity.documentId}`,
      "---",
      content
    ].join(newline);
  }

  const projects = findScalars(frontmatter.lines, "project_id");
  const documents = findScalars(frontmatter.lines, "document_id");
  assertAllIdentityValues(projects, "PROJECT_IDENTITY_MISMATCH", "project_id", identity.projectId);
  assertAllIdentityValues(documents, "DOCUMENT_IDENTITY_MISMATCH", "document_id", identity.documentId);

  const project = projects[0] ?? null;
  const document = documents[0] ?? null;
  if (project !== null && document !== null) return content;

  const additions: string[] = [];
  if (project === null) additions.push(`project_id: ${identity.projectId}`);
  if (document === null) additions.push(`document_id: ${identity.documentId}`);
  const enrichedLines = [frontmatter.lines[0], ...additions, ...frontmatter.lines.slice(1)];
  return `${enrichedLines.join(newline)}${frontmatter.rest}`;
}

export function readManagedMarkdownIdentity(
  content: string,
  logicalPath: string
): VisibleManagedMarkdownIdentity | null {
  if (!isMarkdownPath(logicalPath)) return null;
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const frontmatter = readFrontmatter(content, newline);
  if (!frontmatter) return null;

  const projects = findScalars(frontmatter.lines, "project_id");
  const documents = findScalars(frontmatter.lines, "document_id");
  const projectId = uniqueScalar(projects, "project_id");
  const documentId = uniqueScalar(documents, "document_id");
  if (projectId === undefined && documentId === undefined) return null;
  return {
    ...(projectId !== undefined ? { projectId } : {}),
    ...(documentId !== undefined ? { documentId } : {})
  };
}

export function assertManagedMarkdownIdentityIfPresent(
  content: string,
  identity: ManagedMarkdownIdentity
): void {
  if (!isMarkdownPath(identity.logicalPath)) return;
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const frontmatter = readFrontmatter(content, newline);
  if (!frontmatter) return;

  assertAllIdentityValues(
    findScalars(frontmatter.lines, "project_id"),
    "PROJECT_IDENTITY_MISMATCH",
    "project_id",
    identity.projectId
  );
  assertAllIdentityValues(
    findScalars(frontmatter.lines, "document_id"),
    "DOCUMENT_IDENTITY_MISMATCH",
    "document_id",
    identity.documentId
  );
}

function isMarkdownPath(logicalPath: string): boolean {
  return logicalPath.toLowerCase().endsWith(".md");
}

function readFrontmatter(
  content: string,
  newline: "\n" | "\r\n"
): { lines: string[]; rest: string } | null {
  if (!content.startsWith(`---${newline}`)) return null;
  const closing = `${newline}---${newline}`;
  const end = content.indexOf(closing, 3 + newline.length);
  if (end < 0) return null;
  const closeEnd = end + closing.length;
  return {
    lines: content.slice(0, end + newline.length + 3).split(newline),
    rest: content.slice(closeEnd - newline.length)
  };
}

function findScalars(lines: string[], key: string): string[] {
  const prefix = `${key}:`;
  const values: string[] = [];
  for (const line of lines.slice(1, -1)) {
    if (!line.startsWith(prefix)) continue;
    const raw = line.slice(prefix.length).trim();
    values.push(decodeScalar(raw));
  }
  return values;
}

function uniqueScalar(values: string[], field: string): string | undefined {
  if (values.length === 0) return undefined;
  const first = values[0];
  if (values.some((value) => value !== first)) {
    throw new Error(`Managed document ${field} frontmatter contains contradictory values`);
  }
  return first;
}

function assertAllIdentityValues(
  values: string[],
  code: ManagedDocumentIdentityConflictCode,
  field: "project_id" | "document_id",
  expected: string
): void {
  const conflicting = values.find((value) => value !== expected);
  if (conflicting === undefined) return;
  throw new ManagedDocumentIdentityConflictError(code, field, expected, conflicting);
}

function decodeScalar(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Fall through to literal comparison so malformed YAML fails closed.
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}
