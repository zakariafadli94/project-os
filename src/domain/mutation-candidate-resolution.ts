import { z } from "zod";
import { artifactWriteRequestSchema } from "./artifact-write";
import { managedDocumentRequestSchema } from "./managed-document-request";
import {
  mutationCandidateIdSchema,
  mutationResolutionIdSchema,
  projectIdSchema
} from "./mutation-gate";

const adoptArtifactSchema = z.strictObject({
  operation: z.literal("candidate.adopt_artifact"),
  resolution_id: mutationResolutionIdSchema,
  project_id: projectIdSchema,
  candidate_id: mutationCandidateIdSchema,
  artifact_request: artifactWriteRequestSchema
});

const adoptWorkingSchema = z.strictObject({
  operation: z.literal("candidate.adopt_working"),
  resolution_id: mutationResolutionIdSchema,
  project_id: projectIdSchema,
  candidate_id: mutationCandidateIdSchema,
  document_request: managedDocumentRequestSchema
});

const rejectSchema = z.strictObject({
  operation: z.literal("candidate.reject"),
  resolution_id: mutationResolutionIdSchema,
  project_id: projectIdSchema,
  candidate_id: mutationCandidateIdSchema
});

export const mutationCandidateResolutionRequestSchema = z
  .discriminatedUnion("operation", [adoptArtifactSchema, adoptWorkingSchema, rejectSchema])
  .superRefine((value, ctx) => {
    if (value.operation === "candidate.adopt_artifact" && value.artifact_request.project_id !== value.project_id) {
      ctx.addIssue({
        code: "custom",
        path: ["artifact_request", "project_id"],
        message: "Candidate artifact adoption must stay inside the bound project"
      });
    }
    if (value.operation === "candidate.adopt_working") {
      if (value.document_request.project_id !== value.project_id) {
        ctx.addIssue({
          code: "custom",
          path: ["document_request", "project_id"],
          message: "Candidate working adoption must stay inside the bound project"
        });
      }
      if (value.document_request.operation !== "working.write") {
        ctx.addIssue({
          code: "custom",
          path: ["document_request", "operation"],
          message: "Candidate working adoption requires working.write"
        });
      }
    }
  });

export type MutationCandidateResolutionRequest = z.infer<typeof mutationCandidateResolutionRequestSchema>;
export type MutationCandidateAdoptArtifactRequest = Extract<
  MutationCandidateResolutionRequest,
  { operation: "candidate.adopt_artifact" }
>;
export type MutationCandidateAdoptWorkingRequest = Extract<
  MutationCandidateResolutionRequest,
  { operation: "candidate.adopt_working" }
>;

export function parseMutationCandidateResolutionRequest(input: unknown): MutationCandidateResolutionRequest {
  return mutationCandidateResolutionRequestSchema.parse(input);
}
