/**
 * OCR engine adapter: wraps tesseract.js as the LiteParse `ocrEngine`.
 *
 * The WASM module calls `recognize(pngBytes, width, height, language)` for any
 * image-only page. We forward to a lazily-initialised tesseract.js worker
 * and convert its `Words[]` output into the `text + bbox + confidence` shape
 * the WASM expects.
 *
 * Loading tesseract.js is gated behind an explicit user action because the
 * English language data is ~4-5 MB on first use.
 */
import type { LiteParse } from "@llamaindex/liteparse-wasm";
import type { OcrEngine, RecogniseResult } from "./liteparse";

let _worker: { recognize: (img: Uint8Array) => Promise<{ data: { words: { text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; confidence: number }[] } }> } | null = null;
let _loading: Promise<typeof _worker> | null = null;

export async function loadOcrEngine(
  language = "eng",
): Promise<{ engine: OcrEngine; cleanup: () => void }> {
  const Tesseract = await import("tesseract.js");
  if (!_worker) {
    if (!_loading) {
      _loading = (async () => {
        const w = await Tesseract.createWorker(language, 1, {
          logger: () => {
            /* silence progress noise */
          },
        });
        _worker = w as unknown as typeof _worker;
        return _worker;
      })();
    }
    await _loading;
  }
  const w = _worker!;
  const engine: OcrEngine = async (imageData, _width, _height, _lang) => {
    // tesseract.js accepts a path, Blob, TypedArray, or ImageData.
    // We pass a Blob so it doesn't try to decode the bytes as a URL.
    const blob = new Blob([imageData.buffer as ArrayBuffer], { type: "image/png" });
    const out = await w.recognize(blob as unknown as Uint8Array);
    const words = out.data.words ?? [];
    return words
      .filter((wd) => wd.text && wd.text.trim().length > 0)
      .map((wd) => ({
        text: wd.text,
        bbox: [wd.bbox.x0, wd.bbox.y0, wd.bbox.x1, wd.bbox.y1] as [
          number,
          number,
          number,
          number,
        ],
        confidence: wd.confidence,
      })) as RecogniseResult[];
  };
  return {
    engine,
    cleanup: () => {
      /* keep worker alive between parses */
    },
  };
}

/**
 * Patch an existing parser instance to enable OCR via a custom JS engine.
 */
export function attachOcrEngine(parser: LiteParse, engine: OcrEngine): void {
  const cfg = (parser as unknown as { config?: Record<string, unknown> }).config;
  if (cfg && typeof cfg === "object") {
    (cfg as Record<string, unknown>).ocrEngine = engine;
    (cfg as Record<string, unknown>).ocrEnabled = true;
  }
  (parser as unknown as { ocrEngine?: OcrEngine }).ocrEngine = engine;
}
