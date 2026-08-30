/**
 * End-to-end import pipeline:
 *   inputs → extract → chunk → adapter.extract → merge → WorldImportDraft.
 *
 * Export to a Covel World Package is a separate pure step
 * (exportCovelWorldPackage) so drafts can be reviewed/edited in between.
 */

import { basename } from "node:path";
import { extractDocument } from "./extract/index.js";
import {
  mergeExtractions,
  type ExtractionBatch,
  type MergeOptions,
} from "./merge.js";
import { chunkChapters } from "./chunk.js";
import type {
  Chunk,
  DraftSource,
  ExtractionAdapter,
  WorldImportDraft,
} from "./types.js";
import { hash8 } from "./util.js";
import { buildDraftMeta } from "./draft-meta.js";

export interface ImportInput {
  /** Display/file name — extension decides the extractor. */
  file: string;
  bytes: Uint8Array;
}

export interface RunWorldImportOptions {
  title: string;
  /** Explicit world id (Covel slug); default derives from title + inputs. */
  id?: string;
  inputs: ImportInput[];
  adapter: ExtractionAdapter;
  existingDraft?: WorldImportDraft;
  maxChunkChars?: number;
}

export interface ImportStats {
  sources: number;
  chapters: number;
  chunks: number;
  extractions: number;
  entries: number;
  conflicts: number;
  aiInferred: number;
  userEdited: number;
}

export interface WorldImportResult {
  draft: WorldImportDraft;
  stats: ImportStats;
}

export async function runWorldImport(
  options: RunWorldImportOptions,
): Promise<WorldImportResult> {
  if (options.inputs.length === 0) {
    throw new Error("runWorldImport: no inputs");
  }

  const sources: DraftSource[] = [];
  const allChunks: Chunk[] = [];
  const seenSourceIds = new Set<string>();

  for (const input of options.inputs) {
    let sourceId = `src-${hash8(basename(input.file))}`;
    if (seenSourceIds.has(sourceId)) {
      sourceId = `src-${hash8(basename(input.file))}-${sources.length}`;
    }
    seenSourceIds.add(sourceId);

    const document = extractDocument(input.file, input.bytes);
    const source: DraftSource = {
      id: sourceId,
      file: basename(input.file),
      kind: document.kind,
      ...(document.title ? { title: document.title } : {}),
    };
    sources.push(source);
    allChunks.push(
      ...chunkChapters(sourceId, document.chapters, {
        maxChars: options.maxChunkChars,
      }),
    );
  }

  const batches: ExtractionBatch[] = [];
  let extractionCount = 0;
  for (const chunk of allChunks) {
    const source = sources.find((s) => s.id === chunk.sourceId);
    if (!source) throw new Error(`pipeline: chunk ${chunk.id} has no source`);
    const raw = await options.adapter.extract({
      chunk,
      source,
      draftTitle: options.title,
    });
    extractionCount += raw.length;
    if (raw.length > 0) batches.push({ chunk, raw });
  }

  const meta = buildDraftMeta({
    title: options.title,
    explicitId: options.id,
    sources,
    chunks: allChunks,
    extractionCount,
  });

  const mergeOptions: MergeOptions = options.existingDraft
    ? { existingDraft: options.existingDraft }
    : {};

  const draft = mergeExtractions(
    { id: meta.id, title: options.title, sources, summary: meta.summary },
    batches,
    mergeOptions,
  );

  const stats: ImportStats = {
    sources: sources.length,
    chapters: new Set(allChunks.map((c) => `${c.sourceId}:${c.chapterIndex}`))
      .size,
    chunks: allChunks.length,
    extractions: extractionCount,
    entries: draft.entries.length,
    conflicts: draft.entries.filter((e) => e.provenanceStatus === "conflict")
      .length,
    aiInferred: draft.entries.filter(
      (e) => e.provenanceStatus === "ai-inferred",
    ).length,
    userEdited: draft.entries.filter((e) => e.userEdited === true).length,
  };

  return { draft, stats };
}
