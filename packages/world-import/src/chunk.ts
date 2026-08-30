/**
 * Deterministic, chapter-aware chunking for long novels.
 *
 * A chapter never spans one giant chunk: paragraphs are packed up to
 * maxChars, overflowing chapters split into sequential parts, and a single
 * oversized paragraph is hard-split at the character boundary. Chunk ids are
 * stable (source + chapter + part), so provenance locators survive re-runs.
 */

import type { Chapter, Chunk } from "./types.js";

export interface ChunkOptions {
  /** Approximate character budget per chunk. Default 1600 (CJK-heavy text). */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 1600;

export function chunkChapters(
  sourceId: string,
  chapters: Chapter[],
  options: ChunkOptions = {},
): Chunk[] {
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS);
  const chunks: Chunk[] = [];

  for (const chapter of chapters) {
    const parts: Array<{
      start: number;
      end: number;
      texts: string[];
      chars: number;
    }> = [];
    let current: {
      start: number;
      end: number;
      texts: string[];
      chars: number;
    } | null = null;

    const flush = () => {
      if (current && current.texts.length > 0) parts.push(current);
      current = null;
    };
    const append = (start: number, end: number, text: string) => {
      if (current === null) current = { start, end, texts: [], chars: 0 };
      current.end = end;
      current.texts.push(text);
      current.chars += text.length;
    };

    chapter.paragraphs.forEach((paragraph, i) => {
      const n = i + 1;
      if (paragraph.length > maxChars) {
        flush();
        for (let offset = 0; offset < paragraph.length; offset += maxChars) {
          append(n, n, paragraph.slice(offset, offset + maxChars));
          flush();
        }
        return;
      }
      if (current && current.chars + paragraph.length > maxChars) {
        flush();
      }
      append(n, n, paragraph);
    });
    flush();

    if (parts.length === 0) continue;

    parts.forEach((part, partIndex) => {
      chunks.push({
        id: `${sourceId}-c${chapter.index}-p${partIndex}`,
        sourceId,
        chapterIndex: chapter.index,
        chapterTitle: chapter.title,
        partIndex,
        partCount: parts.length,
        startParagraph: part.start,
        endParagraph: part.end,
        text: part.texts.join("\n"),
      });
    });
  }

  return chunks;
}
