import { describe, expect, it } from "vitest";
import { extractChaptersFromEpub } from "../src/extract/epub.js";
import { buildFixtureEpub } from "./fixtures.js";

describe("extractChaptersFromEpub", () => {
  it("reads spine order, titles and paragraphs from the fixture epub", () => {
    const doc = extractChaptersFromEpub(buildFixtureEpub());
    expect(doc.kind).toBe("epub");
    expect(doc.title).toBe("雾塔行记");
    expect(doc.chapters.map((c) => c.title)).toEqual([
      "雾塔上的守灯人",
      "下山",
    ]);
    expect(doc.chapters[0].paragraphs).toEqual([
      "雾塔上的守灯人",
      "沈铎把玄铁令牌挂在塔檐下，任风雪打磨。",
      "他说，灰隼商会与白霜城的商队若敢再上山，雾塔的灯就会熄。",
    ]);
  });

  it("decodes XML entities inside paragraphs", () => {
    const doc = extractChaptersFromEpub(buildFixtureEpub());
    expect(
      doc.chapters[1].paragraphs.some((p) => p.includes("一枚 & 一枚的铜钱")),
    ).toBe(true);
  });

  it("rejects non-zip bytes with a clear error", () => {
    expect(() => extractChaptersFromEpub(new Uint8Array([1, 2, 3, 4]))).toThrow(
      /zip container/,
    );
  });
});
