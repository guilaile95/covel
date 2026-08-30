/**
 * EPUB extraction — reliable chapter bodies + spine order only.
 *
 * container.xml → OPF → spine → xhtml documents in order. Chapter titles
 * come from the first <h1..h3> in the document, falling back to
 * `第N节`. No PDF/OCR, no layout handling.
 */

import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import path from "node:path";
import type { Chapter } from "../types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // XHTML files carry namespaces; keep tag names bare.
  removeNSPrefix: true,
});

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function readText(files: Record<string, Uint8Array>, filePath: string): string {
  const decodedPath = Object.keys(files).find(
    (k) => k === filePath || decodeURIComponent(k) === filePath,
  );
  const bytes = decodedPath ? files[decodedPath] : undefined;
  if (!bytes) throw new Error(`epub: missing entry ${filePath}`);
  return new TextDecoder("utf-8").decode(bytes);
}

function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (node === null || node === undefined || typeof node !== "object")
    return "";
  const record = node as Record<string, unknown>;
  let out = "";
  for (const [key, value] of Object.entries(record)) {
    if (key === "#text") out += textOf(value);
  }
  return out;
}

/** Block-level XHTML tags whose text becomes one paragraph each. */
const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "div",
  "section",
  "article",
]);

/**
 * Walk a parsed XHTML tree and collect block texts in document order.
 * Inline tags (<span>, <em>, …) flow into the current block.
 */
function collectBlocks(
  node: unknown,
  blocks: string[],
  current: { text: string },
): void {
  if (typeof node === "string" || typeof node === "number") {
    current.text += String(node);
    return;
  }
  if (node === null || typeof node !== "object") return;

  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === "#text") {
      current.text += textOf(value);
      continue;
    }
    if (key.startsWith("@_") || key === "#comment") continue;
    const lower = key.toLowerCase();
    if (BLOCK_TAGS.has(lower)) {
      for (const child of toArray(value)) {
        if (current.text.trim().length > 0) {
          blocks.push(current.text.replace(/\s+/g, " ").trim());
          current.text = "";
        }
        collectBlocks(child, blocks, current);
        if (current.text.trim().length > 0) {
          blocks.push(current.text.replace(/\s+/g, " ").trim());
          current.text = "";
        }
      }
      continue;
    }
    // Non-block wrapper (head, span, body, …): descend without closing blocks.
    for (const child of toArray(value)) {
      collectBlocks(child, blocks, current);
    }
  }
}

interface XhtmlDoc {
  title?: string;
  blocks: string[];
}

function parseXhtml(xml: string): XhtmlDoc {
  const tree = parser.parse(xml) as Record<string, unknown>;
  const html = (tree.html ?? tree.body ?? {}) as Record<string, unknown>;

  let title: string | undefined;
  const head = html.head as Record<string, unknown> | undefined;
  if (head?.title !== undefined) {
    const t = textOf(head.title).trim();
    if (t.length > 0) title = t;
  }

  const blocks: string[] = [];
  const current = { text: "" };
  const body = html.body ?? tree.body;
  if (body !== undefined) collectBlocks(body, blocks, current);
  if (current.text.trim().length > 0)
    blocks.push(current.text.replace(/\s+/g, " ").trim());

  return {
    title,
    blocks: blocks.filter((b) => b.length > 0),
  };
}

export function extractChaptersFromEpub(bytes: Uint8Array): {
  kind: "epub";
  title?: string;
  chapters: Chapter[];
} {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (error) {
    throw new Error(`epub: not a readable zip container (${String(error)})`);
  }

  // parse() returns the document root: {"?xml", "container"} for
  // container.xml and {"?xml", "package"} for the OPF.
  const containerDoc = parser.parse(
    readText(files, "META-INF/container.xml"),
  ) as Record<string, unknown>;
  const containerRoot = (containerDoc.container ?? containerDoc) as Record<
    string,
    unknown
  >;
  const rootfiles = toArray(
    (containerRoot.rootfiles as Record<string, unknown> | undefined)?.rootfile,
  ) as Array<Record<string, string>>;
  const opfPath = rootfiles[0]?.["@_full-path"];
  if (!opfPath) throw new Error("epub: container.xml has no rootfile");

  const opf = parser.parse(readText(files, opfPath)) as Record<string, unknown>;
  const pkg = (opf.package ?? opf) as Record<string, unknown>;

  const metadata = (pkg.metadata ?? {}) as Record<string, unknown>;
  // removeNSPrefix strips "dc:", so the key may be "title" or "dc:title".
  const dcTitle = toArray(metadata["dc:title"] ?? metadata["title"])[0];
  const bookTitle =
    dcTitle !== undefined ? textOf(dcTitle).trim() || undefined : undefined;

  const manifest = (pkg.manifest ?? {}) as Record<string, unknown>;
  const items = new Map<string, { href: string; mediaType: string }>();
  for (const item of toArray(manifest.item) as Array<Record<string, string>>) {
    if (item["@_id"] && item["@_href"]) {
      items.set(item["@_id"], {
        href: item["@_href"],
        mediaType: item["@_media-type"] ?? "",
      });
    }
  }

  const spine = (pkg.spine ?? {}) as Record<string, unknown>;
  const spineRefs = toArray(spine.itemref) as Array<Record<string, string>>;

  const opfDir = path.posix.dirname(opfPath);
  const chapters: Chapter[] = [];

  for (const ref of spineRefs) {
    const item = items.get(ref["@_idref"] ?? "");
    if (!item) continue;
    const mediaType = item.mediaType;
    if (mediaType !== "application/xhtml+xml" && mediaType !== "text/html") {
      continue;
    }
    const docPath = path.posix.normalize(
      opfDir === "." ? item.href : `${opfDir}/${item.href}`,
    );
    const doc = parseXhtml(readText(files, docPath));
    chapters.push({
      index: chapters.length,
      title: doc.title || `第${chapters.length + 1}节`,
      paragraphs: doc.blocks,
    });
  }

  if (chapters.length === 0) {
    throw new Error("epub: spine contains no readable xhtml documents");
  }

  return { kind: "epub", title: bookTitle, chapters };
}
