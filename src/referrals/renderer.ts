import { parseReferralEnvelope, type ReferralEnvelope } from "../domain/referral";

export function renderReferralMarkdown(input: ReferralEnvelope): string {
  const referral = parseReferralEnvelope(input);
  const sourceRefs = referral.source_refs.length
    ? referral.source_refs.map((ref) => `  - ${yamlString(ref)}`).join("\n")
    : "  []";

  return `---\nschema_version: ${referral.schema_version}\nreferral_id: ${referral.referral_id}\nsource_project_id: ${referral.source_project_id}\ntarget_project_id: ${referral.target_project_id}\nreferral_type: ${referral.referral_type}\ntitle: ${yamlString(referral.title)}\ncreated_at: ${referral.created_at}\nsource_refs:\n${sourceRefs}\ncanonical: false\n---\n# ${referral.title}\n\n${referral.body}\n`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
