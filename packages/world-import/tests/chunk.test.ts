import { describe, expect, it } from "vitest";
import { chunkChapters } from "../src/chunk.js";
import { splitTxtChapters } from "../src/extract/index.js";
import { NOVEL_TXT } from "./fixtures.js";

describe("chunkChapters", () => {
  it("keeps small chapters as single chunks with stable ids", () => {
    const chapters = splitTxtChapters(NOVEL_TXT);
    const chunks = chunkChapters("src-novel", chapters);
    expect(chunks).toHaveLength(chapters.length);
    expect(chunks[0].id).toBe("src-novel-c0-p0");
    expect(chunks[0].partCount).toBe(1);
    expect(chunks[0].startParagraph).toBe(1);
  });

  it("splits long chapters at paragraph boundaries with part indexes", () => {
    const chapters = splitTxtChapters(NOVEL_TXT);
    const chunks = chunkChapters("src-novel", chapters, { maxChars: 60 });
    const long = chunks.filter((c) => c.partCount > 1);
    expect(long.length).toBeGreaterThan(0);

    for (const chapter of chapters) {
      const parts = chunks.filter((c) => c.chapterIndex === chapter.index);
      expect(parts).toHaveLength(parts[0].partCount);
      expect(parts.map((p) => p.partIndex)).toEqual(parts.map((_, i) => i));
      // every paragraph is covered exactly once, in order
      const covered: number[] = [];
      for (const part of parts) {
        for (let n = part.startParagraph; n <= part.endParagraph; n++)
          covered.push(n);
      }
      expect(covered).toEqual(chapter.paragraphs.map((_, i) => i + 1));
    }
  });

  it("hard-splits a single oversized paragraph", () => {
    const big = "雪".repeat(200);
    const chapters = [{ index: 0, title: "章", paragraphs: [big, "短句"] }];
    const chunks = chunkChapters("src-x", chapters, { maxChars: 50 });
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const part of chunks.slice(0, 4)) {
      expect(part.text.length).toBeLessThanOrEqual(50);
      expect(part.startParagraph).toBe(1);
      expect(part.endParagraph).toBe(1);
    }
    expect(chunks[chunks.length - 1].text).toBe("短句");
  });

  it("is deterministic across runs", () => {
    const chapters = splitTxtChapters(NOVEL_TXT);
    const a = chunkChapters("src-novel", chapters, { maxChars: 60 });
    const b = chunkChapters("src-novel", chapters, { maxChars: 60 });
    expect(a).toEqual(b);
  });
});
