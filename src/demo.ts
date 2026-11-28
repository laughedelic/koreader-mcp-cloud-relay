/**
 * Demo reader
 *
 * A built-in stand-in for a KOReader device, so connector directory
 * reviewers (and curious users) can try every tool without an e-reader.
 * It is reached by signing in with the DEMO_PAIRING_CODE secret, which
 * grants the device ID "demo-reader". If the secret is unset, there is no
 * demo.
 *
 * It serves the first three chapters of "Alice's Adventures in Wonderland"
 * (public domain) with the plugin's own tool, resource and prompt
 * definitions (src/demo-data.json, generated from the plugin's Lua code).
 * It speaks the handshake protocol versions (2025-03-26 to 2025-11-25);
 * clients on 2026-07-28 get UNSUPPORTED_PROTOCOL_VERSION and fall back.
 *
 * Page turns and highlights are kept per Worker isolate only: good enough
 * for a demo, and nothing anyone writes here is stored.
 */

import data from "./demo-data.json";

export const DEMO_DEVICE_ID = "demo-reader";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const PAGE_CHARS = 1800;
const MAX_ANNOTATIONS = 50;
const MAX_NOTE_CHARS = 4000;
const MAX_SESSIONS = 200;

const INSTRUCTIONS = "Access to the book the user is reading in KOReader on their e-reader. "
  + "Start with get_reading_context to see the current book, page and selection. "
  + "(This is a demo reader with a sample book.)";

interface Page {
  number: number;
  chapter: number;
  text: string;
}

interface Annotation {
  page: number;
  start: number;
  end: number;
  text: string;
  note?: string;
  note_format?: string;
  created: string;
}

/** Split the chapters into pages of about PAGE_CHARS, on paragraph boundaries */
function paginate(): { pages: Page[]; chapterStarts: number[] } {
  const pages: Page[] = [];
  const chapterStarts: number[] = [];
  data.book.chapters.forEach((chapter, ci) => {
    chapterStarts.push(pages.length + 1);
    let current = chapter.title + "\n\n";
    for (const paragraph of chapter.paragraphs) {
      if (current.length + paragraph.length > PAGE_CHARS && current.trim()) {
        pages.push({ number: pages.length + 1, chapter: ci, text: current.trim() });
        current = "";
      }
      current += paragraph + "\n\n";
    }
    if (current.trim()) pages.push({ number: pages.length + 1, chapter: ci, text: current.trim() });
  });
  return { pages, chapterStarts };
}

const { pages: PAGES, chapterStarts: CHAPTER_STARTS } = paginate();

// Demo state is kept per sign-in (OAuth grant), in this isolate's memory
// only, so one reviewer never sees another's page or notes
interface DemoState {
  currentPage: number;
  annotations: Annotation[];
}

const sessions = new Map<string, DemoState>();

function sessionState(key: string): DemoState {
  let found = sessions.get(key);
  if (found) {
    sessions.delete(key); // re-insert to keep the most recent last
  } else {
    found = { currentPage: 1, annotations: [] };
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
  }
  sessions.set(key, found);
  return found;
}

// The state of the request being handled; set right before the synchronous dispatch
let state: DemoState = { currentPage: 1, annotations: [] };

function chapterInfo(page: number) {
  const ci = PAGES[page - 1].chapter;
  const start = CHAPTER_STARTS[ci];
  const end = ci + 1 < CHAPTER_STARTS.length ? CHAPTER_STARTS[ci + 1] - 1 : PAGES.length;
  return { name: data.book.chapters[ci].title, index: ci + 1, start_page: start, end_page: end };
}

function metadata() {
  return {
    title: data.book.title,
    authors: data.book.authors,
    language: data.book.language,
    total_pages: PAGES.length,
    current_page: state.currentPage,
    progress: Math.round((state.currentPage / PAGES.length) * 100) / 100,
    source: data.book.source,
    format: "EPUB",
    demo: true,
  };
}

function toc() {
  return data.book.chapters.map((c, i) => ({ index: i + 1, title: c.title, page: CHAPTER_STARTS[i], depth: 1 }));
}

function pageText(n: number): string {
  const source = PAGES[n - 1].text;
  // Mark highlights by their offsets, last first so earlier offsets stay
  // valid; overlapping highlights after the first are left unmarked
  const marks = state.annotations
    .filter(a => a.page === n)
    .sort((a, b) => b.start - a.start);
  let text = source;
  let limit = source.length;
  for (const a of marks) {
    if (a.end > limit) continue;
    const marked = `[HIGHLIGHT]${source.slice(a.start, a.end)}[/HIGHLIGHT]${a.note ? ` [NOTE: ${a.note}]` : ""}`;
    text = text.slice(0, a.start) + marked + text.slice(a.end);
    limit = a.start;
  }
  return text;
}

function parseRange(range: string): [number, number] | null {
  const m = String(range).trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  if (from < 1 || to < from || to > PAGES.length) return null;
  return [from, Math.min(to, from + 19)];
}

function pagesText(from: number, to: number): string {
  const parts: string[] = [];
  for (let n = from; n <= to; n++) parts.push(`== Page ${n} ==\n\n${pageText(n)}`);
  return parts.join("\n\n");
}

function readingContext(before = 0, after = 0) {
  const context: Record<string, unknown> = {
    book: { title: data.book.title, authors: data.book.authors, total_pages: PAGES.length },
    chapter: chapterInfo(state.currentPage),
    current_page: { number: state.currentPage, text: pageText(state.currentPage) },
  };
  const b = Math.max(0, Math.min(5, Math.floor(before)));
  const a = Math.max(0, Math.min(5, Math.floor(after)));
  if (b || a) {
    const from = Math.max(1, state.currentPage - b);
    const to = Math.min(PAGES.length, state.currentPage + a);
    const extra: string[] = [];
    for (let n = from; n <= to; n++) if (n !== state.currentPage) extra.push(`== Page ${n} ==\n\n${pageText(n)}`);
    context.extra_pages = extra.join("\n\n");
  }
  return context;
}

function bookmarks() {
  return state.annotations.map((a, i) => ({
    index: i + 1,
    page: a.page,
    text: a.text,
    note: a.note,
    note_format: a.note_format,
    chapter: chapterInfo(a.page).name,
    datetime: a.created,
    color: "yellow",
    style: "lighten",
  }));
}

// Positions are "demo:<page>:<offset>" in this reader
function position(page: number, offset: number) {
  return `demo:${page}:${offset}`;
}

function parsePosition(pos: unknown): { page: number; offset: number } | null {
  const m = typeof pos === "string" ? pos.match(/^demo:(\d+):(\d+)$/) : null;
  if (!m) return null;
  const page = Number(m[1]);
  if (page < 1 || page > PAGES.length) return null;
  const offset = Number(m[2]);
  if (offset > PAGES[page - 1].text.length) return null;
  return { page, offset };
}

function text(t: string) {
  return { content: [{ type: "text", text: t }] };
}

function errorResult(t: string) {
  return { content: [{ type: "text", text: t }], isError: true };
}

function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "get_reading_context":
      return text(json(readingContext(Number(args.extra_pages_before) || 0, Number(args.extra_pages_after) || 0)));

    case "get_book_metadata":
      return text(json({ ...metadata(), chapter: chapterInfo(state.currentPage), table_of_contents: toc() }));

    case "read_pages": {
      if (args.chapter !== undefined) {
        const ci = Number(args.chapter);
        if (!Number.isInteger(ci) || ci < 1 || ci > CHAPTER_STARTS.length) {
          return errorResult(`Error: chapter must be 1 to ${CHAPTER_STARTS.length}`);
        }
        const info = chapterInfo(CHAPTER_STARTS[ci - 1]);
        return text(`# ${info.name}\n\n` + pagesText(info.start_page, info.end_page));
      }
      const range = parseRange(String(args.pages ?? state.currentPage));
      if (!range) return errorResult(`Error: pages must be like "5" or "3-7", within 1-${PAGES.length}`);
      return text(pagesText(range[0], range[1]));
    }

    case "search_book": {
      const query = typeof args.query === "string" ? args.query : "";
      if (!query.trim()) return errorResult("Error: Empty search query");
      const caseSensitive = args.case_sensitive === true;
      const needle = caseSensitive ? query : query.toLowerCase();
      const results: unknown[] = [];
      for (const page of PAGES) {
        const hay = caseSensitive ? page.text : page.text.toLowerCase();
        let from = 0;
        for (;;) {
          const at = hay.indexOf(needle, from);
          if (at < 0 || results.length >= 50) break;
          results.push({
            page: page.number,
            chapter: data.book.chapters[page.chapter].title,
            matched_text: page.text.slice(at, at + query.length),
            context: "…" + page.text.slice(Math.max(0, at - 80), at + query.length + 80).replace(/\s+/g, " ") + "…",
            start: position(page.number, at),
            end: position(page.number, at + query.length),
          });
          from = at + needle.length;
        }
      }
      return text(json({ query, total_results: results.length, results }));
    }

    case "goto_page": {
      const page = Number(args.page);
      if (!Number.isInteger(page) || page < 1 || page > PAGES.length) {
        return errorResult(`Error: page must be 1 to ${PAGES.length}`);
      }
      state.currentPage = page;
      return text(`Navigated to page ${page} of ${PAGES.length}`);
    }

    case "annotate": {
      let page = state.currentPage;
      let from = 0;
      let to = 0;
      const start = parsePosition(args.start);
      const end = parsePosition(args.end);
      if (start && end && start.page === end.page && end.offset > start.offset) {
        page = start.page;
        from = start.offset;
        to = end.offset;
      } else if (typeof args.text === "string" && args.text.trim()) {
        const wanted = args.text.trim();
        let found = PAGES.find(p => p.text.includes(wanted));
        let at = found ? found.text.indexOf(wanted) : -1;
        if (!found) {
          found = PAGES.find(p => p.text.toLowerCase().includes(wanted.toLowerCase()));
          at = found ? found.text.toLowerCase().indexOf(wanted.toLowerCase()) : -1;
        }
        if (!found) return errorResult("Error: Text not found in the book");
        page = found.number;
        from = at;
        to = at + wanted.length;
      } else if (args.start !== undefined || args.end !== undefined) {
        return errorResult("Error: Invalid start/end positions (use positions from search_book)");
      } else {
        return errorResult("Error: No text selected. Pass text, or start/end positions from search_book.");
      }

      const passage = PAGES[page - 1].text.slice(from, to);
      const note = typeof args.note === "string" && args.note ? args.note : undefined;
      const tooLong = `Error: Notes in the demo reader are limited to ${MAX_NOTE_CHARS} characters`;
      if (note && note.length > MAX_NOTE_CHARS) return errorResult(tooLong);
      const existing = state.annotations.find(a => a.page === page && a.start === from && a.end === to);
      if (existing) {
        if (note && existing.note && existing.note !== note) {
          const mode = args.if_note_exists === "append" ? "append" : args.if_note_exists === "keep" ? "keep" : "replace";
          if (mode === "append") {
            const appended = existing.note + "\n\n" + note;
            if (appended.length > MAX_NOTE_CHARS) return errorResult(tooLong);
            existing.note = appended;
          } else if (mode === "replace") existing.note = note;
        } else if (note) {
          existing.note = note;
        }
        return text(`Updated the highlight on page ${page}${existing.note ? " with a note" : ""} (demo reader: not saved).`);
      }
      if (state.annotations.length >= MAX_ANNOTATIONS) state.annotations.shift();
      state.annotations.push({
        page,
        start: from,
        end: to,
        text: passage,
        note,
        note_format: typeof args.note_format === "string" ? args.note_format : undefined,
        created: new Date().toISOString(),
      });
      return text(`${note ? "Added a note" : "Highlighted"} on page ${page}: "${passage.slice(0, 120)}" (demo reader: not saved).`);
    }

    default:
      return null;
  }
}

const BOOK_RESOURCES = [
  { uri: "book://current/context", name: "Reading Context", description: "Current book, chapter, page text and selection", mimeType: "application/json" },
  { uri: "book://current/metadata", name: "Book Metadata", description: "Metadata of the open book", mimeType: "application/json" },
  { uri: "book://current/toc", name: "Table of Contents", description: "Table of contents of the open book", mimeType: "application/json" },
  { uri: "book://current/bookmarks", name: "Bookmarks", description: "Highlights and notes in the open book", mimeType: "application/json" },
];

function readResource(uri: string): { uri: string; mimeType: string; text: string } | null {
  const asJson = (value: unknown) => ({ uri, mimeType: "application/json", text: json(value) });
  const asText = (value: string) => ({ uri, mimeType: "text/plain", text: value });
  if (uri === "book://current/context") return asJson(readingContext());
  if (uri === "book://current/metadata") return asJson(metadata());
  if (uri === "book://current/toc") return asJson(toc());
  if (uri === "book://current/bookmarks") return asJson(bookmarks());
  let m = uri.match(/^book:\/\/current\/pages\/(.+)$/);
  if (m) {
    const range = parseRange(decodeURIComponent(m[1]));
    return range ? asText(pagesText(range[0], range[1])) : null;
  }
  m = uri.match(/^book:\/\/current\/chapters\/(\d+)$/);
  if (m) {
    const ci = Number(m[1]);
    if (ci < 1 || ci > CHAPTER_STARTS.length) return null;
    const info = chapterInfo(CHAPTER_STARTS[ci - 1]);
    return asText(`# ${info.name}\n\n` + pagesText(info.start_page, info.end_page));
  }
  const book = { path: "/books/alice.epub", title: data.book.title, authors: data.book.authors, progress: metadata().progress };
  if (uri === "library://books") return asJson([book]);
  if (uri === "library://history") return asJson([{ ...book, last_read: new Date().toISOString() }]);
  if (uri === "library://collections") return asJson([]);
  if (uri.startsWith("library://books/")) {
    return decodeURIComponent(uri.slice("library://books/".length)).replace(/^\/?/, "/") === book.path
      ? asJson(book) : null;
  }
  return null;
}

function getPrompt(name: string, args: Record<string, unknown>) {
  const prompt = data.prompts.find(p => p.name === name);
  if (!prompt) return null;
  const details = Object.entries(args)
    .filter(([, v]) => typeof v === "string" && v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const context = readingContext();
  return {
    description: prompt.description,
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `${prompt.description}\n\n${details ? details + "\n\n" : ""}Reading context:\n${json(context)}`,
      },
    }],
  };
}

type RpcResult = { result?: unknown; error?: { code: number; message: string; data?: unknown }; status?: number };

function dispatch(method: string, params: Record<string, unknown>): RpcResult {
  switch (method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const version = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
      return {
        result: {
          protocolVersion: version,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: "koreader-mcp", title: "KOReader (demo reader)", version: "demo" },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { result: {} };
    case "tools/list":
      return { result: { tools: data.tools } };
    case "tools/call": {
      const name = String(params.name || "");
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
      const result = callTool(name, args);
      return result ? { result } : { error: { code: -32602, message: `Unknown tool: ${name}` } };
    }
    case "resources/list":
      return { result: { resources: [...BOOK_RESOURCES, ...data.libraryResources] } };
    case "resources/templates/list":
      return { result: { resourceTemplates: data.resourceTemplates } };
    case "resources/read": {
      const uri = String(params.uri || "");
      let contents: ReturnType<typeof readResource> = null;
      try {
        contents = readResource(uri);
      } catch {
        // malformed percent escapes: treat as not found
      }
      return contents
        ? { result: { contents: [contents] } }
        : { error: { code: -32002, message: `Resource not found: ${uri}` } };
    }
    case "prompts/list":
      return { result: { prompts: data.prompts } };
    case "prompts/get": {
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
      const result = getPrompt(String(params.name || ""), args);
      return result ? { result } : { error: { code: -32602, message: `Unknown prompt: ${params.name}` } };
    }
    default:
      return { error: { code: -32601, message: "Method not found" } };
  }
}

function rpcResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

/** Handle an authenticated MCP request for the demo reader */
export async function handleDemoMcp(request: Request, session: string): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Allow": "POST" },
    });
  }
  let message: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
  try {
    message = await request.json();
  } catch {
    return rpcResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
    return rpcResponse({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, 400);
  }

  // Notifications and responses get 202 with no body
  if (message.id === undefined || message.id === null || typeof message.method !== "string") {
    return new Response(null, { status: 202 });
  }

  const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>;
  const meta = params._meta as Record<string, unknown> | undefined;
  const modernVersion = meta && typeof meta[META_PROTOCOL_VERSION] === "string" ? meta[META_PROTOCOL_VERSION] : undefined;
  if (modernVersion || message.method === "server/discover") {
    return rpcResponse({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: { supported: PROTOCOL_VERSIONS, requested: modernVersion ?? null },
      },
    }, 400);
  }

  // dispatch is synchronous, so no other request can swap the state midway
  state = sessionState(session);
  const { result, error } = dispatch(message.method, params);
  return rpcResponse(error
    ? { jsonrpc: "2.0", id: message.id, error }
    : { jsonrpc: "2.0", id: message.id, result });
}
