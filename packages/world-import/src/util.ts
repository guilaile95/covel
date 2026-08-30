import { createHash } from "node:crypto";
import type { EntryType } from "./types.js";

/** First 8 hex chars of sha256 — stable, dependency-free content hashing. */
export function hash8(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 8);
}

/**
 * Deterministic alias-key normalization: NFKC fold, whitespace collapse,
 * case fold. Exact-match only — no fuzzy matching in v1.
 */
export function normalizeName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

const ENTRY_ID_PREFIX: Record<EntryType, string> = {
  character: "char",
  faction: "faction",
  location: "loc",
  item: "item",
  rule: "rule",
  power: "power",
  event: "event",
  relationship: "rel",
};

/**
 * Stable entity id: derived from (type, canonical name) only, so the same
 * entity yields the same id across runs, chunks and sources.
 */
export function entryId(type: EntryType, canonicalName: string): string {
  return `${ENTRY_ID_PREFIX[type]}-${hash8(`${type}\u0000${normalizeName(canonicalName)}`)}`;
}

/** Covel world id slug: /^[a-z][a-z0-9-]*$/. CJK input falls back to "imported". */
export function slugifyId(text: string): string {
  const ascii = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii.length > 0 ? ascii : "imported";
}

/** locator: `chapter:<1-based>;paragraph:<a>-<b>` (chapter-relative, 1-based). */
export function formatLocator(
  chapterIndex: number,
  startParagraph: number,
  endParagraph: number,
): string {
  return `chapter:${chapterIndex + 1};paragraph:${startParagraph}-${endParagraph}`;
}
