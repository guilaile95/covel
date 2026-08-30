import { describe, expect, it } from "vitest";
import {
  applyUserEdit,
  DraftContractError,
  loadDraft,
  serializeDraft,
} from "../src/draft.js";
import { findEntry, runFixturePipeline } from "./helpers.js";

describe("draft serialization", () => {
  it("round-trips through serialize/load without loss", async () => {
    const { draft } = await runFixturePipeline({});
    const restored = loadDraft(serializeDraft(draft));
    expect(restored).toEqual(draft);
  });

  it("rejects wrong versions and malformed entries", () => {
    const base = {
      version: 0,
      id: "x",
      title: "t",
      sources: [],
      summary: "",
      entries: [],
    };
    expect(() => loadDraft(JSON.stringify({ ...base, version: 1 }))).toThrow(
      DraftContractError,
    );
    expect(() =>
      loadDraft(
        JSON.stringify({
          ...base,
          entries: [
            {
              id: "e",
              type: "dragon",
              name: "n",
              aliases: [],
              content: "c",
              provenanceStatus: "source-backed",
              sourceRefs: [],
            },
          ],
        }),
      ),
    ).toThrow(/unknown entry type/);
    expect(() =>
      loadDraft(
        JSON.stringify({
          ...base,
          entries: [
            {
              id: "e",
              type: "item",
              name: "n",
              aliases: [],
              provenanceStatus: "source-backed",
              sourceRefs: [],
            },
          ],
        }),
      ),
    ).toThrow(DraftContractError);
  });
});

describe("user edits", () => {
  it("stamps userEdited and never mutates the input draft", async () => {
    const { draft } = await runFixturePipeline({});
    const shenDuo = findEntry(draft, "沈铎");
    const edited = applyUserEdit(draft, shenDuo.id, {
      content: "沈铎，北岭守塔人。年龄与立场已人工核定。",
    });

    expect(edited).not.toBe(draft);
    expect(findEntry(edited, "沈铎").userEdited).toBe(true);
    expect(findEntry(edited, "沈铎").content).toContain("人工核定");
    // original untouched
    expect(findEntry(draft, "沈铎").userEdited).toBeUndefined();

    // survives serialization
    const restored = loadDraft(serializeDraft(edited));
    expect(findEntry(restored, "沈铎").userEdited).toBe(true);
  });

  it("keeps userEdited entries verbatim across a re-merge", async () => {
    const first = await runFixturePipeline({});
    const shenDuo = findEntry(first.draft, "沈铎");
    const edited = applyUserEdit(first.draft, shenDuo.id, {
      content: "人工定稿：沈铎是北岭的守塔人。",
    });

    // Re-run the same import on top of the edited draft: the incoming
    // extractions for 沈铎 must be dropped, not merged over the edit.
    const second = await runFixturePipeline({ existingDraft: edited });
    const after = findEntry(second.draft, "沈铎");

    expect(after.userEdited).toBe(true);
    expect(after.content).toBe("人工定稿：沈铎是北岭的守塔人。");
    expect(after.content).not.toContain("守塔人，沉默寡言");
    expect(second.draft.entries.filter((e) => e.name === "沈铎")).toHaveLength(
      1,
    );
    // other entities still merge normally in the same run
    expect(findEntry(second.draft, "林晚").provenanceStatus).toBe("conflict");
  });
});
