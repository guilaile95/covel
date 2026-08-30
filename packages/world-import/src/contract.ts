/**
 * @covel/world-import/contract — the single source of truth for the
 * WorldImportDraft v0 contract.
 *
 * This entry is BROWSER-SAFE: it imports only types and pure functions
 * (no node:crypto, no fs, no ai-provider). C's review UI imports from here;
 * A's Prompt Play reads serialized drafts conforming to this contract.
 *
 * Contract v0 (frozen):
 *   WorldImportDraft { version: 0, id, title, sources[], summary, entries[] }
 *   Source  { id, file, kind: txt|md|epub, title? }
 *   Entry   { id, type: character|faction|location|item|rule|power|event|
 *             relationship, name, aliases[], content,
 *             provenanceStatus: source-backed|ai-inferred|conflict,
 *             sourceRefs[], conflictNotes?, userEdited?, aiAccepted?,
 *             conflictResolved? }
 *   SourceRef { sourceId, locator, quote? }
 *
 * Decision flags default to false when absent; once set they survive
 * serialize → load → edit → re-merge → export → load (no silent drops).
 */

export {
  DRAFT_VERSION,
  ENTRY_TYPES,
  PROVENANCE_STATUSES,
  type DraftEntry,
  type DraftSource,
  type EntryType,
  type ProvenanceStatus,
  type RawExtraction,
  type SourceKind,
  type SourceRef,
  type WorldImportDraft,
} from "./types.js";

export {
  applyUserEdit,
  DraftContractError,
  loadDraft,
  markAiAccepted,
  markConflictResolved,
  serializeDraft,
  setUserDecision,
  type UserEditPatch,
} from "./draft.js";
