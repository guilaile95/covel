import { useCallback, useEffect, useRef, useState } from "react";
import {
  decisionsWithout,
  deleteEntry,
  EMPTY_DECISIONS,
  isAiAccepted,
  isConflictResolved,
  updateEntry,
  type EntryEditPatch,
  type ReviewDecisions,
  type WorldImportDraft,
} from "./model.js";
import { WorldImportDraftStore } from "./draft-store.js";

/**
 * State owner for the review phase. There is no fixture fallback any more:
 * the review works on a draft that arrived through the import pipeline and
 * was saved locally. `empty` means nothing has been imported yet.
 */

export type ReviewLoadState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ready" };

export interface DraftReview {
  readonly loadState: ReviewLoadState;
  readonly draft: WorldImportDraft | null;
  readonly decisions: ReviewDecisions;
  readonly savedAt: string | null;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly discarding: boolean;
  editEntry(entryId: string, patch: EntryEditPatch): void;
  acceptAi(entryId: string): void;
  removeEntry(entryId: string): void;
  resolveConflict(entryId: string, resolved: boolean): void;
  save(): Promise<void>;
  discard(): Promise<void>;
  /** Adopt a contract-valid draft produced by the import pipeline. */
  adopt(draft: WorldImportDraft): Promise<void>;
  /** Wipe the local review DB after a load-validation failure. */
  discardCorrupted(): Promise<void>;
}

export function useDraftReview(
  storeOverride?: WorldImportDraftStore,
): DraftReview {
  // Keep one store instance for the hook's lifetime: the load effect keys
  // off it, and a per-render default would restart that effect forever.
  const storeRef = useRef<WorldImportDraftStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = storeOverride ?? new WorldImportDraftStore();
  }
  const store = storeRef.current;

  const [loadState, setLoadState] = useState<ReviewLoadState>({
    status: "loading",
  });
  const [draft, setDraft] = useState<WorldImportDraft | null>(null);
  const [decisions, setDecisions] = useState<ReviewDecisions>(EMPTY_DECISIONS);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  const currentRef = useRef<{
    draft: WorldImportDraft | null;
    decisions: ReviewDecisions;
  }>({ draft: null, decisions: EMPTY_DECISIONS });
  currentRef.current = { draft, decisions };

  const applyLoaded = useCallback(
    (saved: {
      savedAt: string;
      draft: WorldImportDraft;
      decisions: ReviewDecisions;
    }) => {
      setDraft(saved.draft);
      setDecisions(saved.decisions);
      setSavedAt(saved.savedAt);
      setDirty(false);
      setLoadState({ status: "ready" });
    },
    [setLoadState],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const saved = await store.loadLatest();
        if (cancelled) return;
        if (saved) {
          applyLoaded(saved);
        } else {
          setLoadState({ status: "empty" });
        }
      } catch (error) {
        if (cancelled) return;
        setLoadState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store, applyLoaded]);

  const mutate = useCallback(
    (nextDraft: WorldImportDraft, nextDecisions: ReviewDecisions) => {
      setDraft(nextDraft);
      setDecisions(nextDecisions);
      setDirty(true);
    },
    [],
  );

  const editEntry = useCallback(
    (entryId: string, patch: EntryEditPatch) => {
      const current = currentRef.current;
      if (!current.draft) return;
      mutate(updateEntry(current.draft, entryId, patch), current.decisions);
    },
    [mutate],
  );

  const acceptAi = useCallback(
    (entryId: string) => {
      const current = currentRef.current;
      if (!current.draft) return;
      const entry = current.draft.entries.find((e) => e.id === entryId);
      if (!entry || entry.provenanceStatus !== "ai-inferred") return;
      if (isAiAccepted(entry, current.decisions)) return;
      mutate(current.draft, {
        ...current.decisions,
        acceptedAi: [...current.decisions.acceptedAi, entryId],
      });
    },
    [mutate],
  );

  const resolveConflict = useCallback(
    (entryId: string, resolved: boolean) => {
      const current = currentRef.current;
      if (!current.draft) return;
      const entry = current.draft.entries.find((e) => e.id === entryId);
      if (!entry || entry.provenanceStatus !== "conflict") return;
      if (isConflictResolved(entry, current.decisions) === resolved) return;
      const next = resolved
        ? [...current.decisions.resolvedConflicts, entryId]
        : current.decisions.resolvedConflicts.filter((id) => id !== entryId);
      mutate(current.draft, {
        ...current.decisions,
        resolvedConflicts: next,
      });
    },
    [mutate],
  );

  const removeEntry = useCallback(
    (entryId: string) => {
      const current = currentRef.current;
      if (!current.draft) return;
      mutate(
        deleteEntry(current.draft, entryId),
        decisionsWithout(current.decisions, entryId),
      );
    },
    [mutate],
  );

  const save = useCallback(async () => {
    const current = currentRef.current;
    if (!current.draft) return;
    setSaving(true);
    try {
      const at = await store.save(current.draft, current.decisions);
      setSavedAt(at);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [store]);

  const adopt = useCallback(
    async (adoptedDraft: WorldImportDraft) => {
      // Save immediately so a refresh right after import reopens the draft.
      const at = await store.save(adoptedDraft, EMPTY_DECISIONS);
      applyLoaded({
        savedAt: at,
        draft: adoptedDraft,
        decisions: EMPTY_DECISIONS,
      });
    },
    [store, applyLoaded],
  );

  const discard = useCallback(async () => {
    const current = currentRef.current;
    setDiscarding(true);
    try {
      if (current.draft) {
        await store.clear(current.draft.id);
      }
      setDraft(null);
      setDecisions(EMPTY_DECISIONS);
      setSavedAt(null);
      setDirty(false);
      setLoadState({ status: "empty" });
    } finally {
      setDiscarding(false);
    }
  }, [store, setLoadState]);

  const discardCorrupted = useCallback(async () => {
    await store.clearAll();
    setDraft(null);
    setDecisions(EMPTY_DECISIONS);
    setSavedAt(null);
    setDirty(false);
    setLoadState({ status: "empty" });
  }, [store, setLoadState]);

  return {
    loadState,
    draft,
    decisions,
    savedAt,
    dirty,
    saving,
    discarding,
    editEntry,
    acceptAi,
    removeEntry,
    resolveConflict,
    save,
    discard,
    adopt,
    discardCorrupted,
  };
}
