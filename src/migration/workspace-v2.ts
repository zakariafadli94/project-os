import {
  DropboxConflictError,
  type DropboxEntry,
  type DropboxTransport
} from "../dropbox/client";
import { machineEventPath } from "../dropbox/layout";
import { assertSafeProjectId, assertSafeSlug, projectRoot } from "../dropbox/paths";

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
