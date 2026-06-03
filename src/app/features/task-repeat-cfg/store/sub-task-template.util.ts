/**
 * Shared comparison of the user-visible content of a single subtask against a
 * repeat-cfg subtask template. Used both when deciding whether stored subtask
 * templates need re-syncing and when detecting whether an overdue repeat
 * instance was edited by the user before cleanup. Notes are trimmed so a stray
 * leading/trailing whitespace difference does not count as a content change.
 */
export interface SubTaskTemplateContent {
  title: string;
  timeEstimate?: number | null;
  notes?: string | null;
}

const _normalizeNotes = (v: string | null | undefined): string => (v ?? '').trim();

export const isSameSubTaskTemplateContent = (
  a: SubTaskTemplateContent,
  b: SubTaskTemplateContent,
): boolean =>
  a.title === b.title &&
  (a.timeEstimate ?? 0) === (b.timeEstimate ?? 0) &&
  _normalizeNotes(a.notes) === _normalizeNotes(b.notes);
