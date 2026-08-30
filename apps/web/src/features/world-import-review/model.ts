/**
 * Review-domain model over the frozen WorldImportDraft v0 contract.
 *
 * The contract itself lives in @covel/world-import (B's package) — this
 * module adds NO schema of its own. Owner review decisions (accept an AI
 * inference / mark a conflict resolved) are UI-layer state kept beside the
 * draft as id lists; they must survive save/reopen but are not part of the
 * frozen contract.
 */

import {
  applyUserEdit,
  loadDraft,
  DraftContractError,
  type UserEditPatch,
} from "@covel/world-import/contract";
import type {
  DraftEntry,
  EntryType,
  ProvenanceStatus,
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
} from "@covel/world-import/contract";

export function findEntry(
  draft: WorldImportDraft,
  entryId: string | null,
): DraftEntry | null {
  if (!entryId) return null;
  return draft.entries.find((entry) => entry.id === entryId) ?? null;
}

/** Owner decisions that must persist, keyed by entry id. */
export interface ReviewDecisions {
  /** Entry ids the owner explicitly accepted from the AI extraction. */
  acceptedAi: string[];
  /** Conflict entry ids the owner marked as resolved. */
  resolvedConflicts: string[];
}

export const EMPTY_DECISIONS: ReviewDecisions = {
  acceptedAi: [],
  resolvedConflicts: [],
};

export function normalizeDecisions(input: unknown): ReviewDecisions {
  const raw = (input ?? {}) as Partial<ReviewDecisions>;
  const stringIds = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : [];
  return {
    acceptedAi: stringIds(raw.acceptedAi),
    resolvedConflicts: stringIds(raw.resolvedConflicts),
  };
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

/** Content edits by the owner (name / aliases / content / conflict notes). */
export type EntryEditPatch = Pick<
  UserEditPatch,
  "name" | "aliases" | "content" | "conflictNotes"
>;

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

/** Decision lists without an entry that no longer exists. */
export function decisionsWithout(
  decisions: ReviewDecisions,
  entryId: string,
): ReviewDecisions {
  return {
    acceptedAi: decisions.acceptedAi.filter((id) => id !== entryId),
    resolvedConflicts: decisions.resolvedConflicts.filter(
      (id) => id !== entryId,
    ),
  };
}

export function isAiAccepted(
  entry: DraftEntry,
  decisions: ReviewDecisions,
): boolean {
  return decisions.acceptedAi.includes(entry.id);
}

export function isConflictResolved(
  entry: DraftEntry,
  decisions: ReviewDecisions,
): boolean {
  return decisions.resolvedConflicts.includes(entry.id);
}

/** Owner decision still open: an unaccepted AI inference or an unresolved conflict. */
export function isPending(
  entry: DraftEntry,
  decisions: ReviewDecisions,
): boolean {
  if (entry.provenanceStatus === "ai-inferred")
    return !isAiAccepted(entry, decisions);
  if (entry.provenanceStatus === "conflict") {
    return !isConflictResolved(entry, decisions);
  }
  return false;
}

/** One deterministic completion state per entry, for the list and the summary. */
export type EntryReviewStatus =
  "unreviewed" | "edited" | "ai-accepted" | "conflict-resolved";

export function entryReviewStatus(
  entry: DraftEntry,
  decisions: ReviewDecisions,
): EntryReviewStatus {
  if (
    entry.provenanceStatus === "conflict" &&
    isConflictResolved(entry, decisions)
  ) {
    return "conflict-resolved";
  }
  if (
    entry.provenanceStatus === "ai-inferred" &&
    isAiAccepted(entry, decisions)
  ) {
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

export function reviewCounts(
  draft: WorldImportDraft,
  decisions: ReviewDecisions,
): ReviewCounts {
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
      if (!isConflictResolved(entry, decisions))
        counts.unresolvedConflicts += 1;
    }
    if (entry.userEdited === true) counts.userEdited += 1;
    if (isPending(entry, decisions)) counts.pending += 1;
  }
  return counts;
}

export function countByType(
  draft: WorldImportDraft,
): Record<EntryType, number> {
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
  decisions: ReviewDecisions,
  filter: { type: EntryType | null; status: StatusFilter },
): DraftEntry[] {
  return draft.entries.filter((entry) => {
    if (filter.type && entry.type !== filter.type) return false;
    if (filter.status === "pending" && !isPending(entry, decisions))
      return false;
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
  return (
    draft.sources.find((source) => source.id === sourceId)?.title ?? sourceId
  );
}

export function decisionsKey(
  draft: WorldImportDraft,
  decisions: ReviewDecisions,
): string {
  return JSON.stringify({ id: draft.id, draft, decisions });
}
