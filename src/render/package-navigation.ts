import type { PackageNavigation, PackageNavigationHead } from "../domain/document-package";

export function renderPackageNavigationLinks(navigation: PackageNavigation = {}): string {
  const links = (["WORKING", "REVIEW", "DELIVERABLES"] as const).filter((zone) => navigation[zone]).map((zone) => `- [[${zone}/CURRENT|${zone} current packages]]`);
  return links.length ? `\n## Current packages\n\n${links.join("\n")}\n` : "";
}
export function renderPackageIndex(head: PackageNavigationHead): string {
  return `# ${head.zone} current packages\n\nGeneration: ${head.generation}\n\n${head.packages.map(({ ref, root }) => `- [[${root}/INDEX|${ref.package_id} v${ref.version}]]`).join("\n")}\n`;
}
