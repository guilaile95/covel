import { describe, expect, it } from "vitest";
import {
  decisionsWithout,
  deleteEntry,
  entryReviewStatus,
  filterEntries,
  isPending,
  parseDraft,
  reviewCounts,
  updateEntry,
  type ReviewDecisions,
  type WorldImportDraft,
} from "../model.js";

/** Minimal contract-valid draft (frozen v0 shape from @covel/world-import). */
export function makeDraft(): WorldImportDraft {
  const parsed = parseDraft({
    version: 0,
    id: "test-draft",
    title: "测试世界",
    sources: [{ id: "src-1", file: "test.txt", kind: "txt" }],
    summary: "测试摘要",
    entries: [
      {
        id: "char-1",
        type: "character",
        name: "林甲",
        aliases: [],
        content: "内容甲",
        provenanceStatus: "source-backed",
        sourceRefs: [{ sourceId: "src-1", locator: "chapter:1;paragraph:1-2" }],
      },
      {
        id: "ai-1",
        type: "faction",
        name: "乙会",
        aliases: [],
        content: "推断内容",
        provenanceStatus: "ai-inferred",
        sourceRefs: [],
      },
      {
        id: "rule-1",
        type: "rule",
        name: "禁令",
        aliases: [],
        content: "规则内容",
        provenanceStatus: "conflict",
        sourceRefs: [
          { sourceId: "src-1", locator: "chapter:1;paragraph:3-3" },
          { sourceId: "src-1", locator: "chapter:2;paragraph:1-1" },
        ],
        conflictNotes: "两处说法不一致",
      },
      {
        id: "rel-1",
        type: "relationship",
        name: "林甲 → 乙会:成员",
        aliases: [],
        content: "推断关系",
        provenanceStatus: "ai-inferred",
        sourceRefs: [],
      },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.draft;
}

describe("parseDraft (contract via @covel/world-import)", () => {
  it("accepts a contract-valid draft and normalizes optional fields", () => {
    const draft = makeDraft();
    expect(draft.version).toBe(0);
    expect(draft.entries).toHaveLength(4);
    // entries without explicit userEdited stay undefined per the contract
    expect(draft.entries[0].userEdited).toBeUndefined();
    expect(draft.entries[0].aliases).toEqual([]);
  });

  it("rejects an unknown entry type and a wrong version", () => {
    const bad = (entries: unknown[]) => ({
      version: 0,
      id: "x",
      title: "t",
      sources: [{ id: "s", file: "f.txt", kind: "txt" }],
      summary: "",
      entries,
    });
    expect(
      parseDraft(
        bad([{ id: "e", type: "power_system", name: "n", content: "" }]),
      ).ok,
    ).toBe(false);
    expect(parseDraft({ ...bad([]), version: 1 }).ok).toBe(false);
  });
});

describe("owner edits and decisions", () => {
  it("updateEntry stamps userEdited via the shared contract helper", () => {
    const draft = makeDraft();
    const next = updateEntry(draft, "char-1", { name: "林甲(改)" });
    const edited = next.entries.find((e) => e.id === "char-1");
    expect(edited?.userEdited).toBe(true);
    expect(edited?.name).toBe("林甲(改)");
  });

  it("pending logic: unaccepted AI inferences and unresolved conflicts only", () => {
    const draft = makeDraft();
    const empty: ReviewDecisions = { acceptedAi: [], resolvedConflicts: [] };
    const byId = new Map(draft.entries.map((e) => [e.id, e]));
    expect(isPending(byId.get("char-1")!, empty)).toBe(false);
    expect(isPending(byId.get("ai-1")!, empty)).toBe(true);
    expect(isPending(byId.get("rule-1")!, empty)).toBe(true);

    const decided: ReviewDecisions = {
      acceptedAi: ["ai-1"],
      resolvedConflicts: ["rule-1"],
    };
    expect(isPending(byId.get("ai-1")!, decided)).toBe(false);
    expect(isPending(byId.get("rule-1")!, decided)).toBe(false);
  });

  it("review status precedence: resolved > accepted > edited > unreviewed", () => {
    const draft = makeDraft();
    const byId = new Map(draft.entries.map((e) => [e.id, e]));
    const empty: ReviewDecisions = { acceptedAi: [], resolvedConflicts: [] };
    expect(entryReviewStatus(byId.get("char-1")!, empty)).toBe("unreviewed");

    const editedOnly = updateEntry(draft, "ai-1", { content: "改" });
    const editedEntry = editedOnly.entries.find((e) => e.id === "ai-1")!;
    expect(entryReviewStatus(editedEntry, empty)).toBe("edited");

    expect(
      entryReviewStatus(editedEntry, {
        acceptedAi: ["ai-1"],
        resolvedConflicts: [],
      }),
    ).toBe("ai-accepted");
  });

  it("counts include unresolvedConflicts, userEdited and pending", () => {
    const draft = makeDraft();
    const empty: ReviewDecisions = { acceptedAi: [], resolvedConflicts: [] };
    let counts = reviewCounts(draft, empty);
    expect(counts).toMatchObject({
      total: 4,
      sourceBacked: 1,
      aiInferred: 2,
      conflict: 1,
      unresolvedConflicts: 1,
      userEdited: 0,
      pending: 3,
    });

    const edited = updateEntry(draft, "char-1", { content: "改" });
    const decided: ReviewDecisions = {
      acceptedAi: ["ai-1", "rel-1"],
      resolvedConflicts: ["rule-1"],
    };
    counts = reviewCounts(edited, decided);
    expect(counts).toMatchObject({
      unresolvedConflicts: 0,
      userEdited: 1,
      pending: 0,
    });
  });

  it("filters by status and category", () => {
    const draft = makeDraft();
    const empty: ReviewDecisions = { acceptedAi: [], resolvedConflicts: [] };
    expect(
      filterEntries(draft, empty, { type: null, status: "pending" }).map(
        (e) => e.id,
      ),
    ).toEqual(["ai-1", "rule-1", "rel-1"]);
    expect(
      filterEntries(draft, empty, { type: "faction", status: "all" }).map(
        (e) => e.id,
      ),
    ).toEqual(["ai-1"]);
    expect(
      filterEntries(draft, empty, {
        type: null,
        status: "conflict",
      }).map((e) => e.id),
    ).toEqual(["rule-1"]);
  });

  it("deleteEntry drops the entry; decisionsWithout cleans the id lists", () => {
    const draft = makeDraft();
    const next = deleteEntry(draft, "ai-1");
    expect(next.entries.map((e) => e.id)).not.toContain("ai-1");
    const decisions = decisionsWithout(
      { acceptedAi: ["ai-1", "rel-1"], resolvedConflicts: ["rule-1"] },
      "ai-1",
    );
    expect(decisions).toEqual({
      acceptedAi: ["rel-1"],
      resolvedConflicts: ["rule-1"],
    });
  });
});
