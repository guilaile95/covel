/**
 * Demo extraction rules for the FakeExtractionAdapter.
 *
 * Until the real Covel Provider adapter lands (B's pipeline keeps the
 * ExtractionAdapter interface stable), the intake route runs this
 * deterministic, keyword-driven rule set so the full upload → review →
 * approve loop is exercisable without calling any model. This is DATA for
 * the package's fake adapter — the extraction/merge logic itself lives in
 * @covel/world-import.
 */

import type { FakeRule } from "@covel/world-import";

export const FAKE_RULES: FakeRule[] = [
  {
    anyOf: ["林一舟"],
    emit: [
      {
        type: "character",
        name: "林一舟",
        content: "雾港最年轻的领航员，熟悉雾季里每一处暗礁与潮路。",
        paragraphs: "match",
      },
    ],
  },
  {
    anyOf: ["雾港务局"],
    emit: [
      {
        type: "faction",
        name: "雾港务局",
        content: "掌管雾港航道、灯塔与封港令的官方机构。",
        paragraphs: "match",
      },
    ],
  },
  {
    anyOf: ["陈半潮"],
    emit: [
      {
        type: "character",
        name: "陈半潮",
        aliases: ["半潮伯"],
        content: "雾港灯塔的老守灯人，码头的人都叫他半潮伯。",
        paragraphs: "match",
      },
    ],
  },
  {
    anyOf: ["观潮石"],
    emit: [
      {
        type: "location",
        name: "观潮石",
        content: "港外礁石上的观测点，本地渔民视之为潮信的来源。",
        paragraphs: "match",
      },
    ],
  },
  {
    // No paragraphs: merge keeps this as a pure AI inference.
    anyOf: ["领航员"],
    emit: [
      {
        type: "relationship",
        name: "林一舟 → 陈半潮:师徒",
        content:
          "【AI 推断】从称呼与对话推断两人存在师徒关系，原文未明确表述。",
        status: "ai-inferred",
      },
    ],
  },
  {
    // Same field, different values in different chapters → merge marks
    // the rule entry as a conflict for the owner to resolve.
    chapter: 1,
    anyOf: ["大雾封港"],
    emit: [
      {
        type: "rule",
        name: "大雾封港规程",
        content: "大雾封港期间，所有船只禁止出入港。",
        paragraphs: "match",
        claims: [{ field: "封港生效时间", value: "黄昏起生效" }],
      },
    ],
  },
  {
    chapter: 2,
    anyOf: ["大雾封港"],
    emit: [
      {
        type: "rule",
        name: "大雾封港规程",
        content: "大雾封港期间，所有船只禁止出入港。",
        paragraphs: "match",
        claims: [{ field: "封港生效时间", value: "午夜起生效" }],
      },
    ],
  },
];

/**
 * Canonical synthetic source used by the route tests and the browser
 * end-to-end walkthrough. Keyword-aligned with FAKE_RULES above.
 */
export const SYNTHETIC_NOVEL_TXT = `第一章 雾港

雾港的清晨总是从雾里开始的。林一舟站在领航员的瞭望位上，看着雾港务局的巡船慢慢驶出防波堤。

港务局的铜钟敲了三下，意味着潮水已经涨到码头第三级台阶。

第二章 灯塔

陈半潮守着灯塔，码头的人都叫他半潮伯。他教林一舟辨认观潮石上的水痕。

大雾封港的黄昏，港务局的巡船全部回港，林一舟却在雾里看见了一盏不该存在的灯。

第三章 对账

雾散之后，林一舟去港务局对账。半潮伯说，规矩就是规矩。

大雾封港的午夜，灯塔的光会准时扫过观潮石。
`;
