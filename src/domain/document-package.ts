import { z } from "zod";
import { assertManagedRelativePath } from "./managed-document";
import { canonicalJson, compareCodePoints } from "../rules/contract";
import { sha256Text } from "../documents/hash";

const projectId = z.string().regex(/^PRJ-[0-9]{4,}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z.string().transform((value) => assertManagedRelativePath(value));
export const packageRefSchema = z.strictObject({ project_id: projectId, package_id: z.string().regex(/^PKG-[A-F0-9]{64}$/), version: z.number().int().positive().safe(), manifest_sha256: hash });
export type PackageRef = z.infer<typeof packageRefSchema>;
export const packageZoneSchema = z.enum(["WORKING", "REVIEW", "DELIVERABLES"]);
export type PackageZone = z.infer<typeof packageZoneSchema>;
const manifestSchema = z.strictObject({
  schema_version: z.literal("1.0"), project_id: projectId,
  creation_request_id: z.string().regex(/^[A-Z][A-Z0-9-]{7,}$/),
  version: z.number().int().positive().safe(), predecessor: packageRefSchema.optional(),
  members: z.array(z.strictObject({ relative_path: relative, document_id: z.string().regex(/^DOC-[A-F0-9]{24}$/), document_version_id: z.string().regex(/^VER-(?:EXT|REQ)-[A-F0-9]{24}$/), immutable_payload_path: z.string().min(1), content_sha256: hash, size: z.number().int().nonnegative().safe() })).min(1),
  links: z.array(z.strictObject({ from_relative_path: relative, target_relative_path: relative })),
  source_refs: z.array(z.string().min(1)).min(1), created_by: z.string().min(1), created_at: z.string().datetime({ offset: true })
});
export type FrozenPackageManifest = z.infer<typeof manifestSchema>;
export function parsePackageManifest(value: unknown): FrozenPackageManifest {
  const manifest = manifestSchema.parse(value);
  const paths = new Set(manifest.members.map((m) => m.relative_path.toLowerCase()));
  if (paths.size !== manifest.members.length || new Set(manifest.members.map((m) => m.document_id)).size !== manifest.members.length) throw new Error("package_duplicate_member");
  for (const member of manifest.members) {
    if (member.relative_path.toLowerCase() === "index.md") throw new Error("package_reserved_member");
    if (!member.immutable_payload_path.startsWith(`/PROJECT_OS/.project-os/projects/${manifest.project_id}/documents/payloads/`) || /(?:^|\/)\.\.(?:\/|$)/.test(member.immutable_payload_path)) throw new Error("package_payload_namespace");
  }
  for (const link of manifest.links) if (!manifest.members.some((m) => m.relative_path === link.from_relative_path) || !manifest.members.some((m) => m.relative_path === link.target_relative_path)) throw new Error("package_missing_link");
  manifest.members.sort((a, b) => compareCodePoints(a.relative_path, b.relative_path));
  manifest.links.sort((a, b) => compareCodePoints(canonicalJson(a), canonicalJson(b)));
  return manifest;
}
export async function packageIdFor(projectIdValue: string, creationRequestId: string): Promise<string> {
  projectId.parse(projectIdValue);
  return `PKG-${(await sha256Text(canonicalJson([projectIdValue, creationRequestId]))).toUpperCase()}`;
}
export function packageManifestPath(ref: Pick<PackageRef, "project_id" | "package_id" | "version">): string {
  return `/PROJECT_OS/.project-os/projects/${ref.project_id}/documents/packages/${ref.package_id}/versions/${ref.version}.json`;
}
export function packageResourceVersion(ref: PackageRef): string { return `${ref.version}:${ref.manifest_sha256}`; }

export const packageNavigationSchema = z.strictObject({
  schema_version: z.literal("1.0"), project_id: projectId, zone: packageZoneSchema,
  generation: z.number().int().positive().safe(), source_request_id: z.string().min(1),
  packages: z.array(z.strictObject({ ref: packageRefSchema, root: z.string().min(1) }))
});
export type PackageNavigationHead = z.infer<typeof packageNavigationSchema>;
export type PackageNavigation = Partial<Record<PackageZone, PackageNavigationHead>>;
export const packageNavigationLedgerSchema = z.strictObject({
  schema_version: z.literal("1.0"), project_id: projectId, source_request_id: z.string().min(1),
  visible_members: z.array(z.strictObject({ path: z.string().min(1), provider_id: z.string().min(1), object_id: z.string().min(1), revision_token: z.string().min(1), content_sha256: hash })).optional(),
  heads: z.strictObject({ WORKING: packageNavigationSchema.optional(), REVIEW: packageNavigationSchema.optional(), DELIVERABLES: packageNavigationSchema.optional() })
});
export function packageNavigationPath(projectIdValue: string): string {
  projectId.parse(projectIdValue);
  return `/PROJECT_OS/.project-os/projects/${projectIdValue}/documents/packages/navigation.json`;
}
