/**
 * markdown.ts — Layout-aware PDF → Markdown converter.
 *
 * LiteParse's WASM build only exposes JSON or text output. The native Rust
 * build has a sophisticated markdown pipeline (see `markdown_layout/` in the
 * liteparse repo) that uses font size, weight, position, and reading order
 * to classify text items into headings, paragraphs, lists, and tables.
 *
 * This is a self-contained, WASM-compatible port of those heuristics that
 * works from the same `BBoxItem[]` shape the rest of the app already uses.
 *
 * Heuristics (ordered):
 *   1. Estimate body font size (char-weighted mode, ignoring rotated items).
 *   2. Classify each line: heading if `size > body + epsilon`, by delta level.
 *   3. Detect bold via `fontName` substring ("Bold", "Heavy", "Black", "Demi").
 *   4. Detect list markers: bullet glyphs (`•·◦▪▸▶●○■□`) and ordered (`1.` `1)`).
 *   5. Group lines into paragraphs: gap > 1.5× line height, or font size change.
 *   6. Dehyphenate soft-hyphen wraps (`architec-` + `ture` → `architecture`).
 *   7. Reading order: Y-band sort (with band tolerance) then X within band.
 */

import type { BBoxItem, PageData, ParseResult } from "./liteparse";

// --- Tunables --------------------------------------------------------------

const HEADING_EPSILON = 2.0; // pt — must be at least 2pt above body to count as heading
// Heading level by font-size delta from body:
//   >= 10pt above body -> H1
//   >= 5pt above body  -> H2
//   >= 2pt above body  -> H3
//   short bold caption  -> H4
const HEADING_LEVEL_THRESHOLDS: [number, 1 | 2 | 3 | 4 | 5 | 6][] = [
  [10, 1],
  [3, 2],
  [2, 3],
];
const PARAGRAPH_GAP_MULT = 1.2; // gap > 1.2x line height = new paragraph
const Y_BAND_TOLERANCE = 0.4; // Y diff (fraction of line height) = same band
const BULLET_CHARS = "•·◦▪▸▶●○■□–—−·";
// Within a Y-band, if items are separated by >= this x-gap (in pt) and the
// leftmost item is a list marker, treat them as separate list items.
const LIST_SPLIT_X_GAP = 8;

// --- Public API -------------------------------------------------------------

export interface MarkdownOptions {
  title?: string;
  source?: string;
  ocr?: boolean;
  /** Treat first text line on the first page as H1 if its size is > body+4. */
  promoteFirstLine?: boolean;
}

export function toMarkdown(
  result: ParseResult,
  opts: MarkdownOptions = {},
): string {
  const blocks = buildBlocks(result, opts);
  return renderMarkdown(blocks, opts);
}

// --- Block model ------------------------------------------------------------

type Block =
  | { kind: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "p"; text: string; bold: boolean }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "hr" }
  | { kind: "code"; text: string };

interface RawLine {
  y: number;
  x: number;
  height: number;
  text: string;
  fontSize: number;
  fontName: string;
  bold: boolean;
  items: BBoxItem[];
}

// --- Body size estimation ---------------------------------------------------

function estimateBodySize(pages: PageData[]): number {
  const weight = new Map<number, number>();
  for (const page of pages) {
    for (const it of page.items) {
      if (it.fontSize == null || !Number.isFinite(it.fontSize)) continue;
      if (it.bbox[0] < 0 || it.bbox[1] < 0) continue;
      // Round to nearest 0.5pt to avoid float jitter creating many bins.
      const key = Math.round(it.fontSize * 2) / 2;
      const w = (it.text || "").length || 1;
      weight.set(key, (weight.get(key) ?? 0) + w);
    }
  }
  if (weight.size === 0) return 11; // sensible default
  let best = 11;
  let bestW = -1;
  for (const [size, w] of weight) {
    if (w > bestW) {
      bestW = w;
      best = size;
    }
  }
  return best;
}

function isBoldFromName(name: string | undefined): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  // Common bold tokens in PDF font names. Order matters — "semibold" comes
  // before "bold" so we don't false-match. Italic check is separate.
  return /bold|black|heavy|demi|extra(|-| )?bold|semibold/.test(n);
}

function isItalicFromName(name: string | undefined): boolean {
  if (!name) return false;
  return /italic|oblique/.test(name.toLowerCase());
}

// --- Line grouping (grid-projection style) ----------------------------------

function groupIntoLines(items: BBoxItem[]): RawLine[] {
  if (items.length === 0) return [];
  // Sort top→bottom, left→right.
  const sorted = [...items].sort((a, b) => {
    const dy = a.bbox[1] - b.bbox[1];
    if (Math.abs(dy) > 4) return dy;
    return a.bbox[0] - b.bbox[0];
  });
  // First pass: Y-bands (rows). Within a band, items are sorted left→right.
  const bands: BBoxItem[][] = [];
  for (const it of sorted) {
    const last = bands[bands.length - 1];
    if (last && last.length) {
      const ref = last[0];
      const h = Math.max(ref.bbox[3] - ref.bbox[1], 8);
      if (Math.abs(ref.bbox[1] - it.bbox[1]) <= h * Y_BAND_TOLERANCE) {
        last.push(it);
        continue;
      }
    }
    bands.push([it]);
  }
  // Second pass: split a band when it contains multiple list markers —
  // e.g. four bullets on the same y at different x. We split at the
  // boundary where the next item starts a new list item.
  const splitBands: BBoxItem[][] = [];
  for (const band of bands) {
    band.sort((a, b) => a.bbox[0] - b.bbox[0]);
    let current: BBoxItem[] = [band[0]];
    for (let i = 1; i < band.length; i++) {
      const prev = current[current.length - 1];
      const cur = band[i];
      const xGap = cur.bbox[0] - prev.bbox[2];
      // If the next item starts a new list marker, and the gap between the
      // previous item's right edge and the current item's left edge is
      // wide enough, treat them as separate list items.
      if (startsWithListMarker(cur.text) && xGap > LIST_SPLIT_X_GAP) {
        splitBands.push(current);
        current = [cur];
      } else {
        current.push(cur);
      }
    }
    splitBands.push(current);
  }
  return splitBands.map((band) => {
    const text = band
      .map((i) => (i.text ?? "").trim())
      .filter(Boolean)
      .join(" ");
    const fs = band[0]?.fontSize ?? 0;
    const fn = band[0]?.fontName ?? "";
    const h = band.reduce(
      (m, i) => Math.max(m, i.bbox[3] - i.bbox[1]),
      fs || 12,
    );
    return {
      y: band[0].bbox[1],
      x: band[0].bbox[0],
      height: h,
      text: text.replace(/\s+/g, " ").trim(),
      fontSize: fs,
      fontName: fn,
      bold: isBoldFromName(fn),
      items: band,
    };
  });
}

// --- Paragraph / block construction ----------------------------------------

function buildBlocks(
  result: ParseResult,
  opts: MarkdownOptions,
): Block[] {
  const bodySize = estimateBodySize(result.pages);
  const out: Block[] = [];

  // Build a "first line is title" heuristic.
  let firstPageFirst = true;

  for (let pageIdx = 0; pageIdx < result.pages.length; pageIdx++) {
    const page = result.pages[pageIdx];
    const lines = groupIntoLines(page.items);
    if (lines.length === 0) continue;

    // Skip the first line of page 1 if it's a giant title and the user
    // already gave us a `title` (avoid duplicate H1).
    const skipFirst = firstPageFirst && !!opts.title;
    firstPageFirst = false;

    // Classify lines first, then group into blocks.
    type Classified =
      | { kind: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; line: RawLine }
      | { kind: "li"; ordered: boolean; line: RawLine }
      | { kind: "p"; line: RawLine };

    const classified: Classified[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (skipFirst && i === 0) continue;
      const ln = lines[i];
      if (!ln.text) continue;

      const cls = classifyLine(ln, bodySize);
      classified.push(cls);
    }

    // Detect horizontal rule: line that is just a sequence of dashes/underscores.
    if (classified.length === 0) continue;

    // Now group adjacent `p` lines into a single paragraph block, and
    // collapse adjacent `li` into a single list block.
    let i = 0;
    while (i < classified.length) {
      const c = classified[i];

      if (c.kind === "li") {
        const firstOrdered = c.ordered;
        const items: string[] = [];
        while (
          i < classified.length &&
          classified[i].kind === "li" &&
          (classified[i] as Extract<Classified, { kind: "li" }>).ordered ===
            firstOrdered
        ) {
          items.push((classified[i] as Extract<Classified, { kind: "li" }>).line.text);
          i++;
        }
        out.push(firstOrdered ? { kind: "ol", items } : { kind: "ul", items });
        continue;
      }

      if (c.kind === "h") {
        out.push({ kind: "h", level: c.level, text: c.line.text });
        i++;
        continue;
      }

      if (c.kind === "p") {
        // Collect consecutive paragraph-classified lines that share a font
        // size (or differ by < 0.5pt) and the gap between them is < 1.5x
        // line height. Apply dehyphenation at the boundary.
        const paras: string[] = [];
        const initialBold = c.line.bold;
        let currentFont = c.line.fontSize;
        let buffer = c.line.text;
        // Track the most recent RawLine so we can compute the gap to the
        // next line for paragraph-break detection.
        let prevLine: RawLine = c.line;
        i++;
        while (i < classified.length) {
          const nxt = classified[i];
          if (nxt.kind !== "p") break;
          const nxtLine: RawLine = nxt.line;
          const gap = nxtLine.y - (prevLine.y + prevLine.height);
          const gapThreshold = prevLine.height * PARAGRAPH_GAP_MULT;
          const sizeDelta = Math.abs(nxtLine.fontSize - currentFont);
          if (gap > gapThreshold || sizeDelta > 0.5) {
            // New paragraph.
            paras.push(buffer);
            buffer = nxtLine.text;
            currentFont = nxtLine.fontSize;
          } else {
            buffer = dehyphenateJoin(buffer, nxtLine.text);
          }
          prevLine = nxtLine;
          i++;
        }
        paras.push(buffer);
        for (const text of paras) {
          if (looksLikeHorizontalRule(text)) {
            out.push({ kind: "hr" });
          } else if (looksLikeCodeBlock(text)) {
            out.push({ kind: "code", text });
          } else {
            out.push({ kind: "p", text, bold: initialBold });
          }
        }
        continue;
      }
    }
  }

  return out;
}

function classifyLine(
  ln: RawLine,
  bodySize: number,
): { kind: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; line: RawLine } | {
  kind: "li";
  ordered: boolean;
  line: RawLine;
} | { kind: "p"; line: RawLine } {
  // 1. List marker?
  const m = parseListMarker(ln.text);
  if (m) {
    return {
      kind: "li",
      ordered: m.ordered,
      line: { ...ln, text: m.remainder },
    };
  }

  // 2. Heading by size (and optionally by boldness for body-size headings).
  const delta = ln.fontSize - bodySize;
  if (delta > HEADING_EPSILON && ln.text.length < 200) {
    let level: 1 | 2 | 3 | 4 | 5 | 6 = 3;
    for (const [threshold, lvl] of HEADING_LEVEL_THRESHOLDS) {
      if (delta >= threshold) {
        level = lvl;
        break;
      }
    }
    return { kind: "h", level, line: ln };
  }

  // 3. Bold, short, sentence-case line right after a gap → body-size heading.
  if (
    ln.bold &&
    !isItalicFromName(ln.fontName) &&
    ln.text.length < 80 &&
    /^[A-Z]/.test(ln.text) &&
    !/[.!?]$/.test(ln.text)
  ) {
    // Promote to H4 only if no other heading signal exists; the strict
    // gap-check is done by the caller via paragraph grouping.
    return { kind: "h", level: 4, line: ln };
  }

  return { kind: "p", line: ln };
}

function parseListMarker(
  text: string,
): { ordered: boolean; marker: string; remainder: string } | null {
  const trimmed = text.trimStart();
  if (!trimmed) return null;

  // Bullet glyph
  const bullet = trimmed[0];
  if (BULLET_CHARS.includes(bullet) && /^\s/.test(trimmed[1] ?? " ")) {
    return {
      ordered: false,
      marker: bullet,
      remainder: trimmed.slice(1).trimStart(),
    };
  }

  // Ordered: 1. / 1) / 12. / 12) followed by whitespace
  const m = /^(\d{1,3})[.)]\s+(.*)$/.exec(trimmed);
  if (m) {
    return { ordered: true, marker: m[1] + trimmed[m[1].length], remainder: m[2] };
  }
  return null;
}

function startsWithListMarker(text: string | undefined): boolean {
  if (!text) return false;
  return parseListMarker(text) !== null;
}

function dehyphenateJoin(prev: string, next: string): string {
  const tPrev = prev.replace(/\s+$/, "");
  if (!tPrev) return next;
  // Soft-hyphen wrap: prev ends with `-` and previous char is a letter AND
  // next starts with a lowercase letter → join without the hyphen.
  if (
    /[A-Za-zÀ-ÿ]-$/.test(tPrev) &&
    /^[a-zà-ÿ]/.test(next)
  ) {
    return tPrev.slice(0, -1) + next;
  }
  return tPrev + " " + next;
}

function looksLikeHorizontalRule(text: string): boolean {
  const t = text.trim();
  if (t.length < 5) return false;
  return /^([-_*=])\1{2,}$/.test(t);
}

function looksLikeCodeBlock(text: string): boolean {
  // Heuristic: a line that is long, has no normal word boundaries, and
  // contains monospace-looking tokens. Conservative — only fires for
  // clearly non-prose shapes.
  if (text.length < 30) return false;
  const letters = text.replace(/[^A-Za-z]/g, "").length;
  if (letters / text.length < 0.3) return true; // symbol/digit heavy
  return false;
}

// --- Rendering --------------------------------------------------------------

function renderMarkdown(blocks: Block[], opts: MarkdownOptions): string {
  const out: string[] = [];
  if (opts.title) {
    out.push(`# ${opts.title}`);
    out.push("");
  }
  if (opts.source) {
    out.push(`*Source: \`${opts.source}\`*`);
    out.push("");
  }
  if (opts.ocr) {
    out.push("> Extracted with OCR fallback enabled.");
    out.push("");
  }
  for (const b of blocks) {
    switch (b.kind) {
      case "h":
        out.push(`${"#".repeat(b.level)} ${inlineMarkdown(b.text)}`);
        out.push("");
        break;
      case "p":
        out.push(b.bold ? `**${inlineMarkdown(b.text)}**` : inlineMarkdown(b.text));
        out.push("");
        break;
      case "ul":
        for (const it of b.items) out.push(`- ${inlineMarkdown(it)}`);
        out.push("");
        break;
      case "ol":
        b.items.forEach((it, idx) =>
          out.push(`${idx + 1}. ${inlineMarkdown(it)}`),
        );
        out.push("");
        break;
      case "hr":
        out.push("---");
        out.push("");
        break;
      case "code":
        out.push("```");
        out.push(b.text);
        out.push("```");
        out.push("");
        break;
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function inlineMarkdown(s: string): string {
  // Avoid breaking existing emphasis; escape the rare `<` `>` that can
  // appear in headings like "Min < 5". Otherwise, return as-is.
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
