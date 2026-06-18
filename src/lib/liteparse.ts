/**
 * liteparse.ts — thin wrapper around the @llamaindex/liteparse-wasm module.
 *
 * The WASM is large (~4.5MB) so we lazy-load it on first use. We keep a
 * single parser instance and reuse it across pages / re-parses.
 *
 * The actual result shape from LiteParse.wasm (verified against sample.pdf):
 *   {
 *     text: string,
 *     pages: [
 *       {
 *         pageNum: number,        // 1-based page number
 *         width: number,          // PDF user-space points
 *         height: number,
 *         text: string,           // full text for the page
 *         textItems: [
 *           {
 *             text: string,
 *             x: number,          // top-left x in PDF points (origin = top-left)
 *             y: number,          // top y in PDF points (origin = top-left)
 *             width: number,
 *             height: number,
 *             fontName?: string,
 *             fontSize?: number
 *           }
 *         ]
 *       }
 *     ]
 *   }
 *
 * This wrapper normalizes + type-narrows the result and exposes a stable
 * shape to the rest of the app: { pageNumber, width, height, items[] }.
 * Each item's `bbox` is the [x0, y0, x1, y2] rectangle in points, origin top-left.
 */
import init, { LiteParse } from "@llamaindex/liteparse-wasm";

export interface BBoxItem {
  text: string;
  /** [x0, y0, x1, y1] in PDF user-space points, origin = top-left. */
  bbox: [number, number, number, number];
  fontName?: string;
  fontSize?: number;
}

export interface PageData {
  pageNumber: number;
  width: number;
  height: number;
  items: BBoxItem[];
}

export interface ParseResult {
  text: string;
  pages: PageData[];
}

export interface ParseOptions {
  /** Page range, e.g. "1-5,10,15-20" or undefined for all. */
  targetPages?: string;
  /** Max pages (default 1000 in wasm). */
  maxPages?: number;
  /** Render DPI for screenshots / OCR (default 150). */
  dpi?: number;
  /** Enable OCR fallback for image-only pages. */
  ocrEnabled?: boolean;
  /** OCR language (e.g. "eng"). */
  ocrLanguage?: string;
  /** Custom OCR engine function for browser-side OCR. */
  ocrEngine?: OcrEngine;
}

let parser: LiteParse | null = null;
let initPromise: Promise<void> | null = null;
let parserOcr: boolean = false;

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await init();
    })();
  }
  await initPromise;
}

export interface RecogniseResult {
  text: string;
  bbox: [number, number, number, number];
  confidence?: number;
}
export type OcrEngine = (
  imageData: Uint8Array<ArrayBufferLike>,
  width: number,
  height: number,
  language: string,
) => Promise<RecogniseResult[]>;

export async function getParser(opts: { ocrEnabled?: boolean; ocrEngine?: OcrEngine } = {}): Promise<LiteParse> {
  await ensureInit();
  const wantOcr = !!opts.ocrEnabled;
  const wantEngine = opts.ocrEngine;

  if (!parser) {
    // We pass the engine on the config object as `ocrEngine`; the WASM
    // reads it from there at parse time.
    parser = new LiteParse({
      ocrEnabled: wantOcr,
      quiet: true,
      ocrEngine: wantEngine,
    } as unknown as ConstructorParameters<typeof LiteParse>[0]);
    parserOcr = wantOcr;
  } else {
    // Re-create the parser if the OCR setting changed, or if an engine
    // was supplied where previously there was none.
    if (wantOcr && (wantEngine || !parserOcr)) {
      parser = new LiteParse({
        ocrEnabled: wantOcr,
        quiet: true,
        ocrEngine: wantEngine,
      } as unknown as ConstructorParameters<typeof LiteParse>[0]);
      parserOcr = wantOcr;
    } else if (!wantOcr && parserOcr) {
      parser = new LiteParse({ ocrEnabled: false, quiet: true });
      parserOcr = false;
    }
  }
  return parser;
}

export async function parsePdf(
  bytes: Uint8Array,
  opts: ParseOptions = {},
): Promise<ParseResult> {
  const p = await getParser({
    ocrEnabled: opts.ocrEnabled,
  });
  const cfg = p.config;
  if (opts.targetPages !== undefined) cfg.targetPages = opts.targetPages;
  if (opts.maxPages !== undefined) cfg.maxPages = opts.maxPages;
  if (opts.dpi !== undefined) cfg.dpi = opts.dpi;
  if (opts.ocrEnabled !== undefined) cfg.ocrEnabled = opts.ocrEnabled;

  const raw = (await p.parse(bytes)) as unknown as RawParseResult;
  return normalize(raw);
}

// ---------- Internal: raw WASM shape (kept loose because the WASM types
// don't quite match the runtime payload) ----------

interface RawTextItem {
  text?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  fontName?: unknown;
  fontSize?: unknown;
  confidence?: unknown;
}

interface RawPage {
  pageNum?: unknown;
  width?: unknown;
  height?: unknown;
  text?: unknown;
  textItems?: RawTextItem[];
  items?: RawTextItem[]; // tolerate either key, just in case
}

interface RawParseResult {
  text?: unknown;
  pages?: RawPage[];
}

function normalize(raw: RawParseResult): ParseResult {
  const pages: PageData[] = (raw.pages ?? []).map((p) => {
    const width = Number(p.width ?? 0);
    const height = Number(p.height ?? 0);
    const rawItems = p.textItems ?? p.items ?? [];
    const items: BBoxItem[] = rawItems.map((it) => {
      const x = Number(it.x ?? 0);
      const y = Number(it.y ?? 0);
      const w = Number(it.width ?? 0);
      const h = Number(it.height ?? 0);
      return {
        text: String(it.text ?? "").trimEnd(),
        bbox: [x, y, x + w, y + h] as [number, number, number, number],
        fontName: typeof it.fontName === "string" ? it.fontName : undefined,
        fontSize: typeof it.fontSize === "number" ? it.fontSize : undefined,
      };
    });
    return {
      pageNumber: Number(p.pageNum ?? 0),
      width,
      height,
      items,
    };
  });
  return {
    text: String(raw.text ?? ""),
    pages,
  };
}

/**
 * Render a single page to PNG via PDFium (browser-side). Returns a
 * data-URL ready for use as <img src>.
 */
let pdfjsModule: typeof import("pdfjs-dist") | null = null;

async function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (pdfjsModule) return pdfjsModule;
  const pdfjs = await import("pdfjs-dist");
  // Use the bundled worker (vite ?url import).
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url"))
    .default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  pdfjsModule = pdfjs;
  return pdfjs;
}

export async function renderPagePng(
  bytes: Uint8Array,
  pageNumber: number,
  dpi = 150,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const pdfjs = await loadPdfjs();
  // PDF.js takes a fresh copy — typed-array buffer can be detached.
  const data = new Uint8Array(bytes);
  const loadingTask = pdfjs.getDocument({ data });
  const doc = await loadingTask.promise;
  // PDF.js page numbers are 1-based. Defensive clamp in case the upstream
  // pageNumber is 0-based (some parsers ship 0-based).
  const safePage = Math.min(Math.max(1, pageNumber), doc.numPages);
  const page = await doc.getPage(safePage);
  // scale = dpi / 72 (PDF default is 72dpi).
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D not available");
  await page.render({
    canvasContext: ctx,
    viewport,
    canvas,
  }).promise;
  const dataUrl = canvas.toDataURL("image/png");
  const out = { dataUrl, width: viewport.width, height: viewport.height };
  // Free PDF.js page resources.
  page.cleanup();
  return out;
}

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

/**
 * Convert a parsed result to Markdown. Heuristics:
 *  - Items grouped per page, then by y-band (lines).
 *  - Font size bands:
 *      >= 22pt -> # heading
 *      >= 16pt -> ## heading
 *      >= 13pt -> ### heading
 *      else    -> paragraph
 *  - "- " prefixed lines become list items.
 *  - Empty bands become blank lines (paragraph break).
 *  - Each page is separated by `---`.
 */
export function toMarkdown(
  result: ParseResult,
  meta?: { title?: string; source?: string; ocr?: boolean },
): string {
  const out: string[] = [];
  const title = meta?.title ?? "Parsed PDF";
  out.push(`# ${title}`);
  out.push("");
  if (meta?.source) {
    out.push(`*Source: \`${meta.source}\`*`);
    out.push("");
  }
  if (meta?.ocr) {
    out.push("> Extracted with OCR fallback enabled.");
    out.push("");
  }

  result.pages.forEach((page, pageIdx) => {
    if (pageIdx > 0) {
      out.push("");
      out.push("---");
      out.push("");
    }
    if (result.pages.length > 1) {
      out.push(`## Page ${page.pageNumber}`);
      out.push("");
    }

    const lines = groupIntoLines(page.items);
    for (const line of lines) {
      const text = line.map((i) => i.text).join(" ").trim();
      if (!text) {
        out.push("");
        continue;
      }
      const maxFs = Math.max(
        ...line.map((i) => i.fontSize ?? 11).filter((n) => Number.isFinite(n)),
      );
      // Detect bullet: line is just "-" or starts with "- " or similar.
      if (/^[-*•·]\s*$/.test(text) || text === "-") {
        // Will be combined with following content as a list item by caller.
        out.push(`- ${text.replace(/^[-*•·]\s*/, "")}`.trim());
        continue;
      }
      if (maxFs >= 22) {
        out.push(`# ${text}`);
      } else if (maxFs >= 16) {
        out.push(`## ${text}`);
      } else if (maxFs >= 13) {
        out.push(`### ${text}`);
      } else {
        out.push(text);
      }
      out.push("");
    }
  });

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function groupIntoLines(items: BBoxItem[]): BBoxItem[][] {
  if (items.length === 0) return [];
  // Sort top-to-bottom, left-to-right.
  const sorted = [...items].sort((a, b) => {
    if (Math.abs(a.bbox[1] - b.bbox[1]) > 4) return a.bbox[1] - b.bbox[1];
    return a.bbox[0] - b.bbox[0];
  });
  const lines: BBoxItem[][] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].bbox[1] - it.bbox[1]) <= 4) {
      last.push(it);
    } else {
      lines.push([it]);
    }
  }
  return lines;
}
