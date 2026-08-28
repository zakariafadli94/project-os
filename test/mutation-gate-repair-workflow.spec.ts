import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflowPath = fileURLToPath(new URL("../.github/workflows/mutation-candidate-reject.yml", import.meta.url));

const expectedCandidates = [
  "MUTCAND-A546CDBE7CF04684BD3A0C80",
  "MUTCAND-5A8935635AAEB09CCF1ABA29",
  "MUTCAND-A0F80BD3D82FED5C45DA472F",
  "MUTCAND-40BE82147A4DDA2B277AA2EE",
  "MUTCAND-F70FB05673E9F63940717150",
  "MUTCAND-A0FF170F4D6D3412953AFACB",
  "MUTCAND-D95D6E3FD68ACD3A2B93DB3A",
  "MUTCAND-34C0FA6FF7DA80ACDA79EA88"
];

describe("MutationGate candidate reject operator workflow", () => {
  it("is manual-only and fails closed around the authenticated reject ingress", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s*push:/m);
    expect(workflow).not.toMatch(/^\s*pull_request:/m);
    expect(workflow).toContain("PROJECT_OS_INGRESS_TOKEN");
    expect(workflow).toContain("/v1/mutation-candidates/resolve");
    expect(workflow).toContain('"operation":"candidate.reject"');
    expect(workflow).toContain('"status":"committed"');
    expect(workflow).toContain('"action":"reject"');
    expect(workflow).toContain("confirm_reject");
    expect(workflow).toContain("candidate_ids_json");
    expect(workflow).not.toContain("dropbox");

    for (const candidateId of expectedCandidates) {
      expect(workflow).toContain(candidateId);
    }
  });
});
