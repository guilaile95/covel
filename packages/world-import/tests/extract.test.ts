import { describe, expect, it } from "vitest";
import {
  decodeTextBytes,
  splitByHeadings,
  splitTxtChapters,
} from "../src/extract/index.js";
import { NOVEL_TXT, SETTING_MD } from "./fixtures.js";

describe("splitTxtChapters", () => {
  it("splits the fixture novel into ordered chapters", () => {
    const chapters = splitTxtChapters(NOVEL_TXT);
    expect(chapters.map((c) => c.title)).toEqual([
      "序章 雪落",
      "第一章 北来的旅人",
      "第二章 白霜城",
      "第三章 北岭",
      "第四章 十六岁之约",
      "第五章 十九岁的真相",
      "第六章 盟约",
    ]);
    expect(chapters.map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("numbers paragraphs from 1 inside each chapter", () => {
    const chapters = splitTxtChapters(NOVEL_TXT);
    const ch1 = chapters[1];
    expect(ch1.paragraphs).toHaveLength(3);
    expect(ch1.paragraphs[0]).toContain("林晚踏进白霜城");
    expect(ch1.paragraphs[2]).toContain("玄铁令牌");
  });

  it("keeps body sentences mentioning 楔子/序章 words as body text", () => {
    const text = [
      "第一章 试炼",
      "他说序章不过是噱头，没人真信。",
      "",
      "第二章 归途",
      "到了。",
    ].join("\n");
    const chapters = splitTxtChapters(text);
    expect(chapters).toHaveLength(2);
    expect(chapters[0].paragraphs[0]).toContain("序章不过是噱头");
  });

  it("falls back to a single chapter when no heading exists", () => {
    const chapters = splitTxtChapters("第一段。\n第二段。");
    expect(chapters).toHaveLength(1);
    expect(chapters[0].paragraphs).toHaveLength(2);
  });
});

describe("splitByHeadings (md)", () => {
  it("splits on ATX headings up to level 2", () => {
    const chapters = splitByHeadings(SETTING_MD);
    const titles = chapters.map((c) => c.title);
    expect(titles).toContain("白霜之城 设定集");
    expect(titles).toContain("林晚");
    expect(titles).toContain("霜脉");
    expect(titles).toContain("城规");
    expect(titles).toContain("沈铎");
  });

  it("ignores heading syntax inside fenced code blocks", () => {
    const chapters = splitByHeadings(SETTING_MD);
    const allParagraphs = chapters.flatMap((c) => c.paragraphs).join("\n");
    expect(allParagraphs).toContain("这不是章节标题");
    // the fenced comment must not have become a chapter title
    expect(chapters.map((c) => c.title)).not.toContain(
      "这不是章节标题，是围栏里的注释",
    );
  });

  it("respects maxLevel option", () => {
    const text = [
      "# 书名",
      "引",
      "## 第一章",
      "正文一",
      "### 小节",
      "正文二",
    ].join("\n");
    const chapters = splitByHeadings(text, { maxLevel: 1 });
    expect(chapters.map((c) => c.title)).toEqual(["书名"]);
  });
});

describe("decodeTextBytes", () => {
  it("strips a UTF-8 BOM", () => {
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode("雪落"),
    ]);
    expect(decodeTextBytes(bytes)).toBe("雪落");
  });

  it("decodes UTF-16LE via BOM sniffing", () => {
    const text = "白霜城";
    const bom = new Uint8Array([0xff, 0xfe]);
    const body = new TextEncoder().encode(text); // utf-8, not what we want
    const utf16 = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      utf16[i * 2] = code & 0xff;
      utf16[i * 2 + 1] = code >> 8;
    }
    const bytes = new Uint8Array(bom.length + utf16.length);
    bytes.set(bom, 0);
    bytes.set(utf16, bom.length);
    expect(decodeTextBytes(bytes)).toBe("白霜城");
    void body;
  });

  it("falls back to GB18030 when bytes are not valid UTF-8", () => {
    // 0xD6F7 is "主" in GBK and invalid UTF-8.
    expect(decodeTextBytes(new Uint8Array([0xd6, 0xf7]))).toBe("主");
  });
});
