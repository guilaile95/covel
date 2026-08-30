import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";
import { WorldImportDraftStore } from "../draft-store.js";
import { makeDraft } from "./model.test.js";

let dbCounter = 0;
function newStore() {
  dbCounter += 1;
  return new WorldImportDraftStore(`test-world-import-review-${dbCounter}`);
}

describe("WorldImportDraftStore", () => {
  it("returns null when nothing is stored", async () => {
    const store = newStore();
    expect(await store.loadLatest()).toBeNull();
  });

  it("saves and reloads the draft together with the review decisions", async () => {
    const store = newStore();
    const draft = makeDraft();
    const decisions = { acceptedAi: ["ai-1"], resolvedConflicts: ["rule-1"] };
    const savedAt = await store.save(draft, decisions);
    expect(typeof savedAt).toBe("string");

    const reloaded = await store.loadLatest();
    expect(reloaded).not.toBeNull();
    expect(reloaded?.savedAt).toBe(savedAt);
    expect(reloaded?.draft).toEqual(draft);
    expect(reloaded?.decisions).toEqual(decisions);
  });

  it("overwrites the record for the same draft id and loadLatest picks the newest", async () => {
    const store = newStore();
    const draft = makeDraft();
    await store.save(draft, { acceptedAi: [], resolvedConflicts: [] });
    const edited = {
      ...draft,
      entries: draft.entries.map((e) =>
        e.id === "char-1" ? { ...e, content: "主人改动" } : e,
      ),
    };
    const second = await store.save(edited, {
      acceptedAi: ["rel-1"],
      resolvedConflicts: [],
    });
    const reloaded = await store.loadLatest();
    expect(reloaded?.savedAt).toBe(second);
    expect(
      reloaded?.draft.entries.find((e) => e.id === "char-1")?.content,
    ).toBe("主人改动");
    expect(reloaded?.decisions.acceptedAi).toEqual(["rel-1"]);
  });

  it("normalizes junk decisions instead of rejecting them", async () => {
    const store = newStore();
    const draft = makeDraft();
    await store.save(draft, {
      acceptedAi: [42, "ai-1"] as unknown as string[],
      resolvedConflicts: undefined as unknown as string[],
    });
    const reloaded = await store.loadLatest();
    expect(reloaded?.decisions).toEqual({
      acceptedAi: ["ai-1"],
      resolvedConflicts: [],
    });
  });

  it("rejects a record that no longer satisfies the frozen contract", async () => {
    const store = newStore();
    const draft = makeDraft();
    await store.save(draft, { acceptedAi: [], resolvedConflicts: [] });
    // Corrupt the record behind Dexie's back: unknown entry type.
    const db = (
      store as unknown as {
        db: { table: (n: string) => { put: (r: unknown) => Promise<void> } };
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
      decisions: { acceptedAi: [], resolvedConflicts: [] },
    });
    await expect(store.loadLatest()).rejects.toThrow(/contract validation/);
  });

  it("clear removes the saved draft", async () => {
    const store = newStore();
    const draft = makeDraft();
    await store.save(draft, { acceptedAi: [], resolvedConflicts: [] });
    await store.clear(draft.id);
    expect(await store.load(draft.id)).toBeNull();
    expect(await store.loadLatest()).toBeNull();
  });
});
