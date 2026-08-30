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
    expect(after.conflictNotes).toBeUndefined();
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
