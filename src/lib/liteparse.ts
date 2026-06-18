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
}

let parser: LiteParse | null = null;
let initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await init();
    })();
  }
  await initPromise;
}

export async function getParser(): Promise<LiteParse> {
  await ensureInit();
  if (!parser) {
    parser = new LiteParse({
      ocrEnabled: false,
      quiet: true,
    });
  }
  return parser;
}

export async function parsePdf(
  bytes: Uint8Array,
  opts: ParseOptions = {},
): Promise<ParseResult> {
  const p = await getParser();
  const cfg = p.config;
  if (opts.targetPages !== undefined) cfg.targetPages = opts.targetPages;
  if (opts.maxPages !== undefined) cfg.maxPages = opts.maxPages;
  if (opts.dpi !== undefined) cfg.dpi = opts.dpi;

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
    // The WASM ships text items as `textItems`; fall back to `items` defensively.
    const rawItems = p.textItems ?? p.items ?? [];
    const items: BBoxItem[] = rawItems.map((it) => {
      // The WASM uses top-left origin in the shape we observed (x=60, y=18.9
      // is the title drawn near the top of the page). Treat as such directly
      // and only build bbox if we don't already have a confident top-left.
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
 *
 * We use the native `pdfjs-dist` browser PDF.js for rendering because the
 * LiteParse WASM module only returns text + bboxes — not bitmap output.
 * PDF.js is the canonical browser PDF renderer.
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
