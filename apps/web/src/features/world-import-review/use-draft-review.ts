import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteEntry,
  findEntry,
  markAiAccepted,
  markConflictResolved,
  parseDraft,
  updateEntry,
  type EntryEditPatch,
  type WorldImportDraft,
} from "./model.js";
import { WorldImportDraftStore } from "./draft-store.js";

/**
 * State owner for the review phase. There is no fixture fallback: the
 * review works on a draft that arrived through the import pipeline and was
 * saved locally. `empty` means nothing has been imported yet.
 *
 * Owner decisions are written straight into the canonical draft via the
 * contract helpers (markAiAccepted / markConflictResolved) — the draft is
 * the single source of review truth.
 */

export type ReviewLoadState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ready" };

export interface DraftReview {
  readonly loadState: ReviewLoadState;
  readonly draft: WorldImportDraft | null;
  readonly savedAt: string | null;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly discarding: boolean;
  editEntry(entryId: string, patch: EntryEditPatch): void;
  acceptAi(entryId: string): void;
  removeEntry(entryId: string): void;
  resolveConflict(entryId: string): void;
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
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  const draftRef = useRef<WorldImportDraft | null>(null);
  draftRef.current = draft;

  const applyLoaded = useCallback(
    (saved: { savedAt: string; draft: WorldImportDraft }) => {
      setDraft(saved.draft);
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

  const mutate = useCallback((next: WorldImportDraft) => {
    setDraft(next);
    setDirty(true);
  }, []);

  const editEntry = useCallback(
    (entryId: string, patch: EntryEditPatch) => {
      const current = draftRef.current;
      if (!current || !findEntry(current, entryId)) return;
      mutate(updateEntry(current, entryId, patch));
    },
    [mutate],
  );

  const acceptAi = useCallback(
    (entryId: string) => {
      const current = draftRef.current;
      if (!current || !findEntry(current, entryId)) return;
      mutate(markAiAccepted(current, entryId));
    },
    [mutate],
  );

  const resolveConflict = useCallback(
    (entryId: string) => {
      const current = draftRef.current;
      if (!current || !findEntry(current, entryId)) return;
      mutate(markConflictResolved(current, entryId));
    },
    [mutate],
  );

  const removeEntry = useCallback(
    (entryId: string) => {
      const current = draftRef.current;
      if (!current) return;
      mutate(deleteEntry(current, entryId));
    },
    [mutate],
  );

  const save = useCallback(async () => {
    const current = draftRef.current;
    if (!current) return;
    setSaving(true);
    try {
      const at = await store.save(current);
      setSavedAt(at);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [store]);

  const adopt = useCallback(
    async (adoptedDraft: WorldImportDraft) => {
      // Save immediately so a refresh right after import reopens the draft.
      const at = await store.save(adoptedDraft);
      applyLoaded({ savedAt: at, draft: adoptedDraft });
    },
    [store, applyLoaded],
  );

  const discard = useCallback(async () => {
    const current = draftRef.current;
    setDiscarding(true);
    try {
      if (current) {
        await store.clear(current.id);
      }
      setDraft(null);
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
    setSavedAt(null);
    setDirty(false);
    setLoadState({ status: "empty" });
  }, [store, setLoadState]);

  return {
    loadState,
    draft,
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
