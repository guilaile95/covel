/**
 * World Import Core — shared types.
 *
 * The WorldImportDraft v0 contract is frozen across A/B/C:
 *   draft:  { version, id, title, sources[], summary, entries[] }
 *   entry:  { id, type, name, aliases[], content, provenanceStatus,
 *             sourceRefs[], conflictNotes?, userEdited? }
 *   sourceRef: { sourceId, locator }
 *
 * locator format (human-readable, machine-parseable):
 *   `chapter:<1-based n>;paragraph:<a>-<b>`
 * where paragraphs are 1-based within the chapter. Do not add fields
 * to the frozen contract without a new contract round.
 */

export const ENTRY_TYPES = [
  "character",
  "faction",
  "location",
  "item",
  "rule",
  "power",
  "event",
  "relationship",
] as const;

export type EntryType = (typeof ENTRY_TYPES)[number];

export const PROVENANCE_STATUSES = [
  "source-backed",
  "ai-inferred",
  "conflict",
] as const;

export type ProvenanceStatus = (typeof PROVENANCE_STATUSES)[number];

/** Raw model/adapter claim status before merge resolution. */
export type RawStatus = "source-backed" | "ai-inferred";

export type SourceKind = "txt" | "md" | "epub";

export interface DraftSource {
  id: string;
  /** Original file name (basename), never the raw content. */
  file: string;
  kind: SourceKind;
  /** Book/document title if the container provides one (e.g. EPUB metadata). */
  title?: string;
}

export interface SourceRef {
  sourceId: string;
  locator: string;
}

export interface DraftEntry {
  id: string;
  type: EntryType;
  name: string;
  aliases: string[];
  content: string;
  provenanceStatus: ProvenanceStatus;
  sourceRefs: SourceRef[];
  conflictNotes?: string;
  userEdited?: boolean;
}

/** Frozen contract version of WorldImportDraft. */
export const DRAFT_VERSION = 0;

export interface WorldImportDraft {
  version: number;
  id: string;
  title: string;
  sources: DraftSource[];
  summary: string;
  entries: DraftEntry[];
}

// ── Text extraction ─────────────────────────────────────────────

/** One chapter of an extracted document. Paragraphs are non-empty. */
export interface Chapter {
  /** 0-based, sequential within one source document. */
  index: number;
  title: string;
  /** 1-based paragraph numbering is derived from array position. */
  paragraphs: string[];
}

// ── Chunking ────────────────────────────────────────────────────

export interface Chunk {
  id: string;
  sourceId: string;
  /** 0-based chapter index within its source. */
  chapterIndex: number;
  chapterTitle: string;
  /** 0-based part index when a chapter is split into multiple chunks. */
  partIndex: number;
  partCount: number;
  /** 1-based chapter-relative paragraph range, inclusive. */
  startParagraph: number;
  endParagraph: number;
  text: string;
}

// ── Extraction adapter ──────────────────────────────────────────

/**
 * A structured fact asserted by an adapter about an entity.
 * Used by merge to detect contradictions deterministically; never
 * serialized into the frozen draft contract.
 */
export interface ExtractionClaim {
  field: string;
  value: string;
}

export interface RawExtraction {
  type: EntryType;
  name: string;
  aliases?: string[];
  content: string;
  status: RawStatus;
  /**
   * 1-based paragraph numbers relative to the chunk (1..chunk paragraph
   * count) that support this extraction. Required for "source-backed";
   * must be omitted for "ai-inferred".
   */
  paragraphs?: number[];
  claims?: ExtractionClaim[];
}

export interface ExtractionRequest {
  chunk: Chunk;
  source: DraftSource;
  draftTitle: string;
}

/**
 * Model-agnostic extraction interface. A Covel Provider adapter can be
 * implemented on top of this later; tests and development use
 * FakeExtractionAdapter so no paid model is ever called.
 */
export interface ExtractionAdapter {
  readonly id: string;
  extract(request: ExtractionRequest): Promise<RawExtraction[]>;
}
