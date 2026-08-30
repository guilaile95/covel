import { describe, expect, it } from "vitest";
import {
  deleteEntry,
  entryReviewStatus,
  filterEntries,
  isPending,
  markAiAccepted,
  markConflictResolved,
  parseDraft,
  reviewCounts,
  updateEntry,
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
        sourceRefs: [
          { sourceId: "src-1", locator: "chapter:1;paragraph:1-2" },
        ],
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
        conflictNotes: "机器生成的冲突指纹",
      },
      {
        id: "rel-1",
        type: "relationship",
        name: "林甲与乙会",
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

describe("parseDraft (contract via @covel/world-import/contract)", () => {
  it("accepts a contract-valid draft and normalizes optional fields", () => {
    const draft = makeDraft();
    expect(draft.version).toBe(0);
    expect(draft.entries).toHaveLength(4);
    // decision flags default to undefined until the owner acts
    expect(draft.entries[0].userEdited).toBeUndefined();
    expect(draft.entries[1].aiAccepted).toBeUndefined();
    expect(draft.entries[2].conflictResolved).toBeUndefined();
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

describe("canonical owner decisions on the draft", () => {
  it("updateEntry stamps userEdited via the shared contract helper", () => {
    const draft = makeDraft();
    const next = updateEntry(draft, "char-1", { name: "林甲(改)" });
    const edited = next.entries.find((e) => e.id === "char-1");
    expect(edited?.userEdited).toBe(true);
    expect(edited?.name).toBe("林甲(改)");
  });

  it("markAiAccepted / markConflictResolved write canonical flags", () => {
    const draft = makeDraft();
    const decided = markConflictResolved(
      markAiAccepted(draft, "ai-1"),
      "rule-1",
    );
    const byId = new Map(decided.entries.map((e) => [e.id, e]));
    expect(byId.get("ai-1")?.aiAccepted).toBe(true);
    expect(byId.get("rule-1")?.conflictResolved).toBe(true);
    // decisions never stamp userEdited — accepting is not editing
    expect(byId.get("ai-1")?.userEdited).toBeUndefined();
  });

  it("pending logic: unaccepted AI inferences and unresolved conflicts only", () => {
    const draft = makeDraft();
    const byId = new Map(draft.entries.map((e) => [e.id, e]));
    expect(isPending(byId.get("char-1")!)).toBe(false);
    expect(isPending(byId.get("ai-1")!)).toBe(true);
    expect(isPending(byId.get("rule-1")!)).toBe(true);

    const decided = markConflictResolved(
      markAiAccepted(draft, "ai-1"),
      "rule-1",
    );
    const decidedById = new Map(decided.entries.map((e) => [e.id, e]));
    expect(isPending(decidedById.get("ai-1")!)).toBe(false);
    expect(isPending(decidedById.get("rule-1")!)).toBe(false);
    // the second AI entry was never accepted — still pending
    expect(isPending(decidedById.get("rel-1")!)).toBe(true);
  });

  it("review status precedence: resolved > accepted > edited > unreviewed", () => {
    const draft = makeDraft();
    const byId = new Map(draft.entries.map((e) => [e.id, e]));
    expect(entryReviewStatus(byId.get("char-1")!)).toBe("unreviewed");

    const editedOnly = updateEntry(draft, "ai-1", { content: "改" });
    const editedEntry = editedOnly.entries.find((e) => e.id === "ai-1")!;
    expect(entryReviewStatus(editedEntry)).toBe("edited");
    const acceptedEntry = markAiAccepted(editedOnly, "ai-1").entries.find(
      (e) => e.id === "ai-1",
    )!;
    expect(entryReviewStatus(acceptedEntry)).toBe("ai-accepted");
  });

  it("counts include unresolvedConflicts, userEdited and pending", () => {
    const draft = makeDraft();
    let counts = reviewCounts(draft);
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
    const decided = markConflictResolved(
      markAiAccepted(edited, "ai-1"),
      "rule-1",
    );
    counts = reviewCounts(markAiAccepted(decided, "rel-1"));
    expect(counts).toMatchObject({
      unresolvedConflicts: 0,
      userEdited: 1,
      pending: 0,
    });
  });

  it("filters by status and category", () => {
    const draft = makeDraft();
    expect(
      filterEntries(draft, { type: null, status: "pending" }).map((e) => e.id),
    ).toEqual(["ai-1", "rule-1", "rel-1"]);
    expect(
      filterEntries(draft, { type: "faction", status: "all" }).map((e) => e.id),
    ).toEqual(["ai-1"]);
    expect(
      filterEntries(draft, { type: null, status: "conflict" }).map(
        (e) => e.id,
      ),
    ).toEqual(["rule-1"]);
  });

  it("deleteEntry drops the entry", () => {
    const draft = makeDraft();
    const next = deleteEntry(draft, "ai-1");
    expect(next.entries.map((e) => e.id)).not.toContain("ai-1");
  });
});
