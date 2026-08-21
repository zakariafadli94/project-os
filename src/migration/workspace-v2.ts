import {
  DropboxConflictError,
  type DropboxEntry,
  type DropboxTransport
} from "../dropbox/client";
import { machineEventPath, machineReceiptPath, machineTransactionPath } from "../dropbox/layout";
import { assertSafeProjectId, assertSafeSlug, PROJECT_OS_ROOT, projectRoot } from "../dropbox/paths";

export interface MigrationTransport extends DropboxTransport {
  listFolder(path: string): Promise<DropboxEntry[]>;
}

export async function mirrorImmutableFile(
  transport: DropboxTransport,
  sourcePath: string,
  destinationPath: string
): Promise<void> {
  const content = await transport.download(sourcePath);
  if (content === null) throw new Error(`Legacy migration source missing: ${sourcePath}`);

  try {
    await transport.upload(destinationPath, content, "add");
  } catch (error) {
    if (!(error instanceof DropboxConflictError)) throw error;
    const existing = await transport.download(destinationPath);
    if (existing !== content) {
      throw new Error(`Migration conflict with different immutable content: ${destinationPath}`);
    }
  }
}

export async function mirrorLegacyEvents(
  transport: MigrationTransport,
  projectId: string,
  slug: string
): Promise<{ mirrored: number }> {
  const safeProjectId = assertSafeProjectId(projectId);
  const safeSlug = assertSafeSlug(slug);
  const legacyEventsRoot = `${projectRoot(safeProjectId, safeSlug)}/.system/events`;
  const entries = await transport.listFolder(legacyEventsRoot);
  let mirrored = 0;

  for (const entry of entries
    .filter((item) => item.tag === "file" && /^EVT-[0-9]{6,}\.json$/.test(item.name))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const sourcePath = entry.path_display;
    if (!sourcePath) continue;
    const eventId = entry.name.replace(/\.json$/, "");
    await mirrorImmutableFile(transport, sourcePath, machineEventPath(safeProjectId, eventId));
    mirrored += 1;
  }

  return { mirrored };
}

export async function mirrorLegacyLedger(
  transport: MigrationTransport
): Promise<{ transactions: number; receipts: number }> {
  let transactions = 0;
  let receipts = 0;

  for (const status of ["committed", "rejected", "conflicts"] as const) {
    const legacyRoot = `${PROJECT_OS_ROOT}/TRANSACTIONS/${status}`;
    const entries = await transport.listFolder(legacyRoot);

    for (const entry of entries
      .filter((item) => item.tag === "file" && /^TXN-[A-Z0-9-]{10,}\.json$/.test(item.name))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const sourcePath = entry.path_display;
      if (!sourcePath) continue;
      const transactionId = entry.name.replace(/\.json$/, "");
      await mirrorImmutableFile(transport, sourcePath, machineTransactionPath(status, transactionId));
      transactions += 1;
    }
  }

  const receiptEntries = await transport.listFolder(`${PROJECT_OS_ROOT}/RECEIPTS`);
  for (const entry of receiptEntries
    .filter((item) => item.tag === "file" && /^TXN-[A-Z0-9-]{10,}\.json$/.test(item.name))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const sourcePath = entry.path_display;
    if (!sourcePath) continue;
    const transactionId = entry.name.replace(/\.json$/, "");
    await mirrorImmutableFile(transport, sourcePath, machineReceiptPath(transactionId));
    receipts += 1;
  }

  return { transactions, receipts };
}
