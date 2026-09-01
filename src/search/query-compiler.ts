import { searchQuerySchema } from "./contract";

const TOKEN_PATTERN = /[\p{L}\p{N}]+(?:[_-][\p{L}\p{N}]+)*/gu;
const MAX_LEXICAL_TERMS = 32;

export function lexicalQueryTerms(text: string): string[] {
  const bounded = searchQuerySchema.shape.text.parse(text)?.trim() ?? "";
  if (!bounded) return [];
  return (bounded.match(TOKEN_PATTERN) ?? []).slice(0, MAX_LEXICAL_TERMS);
}

export function compileLexicalQuery(text: string): string | null {
  const terms = lexicalQueryTerms(text);
  if (terms.length === 0) return null;
  return terms
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}
