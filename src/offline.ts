/**
 * Offline answers
 *
 * When a reader can't answer (asleep, WiFi off, away), the Worker answers
 * the AI app itself instead of failing the request:
 *
 * - With no saved copy, every tool returns a plain result saying the reader
 *   is offline and when it was last seen, so the app can tell the user what
 *   to do. Nothing about the book is known or stored in that case.
 * - With a saved copy (offline memory, turned on from the reader), the
 *   read-only tools answer from it, and every answer starts with a notice
 *   that says so, how old the copy is and which pages it covers.
 *
 * The tool list is the same as the reader's own (from the manifest the
 * plugin sends at registration, or the built-in definitions for plugins
 * that send none), so apps see one stable server whether or not the reader
 * is connected. Tools that need the reader (page turns, highlights) refuse.
 *
 * Like the plugin, this speaks both protocol eras: the initialize handshake
 * (2025-03-26 to 2025-11-25) and stateless 2026-07-28.
 */

import data from "./demo-data.json";
import type { Manifest, OfflineInfo } from "./types";

const MODERN_VERSIONS = ["2026-07-28"];
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const ALL_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const RESOURCE_NOT_FOUND = -32002;

const DEFAULT_INSTRUCTIONS = "Access to the book the user is reading in KOReader on their e-reader. "
  + "Start with get_reading_context to see the current book, page and selection. "
  + "If the reader is offline, answers come from a saved copy when there is one, and say so.";

// Tools that can be answered from a saved copy; every other tool needs the reader
const READ_TOOLS = new Set(["get_reading_context", "get_book_metadata", "read_pages", "search_book"]);

const MAX_PAGES_PER_READ = 20;
const MAX_SEARCH_RESULTS = 50;
const MAX_LISTED_ANNOTATIONS = 20;
const MAX_LISTED_TOC = 200;

// ============================================
// Snapshot
// ============================================

export interface SnapshotPage {
  number: number;
  text: string;
}

export interface SnapshotAnnotation {
  text?: string;
  note?: string;
  note_format?: string;
  page?: number;
  chapter?: string;
  datetime?: string;
  color?: string;
  style?: string;
}

export interface SnapshotTocEntry {
  index: number;
  title: string;
  page: number;
  depth: number;
}

/** What a reader saves (format version 1); see README: Offline memory */
export interface Snapshot {
  v: 1;
  /** Reader's clock when the snapshot was taken (Unix seconds) */
  taken_at?: number;
  scope?: string;
  book: {
    title: string;
    authors?: string;
    language?: string;
    series?: string;
    keywords?: string;
    description?: string;
    format?: string;
    total_pages: number;
  };
  position: {
    page: number;
    percent_finished?: number;
    chapter?: { name: string; index?: number; start_page?: number; end_page?: number };
  };
  toc: SnapshotTocEntry[];
  annotations: SnapshotAnnotation[];
  /** Saved page text, ascending by page number (may be empty) */
  pages: SnapshotPage[];
}

const str = (v: unknown): string | undefined => typeof v === "string" && v !== "" ? v : undefined;
const num = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) ? v : undefined;
// The plugin's JSON encoder writes an empty list as {}
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Turn decrypted snapshot JSON into a Snapshot, dropping anything malformed; null if unusable */
export function parseSnapshot(jsonText: string): Snapshot | null {
  let raw: Record<string, unknown>;
  try {
    raw = obj(JSON.parse(jsonText));
  } catch {
    return null;
  }
  if (raw.v !== 1) return null;
  const book = obj(raw.book);
  const position = obj(raw.position);
  const page = num(position.page);
  const totalPages = num(book.total_pages);
  if (!page || !totalPages) return null;

  const chapterRaw = obj(position.chapter);
  const chapterName = str(chapterRaw.name);

  const pages: SnapshotPage[] = [];
  for (const item of list(raw.pages)) {
    const p = obj(item);
    const number = num(p.number);
    const text = str(p.text);
    if (number && text) pages.push({ number, text });
  }
  pages.sort((a, b) => a.number - b.number);

  const toc: SnapshotTocEntry[] = [];
  list(raw.toc).forEach((item, i) => {
    const t = obj(item);
    const tocPage = num(t.page);
    if (tocPage === undefined) return;
    toc.push({ index: num(t.index) ?? i + 1, title: str(t.title) ?? "", page: tocPage, depth: num(t.depth) ?? 0 });
  });

  const annotations: SnapshotAnnotation[] = [];
  for (const item of list(raw.annotations)) {
    const a = obj(item);
    const annotation: SnapshotAnnotation = {
      text: str(a.text),
      note: str(a.note),
      note_format: str(a.note_format),
      page: num(a.page),
      chapter: str(a.chapter),
      datetime: str(a.datetime),
      color: str(a.color),
      style: str(a.style),
    };
    if (annotation.text || annotation.note) annotations.push(annotation);
  }

  return {
    v: 1,
    taken_at: num(raw.taken_at),
    scope: str(raw.scope),
    book: {
      title: str(book.title) ?? "Unknown",
      authors: str(book.authors),
      language: str(book.language),
      series: str(book.series),
      keywords: str(book.keywords),
      description: str(book.description),
      format: str(book.format),
      total_pages: totalPages,
    },
    position: {
      page,
      percent_finished: num(position.percent_finished),
      chapter: chapterName ? {
        name: chapterName,
        index: num(chapterRaw.index),
        start_page: num(chapterRaw.start_page),
        end_page: num(chapterRaw.end_page),
      } : undefined,
    },
    toc,
    annotations,
    pages,
  };
}

// ============================================
// Context of one offline request
// ============================================

export interface OfflineContext {
  info: OfflineInfo;
  /**
   * "none": nothing is saved. "locked": something is saved that this app
   * can't open. "unreadable": it couldn't be decrypted or parsed.
   * "ok": `snapshot` holds it.
   */
  memory: "none" | "locked" | "unreadable" | "ok";
  snapshot: Snapshot | null;
  now: number;
}

function ago(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (seconds < 90) return "about a minute ago";
  if (seconds < 3600) return plural(Math.round(seconds / 60), "minute");
  if (seconds < 86400 * 2) return plural(Math.round(seconds / 3600), "hour");
  return plural(Math.round(seconds / 86400), "day");
}

function utc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** "112-124", or runs like "3-5, 9-12" if the saved pages have gaps */
function pageRanges(pages: SnapshotPage[]): string {
  const runs: string[] = [];
  let start = 0;
  for (let i = 0; i < pages.length; i++) {
    if (i + 1 < pages.length && pages[i + 1].number === pages[i].number + 1) continue;
    runs.push(start === i ? `${pages[start].number}` : `${pages[start].number}-${pages[i].number}`);
    start = i + 1;
  }
  return runs.join(", ");
}

/** First sentence of every offline answer: what is going on with the reader */
function readerStatus(ctx: OfflineContext): string {
  const seen = ctx.info.lastSeen ? ` (last seen ${ago(ctx.info.lastSeen, ctx.now)})` : "";
  return ctx.info.unresponsive
    ? `The e-reader did not answer in time${seen}; it has probably just gone to sleep or lost its connection.`
    : `The e-reader is not connected right now${seen}.`;
}

/** Notice that starts every answer given from a saved copy */
function savedCopyNotice(ctx: OfflineContext, snapshot: Snapshot): string {
  const saved = ctx.info.snapshot?.receivedAt;
  const when = saved ? ` saved ${ago(saved, ctx.now)} (${utc(saved)})` : " saved earlier";
  const lines = [
    "[Reader offline: answering from a saved copy]",
    `${readerStatus(ctx)} This answer comes from a copy the reader${when}, `
      + `when it was on page ${snapshot.position.page} of ${snapshot.book.total_pages}.`,
  ];
  if (snapshot.pages.length > 0) {
    lines.push(`The saved copy holds the text of page${snapshot.pages.length === 1 ? "" : "s"} `
      + `${pageRanges(snapshot.pages)} only, plus the table of contents and the user's highlights and notes. `
      + "The rest of the book is unavailable until the reader is back online.");
  } else {
    lines.push("The saved copy holds the reading position, the table of contents and the user's highlights "
      + "and notes, but no page text. Page text is unavailable until the reader is back online.");
  }
  lines.push(`The user may have read further since then, and pages after ${snapshot.position.page} `
    + "may not have been read yet, so avoid spoilers from them. Tell the user this is a saved copy.");
  return lines.join("\n");
}

/** Notice when there is nothing to answer from */
function unavailableNotice(ctx: OfflineContext): string {
  const lines = ["[Reader offline]"];
  if (ctx.memory === "locked") {
    lines.push(`${readerStatus(ctx)} A saved copy of the book exists, but this app can't open it yet: `
      + "it was saved before this app was set up for offline memory. "
      + "It becomes available after the reader has been online once more.");
  } else if (ctx.memory === "unreadable") {
    lines.push(`${readerStatus(ctx)} A saved copy of the book exists but could not be read. `
      + "A new one is saved the next time the reader is online.");
  } else {
    lines.push(`${readerStatus(ctx)} No saved copy of the book is available, so it can't be read now.`);
  }
  lines.push("Tell the user the reader is offline. To continue, they need to wake it, make sure WiFi is on "
    + "and start the MCP server in KOReader.");
  return lines.join("\n");
}

function readerState(ctx: OfflineContext, snapshot: Snapshot | null) {
  const saved = ctx.info.snapshot?.receivedAt;
  return {
    online: false,
    last_seen: ctx.info.lastSeen ? new Date(ctx.info.lastSeen).toISOString() : null,
    source: snapshot ? "saved_copy" : "none",
    ...(snapshot ? {
      saved_at: saved ? new Date(saved).toISOString() : null,
      saved_position_page: snapshot.position.page,
      saved_pages: snapshot.pages.map(p => p.number),
    } : {}),
  };
}

// ============================================
// Tools
// ============================================

type ToolResult = { content: unknown[]; structuredContent?: unknown; isError?: boolean };

function textResult(text: string, structuredContent?: unknown, isError = false): ToolResult {
  const result: ToolResult = { content: [{ type: "text", text }] };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  if (isError) result.isError = true;
  return result;
}

function pageByNumber(snapshot: Snapshot, n: number): SnapshotPage | undefined {
  return snapshot.pages.find(p => p.number === n);
}

/** Chapter containing a page, from the table of contents (as the plugin computes it) */
function chapterAt(snapshot: Snapshot, page: number) {
  let current: { name: string; index: number; start_page: number; end_page: number } | undefined;
  for (const entry of snapshot.toc) {
    if (entry.page <= page) {
      current = { name: entry.title, index: entry.index, start_page: entry.page, end_page: snapshot.book.total_pages };
    } else if (current) {
      current.end_page = entry.page - 1;
      break;
    } else {
      break;
    }
  }
  return current;
}

function annotationLine(a: SnapshotAnnotation): string {
  const clip = (s: string, n: number) => s.length > n ? s.slice(0, n) + "…" : s;
  const where = a.page ? `Page ${a.page}` : a.chapter ? a.chapter : "Unknown page";
  let line = `- ${where}`;
  if (a.text) line += `: "${clip(a.text.replace(/\s+/g, " "), 300)}"`;
  if (a.note) line += `\n  Note: ${clip(a.note, 500)}`;
  return line;
}

function annotationsSection(snapshot: Snapshot): string {
  if (snapshot.annotations.length === 0) return "";
  // Most recent first, when the reader recorded times
  const sorted = [...snapshot.annotations].sort((a, b) => (b.datetime || "").localeCompare(a.datetime || ""));
  const shown = sorted.slice(0, MAX_LISTED_ANNOTATIONS);
  let text = `\n\n--- The user's highlights and notes (${snapshot.annotations.length}) ---\n`
    + shown.map(annotationLine).join("\n");
  if (sorted.length > shown.length) {
    text += `\n... and ${sorted.length - shown.length} more (search_book also searches them)`;
  }
  return text;
}

function getReadingContext(ctx: OfflineContext, snapshot: Snapshot, args: Record<string, unknown>): ToolResult {
  const clamp = (v: unknown) => Math.max(0, Math.min(5, Math.floor(Number(v) || 0)));
  const before = clamp(args.extra_pages_before);
  const after = clamp(args.extra_pages_after);
  const current = snapshot.position.page;
  const currentPage = pageByNumber(snapshot, current);

  const context: Record<string, unknown> = {
    reader: readerState(ctx, snapshot),
    book: { title: snapshot.book.title, authors: snapshot.book.authors, total_pages: snapshot.book.total_pages },
  };
  const chapter = snapshot.position.chapter ?? chapterAt(snapshot, current);
  if (chapter) context.chapter = chapter;
  context.current_page = { number: current, ...(currentPage ? { text: currentPage.text } : {}) };

  let text = snapshot.book.title + (snapshot.book.authors ? ` by ${snapshot.book.authors}` : "") + "\n";
  if (chapter) {
    text += `Chapter: ${chapter.name}`;
    if (chapter.start_page && chapter.end_page) text += ` (pages ${chapter.start_page}-${chapter.end_page})`;
    text += "\n";
  }

  if (before || after) {
    let pagesText = "";
    for (let n = current - before; n <= current + after; n++) {
      const page = pageByNumber(snapshot, n);
      if (n === current) {
        pagesText += `== Current page: ${n} ==\n\n${page ? page.text + "\n\n" : ""}`;
      } else if (page) {
        pagesText += `== Page ${n} ==\n\n${page.text}\n\n`;
      }
    }
    context.pages_text = pagesText;
    context.current_page = { number: current };
    text += "\n" + pagesText;
  } else {
    text += `Page ${current} of ${snapshot.book.total_pages}\n\n`;
    if (currentPage) text += currentPage.text;
  }
  if (!currentPage) text += "(The text of this page is not in the saved copy.)";
  text += annotationsSection(snapshot);
  if (snapshot.annotations.length > 0) context.annotations = snapshot.annotations;

  return textResult(`${savedCopyNotice(ctx, snapshot)}\n\n${text}`, context);
}

function bookMetadata(snapshot: Snapshot) {
  return {
    ...snapshot.book,
    percent_finished: snapshot.position.percent_finished ?? 0,
    current_page: snapshot.position.page,
  };
}

function getBookMetadata(ctx: OfflineContext, snapshot: Snapshot): ToolResult {
  const metadata = bookMetadata(snapshot);
  let text = "Book Metadata\n" + "=".repeat(40) + "\n\n";
  text += `Title: ${metadata.title}\n`;
  if (metadata.authors) text += `Authors: ${metadata.authors}\n`;
  if (metadata.language) text += `Language: ${metadata.language}\n`;
  if (metadata.series) text += `Series: ${metadata.series}\n`;
  if (metadata.description) text += `\nDescription:\n${metadata.description}\n`;
  text += `\nFormat: ${metadata.format || "unknown"}\n`;
  text += `Pages: ${metadata.total_pages}\n`;
  text += `Progress: ${Math.floor(metadata.percent_finished * 100)}%\n`;
  if (snapshot.toc.length > 0) {
    text += "\nTable of contents:\n";
    for (const entry of snapshot.toc.slice(0, MAX_LISTED_TOC)) {
      text += `${"  ".repeat(Math.max(0, entry.depth - 1))}${entry.index}. ${entry.title} (page ${entry.page})\n`;
    }
    if (snapshot.toc.length > MAX_LISTED_TOC) text += `... and ${snapshot.toc.length - MAX_LISTED_TOC} more entries\n`;
  }
  return textResult(`${savedCopyNotice(ctx, snapshot)}\n\n${text}`, {
    reader: readerState(ctx, snapshot),
    ...metadata,
    table_of_contents: snapshot.toc,
  });
}

/** "5" or "10-15" -> [from, to], limited like the plugin; null if malformed */
function parseRange(range: string, totalPages: number): [number, number] | null {
  const m = range.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!m) return null;
  const from = Math.max(1, Math.min(Number(m[1]), totalPages));
  let to = m[2] ? Math.max(from, Math.min(Number(m[2]), totalPages)) : from;
  if (to - from > MAX_PAGES_PER_READ) to = from + MAX_PAGES_PER_READ;
  return [from, to];
}

function savedCoverage(snapshot: Snapshot): string {
  return snapshot.pages.length > 0
    ? `The saved copy holds page${snapshot.pages.length === 1 ? "" : "s"} ${pageRanges(snapshot.pages)}.`
    : "The saved copy holds no page text.";
}

/** Text of the saved pages in [from, to], and how many pages of the range are missing */
function pagesText(snapshot: Snapshot, from: number, to: number, withHeaders: boolean): { text: string; missing: number } {
  let text = "";
  let found = 0;
  for (const page of snapshot.pages) {
    if (page.number < from || page.number > to) continue;
    text += withHeaders ? `=== Page ${page.number} ===\n${page.text}\n\n` : `${page.text}\n\n`;
    found++;
  }
  return { text, missing: (to - from + 1) - found };
}

function readPages(ctx: OfflineContext, snapshot: Snapshot, args: Record<string, unknown>): ToolResult {
  const notice = savedCopyNotice(ctx, snapshot);
  let from: number;
  let to: number;
  let heading = "";
  let label: string;

  const chapterIndex = args.chapter !== undefined && args.chapter !== null ? Number(args.chapter) : undefined;
  if (chapterIndex !== undefined) {
    const position = snapshot.toc.findIndex(entry => entry.index === chapterIndex);
    if (position < 0) {
      return textResult(`${notice}\n\nError: Invalid chapter index or chapter not found`, undefined, true);
    }
    const entry = snapshot.toc[position];
    from = entry.page || 1;
    to = position + 1 < snapshot.toc.length
      ? Math.max(from, snapshot.toc[position + 1].page - 1) : snapshot.book.total_pages;
    heading = `Chapter: ${entry.title || "Untitled"}\nPages: ${from}-${to}\n\n`;
    label = `chapter ${chapterIndex} (pages ${from}-${to})`;
  } else if (typeof args.pages === "string" || typeof args.pages === "number") {
    const range = parseRange(String(args.pages), snapshot.book.total_pages);
    if (!range) return textResult(`${notice}\n\nError: Invalid page range`, undefined, true);
    [from, to] = range;
    label = from === to ? `page ${from}` : `pages ${from}-${to}`;
  } else {
    return textResult(`${notice}\n\nPlease specify 'pages' (e.g., '5' or '10-15') or 'chapter' (index from TOC).\n`
      + `Current page: ${snapshot.position.page} of ${snapshot.book.total_pages}`, undefined, true);
  }

  const { text, missing } = pagesText(snapshot, from, to, chapterIndex === undefined);
  if (!text) {
    return textResult(`${notice}\n\nError: ${label[0].toUpperCase()}${label.slice(1)} is not in the saved copy. `
      + `${savedCoverage(snapshot)} Other pages can be read once the reader is back online.`, undefined, true);
  }
  const partial = missing > 0
    ? `\n(${missing} of the requested pages are not in the saved copy. ${savedCoverage(snapshot)})`
    : "";
  return textResult(`${notice}\n\n${heading}${text}${partial}`.trimEnd());
}

// Typographic characters an app may have replaced with ASCII ones (or the
// reverse). Each maps to one character, so positions stay the same.
const FOLD: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"',
  "–": "-", "—": "-", "−": "-", " ": " ",
};
const FOLD_PATTERN = /[‘’‚‛“”„‟–—− ]/g;

function fold(value: string, caseSensitive: boolean): string {
  const folded = value.replace(FOLD_PATTERN, c => FOLD[c]);
  return caseSensitive ? folded : folded.toLowerCase();
}

/** All positions of a needle in a haystack (both already folded) */
function findAll(haystack: string, needle: string, limit: number): number[] {
  const found: number[] = [];
  let from = 0;
  while (found.length < limit) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    found.push(at);
    from = at + needle.length;
  }
  return found;
}

function searchBook(ctx: OfflineContext, snapshot: Snapshot, args: Record<string, unknown>): ToolResult {
  const query = typeof args.query === "string" ? args.query : "";
  if (!query.trim()) return textResult("Error: Empty search query", undefined, true);
  const caseSensitive = args.case_sensitive === true;
  const needle = fold(query, caseSensitive);
  // Lowercasing can change a string's length in a few scripts; if it does,
  // positions no longer line up, so match case-sensitively for that text
  const foldSafe = (s: string) => {
    const folded = fold(s, caseSensitive);
    return folded.length === s.length ? folded : fold(s, true);
  };
  const squeeze = (s: string) => s.replace(/\s+/g, " ");

  const results: Record<string, unknown>[] = [];
  for (const page of snapshot.pages) {
    for (const at of findAll(foldSafe(page.text), needle, MAX_SEARCH_RESULTS - results.length)) {
      results.push({
        page: page.number,
        matched_text: page.text.slice(at, at + needle.length),
        context_before: squeeze(page.text.slice(Math.max(0, at - 80), at)),
        context_after: squeeze(page.text.slice(at + needle.length, at + needle.length + 80)),
      });
    }
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }

  const inNotes: SnapshotAnnotation[] = [];
  for (const annotation of snapshot.annotations) {
    const haystack = fold(`${annotation.text || ""}\n${annotation.note || ""}`, caseSensitive);
    if (haystack.includes(needle)) inNotes.push(annotation);
  }

  const scope = snapshot.pages.length > 0
    ? `Only the saved pages (${pageRanges(snapshot.pages)} of ${snapshot.book.total_pages}) and the user's `
      + `${snapshot.annotations.length} highlights and notes were searched. The rest of the book was NOT searched, `
      + "so no result here does not mean the text is absent from the book."
    : `Only the user's ${snapshot.annotations.length} highlights and notes were searched: the saved copy holds no `
      + "page text. The book itself was NOT searched, so no result here does not mean the text is absent from it.";

  let text = `${savedCopyNotice(ctx, snapshot)}\n\n${scope}\n\n`;
  if (results.length === 0 && inNotes.length === 0) {
    text += `No results found for: ${query}`;
  } else {
    if (results.length > 0) {
      text += `Found ${results.length} result${results.length === 1 ? "" : "s"} in the saved pages:\n\n`;
      for (const r of results.slice(0, 20)) {
        text += `Page ${r.page}: ${r.context_before}**${r.matched_text}**${r.context_after}\n\n`;
      }
      if (results.length > 20) text += `... and ${results.length - 20} more results\n\n`;
    }
    if (inNotes.length > 0) {
      text += `Found in ${inNotes.length} highlight${inNotes.length === 1 ? "" : "s"} or note${inNotes.length === 1 ? "" : "s"}:\n`
        + inNotes.slice(0, 20).map(annotationLine).join("\n");
    }
  }

  return textResult(text.trimEnd(), {
    reader: readerState(ctx, snapshot),
    query,
    searched: { pages: snapshot.pages.map(p => p.number), annotations: snapshot.annotations.length, whole_book: false },
    total_count: results.length,
    results,
    annotation_matches: inNotes,
  });
}

function toolNames(manifest: Manifest | null): Set<string> {
  const names = new Set<string>();
  for (const tool of toolList(manifest)) {
    const name = (tool as { name?: unknown }).name;
    if (typeof name === "string") names.add(name);
  }
  return names;
}

function toolList(manifest: Manifest | null): unknown[] {
  return manifest?.tools && manifest.tools.length > 0 ? manifest.tools : data.tools;
}

/** @returns a tool result, or null for a tool this server doesn't have */
function callTool(ctx: OfflineContext, name: string, args: Record<string, unknown>): ToolResult | null {
  if (!toolNames(ctx.info.manifest).has(name)) return null;

  if (!READ_TOOLS.has(name)) {
    const outcome = ctx.info.unresponsive
      ? "The request was sent to the reader, but it did not confirm it, so it may or may not have been carried "
        + "out. Check on the reader before trying again."
      : "Nothing was changed.";
    return textResult(`[Reader offline]\n${readerStatus(ctx)} This action needs the reader itself, `
      + `so it can't be done now. ${outcome}\nTell the user the reader is offline. To continue, they need to wake `
      + "it, make sure WiFi is on and start the MCP server in KOReader.",
      { reader: readerState(ctx, ctx.snapshot) }, true);
  }

  const snapshot = ctx.snapshot;
  if (!snapshot) {
    return textResult(unavailableNotice(ctx), { reader: readerState(ctx, null) }, true);
  }
  switch (name) {
    case "get_reading_context": return getReadingContext(ctx, snapshot, args);
    case "get_book_metadata": return getBookMetadata(ctx, snapshot);
    case "read_pages": return readPages(ctx, snapshot, args);
    default: return searchBook(ctx, snapshot, args);
  }
}

// ============================================
// Resources and prompts
// ============================================

const BOOK_RESOURCES = [
  { uri: "book://current/context", name: "Reading Context", description: "Current book, chapter, page text and selection (saved copy while the reader is offline)", mimeType: "application/json" },
  { uri: "book://current/metadata", name: "Book Metadata", description: "Metadata of the open book (saved copy while the reader is offline)", mimeType: "application/json" },
  { uri: "book://current/toc", name: "Table of Contents", description: "Table of contents of the open book (saved copy while the reader is offline)", mimeType: "application/json" },
  { uri: "book://current/bookmarks", name: "Bookmarks", description: "Highlights and notes in the open book (saved copy while the reader is offline)", mimeType: "application/json" },
];

function readResource(ctx: OfflineContext, snapshot: Snapshot, uri: string) {
  const reader = readerState(ctx, snapshot);
  const asJson = (value: unknown) => ({ uri, mimeType: "application/json", text: JSON.stringify(value) });
  const asText = (value: string) => ({ uri, mimeType: "text/plain", text: `${savedCopyNotice(ctx, snapshot)}\n\n${value}` });

  if (uri === "book://current/context") {
    const current = snapshot.position.page;
    let text = "";
    for (const n of [current - 1, current, current + 1]) {
      const page = pageByNumber(snapshot, n);
      if (n === current) text += `== Current page: ${n} ==\n\n${page ? page.text + "\n\n" : ""}`;
      else if (page) text += `== Page ${n} ==\n\n${page.text}\n\n`;
    }
    return asJson({
      reader,
      book: { title: snapshot.book.title, authors: snapshot.book.authors, total_pages: snapshot.book.total_pages },
      chapter: snapshot.position.chapter ?? chapterAt(snapshot, current),
      current_page: { number: current },
      pages_text: text,
    });
  }
  if (uri === "book://current/metadata") {
    const { total_pages, ...rest } = bookMetadata(snapshot);
    return asJson({ reader, ...rest, pages: total_pages });
  }
  if (uri === "book://current/toc") return asJson({ reader, chapters: snapshot.toc });
  if (uri === "book://current/bookmarks") {
    return asJson({
      reader,
      highlights: snapshot.annotations.filter(a => !a.note),
      notes: snapshot.annotations.filter(a => a.note),
    });
  }
  let m = uri.match(/^book:\/\/current\/pages\/(.+)$/);
  if (m) {
    const range = parseRange(decodeURIComponent(m[1]), snapshot.book.total_pages);
    if (!range) return asText("Error: Invalid page range format");
    const { text } = pagesText(snapshot, range[0], range[1], true);
    return asText(text || `No text available for specified pages. ${savedCoverage(snapshot)}`);
  }
  m = uri.match(/^book:\/\/current\/chapters\/(\d+)$/);
  if (m) {
    const result = readPages(ctx, snapshot, { chapter: Number(m[1]) });
    const first = result.content[0] as { text: string };
    return { uri, mimeType: "text/plain", text: first.text };
  }
  return null;
}

function promptList(manifest: Manifest | null): { name?: string; description?: string }[] {
  const prompts = manifest?.prompts && manifest.prompts.length > 0 ? manifest.prompts : data.prompts;
  return prompts as { name?: string; description?: string }[];
}

function getPrompt(ctx: OfflineContext, name: string, args: Record<string, unknown>) {
  const prompt = promptList(ctx.info.manifest).find(p => p.name === name);
  if (!prompt) return null;
  const details = Object.entries(args)
    .filter(([, v]) => typeof v === "string" && v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const context = ctx.snapshot
    ? (getReadingContext(ctx, ctx.snapshot, {}).content[0] as { text: string }).text
    : unavailableNotice(ctx);
  return {
    description: prompt.description,
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `${prompt.description || name}\n\n${details ? details + "\n\n" : ""}Reading context:\n${context}`,
      },
    }],
  };
}

// ============================================
// Protocol
// ============================================

type RpcError = { code: number; message: string; data?: unknown };
type Dispatched = { result?: Record<string, unknown>; error?: RpcError; status?: number };

function serverInfo(manifest: Manifest | null) {
  return {
    name: manifest?.serverInfo?.name || "koreader-mcp",
    title: manifest?.serverInfo?.title || "KOReader",
    version: manifest?.serverInfo?.version || "offline",
  };
}

function dispatch(ctx: OfflineContext, method: string, params: Record<string, unknown>, modern: boolean): Dispatched {
  const manifest = ctx.info.manifest;
  const args = () => obj(params.arguments);
  switch (method) {
    case "ping":
      // Removed in 2026-07-28
      return modern ? { error: { code: METHOD_NOT_FOUND, message: "Method not found: ping" }, status: 404 } : { result: {} };
    case "tools/list":
      return { result: { tools: toolList(manifest) } };
    case "tools/call": {
      if (typeof params.name !== "string") {
        return { error: { code: INVALID_PARAMS, message: "Invalid params: missing name" } };
      }
      const result = callTool(ctx, params.name, args());
      return result
        ? { result: result as unknown as Record<string, unknown> }
        : { error: { code: INVALID_PARAMS, message: `Unknown tool: ${params.name}` } };
    }
    case "resources/list":
      // Library resources need the reader, so only the saved book is listed
      return { result: { resources: ctx.snapshot ? BOOK_RESOURCES : [] } };
    case "resources/templates/list":
      return {
        result: {
          resourceTemplates: ctx.snapshot
            ? data.resourceTemplates.filter(t => t.uriTemplate.startsWith("book://"))
            : [],
        },
      };
    case "resources/read": {
      if (typeof params.uri !== "string") {
        return { error: { code: INVALID_PARAMS, message: "Invalid params: missing uri" } };
      }
      let contents: ReturnType<typeof readResource> = null;
      if (ctx.snapshot) {
        try {
          contents = readResource(ctx, ctx.snapshot, params.uri);
        } catch {
          // malformed percent escapes: treated as not found
        }
      }
      return contents
        ? { result: { contents: [contents] } }
        : {
            error: {
              code: RESOURCE_NOT_FOUND,
              message: `Resource not available while the reader is offline: ${params.uri}`,
            },
          };
    }
    case "resources/subscribe":
    case "resources/unsubscribe":
      return modern ? {} : { result: {} };
    case "prompts/list":
      return { result: { prompts: promptList(manifest) } };
    case "prompts/get": {
      const result = getPrompt(ctx, String(params.name || ""), args());
      return result ? { result } : { error: { code: INVALID_PARAMS, message: "Prompt not found" } };
    }
    default:
      return {};
  }
}

function rpcResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

function rpcError(id: unknown, error: RpcError, status = 200): Response {
  return rpcResponse({ jsonrpc: "2.0", id: id ?? null, error }, status);
}

/**
 * Answer an authenticated MCP request for a reader that is offline
 * @param bodyText the request body (the Worker has already read it)
 * @param headers the request's headers (for the protocol version)
 */
export function handleOfflineMcp(bodyText: string, headers: Headers, ctx: OfflineContext): Response {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(bodyText);
  } catch {
    return rpcError(null, { code: PARSE_ERROR, message: "Parse error" }, 400);
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(null, { code: INVALID_REQUEST, message: "Invalid Request: batches are not supported" }, 400);
  }
  const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;
  const method = message.method;
  if (message.jsonrpc !== "2.0" || (method !== undefined && typeof method !== "string")
      || (message.params !== undefined && message.params !== null && typeof message.params !== "object")) {
    return rpcError(id, { code: INVALID_REQUEST, message: "Invalid Request" }, 400);
  }
  // Notifications and client responses get 202 with no body
  if (id === undefined || method === undefined) {
    return new Response(null, { status: 202 });
  }

  const params = obj(message.params);
  const meta = obj(params._meta);
  const headerVersion = headers.get("mcp-protocol-version")?.trim() || undefined;
  const info = serverInfo(ctx.info.manifest);
  const instructions = ctx.info.manifest?.instructions || DEFAULT_INSTRUCTIONS;

  // Stateless era: the version travels in every request's _meta
  const modern = meta[META_PROTOCOL_VERSION] !== undefined
    || (method !== "initialize" && headerVersion !== undefined && MODERN_VERSIONS.includes(headerVersion));
  if (modern) {
    const version = meta[META_PROTOCOL_VERSION];
    if (typeof version !== "string") {
      return rpcError(id, { code: INVALID_PARAMS, message: `Invalid params: _meta is missing ${META_PROTOCOL_VERSION}` }, 400);
    }
    if (headerVersion !== undefined && headerVersion !== version) {
      return rpcError(id, {
        code: HEADER_MISMATCH,
        message: `Header mismatch: MCP-Protocol-Version header value '${headerVersion}' does not match body value '${version}'`,
      }, 400);
    }
    if (!MODERN_VERSIONS.includes(version)) {
      return rpcError(id, {
        code: UNSUPPORTED_PROTOCOL_VERSION,
        message: "Unsupported protocol version",
        data: { supported: ALL_VERSIONS, requested: version },
      }, 400);
    }

    let outcome: Dispatched;
    if (method === "server/discover") {
      outcome = {
        result: {
          supportedVersions: ALL_VERSIONS,
          capabilities: { tools: {}, prompts: {}, resources: {} },
          instructions,
        },
      };
    } else {
      outcome = dispatch(ctx, method, params, true);
    }
    if (outcome.error) return rpcError(id, outcome.error, outcome.status);
    if (!outcome.result) {
      return rpcError(id, { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` }, 404);
    }
    // Nothing answered while offline may be cached: the reader's own answer
    // replaces it as soon as it is back
    return rpcResponse({
      jsonrpc: "2.0",
      id,
      result: {
        ...outcome.result,
        resultType: "complete",
        _meta: { ...obj(outcome.result._meta), [META_SERVER_INFO]: info },
        ttlMs: 0,
        cacheScope: "private",
      },
    });
  }

  // Handshake era
  if (headerVersion && method !== "initialize" && !LEGACY_VERSIONS.includes(headerVersion)) {
    return rpcError(id, {
      code: INVALID_REQUEST,
      message: `Unsupported protocol version: ${headerVersion} (supported: ${ALL_VERSIONS.join(", ")})`,
      data: { supported: ALL_VERSIONS, requested: headerVersion },
    }, 400);
  }
  if (method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    return rpcResponse({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0],
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: info,
        instructions,
      },
    });
  }
  const outcome = dispatch(ctx, method, params, false);
  if (outcome.error) return rpcError(id, outcome.error, outcome.status);
  if (!outcome.result) return rpcError(id, { code: METHOD_NOT_FOUND, message: "Method not found" });
  return rpcResponse({ jsonrpc: "2.0", id, result: outcome.result });
}
