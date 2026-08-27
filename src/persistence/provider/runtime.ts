import type { ProjectOsPersistenceRuntime } from "./capabilities";

export type PersistenceInput = ProjectOsPersistenceRuntime;

export function asProjectOsPersistence(input: PersistenceInput): ProjectOsPersistenceRuntime {
  return input;
}
