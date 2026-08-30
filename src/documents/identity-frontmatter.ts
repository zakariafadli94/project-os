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

  const project = findScalar(frontmatter.lines, "project_id");
  const document = findScalar(frontmatter.lines, "document_id");
  if (project !== null && project !== identity.projectId) {
    throw new ManagedDocumentIdentityConflictError(
      "PROJECT_IDENTITY_MISMATCH",
      "project_id",
      identity.projectId,
      project
    );
  }
  if (document !== null && document !== identity.documentId) {
    throw new ManagedDocumentIdentityConflictError(
      "DOCUMENT_IDENTITY_MISMATCH",
      "document_id",
      identity.documentId,
      document
    );
  }
  if (project !== null && document !== null) return content;

  const additions: string[] = [];
  if (project === null) additions.push(`project_id: ${identity.projectId}`);
  if (document === null) additions.push(`document_id: ${identity.documentId}`);
  const enrichedLines = [frontmatter.lines[0], ...additions, ...frontmatter.lines.slice(1)];
  return `${enrichedLines.join(newline)}${frontmatter.rest}`;
}

export function assertManagedMarkdownIdentityIfPresent(
  content: string,
  identity: ManagedMarkdownIdentity
): void {
  if (!isMarkdownPath(identity.logicalPath)) return;
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const frontmatter = readFrontmatter(content, newline);
  if (!frontmatter) return;

  const project = findScalar(frontmatter.lines, "project_id");
  const document = findScalar(frontmatter.lines, "document_id");
  if (project !== null && project !== identity.projectId) {
    throw new ManagedDocumentIdentityConflictError(
      "PROJECT_IDENTITY_MISMATCH",
      "project_id",
      identity.projectId,
      project
    );
  }
  if (document !== null && document !== identity.documentId) {
    throw new ManagedDocumentIdentityConflictError(
      "DOCUMENT_IDENTITY_MISMATCH",
      "document_id",
      identity.documentId,
      document
    );
  }
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

function findScalar(lines: string[], key: string): string | null {
  const prefix = `${key}:`;
  for (const line of lines.slice(1, -1)) {
    if (!line.startsWith(prefix)) continue;
    const raw = line.slice(prefix.length).trim();
    return decodeScalar(raw);
  }
  return null;
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
