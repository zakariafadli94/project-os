import {
  asProjectOsPersistence,
  type PersistenceInput
} from "../persistence/compatibility/legacy-dropbox-runtime";
import { machineEventPath, machineReceiptPath, machineTransactionPath } from "../persistence/layout";
import { assertSafeProjectId, assertSafeSlug, PROJECT_OS_ROOT, projectRoot } from "../persistence/paths";
import type { ObjectPersistence } from "../persistence/provider/contract";
import { ProviderConflictError } from "../persistence/provider/errors";

export type MigrationInput = ObjectPersistence | PersistenceInput;

export async function mirrorImmutableFile(
  input: MigrationInput,
  sourcePath: string,
  destinationPath: string
): Promise<void> {
  const objects = migrationObjects(input);
  const content = await objects.readText(sourcePath);
  if (content === null) throw new Error(`Legacy migration source missing: ${sourcePath}`);

  try {
    await objects.createText(destinationPath, content);
  } catch (error) {
    if (!(error instanceof ProviderConflictError)) throw error;
    const existing = await objects.readText(destinationPath);
    if (existing !== content) {
      throw new Error(`Migration conflict with different immutable content: ${destinationPath}`);
    }
  }
}

export async function mirrorLegacyEvents(
  input: MigrationInput,
  projectId: string,
  slug: string
): Promise<{ mirrored: number }> {
  const objects = migrationObjects(input);
  const safeProjectId = assertSafeProjectId(projectId);
  const safeSlug = assertSafeSlug(slug);
  const legacyEventsRoot = `${projectRoot(safeProjectId, safeSlug)}/.system/events`;
  const entries = await objects.listChildren(legacyEventsRoot);
  let mirrored = 0;

  for (const entry of entries
    .filter((item) => item.kind === "file" && /^EVT-[0-9]{6,}\.json$/.test(item.name))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const sourcePath = entry.path;
    if (!sourcePath) continue;
    const eventId = entry.name.replace(/\.json$/, "");
    await mirrorImmutableFile(objects, sourcePath, machineEventPath(safeProjectId, eventId));
    mirrored += 1;
  }

  return { mirrored };
}

export async function mirrorLegacyLedger(
  input: MigrationInput
): Promise<{ transactions: number; receipts: number }> {
  const objects = migrationObjects(input);
  let transactions = 0;
  let receipts = 0;

  for (const status of ["committed", "rejected", "conflicts"] as const) {
    const legacyRoot = `${PROJECT_OS_ROOT}/TRANSACTIONS/${status}`;
    const entries = await objects.listChildren(legacyRoot);

    for (const entry of entries
      .filter((item) => item.kind === "file" && /^TXN-[A-Z0-9-]{10,}(?:\.source)?\.json$/.test(item.name))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const sourcePath = entry.path;
      if (!sourcePath) continue;
      const isSourceArtifact = entry.name.endsWith(".source.json");
      const transactionId = entry.name.replace(/(?:\.source)?\.json$/, "");
      const terminalPath = machineTransactionPath(status, transactionId);
      const destinationPath = isSourceArtifact
        ? terminalPath.replace(/\.json$/, ".source.json")
        : terminalPath;
      await mirrorImmutableFile(objects, sourcePath, destinationPath);
      if (!isSourceArtifact) transactions += 1;
    }
  }

  const receiptEntries = await objects.listChildren(`${PROJECT_OS_ROOT}/RECEIPTS`);
  for (const entry of receiptEntries
    .filter((item) => item.kind === "file" && /^TXN-[A-Z0-9-]{10,}\.json$/.test(item.name))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const sourcePath = entry.path;
    if (!sourcePath) continue;
    const transactionId = entry.name.replace(/\.json$/, "");
    await mirrorImmutableFile(objects, sourcePath, machineReceiptPath(transactionId));
    receipts += 1;
  }

  return { transactions, receipts };
}

function migrationObjects(input: MigrationInput): ObjectPersistence {
  return isObjectPersistence(input)
    ? input
    : asProjectOsPersistence(input).objects;
}

function isObjectPersistence(input: MigrationInput): input is ObjectPersistence {
  return typeof input === "object"
    && input !== null
    && "readText" in input
    && "createText" in input
    && "listChildren" in input;
}
