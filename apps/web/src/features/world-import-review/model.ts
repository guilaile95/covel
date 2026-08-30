/**
 * Review-domain view over the canonical WorldImportDraft.
 *
 * The contract, its decision flags (`aiAccepted` / `conflictResolved`) and
 * the decision mutations (`markAiAccepted` / `markConflictResolved`) all
 * live in @covel/world-import/contract — B's package. This module adds NO
 * schema and NO second decision state: the draft itself is the single
 * source of review truth.
 */

import {
  applyUserEdit,
  loadDraft,
  DraftContractError,
  type UserEditPatch,
} from "@covel/world-import/contract";
import type {
  DraftEntry,
  DraftSource,
  EntryType,
  ProvenanceStatus,
  SourceRef,
  WorldImportDraft,
} from "@covel/world-import/contract";

export type {
  DraftEntry,
  DraftSource,
  EntryType,
  ProvenanceStatus,
  SourceRef,
  WorldImportDraft,
} from "@covel/world-import/contract";
export {
  DRAFT_VERSION,
  ENTRY_TYPES,
  PROVENANCE_STATUSES,
  markAiAccepted,
  markConflictResolved,
} from "@covel/world-import/contract";

export function findEntry(
  draft: WorldImportDraft,
  entryId: string | null,
): DraftEntry | null {
  if (!entryId) return null;
  return draft.entries.find((entry) => entry.id === entryId) ?? null;
}

/** Parse + validate any external draft against the frozen contract. */
export function parseDraft(
  input: unknown,
): { ok: true; draft: WorldImportDraft } | { ok: false; error: string } {
  try {
    return { ok: true, draft: loadDraft(JSON.stringify(input)) };
  } catch (error) {
    if (error instanceof DraftContractError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: String(error) };
  }
}

/**
 * Content edits by the owner. `conflictNotes` is intentionally NOT here:
 * v0 conflict notes are a machine-generated resolution fingerprint, shown
 * read-only in the UI; the resolve action writes through
 * markConflictResolved instead.
 */
export type EntryEditPatch = Pick<UserEditPatch, "name" | "aliases" | "content">;

export function updateEntry(
  draft: WorldImportDraft,
  entryId: string,
  patch: EntryEditPatch,
): WorldImportDraft {
  return applyUserEdit(draft, entryId, patch);
}

export function deleteEntry(
  draft: WorldImportDraft,
  entryId: string,
): WorldImportDraft {
  return {
    ...draft,
    entries: draft.entries.filter((entry) => entry.id !== entryId),
  };
}

export function isAiAccepted(entry: DraftEntry): boolean {
  return entry.aiAccepted === true;
}

export function isConflictResolved(entry: DraftEntry): boolean {
  return entry.conflictResolved === true;
}

/** Owner decision still open: an unaccepted AI inference or an unresolved conflict. */
export function isPending(entry: DraftEntry): boolean {
  if (entry.provenanceStatus === "ai-inferred") return !isAiAccepted(entry);
  if (entry.provenanceStatus === "conflict") {
    return !isConflictResolved(entry);
  }
  return false;
}

/** One deterministic completion state per entry, for the list and the summary. */
export type EntryReviewStatus =
  | "unreviewed"
  | "edited"
  | "ai-accepted"
  | "conflict-resolved";

export function entryReviewStatus(entry: DraftEntry): EntryReviewStatus {
  if (entry.provenanceStatus === "conflict" && isConflictResolved(entry)) {
    return "conflict-resolved";
  }
  if (entry.provenanceStatus === "ai-inferred" && isAiAccepted(entry)) {
    return "ai-accepted";
  }
  if (entry.userEdited === true) return "edited";
  return "unreviewed";
}

export interface ReviewCounts {
  total: number;
  sourceBacked: number;
  aiInferred: number;
  conflict: number;
  unresolvedConflicts: number;
  userEdited: number;
  pending: number;
}

export function reviewCounts(draft: WorldImportDraft): ReviewCounts {
  const counts: ReviewCounts = {
    total: draft.entries.length,
    sourceBacked: 0,
    aiInferred: 0,
    conflict: 0,
    unresolvedConflicts: 0,
    userEdited: 0,
    pending: 0,
  };
  for (const entry of draft.entries) {
    if (entry.provenanceStatus === "source-backed") counts.sourceBacked += 1;
    if (entry.provenanceStatus === "ai-inferred") counts.aiInferred += 1;
    if (entry.provenanceStatus === "conflict") {
      counts.conflict += 1;
      if (!isConflictResolved(entry)) counts.unresolvedConflicts += 1;
    }
    if (entry.userEdited === true) counts.userEdited += 1;
    if (isPending(entry)) counts.pending += 1;
  }
  return counts;
}

export function countByType(draft: WorldImportDraft): Record<EntryType, number> {
  const counts = {
    character: 0,
    faction: 0,
    location: 0,
    item: 0,
    rule: 0,
    power: 0,
    event: 0,
    relationship: 0,
  } as Record<EntryType, number>;
  for (const entry of draft.entries) {
    counts[entry.type] += 1;
  }
  return counts;
}

/** Status filter alongside the category filter. */
export type StatusFilter = "all" | "pending" | "ai-inferred" | "conflict";

export function filterEntries(
  draft: WorldImportDraft,
  filter: { type: EntryType | null; status: StatusFilter },
): DraftEntry[] {
  return draft.entries.filter((entry) => {
    if (filter.type && entry.type !== filter.type) return false;
    if (filter.status === "pending" && !isPending(entry)) return false;
    if (
      filter.status === "ai-inferred" &&
      entry.provenanceStatus !== "ai-inferred"
    ) {
      return false;
    }
    if (filter.status === "conflict" && entry.provenanceStatus !== "conflict") {
      return false;
    }
    return true;
  });
}

export function resolveSourceTitle(
  draft: WorldImportDraft,
  sourceId: string,
): string {
  const source = draft.sources.find((s) => s.id === sourceId);
  return source?.title ?? source?.file ?? sourceId;
}
