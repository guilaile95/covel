/**
 * Chapter splitting for plain text and Markdown.
 *
 * txt — heading line patterns common in Chinese novel dumps (第X章 / 楔子 /
 *       番外 / Chapter N), capped by line length so body sentences that
 *       mention "序章" are not mistaken for headings.
 * md  — ATX headings (# .. ######) up to a configurable max level (default 2),
 *       with fenced code blocks excluded from heading detection.
 */

import type { Chapter } from "../types.js";

const TXT_HEADING_PATTERNS: RegExp[] = [
  /^第\s*[0-9零〇一二三四五六七八九十百千两]+\s*[章节卷部回集]/,
  /^[Cc]hapter\s+\d+/,
  /^(楔子|引子|序章|序言|序幕|终章|尾声|番外|后记)(\s|：|:|．|\.|$)/,
];

const TXT_HEADING_MAX_LENGTH = 40;

export function isTxtHeading(line: string): boolean {
  if (line.length > TXT_HEADING_MAX_LENGTH) return false;
  return TXT_HEADING_PATTERNS.some((re) => re.test(line));
}

function newChapter(index: number, title: string): Chapter {
  return { index, title, paragraphs: [] };
}

function finalize(chapters: Chapter[]): Chapter[] {
  if (chapters.length === 0) {
    return [newChapter(0, "全文")];
  }
  // Drop chapters that ended up with no body at all (e.g. trailing heading).
  return chapters.filter(
    (ch, i) => ch.paragraphs.length > 0 || i === 0 || chapters.length === 1,
  );
}

export function splitTxtChapters(text: string): Chapter[] {
  const chapters: Chapter[] = [];
  let current: Chapter | null = null;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (isTxtHeading(line)) {
      current = newChapter(chapters.length, line);
      chapters.push(current);
      continue;
    }
    if (current === null) {
      current = newChapter(chapters.length, "开篇");
      chapters.push(current);
    }
    current.paragraphs.push(line);
  }

  return finalize(chapters);
}

export interface MdSplitOptions {
  /** Headings at level <= maxLevel start a new chapter. Default 2. */
  maxLevel?: number;
}

export function splitByHeadings(
  text: string,
  options: MdSplitOptions = {},
): Chapter[] {
  const maxLevel = options.maxLevel ?? 2;
  const chapters: Chapter[] = [];
  let current: Chapter | null = null;
  let inFence = false;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const heading = inFence ? null : line.match(/^(#{1,6})\s+(.+)$/);
    if (heading && heading[1].length <= maxLevel) {
      current = newChapter(chapters.length, heading[2].trim());
      chapters.push(current);
      continue;
    }
    if (current === null) {
      current = newChapter(chapters.length, "全文");
      chapters.push(current);
    }
    current.paragraphs.push(line);
  }

  return finalize(chapters);
}
