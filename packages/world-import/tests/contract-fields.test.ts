import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  loadDraft,
  markAiAccepted,
  markConflictResolved,
  serializeDraft,
} from "../src/contract.js";
import { exportCovelWorldPackage } from "../src/export/covel-package.js";
import { applyUserEdit } from "../src/draft.js";
import { mergeExtractions } from "../src/merge.js";
import type { Chunk, RawExtraction } from "../src/contract.js";
import { findEntry, runFixturePipeline } from "./helpers.js";

describe("contract decision fields", () => {
  it("keeps quotes on source-backed refs", async () => {
    const { draft } = await runFixturePipeline({});
    const linWan = findEntry(draft, "林晚");
    expect(linWan.sourceRefs.length).toBeGreaterThan(0);
    for (const ref of linWan.sourceRefs) {
      expect(ref.quote).toBeTruthy();
      expect(ref.quote!.length).toBeLessThanOrEqual(160);
    }
  });

  it("round-trips aiAccepted / conflictResolved / quote through serialize → load", async () => {
    const { draft } = await runFixturePipeline({});
    let edited = markAiAccepted(draft, findEntry(draft, "雾隐塔").id);
    edited = markConflictResolved(edited, findEntry(edited, "林晚").id);
    edited = applyUserEdit(edited, findEntry(edited, "沈铎").id, {
      content: "人工定稿内容",
    });

    const restored = loadDraft(serializeDraft(edited));
    expect(findEntry(restored, "雾隐塔").aiAccepted).toBe(true);
    expect(findEntry(restored, "林晚").conflictResolved).toBe(true);
    expect(findEntry(restored, "沈铎").userEdited).toBe(true);
    // unset flags stay absent (default false), nothing else dropped
    expect(findEntry(restored, "白霜城").aiAccepted).toBeUndefined();
  });

  it("does not re-create a resolved conflict on re-merge, but keeps merging content", async () => {
    const first = await runFixturePipeline({});
    const linWan = findEntry(first.draft, "林晚");
    expect(linWan.provenanceStatus).toBe("conflict");

    const decided = markConflictResolved(first.draft, linWan.id);
    const second = await runFixturePipeline({ existingDraft: decided });
    const after = findEntry(second.draft, "林晚");

    expect(after.conflictResolved).toBe(true);
    expect(after.provenanceStatus).not.toBe("conflict");
    // the resolved fingerprints stay in the notes so LATER re-merges can
    // still tell the old conflict from a new one
    expect(after.conflictNotes).toContain("16");
    expect(after.conflictNotes).toContain("19");
    // contributions still flow in (not frozen like userEdited)
    expect(after.content).toContain("十六岁");
    expect(after.sourceRefs.length).toBeGreaterThan(0);
  });

  it("keeps aiAccepted across a re-merge", async () => {
    const first = await runFixturePipeline({});
    const wuyin = findEntry(first.draft, "雾隐塔");
    expect(wuyin.provenanceStatus).toBe("ai-inferred");

    const decided = markAiAccepted(first.draft, wuyin.id);
    const second = await runFixturePipeline({ existingDraft: decided });
    expect(findEntry(second.draft, "雾隐塔").aiAccepted).toBe(true);
  });

  it("exports decided entries without provenance markers and labels them in WORLD.md", async () => {
    const { draft } = await runFixturePipeline({});
    let edited = markAiAccepted(draft, findEntry(draft, "雾隐塔").id);
    edited = markConflictResolved(edited, findEntry(edited, "林晚").id);

    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(tmpdir(), "covel-decided-"));
    try {
      await exportCovelWorldPackage(edited, dir);
      const lorebook = parseYaml(
        await readFile(path.join(dir, "data/lorebook.yaml"), "utf-8"),
      );
      const wuyinLore = lorebook.find(
        (e: { id: string }) => e.id === findEntry(edited, "雾隐塔").id,
      );
      const linWanLore = lorebook.find(
        (e: { id: string }) => e.id === findEntry(edited, "林晚").id,
      );
      expect(wuyinLore.content).not.toContain("[推断]");
      expect(linWanLore.content).not.toContain("[冲突待解]");

      const worldMd = await readFile(path.join(dir, "WORLD.md"), "utf-8");
      expect(worldMd).toContain("已采纳推断");
      expect(worldMd).toContain("冲突已解决");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── Fingerprint semantics (unit-level, precise) ─────────────────

function chunkOf(id: string, paragraphs: string[]): Chunk {
  return {
    id,
    sourceId: "src-unit",
    chapterIndex: 0,
    chapterTitle: "章",
    partIndex: 0,
    partCount: 1,
    startParagraph: 1,
    endParagraph: paragraphs.length,
    text: paragraphs.join("\n"),
  };
}

function linWanClaim(value: string, text: string): RawExtraction {
  return {
    type: "character",
    name: "林晚",
    content: text,
    status: "source-backed",
    paragraphs: [1],
    claims: [{ field: "age", value }],
  };
}

const META = {
  id: "d",
  title: "t",
  sources: [{ id: "src-unit", file: "n.txt", kind: "txt" as const }],
  summary: "",
};

describe("conflict fingerprint semantics", () => {
  it("resolved old conflict stays quiet; a NEW value re-opens the conflict", () => {
    const batch16 = {
      chunk: chunkOf("c1", ["她说自己十六岁。"]),
      raw: [linWanClaim("16", "她说自己十六岁。")],
    };
    const batch19 = {
      chunk: chunkOf("c2", ["名册上写着十九岁。"]),
      raw: [linWanClaim("19", "名册上写着十九岁。")],
    };
    const batch21 = {
      chunk: chunkOf("c3", ["雾塔的簿册上写着二十一岁。"]),
      raw: [linWanClaim("21", "雾塔的簿册上写着二十一岁。")],
    };

    // round 1: 16 vs 19 → conflict
    const first = mergeExtractions(META, [batch16, batch19]);
    const linWan1 = findEntry(first, "林晚");
    expect(linWan1.provenanceStatus).toBe("conflict");

    // Owner resolves
    const decided = markConflictResolved(first, linWan1.id);

    // round 2: same 16 vs 19 again → NOT re-opened
    const second = mergeExtractions(META, [batch16, batch19], {
      existingDraft: decided,
    });
    const linWan2 = findEntry(second, "林晚");
    expect(linWan2.conflictResolved).toBe(true);
    expect(linWan2.provenanceStatus).not.toBe("conflict");
    // fingerprint carrier is kept for later rounds
    expect(linWan2.conflictNotes).toContain("16");

    // round 3: NEW value 21 → conflict re-opens, resolved flag cleared;
    // notes report the new pair (16 vs 21) AND keep the historical resolved
    // pair (16 vs 19) so it never re-reports in later rounds
    const third = mergeExtractions(META, [batch16, batch19, batch21], {
      existingDraft: decided,
    });
    const linWan3 = findEntry(third, "林晚");
    expect(linWan3.provenanceStatus).toBe("conflict");
    expect(linWan3.conflictResolved).toBeUndefined();
    expect(linWan3.conflictNotes).toContain("21");
    expect(linWan3.conflictNotes).toContain("16");
    expect(linWan3.conflictNotes).toContain("19");
  });
});

describe("decided entries survive rounds without new evidence", () => {
  it("aiAccepted entry absent from the next extraction keeps content/sourceRefs/flag", () => {
    const wuyinBatch = {
      chunk: chunkOf("c1", ["北岭的雾气终年不散。"]),
      raw: [
        {
          type: "location",
          name: "雾隐塔",
          content: "雾气深处或有一座哨塔（推断）。",
          status: "ai-inferred" as const,
        },
      ],
    };
    const otherBatch = {
      chunk: chunkOf("c2", ["沈铎守着雾塔。"]),
      raw: [
        {
          type: "character",
          name: "沈铎",
          content: "沈铎是守塔人。",
          status: "source-backed" as const,
          paragraphs: [1],
        },
      ],
    };

    const first = mergeExtractions(META, [wuyinBatch, otherBatch]);
    const decided = markAiAccepted(first, findEntry(first, "雾隐塔").id);
    const before = findEntry(decided, "雾隐塔");

    // next round: NO extraction for 雾隐塔 at all
    const second = mergeExtractions(META, [otherBatch], {
      existingDraft: decided,
    });
    const after = findEntry(second, "雾隐塔");
    expect(after.content).toBe(before.content);
    expect(after.sourceRefs).toEqual(before.sourceRefs);
    expect(after.provenanceStatus).toBe(before.provenanceStatus);
    expect(after.aiAccepted).toBe(true);
  });

  it("conflictResolved entry absent from the next extraction keeps everything", () => {
    const conflictBatch = {
      chunk: chunkOf("c1", ["她说自己十六岁。"]),
      raw: [linWanClaim("16", "她说自己十六岁。")],
    };
    const conflictingBatch = {
      chunk: chunkOf("c2", ["名册上写着十九岁。"]),
      raw: [linWanClaim("19", "名册上写着十九岁。")],
    };

    const first = mergeExtractions(META, [conflictBatch, conflictingBatch]);
    const decided = markConflictResolved(first, findEntry(first, "林晚").id);
    const before = findEntry(decided, "林晚");

    // next round: NO extraction for 林晚 at all
    const second = mergeExtractions(META, [], { existingDraft: decided });
    const after = findEntry(second, "林晚");
    expect(after.content).toBe(before.content);
    expect(after.sourceRefs).toEqual(before.sourceRefs);
    expect(after.conflictResolved).toBe(true);
    // resolved + no new conflicts → the entry is no longer in conflict state
    expect(after.provenanceStatus).not.toBe("conflict");
  });
});

describe("resolved fingerprints survive chained re-merges", () => {
  // Every round uses the PREVIOUS round's output as its existingDraft —
  // no test shortcuts back to the originally decided draft.
  it("16v19 quiet across rounds; 21 re-opens; re-resolve silences every known pair", () => {
    const batch16 = {
      chunk: chunkOf("c1", ["她说自己十六岁。"]),
      raw: [linWanClaim("16", "她说自己十六岁。")],
    };
    const batch19 = {
      chunk: chunkOf("c2", ["名册上写着十九岁。"]),
      raw: [linWanClaim("19", "名册上写着十九岁。")],
    };
    const batch21 = {
      chunk: chunkOf("c3", ["雾塔的簿册上写着二十一岁。"]),
      raw: [linWanClaim("21", "雾塔的簿册上写着二十一岁。")],
    };
    const resolve = (draft: ReturnType<typeof mergeExtractions>) =>
      markConflictResolved(draft, findEntry(draft, "林晚").id);

    // round 1: 16 vs 19 → conflict; Owner resolves
    const round1 = mergeExtractions(META, [batch16, batch19]);
    expect(findEntry(round1, "林晚").provenanceStatus).toBe("conflict");
    const decided1 = resolve(round1);

    // round 2 (input = round 1 output): quiet, fingerprints carried
    const round2 = mergeExtractions(META, [batch16, batch19], {
      existingDraft: decided1,
    });
    const quiet2 = findEntry(round2, "林晚");
    expect(quiet2.conflictResolved).toBe(true);
    expect(quiet2.provenanceStatus).not.toBe("conflict");
    expect(quiet2.conflictNotes).toContain("16");

    // round 3 (input = round 2 output): STILL quiet — the fingerprints
    // survived the previous round's output
    const round3 = mergeExtractions(META, [batch16, batch19], {
      existingDraft: round2,
    });
    const quiet3 = findEntry(round3, "林晚");
    expect(quiet3.conflictResolved).toBe(true);
    expect(quiet3.provenanceStatus).not.toBe("conflict");

    // round 4 (input = round 3 output): NEW value 21 → re-opens; the
    // historical resolved pair must NOT be dropped from the carrier
    const round4 = mergeExtractions(META, [batch16, batch19, batch21], {
      existingDraft: round3,
    });
    const reopened = findEntry(round4, "林晚");
    expect(reopened.provenanceStatus).toBe("conflict");
    expect(reopened.conflictResolved).toBeUndefined();
    expect(reopened.conflictNotes).toContain("21");
    expect(reopened.conflictNotes).toContain("19"); // history preserved

    // Owner resolves again
    const decided2 = resolve(round4);

    // round 5 (input = round 4 output): every resolved pair stays quiet
    const round5 = mergeExtractions(META, [batch16, batch19, batch21], {
      existingDraft: decided2,
    });
    const quiet5 = findEntry(round5, "林晚");
    expect(quiet5.conflictResolved).toBe(true);
    expect(quiet5.provenanceStatus).not.toBe("conflict");
    expect(quiet5.conflictNotes).toContain("19");
    expect(quiet5.conflictNotes).toContain("21");

    // round 6 (input = round 5 output): still quiet, chains indefinitely
    const round6 = mergeExtractions(META, [batch16, batch19, batch21], {
      existingDraft: round5,
    });
    expect(findEntry(round6, "林晚").conflictResolved).toBe(true);
    expect(findEntry(round6, "林晚").provenanceStatus).not.toBe("conflict");
  });
});
