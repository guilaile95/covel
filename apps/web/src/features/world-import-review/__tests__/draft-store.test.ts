import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";
import { markAiAccepted, markConflictResolved } from "../model.js";
import { WorldImportDraftStore } from "../draft-store.js";
import { makeDraft } from "./model.test.js";

let dbCounter = 0;
function newStore() {
  dbCounter += 1;
  return new WorldImportDraftStore(`test-world-import-review-${dbCounter}`);
}

describe("WorldImportDraftStore", () => {
  it("persists canonical decision flags inside the draft", async () => {
    const store = newStore();
    const decided = markConflictResolved(
      markAiAccepted(makeDraft(), "ai-1"),
      "rule-1",
    );

    const savedAt = await store.save(decided);
    const reloaded = await store.loadLatest();

    expect(reloaded?.savedAt).toBe(savedAt);
    expect(
      reloaded?.draft.entries.find((entry) => entry.id === "ai-1")?.aiAccepted,
    ).toBe(true);
    expect(
      reloaded?.draft.entries.find((entry) => entry.id === "rule-1")
        ?.conflictResolved,
    ).toBe(true);
    expect(reloaded).not.toHaveProperty("decisions");
  });

  it("rejects a saved record that violates B's contract", async () => {
    const store = newStore();
    const draft = makeDraft();
    await store.save(draft);
    const db = (
      store as unknown as {
        db: { table: (name: string) => { put: (record: unknown) => Promise<void> } };
      }
    ).db.table("drafts");
    await db.put({
      draftId: draft.id,
      savedAt: new Date().toISOString(),
      draft: {
        ...draft,
        entries: [
          { ...draft.entries[0], type: "power_system" },
          ...draft.entries.slice(1),
        ],
      },
    });

    await expect(store.loadLatest()).rejects.toThrow(/contract validation/);
  });
});
