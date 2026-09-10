import {
  AdmissionError,
  parseMutationContextOrNull,
  type MutationContext
} from "./mutation-context";

export interface AdmissionEnvelope<T> {
  admission_version: "1.0";
  request: T;
  mutation_context: MutationContext | null;
}

export function encodeAdmission<T>(request: T, context: MutationContext | null): AdmissionEnvelope<T> {
  return { admission_version: "1.0", request, mutation_context: context };
}

export function decodeAdmission<T>(raw: unknown, parse: (value: unknown) => T): AdmissionEnvelope<T> {
  if (raw && typeof raw === "object" && "admission_version" in raw) {
    const input = raw as Record<string, unknown>;
    const keys = Object.keys(input);
    if (
      input.admission_version !== "1.0"
      || !("request" in input)
      || !("mutation_context" in input)
      || keys.some((key) => !["admission_version", "request", "mutation_context"].includes(key))
    ) throw new AdmissionError("mutation_context_invalid", 428);
    return encodeAdmission(parse(input.request), parseMutationContextOrNull(input.mutation_context));
  }
  return encodeAdmission(parse(raw), null);
}
