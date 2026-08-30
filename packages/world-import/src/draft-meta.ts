/**
 * Shared draft id / summary derivation for both the one-shot pipeline and
 * the resumable job — keeps ids identical no matter which entry point ran.
 */

import type { Chunk, DraftSource } from "./types.js";
import { hash8, slugifyId } from "./util.js";

export interface DraftMetaInput {
  title: string;
  explicitId?: string;
  sources: DraftSource[];
  chunks: Chunk[];
  extractionCount: number;
}

export interface DraftMeta {
  id: string;
  summary: string;
}

export function buildDraftMeta(input: DraftMetaInput): DraftMeta {
  const signature = `${input.title}\u0000${input.sources
    .map((s) => `${s.kind}:${s.file}`)
    .join("\u0001")}`;
  const id =
    input.explicitId ?? `${slugifyId(input.title)}-${hash8(signature)}`;
  const chapterCount = new Set(
    input.chunks.map((c) => `${c.sourceId}:${c.chapterIndex}`),
  ).size;
  const summary = `《${input.title}》导入草稿：${input.sources.length} 个来源，${chapterCount} 章，${input.chunks.length} 个分块，原始抽取 ${input.extractionCount} 条。条目内容需人工审核后方可定稿。`;
  return { id, summary };
}

export function countChapters(chunks: Chunk[]): number {
  return new Set(chunks.map((c) => `${c.sourceId}:${c.chapterIndex}`)).size;
}
