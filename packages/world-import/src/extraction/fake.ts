/**
 * FakeExtractionAdapter — deterministic, keyword-driven extraction used for
 * development and tests. Never calls a model; never costs money.
 *
 * A real Covel Provider adapter implements the same ExtractionAdapter
 * interface later; merge/export do not know which adapter produced the
 * raw extractions.
 */

import type {
  ExtractionAdapter,
  ExtractionClaim,
  ExtractionRequest,
  EntryType,
  RawExtraction,
  RawStatus,
} from "../types.js";

export interface FakeEmit {
  type: EntryType;
  name: string;
  aliases?: string[];
  content: string;
  /** Default "source-backed". */
  status?: RawStatus;
  /**
   * Supporting paragraphs: "match" = every paragraph in the chunk that
   * contains a matched keyword; or explicit 1-based chunk-relative numbers.
   */
  paragraphs?: number[] | "match";
  claims?: ExtractionClaim[];
}

export interface FakeRule {
  /** Matches when any substring is present in the chunk text. */
  anyOf?: string[];
  /** Matches when this regex hits the chunk text. */
  regex?: string;
  /** Restrict the rule to one 0-based chapter index. */
  chapter?: number;
  emit: FakeEmit[];
}

export class FakeExtractionAdapter implements ExtractionAdapter {
  readonly id = "fake";

  constructor(private readonly rules: FakeRule[]) {}

  async extract(request: ExtractionRequest): Promise<RawExtraction[]> {
    const { chunk } = request;
    const results: RawExtraction[] = [];

    for (const rule of this.rules) {
      if (rule.chapter !== undefined && rule.chapter !== chunk.chapterIndex)
        continue;

      const matchedKeywords: string[] = [];
      if (rule.anyOf) {
        for (const keyword of rule.anyOf) {
          if (chunk.text.includes(keyword)) matchedKeywords.push(keyword);
        }
      }
      const regex = rule.regex ? new RegExp(rule.regex) : null;
      const regexHit = regex !== null && regex.test(chunk.text);
      if (matchedKeywords.length === 0 && !regexHit) continue;

      const matchParagraphs = (): number[] => {
        const needles = [...matchedKeywords];
        return chunk.text
          .split("\n")
          .map((paragraph, i) =>
            needles.some((k) => paragraph.includes(k)) ? i + 1 : 0,
          )
          .filter((n) => n > 0);
      };

      for (const emit of rule.emit) {
        const status = emit.status ?? "source-backed";
        let paragraphs: number[] | undefined;
        if (status === "source-backed") {
          paragraphs =
            emit.paragraphs === "match" || emit.paragraphs === undefined
              ? matchParagraphs()
              : emit.paragraphs;
          if (paragraphs.length === 0) paragraphs = [1];
        }
        results.push({
          type: emit.type,
          name: emit.name,
          aliases: emit.aliases,
          content: emit.content,
          status,
          paragraphs,
          claims: emit.claims,
        });
      }
    }

    return results;
  }
}
