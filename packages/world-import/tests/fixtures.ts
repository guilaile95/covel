/**
 * Synthetic fixtures — 《白霜之城》 is invented for tests only. No real
 * novel text is ever committed to git.
 */

import { strToU8, zipSync } from "fflate";
import type { FakeRule } from "../src/extraction/fake.js";

// ── .txt novel (6 chapters, 序章 included) ──────────────────────

export const NOVEL_TXT = [
  "序章 雪落",
  "白霜之围已经过去了十年，城门依旧紧闭。",
  "",
  "第一章 北来的旅人",
  "林晚踏进白霜城的南门，斗篷上落满了雪。",
  "旅人们低声叫她晚姐，说她的刀比雪还冷。",
  "她从怀里取出一枚玄铁令牌，守卫立刻让开了路。",
  "",
  "第二章 白霜城",
  "白霜城坐落在北岭以南的雪谷，终年落雪。",
  "灰隼商会垄断了城里的皮货与盐路，连城主也要让其三分。",
  "城里流传着一条铁规：凡持玄铁令牌者，不得入城主府。",
  "",
  "第三章 北岭",
  "北岭是白霜城以北的山岭，雾气终年不散。",
  "有人说雾气深处藏着白霜之围时消失的哨塔。",
  "",
  "第四章 十六岁之约",
  "林晚在灯下擦拭刀锋，她说自己十六岁。",
  "沈铎把一碗热汤推过去，什么也没问。",
  "",
  "第五章 十九岁的真相",
  "商会的名册上写着，晚姐十九岁。",
  "她盯着那行字，忽然笑了。",
  "",
  "第六章 盟约",
  "林晚与沈铎在雾塔下结为盟友。",
  "霜脉在两人掌心同时亮起，像两盏灯。",
  "而雾塔的簿册上写着二十一岁。",
].join("\n");

// ── .md setting collection ─────────────────────────────────────

export const SETTING_MD = [
  "# 白霜之城 设定集",
  "",
  "## 林晚",
  "林晚，白霜城斥候，惯用短刀，代号晚姐。",
  "",
  "## 霜脉",
  "霜脉让触碰者感知风雪的来向，是北地血脉的天赋。",
  "",
  "## 城规",
  "凡持玄铁令牌者，不得入城主府，违者逐出城去。",
  "",
  "```text",
  "# 这不是章节标题，是围栏里的注释",
  "```",
  "",
  "## 沈铎",
  "沈铎是北岭雾塔的守塔人，沉默寡言。",
].join("\n");

// ── .epub (2 xhtml chapters, built deterministically) ──────────

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const CONTENT_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:baishuang-test</dc:identifier>
    <dc:title>雾塔行记</dc:title>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

const CH1_XHTML = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>雾塔上的守灯人</title></head>
<body>
<h1>雾塔上的守灯人</h1>
<p>沈铎把玄铁令牌挂在塔檐下，任风雪打磨。</p>
<p>他说，灰隼商会与白霜城的商队若敢再上山，雾塔的灯就会熄。</p>
</body>
</html>`;

const CH2_XHTML = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>下山</title></head>
<body>
<h1>下山</h1>
<p>北岭的雪停了，白霜城的门开了一条缝。</p>
<p>林晚在城下等他，手里握着一枚 &amp; 一枚的铜钱。</p>
</body>
</html>`;

export function buildFixtureEpub(): Uint8Array {
  return zipSync(
    {
      mimetype: [strToU8("application/epub+zip"), { level: 0 }],
      "META-INF/container.xml": strToU8(CONTAINER_XML),
      "OEBPS/content.opf": strToU8(CONTENT_OPF),
      "OEBPS/ch1.xhtml": strToU8(CH1_XHTML),
      "OEBPS/ch2.xhtml": strToU8(CH2_XHTML),
    },
    { mtime: new Date(Date.UTC(2020, 0, 1)) },
  );
}

// ── fake adapter rules (keyword-driven, deterministic) ──────────

export const FIXTURE_RULES: FakeRule[] = [
  {
    anyOf: ["林晚"],
    emit: [
      {
        type: "character",
        name: "林晚",
        content: "林晚是白霜城的年轻斥候，行事果决。",
        paragraphs: "match",
      },
    ],
  },
  {
    anyOf: ["晚姐"],
    chapter: 1,
    emit: [
      {
        type: "character",
        name: "林晚",
        aliases: ["晚姐"],
        content: "旅人们称她为晚姐。",
        paragraphs: "match",
      },
    ],
  },
  {
    // Alias-only mention in a later chapter must merge into 林晚.
    anyOf: ["晚姐"],
    chapter: 5,
    emit: [
      {
        type: "character",
        name: "晚姐",
        content: "名册上写着，晚姐十九岁。",
        paragraphs: "match",
        claims: [{ field: "age", value: "19" }],
      },
    ],
  },
  {
    anyOf: ["林晚"],
    chapter: 4,
    emit: [
      {
        type: "character",
        name: "林晚",
        content: "她说自己十六岁。",
        paragraphs: "match",
        claims: [{ field: "age", value: "16" }],
      },
    ],
  },
  {
    // A third, later value for the same field — used to prove that a NEW
    // conflict re-opens a conflictResolved entry while the old 16-vs-19
    // pair stays suppressed.
    anyOf: ["二十一岁"],
    chapter: 6,
    emit: [
      {
        type: "character",
        name: "林晚",
        content: "雾塔的簿册上写着二十一岁。",
        paragraphs: "match",
        claims: [{ field: "age", value: "21" }],
      },
    ],
  },
  {
    anyOf: ["沈铎"],
    emit: [
      {
        type: "character",
        name: "沈铎",
        content: "沈铎是北岭的守塔人，沉默寡言。",
        paragraphs: "match",
      },
    ],
  },
  {
    // Inferred completion without source support.
    anyOf: ["沈铎"],
    emit: [
      {
        type: "character",
        name: "沈铎",
        status: "ai-inferred",
        content: "沈铎似乎忌惮灰隼商会的商队。",
      },
    ],
  },
  {
    anyOf: ["灰隼商会"],
    emit: [
      {
        type: "faction",
        name: "灰隼商会",
        content: "灰隼商会垄断了白霜城的皮货与盐路。",
        paragraphs: "match",
      },
    ],
  },
  {
    anyOf: ["白霜城"],
    emit: [
      {
        type: "location",
        name: "白霜城",
        content: "白霜城坐落在北岭以南的雪谷，终年落雪。",
        paragraphs: "match",
      },
    ],
  },
  {
    anyOf: ["北岭"],
    emit: [
      {
        type: "location",
        name: "北岭",
        content: "北岭是白霜城以北的山岭，雾气终年不散。",
        paragraphs: "match",
      },
    ],
  },
  {
    // Pure ai-inferred entity — must never pretend to be source-backed.
    anyOf: ["雾气"],
    emit: [
      {
        type: "location",
        name: "雾隐塔",
        status: "ai-inferred",
        content: "雾气深处或有一座被遗忘的哨塔（推测，无原文支撑）。",
      },
    ],
  },
  {
    anyOf: ["玄铁令牌"],
    emit: [
      {
        type: "item",
        name: "玄铁令牌",
        content: "玄铁令牌是进入内城的信物，玄铁所铸。",
        paragraphs: "match",
      },
    ],
  },
  {
    anyOf: ["不得入城主府"],
    emit: [
      {
        type: "rule",
        name: "令牌禁令",
        content: "凡持玄铁令牌者，不得入城主府。",
        paragraphs: "match",
      },
    ],
  },
  {
    anyOf: ["霜脉"],
    emit: [
      {
        type: "power",
        name: "霜脉",
        content: "霜脉让触碰者感知风雪的来向。",
        paragraphs: "match",
      },
    ],
  },
  {
    anyOf: ["白霜之围"],
    emit: [
      {
        type: "event",
        name: "白霜之围",
        content: "十年前的白霜之围让白霜城紧闭城门。",
        paragraphs: "match",
      },
    ],
  },
  {
    anyOf: ["盟友"],
    chapter: 6,
    emit: [
      {
        type: "relationship",
        name: "林晚与沈铎",
        aliases: ["林晚", "沈铎"],
        content: "林晚与沈铎在雾塔下结为盟友。",
        paragraphs: "match",
      },
    ],
  },
];
