/**
 * Text extraction for .txt / .md / .epub.
 *
 * v1 scope: reliable chapter bodies + chapter order only. No PDF/OCR, no
 * layout analysis, no generic ETL framework.
 *
 * Paragraph unit:
 *   txt/md — one non-empty line (the dominant convention for Chinese novel
 *            txt dumps; hard-wrapped documents over-segment but locator
 *            granularity stays correct)
 *   epub   — one block element (<p>, <h1..h6>, <li>, <blockquote>, <div>)
 */

import path from "node:path";
import { extractChaptersFromEpub } from "./epub.js";
import { splitByHeadings, splitTxtChapters } from "./txt-md.js";
import type { Chapter, SourceKind } from "../types.js";

export { extractChaptersFromEpub } from "./epub.js";
export { splitTxtChapters, splitByHeadings } from "./txt-md.js";

export function detectSourceKind(fileName: string): SourceKind {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".txt") return "txt";
  if (ext === ".md" || ext === ".markdown") return "md";
  if (ext === ".epub") return "epub";
  throw new Error(
    `unsupported input format: ${fileName} (v1 supports .txt, .md, .epub only)`,
  );
}

/** Decode bytes to text: BOM sniff, strict UTF-8, then GB18030 fallback. */
export function decodeTextBytes(bytes: Uint8Array): string {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gb18030").decode(bytes);
  }
}

export interface ExtractedDocument {
  kind: SourceKind;
  title?: string;
  chapters: Chapter[];
}

/** Extract chapters (in order) from one source document. */
export function extractDocument(
  fileName: string,
  bytes: Uint8Array,
): ExtractedDocument {
  const kind = detectSourceKind(fileName);
  switch (kind) {
    case "txt":
      return { kind, chapters: splitTxtChapters(decodeTextBytes(bytes)) };
    case "md":
      return { kind, chapters: splitByHeadings(decodeTextBytes(bytes)) };
    case "epub":
      return extractChaptersFromEpub(bytes);
  }
}
