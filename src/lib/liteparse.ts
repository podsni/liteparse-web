/**
 * liteparse.ts — thin wrapper around the @llamaindex/liteparse-wasm module.
 *
 * The WASM is large (~4.5MB) so we lazy-load it on first use. We keep a
 * single parser instance and reuse it across pages / re-parses.
 *
 * The result shape from LiteParse.wasm:
 *   {
 *     text: string,
 *     pages: [
 *       {
 *         pageNumber: number,
 *         width: number,
 *         height: number,
 *         items: [
 *           { text: string, bbox: [x1, y1, x2, y2], confidence?: number }
 *         ]
 *       }
 *     ]
 *   }
 *
 * This wrapper normalizes + type-narrows the result.
 */
import init, { LiteParse } from "@llamaindex/liteparse-wasm";

export interface BBoxItem {
  text: string;
  /** [x1, y1, x2, y2] in PDF user-space points (origin = top-left in LiteParse). */
  bbox: [number, number, number, number];
  confidence?: number;
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
  // Configure per-parse settings via the live config object.
  // (LiteParse config is read on parse; mutating here is fine.)
  const cfg = p.config;
  if (opts.targetPages !== undefined) cfg.targetPages = opts.targetPages;
  if (opts.maxPages !== undefined) cfg.maxPages = opts.maxPages;
  if (opts.dpi !== undefined) cfg.dpi = opts.dpi;

  const raw = (await p.parse(bytes)) as ParseResult;
  return normalize(raw);
}

function normalize(raw: ParseResult): ParseResult {
  const pages = (raw.pages ?? []).map((p) => ({
    pageNumber: Number(p.pageNumber ?? 0),
    width: Number(p.width ?? 0),
    height: Number(p.height ?? 0),
    items: (p.items ?? []).map((it) => {
      const b = it.bbox ?? [];
      return {
        text: String(it.text ?? ""),
        bbox: [
          Number(b[0] ?? 0),
          Number(b[1] ?? 0),
          Number(b[2] ?? 0),
          Number(b[3] ?? 0),
        ] as [number, number, number, number],
        confidence:
          typeof it.confidence === "number" ? it.confidence : undefined,
      };
    }),
  }));
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
  const page = await doc.getPage(pageNumber);
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
