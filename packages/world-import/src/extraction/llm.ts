/**
 * LlmExtractionAdapter — the real extraction adapter on top of Covel's
 * provider stack.
 *
 * The adapter takes an injectable text backend (in production:
 * `createGateway(...).generateText` bound to a model slot; in tests: a fake
 * backend). It never calls a paid model itself — wiring the real gateway is
 * the caller's decision.
 *
 * Contract with the model:
 *  - input: one chunk with paragraph-relative numbering [P1..Pn];
 *  - output: strict JSON {"extractions": RawExtraction[]} covering the 8
 *    fixed entity types;
 *  - nothing may be extracted without textual basis; source-backed entries
 *    must cite paragraphs; model completions must be ai-inferred with no
 *    paragraphs; fabricated sources are rejected;
 *  - malformed JSON gets a bounded repair loop (default 2 repairs); if the
 *    output is still invalid after that, extraction FAILS loudly — no
 *    silent degradation.
 */

import type {
  TextGenerationParams,
  TextGenerationResult,
} from "@covel/ai-provider";
import {
  ENTRY_TYPES,
  type EntryType,
  type ExtractionAdapter,
  type ExtractionRequest,
  type RawExtraction,
  type RawStatus,
} from "../types.js";

/** Minimal surface of Covel's gateway.generateText this adapter needs. */
export type ExtractionLlmBackend = (
  params: TextGenerationParams,
) => Promise<TextGenerationResult>;

export interface AdapterUsage {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
}

/** Implemented by adapters that can report call/token usage. */
export interface UsageReportingAdapter {
  getUsage(): AdapterUsage;
}

export interface LlmExtractionAdapterOptions {
  /** Bound Covel provider call, e.g. `(params) => gateway.generateText(params)`. */
  backend: ExtractionLlmBackend;
  /** Model slot id / model name passed through to the backend. */
  model: string;
  /** Bounded repair attempts after the first invalid output. Default 2. */
  maxRepairs?: number;
}

const SYSTEM_PROMPT = `你是世界信息抽取器。从小说/设定文本分块中抽取实体，只输出严格 JSON，不要输出任何其它文字或代码围栏。

可抽取的实体类型（type 字段，只能取以下 8 个值）：
character（人物）、faction（势力）、location（地点）、item（物品）、rule（规则）、power（能力体系）、event（事件）、relationship（关系）

硬性规则：
1. 没有文本依据的实体一律不要提取。
2. status="source-backed" 的条目必须给出 paragraphs（分块内相对段落号，从 1 开始，如 [1,2]）。
3. 你自己的补充、猜测或补全必须标 status="ai-inferred"，并且绝不能带 paragraphs。
4. 不得伪造段落来源。
5. 涉及可比对的属性（年龄、阵营、位置、数值等）用 claims 表达：[{"field":"age","value":"19"}]。
6. relationship 条目的 name 写作「甲与乙」，aliases 填 [甲,乙]。

输出 JSON 格式：
{"extractions":[{"type":"character","name":"林晚","aliases":["晚姐"],"content":"……","status":"source-backed","paragraphs":[1],"claims":[{"field":"age","value":"19"}]}]}

没有任何可抽取内容时输出：{"extractions":[]}`;

export class ExtractionOutputError extends Error {
  constructor(
    message: string,
    readonly errors: string[],
    readonly lastRawOutput: string,
  ) {
    super(message);
  }
}

export class LlmExtractionAdapter
  implements ExtractionAdapter, UsageReportingAdapter
{
  readonly id: string;

  private readonly backend: ExtractionLlmBackend;
  private readonly model: string;
  private readonly maxRepairs: number;
  private readonly usage: AdapterUsage = {
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  constructor(options: LlmExtractionAdapterOptions) {
    this.backend = options.backend;
    this.model = options.model;
    this.maxRepairs = options.maxRepairs ?? 2;
    this.id = `llm:${options.model}`;
  }

  getUsage(): AdapterUsage {
    return { ...this.usage };
  }

  async extract(request: ExtractionRequest): Promise<RawExtraction[]> {
    const chunkParagraphs = request.chunk.text.split("\n");
    const messages: TextGenerationParams["messages"] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: buildUserPrompt(request, chunkParagraphs.length),
      },
    ];

    let lastRaw = "";
    let lastErrors: string[] = [];

    for (let attempt = 0; attempt <= this.maxRepairs; attempt++) {
      const result = await this.backend({ model: this.model, messages });
      this.usage.llmCalls += 1;
      this.usage.inputTokens += result.usage?.inputTokens ?? 0;
      this.usage.outputTokens += result.usage?.outputTokens ?? 0;
      lastRaw = result.text;

      const parsed = parseExtractionJson(result.text);
      if (parsed.ok) {
        const validated = validateExtractions(
          parsed.value,
          chunkParagraphs.length,
        );
        if (validated.ok) return validated.value;
        lastErrors = validated.errors;
      } else {
        lastErrors = parsed.errors;
      }

      messages.push({ role: "assistant", content: lastRaw });
      messages.push({
        role: "user",
        content: `你上次的输出不合法：\n${lastErrors.map((e) => `- ${e}`).join("\n")}\n请重新输出符合系统规则的完整 JSON（只输出 JSON 本体）。`,
      });
    }

    throw new ExtractionOutputError(
      `extraction output invalid after ${this.maxRepairs} repair attempts`,
      lastErrors,
      lastRaw,
    );
  }
}

function buildUserPrompt(
  request: ExtractionRequest,
  paragraphCount: number,
): string {
  const lines: string[] = [];
  lines.push(`作品：${request.draftTitle}`);
  lines.push(
    `来源文件：${request.source.file}；章节：${request.chunk.chapterTitle}（第 ${request.chunk.chapterIndex + 1} 章，分块 ${request.chunk.partIndex + 1}/${request.chunk.partCount}，共 ${paragraphCount} 个段落）`,
  );
  lines.push(
    "分块正文（每段前的 [Pn] 是段落相对编号，paragraphs 必须引用这些编号）：",
  );
  request.chunk.text.split("\n").forEach((paragraph, i) => {
    lines.push(`[P${i + 1}] ${paragraph}`);
  });
  return lines.join("\n");
}

// ── Parsing & validation ────────────────────────────────────────

type ParseOk = { ok: true; value: unknown[] };
type ParseFail = { ok: false; errors: string[] };

export function parseExtractionJson(text: string): ParseOk | ParseFail {
  const stripped = stripCodeFence(text.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (error) {
    return { ok: false, errors: [`不是合法 JSON：${String(error)}`] };
  }
  if (Array.isArray(parsed)) return { ok: true, value: parsed };
  if (parsed !== null && typeof parsed === "object") {
    const extractions = (parsed as Record<string, unknown>).extractions;
    if (Array.isArray(extractions)) return { ok: true, value: extractions };
    return { ok: false, errors: ['缺少 "extractions" 数组'] };
  }
  return { ok: false, errors: ["顶层必须是对象或数组"] };
}

function stripCodeFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : text;
}

type ValidateOk = { ok: true; value: RawExtraction[] };
type ValidateFail = { ok: false; errors: string[] };

export function validateExtractions(
  value: unknown[],
  chunkParagraphCount: number,
): ValidateOk | ValidateFail {
  const errors: string[] = [];
  const out: RawExtraction[] = [];

  value.forEach((item, i) => {
    const what = `extractions[${i}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${what} 必须是对象`);
      return;
    }
    const raw = item as Record<string, unknown>;

    const type = raw.type;
    if (
      typeof type !== "string" ||
      !(ENTRY_TYPES as readonly string[]).includes(type)
    ) {
      errors.push(`${what}.type 非法：${JSON.stringify(type)}`);
      return;
    }

    const name = raw.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      errors.push(`${what}.name 必须是非空字符串`);
      return;
    }

    const content = raw.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      errors.push(`${what}.content 必须是非空字符串`);
      return;
    }

    const status = raw.status;
    if (status !== "source-backed" && status !== "ai-inferred") {
      errors.push(`${what}.status 必须是 "source-backed" 或 "ai-inferred"`);
      return;
    }

    let paragraphs: number[] | undefined;
    if (status === "source-backed") {
      const paragraphsRaw = raw.paragraphs;
      if (
        !Array.isArray(paragraphsRaw) ||
        paragraphsRaw.length === 0 ||
        paragraphsRaw.some((p) => !Number.isInteger(p) || (p as number) < 1)
      ) {
        errors.push(
          `${what} 是 source-backed 但 paragraphs 缺失/为空/含非正整数（必须引用 [P1..P${chunkParagraphCount}]）`,
        );
        return;
      }
      const outOfRange = (paragraphsRaw as number[]).filter(
        (p) => p > chunkParagraphCount,
      );
      if (outOfRange.length > 0) {
        errors.push(
          `${what}.paragraphs 越界：${outOfRange.join(",")}（本分块只有 ${chunkParagraphCount} 段，不得伪造来源）`,
        );
        return;
      }
      paragraphs = [...new Set(paragraphsRaw as number[])].sort(
        (a, b) => a - b,
      );
    }
    // ai-inferred entries must not carry paragraphs — strip conservatively.

    let claims: RawExtraction["claims"];
    if (raw.claims !== undefined) {
      if (!Array.isArray(raw.claims)) {
        errors.push(`${what}.claims 必须是数组`);
        return;
      }
      claims = [];
      for (const claim of raw.claims) {
        if (
          claim === null ||
          typeof claim !== "object" ||
          Array.isArray(claim)
        ) {
          errors.push(`${what}.claims 条目必须是对象`);
          return;
        }
        const field = (claim as Record<string, unknown>).field;
        const claimValue = (claim as Record<string, unknown>).value;
        if (typeof field !== "string" || field.trim().length === 0) {
          errors.push(`${what}.claims[].field 必须是非空字符串`);
          return;
        }
        if (typeof claimValue !== "string" || claimValue.trim().length === 0) {
          errors.push(`${what}.claims[].value 必须是非空字符串`);
          return;
        }
        claims.push({ field: field.trim(), value: claimValue.trim() });
      }
    }

    let aliases: string[] | undefined;
    if (raw.aliases !== undefined) {
      if (
        !Array.isArray(raw.aliases) ||
        raw.aliases.some((a) => typeof a !== "string")
      ) {
        errors.push(`${what}.aliases 必须是字符串数组`);
        return;
      }
      aliases = (raw.aliases as string[]).filter((a) => a.trim().length > 0);
    }

    out.push({
      type: type as EntryType,
      name: name.trim(),
      aliases: aliases && aliases.length > 0 ? aliases : undefined,
      content: content.trim(),
      status: status as RawStatus,
      paragraphs,
      claims,
    });
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}
