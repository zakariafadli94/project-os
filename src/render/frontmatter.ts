import type { ProjectState } from "../domain/project-state";

export function renderProjectFrontmatter(
  state: ProjectState,
  noteId: string,
  noteType: string
): string {
  return [
    "---",
    `project_id: ${yamlScalar(state.project_id)}`,
    `project_slug: ${yamlScalar(state.slug)}`,
    `project_name: ${yamlScalar(state.name)}`,
    `note_id: ${yamlScalar(noteId)}`,
    `note_type: ${yamlScalar(noteType)}`,
    "canonical: true",
    `revision: ${state.revision}`,
    "---",
    ""
  ].join("\n");
}

function yamlScalar(value: string): string {
  const simple = /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(value)
    && !/^(?:true|false|null|~|[-+]?\d+(?:\.\d+)?)$/i.test(value)
    && !value.includes(": ")
    && !value.includes(" #");
  return simple ? value : JSON.stringify(value);
}
