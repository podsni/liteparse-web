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
 *   2. Detect multi-column layout (X-clusters) → reading order grid projection.
 *   3. Classify each line: heading if `size > body + epsilon`, by delta level.
 *   4. Detect bold/italic via `fontName` substring patterns (only signal
 *      the WASM build exposes).
 *   5. Detect inline code via monospace font name (`Mono`, `Courier`, `Code`,
 *      `Consolas`, `Inconsolata`, `Menlo`).
 *   6. Detect list markers: bullet glyphs (`•·◦▪▸▶●○■□`) and ordered (`1.`)
 *   7. Group lines into paragraphs: gap > 1.5× line height, or font size change.
 *   8. Dehyphenate soft-hyphen wraps (`architec-` + `ture` → `architecture`).
 *   9. Detect tables by column alignment (X-clusters of consistent gaps).
 *  10. Convert typography: straight quotes → smart quotes, `--` → em-dash,
 *      `...` → ellipsis.
 *  11. Insert page-break markers between pages.
 */

import type { BBoxItem, PageData, ParseResult } from "./liteparse";

// --- Tunables --------------------------------------------------------------

const HEADING_EPSILON = 2.0; // pt — must be at least 2pt above body to count as heading
// Heading level by font-size delta from body:
const HEADING_LEVEL_THRESHOLDS: [number, 1 | 2 | 3 | 4 | 5 | 6][] = [
  [10, 1],
  [3, 2],
  [2, 3],
];
const PARAGRAPH_GAP_MULT = 1.2; // gap > 1.2x line height = new paragraph
const Y_BAND_TOLERANCE = 0.4; // Y diff (fraction of line height) = same band
const BULLET_CHARS = "•·◦▪▸▶●○■□–—−·";
const LIST_SPLIT_X_GAP = 8;
// Column detection: items in the same Y-band with X gap > this are separate columns.
const COLUMN_X_GAP_RATIO = 0.15; // gap > 15% of page width
const COLUMN_MIN_ITEMS = 3; // need at least 3 Y-bands to declare columns
// Table detection
const TABLE_MIN_ROWS = 2;
const TABLE_MIN_COLS = 2;
const TABLE_COL_GAP_TOLERANCE = 4; // pt tolerance for matching column edges

// --- Public API -------------------------------------------------------------

export interface MarkdownOptions {
  title?: string;
  source?: string;
  ocr?: boolean;
}

export function toMarkdown(
  result: ParseResult,
  opts: MarkdownOptions = {},
): string {
  const blocks = buildBlocks(result, opts);
  return renderMarkdown(blocks, opts);
}

// --- Block model ------------------------------------------------------------

type InlineRun = { text: string; bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean };

type Block =
  | { kind: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "p"; runs: InlineRun[] }
  | { kind: "ul"; items: InlineRun[][] }
  | { kind: "ol"; items: InlineRun[][] }
  | { kind: "hr" }
  | { kind: "code"; text: string }
  | { kind: "table"; header: InlineRun[][]; rows: InlineRun[][][] }
  | { kind: "pagebreak" };

interface RawLine {
  y: number;
  x: number;
  height: number;
  text: string;
  fontSize: number;
  fontName: string;
  bold: boolean;
  italic: boolean;
  mono: boolean;
  runs: InlineRun[];
  items: BBoxItem[];
}

// --- Body size estimation ---------------------------------------------------

function estimateBodySize(pages: PageData[]): number {
  const weight = new Map<number, number>();
  for (const page of pages) {
    for (const it of page.items) {
      if (it.fontSize == null || !Number.isFinite(it.fontSize)) continue;
      if (it.bbox[0] < 0 || it.bbox[1] < 0) continue;
      const key = Math.round(it.fontSize * 2) / 2;
      const w = (it.text || "").length || 1;
      weight.set(key, (weight.get(key) ?? 0) + w);
    }
  }
  if (weight.size === 0) return 11;
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

// --- Font name analysis -----------------------------------------------------

const MONO_PATTERNS = [
  /mono/i,
  /courier/i,
  /code/i,
  /consolas/i,
  /menlo/i,
  /inconsolata/i,
  /fira\s*code/i,
  /source\s*code/i,
  /roboto\s*mono/i,
  /typewriter/i,
  /fixed/i,
  /terminal/i,
];

function isBoldFromName(name: string | undefined): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  return /bold|black|heavy|demi|extra(|-| )?bold|semibold|medium(?![\w])/.test(n);
}

function isItalicFromName(name: string | undefined): boolean {
  if (!name) return false;
  return /italic|oblique/.test(name.toLowerCase());
}

function isMonoFromName(name: string | undefined): boolean {
  if (!name) return false;
  return MONO_PATTERNS.some((p) => p.test(name));
}

// --- Multi-column detection -------------------------------------------------

interface ColumnInfo {
  /** X boundaries (left edges of columns). */
  leftEdges: number[];
  /** Function: given an X, return which column index (0-based), or -1. */
  indexOf: (x: number) => number;
}

function detectColumns(items: BBoxItem[], pageWidth: number): ColumnInfo | null {
  if (items.length === 0 || pageWidth <= 0) return null;

  // Bucket items into Y-bands first, then look at the X-distribution
  // within each band. A multi-column page has at least 2 recurring X-clusters.
  const sorted = [...items].sort((a, b) => {
    const dy = a.bbox[1] - b.bbox[1];
    if (Math.abs(dy) > 8) return dy;
    return a.bbox[0] - b.bbox[0];
  });

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

  // Collect X-cluster: round each item's left X to nearest 5pt, build histogram.
  const xHist = new Map<number, number>();
  for (const band of bands) {
    for (const it of band) {
      const x = Math.round(it.bbox[0] / 5) * 5;
      xHist.set(x, (xHist.get(x) ?? 0) + 1);
    }
  }
  if (xHist.size < 2) return null;

  // Sort X-bins by frequency, take top peaks that are far enough apart.
  const bins = [...xHist.entries()].sort((a, b) => b[1] - a[1]);
  const peaks: number[] = [];
  const minXSep = pageWidth * COLUMN_X_GAP_RATIO;
  for (const [x, count] of bins) {
    if (count < COLUMN_MIN_ITEMS) break;
    if (peaks.every((p) => Math.abs(p - x) >= minXSep)) {
      peaks.push(x);
    }
    if (peaks.length >= 6) break; // max 6 columns
  }
  peaks.sort((a, b) => a - b);
  if (peaks.length < 2) return null;

  return {
    leftEdges: peaks,
    indexOf(x: number) {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < peaks.length; i++) {
        const d = Math.abs(x - peaks[i]);
        if (d < bestDist && d <= minXSep) {
          bestDist = d;
          bestIdx = i;
        }
      }
      return bestIdx;
    },
  };
}

// --- Line grouping with column-aware reading order -------------------------

function groupIntoLines(
  items: BBoxItem[],
  pageWidth: number,
): RawLine[] {
  if (items.length === 0) return [];
  const columns = detectColumns(items, pageWidth);

  // Sort top→bottom, then left→right. If multi-column, items from column 0
  // come entirely before column 1 in the same Y-band (reading order).
  const sorted = [...items].sort((a, b) => {
    const dy = a.bbox[1] - b.bbox[1];
    if (Math.abs(dy) > 4) return dy;
    // Same Y-band: use column-aware ordering if available.
    if (columns) {
      const ca = columns.indexOf(a.bbox[0]);
      const cb = columns.indexOf(b.bbox[0]);
      if (ca !== cb) return ca - cb;
    }
    return a.bbox[0] - b.bbox[0];
  });

  // First pass: Y-bands.
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

  // Second pass: split bands by list markers.
  const splitBands: BBoxItem[][] = [];
  for (const band of bands) {
    band.sort((a, b) => a.bbox[0] - b.bbox[0]);
    let current: BBoxItem[] = [band[0]];
    for (let i = 1; i < band.length; i++) {
      const prev = current[current.length - 1];
      const cur = band[i];
      const xGap = cur.bbox[0] - prev.bbox[2];
      if (startsWithListMarker(cur.text) && xGap > LIST_SPLIT_X_GAP) {
        splitBands.push(current);
        current = [cur];
      } else {
        current.push(cur);
      }
    }
    splitBands.push(current);
  }

  return splitBands.map((band) => buildRawLine(band));
}

function buildRawLine(band: BBoxItem[]): RawLine {
  const fs = band[0]?.fontSize ?? 0;
  const fn = band[0]?.fontName ?? "";
  const h = band.reduce(
    (m, i) => Math.max(m, i.bbox[3] - i.bbox[1]),
    fs || 12,
  );
  // Build inline runs preserving bold/italic/mono per item, with spaces between
  // runs of different styles (preserves word boundaries in the rendered text).
  const runs: InlineRun[] = [];
  for (const it of band) {
    const t = (it.text ?? "").trim();
    if (!t) continue;
    const next: InlineRun = {
      text: t,
      bold: isBoldFromName(it.fontName),
      italic: isItalicFromName(it.fontName),
      code: isMonoFromName(it.fontName),
    };
    if (runs.length && needsSpaceBetween(runs[runs.length - 1], next)) {
      runs.push({ text: " " });
    }
    runs.push(next);
  }
  const text = runs.map((r) => r.text).join("").replace(/\s+/g, " ").trim();
  return {
    y: band[0].bbox[1],
    x: band[0].bbox[0],
    height: h,
    text,
    fontSize: fs,
    fontName: fn,
    bold: runs.some((r) => r.bold) && runs.every((r) => r.bold),
    italic: runs.some((r) => r.italic),
    mono: runs.some((r) => r.code),
    runs,
    items: band,
  };
}

function needsSpaceBetween(prev: InlineRun, next: InlineRun): boolean {
  // No space if either side already ends/starts with whitespace.
  if (/\s$/.test(prev.text) || /^\s/.test(next.text)) return false;
  // No space within the same style if both are pure prose.
  return true;
}

// --- Paragraph / block construction ----------------------------------------

function buildBlocks(
  result: ParseResult,
  opts: MarkdownOptions,
): Block[] {
  const bodySize = estimateBodySize(result.pages);
  const out: Block[] = [];
  let firstPageFirst = true;

  for (let pageIdx = 0; pageIdx < result.pages.length; pageIdx++) {
    const page = result.pages[pageIdx];
    const lines = groupIntoLines(page.items, page.width);
    if (lines.length === 0) {
      if (pageIdx > 0) out.push({ kind: "pagebreak" });
      continue;
    }

    const skipFirst = firstPageFirst && !!opts.title;
    firstPageFirst = false;

    type Classified =
      | { kind: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; line: RawLine }
      | { kind: "li"; ordered: boolean; line: RawLine }
      | { kind: "p"; line: RawLine };

    const classified: Classified[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (skipFirst && i === 0) continue;
      const ln = lines[i];
      if (!ln.text) continue;
      classified.push(classifyLine(ln, bodySize));
    }

    if (classified.length === 0) {
      if (pageIdx > 0) out.push({ kind: "pagebreak" });
      continue;
    }

    // --- Try table detection at current position ---
    let i = 0;
    while (i < classified.length) {
      const tbl = tryBuildTableFrom(classified, i);
      if (tbl) {
        out.push({ kind: "table", header: tbl.header, rows: tbl.rows });
        i += tbl.consumed;
        continue;
      }
      const c = classified[i];

      if (c.kind === "li") {
        const firstOrdered = c.ordered;
        const items: InlineRun[][] = [];
        while (
          i < classified.length &&
          classified[i].kind === "li" &&
          (classified[i] as Extract<Classified, { kind: "li" }>).ordered === firstOrdered
        ) {
          items.push((classified[i] as Extract<Classified, { kind: "li" }>).line.runs);
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
        const paras: InlineRun[][] = [];
        let buffer: InlineRun[] = [...c.line.runs];
        let currentFont = c.line.fontSize;
        let prevLine: RawLine = c.line;
        i++;
        while (i < classified.length) {
          const nxt = classified[i];
          if (nxt.kind !== "p") break;
          const nxtLine = nxt.line;
          const gap = nxtLine.y - (prevLine.y + prevLine.height);
          // Use font-size-derived line height (more reliable than bbox height
          // which varies across fonts and rendering modes).
          const lineHeight = Math.max(prevLine.fontSize * 1.2, prevLine.height);
          const gapThreshold = lineHeight * PARAGRAPH_GAP_MULT;
          const sizeDelta = Math.abs(nxtLine.fontSize - currentFont);
          if (gap > gapThreshold || sizeDelta > 0.5) {
            paras.push(buffer);
            buffer = [...nxtLine.runs];
            currentFont = nxtLine.fontSize;
          } else {
            // Same paragraph — join, preserving code-line boundaries with \n.
            buffer = dehyphenateJoinRuns(buffer, nxtLine.runs, true);
          }
          prevLine = nxtLine;
          i++;
        }
        paras.push(buffer);
        for (const runs of paras) {
          if (runs.length === 0) continue;
          // Plain text for length checks; preserve newlines for code blocks.
          const flatText = runs.map((r) => r.text).join("");
          if (looksLikeHorizontalRule(flatText)) {
            out.push({ kind: "hr" });
          } else if (looksLikeCodeBlock(runs)) {
            out.push({ kind: "code", text: flatText });
          } else {
            out.push({ kind: "p", runs });
          }
        }
        continue;
      }
    }

    if (pageIdx < result.pages.length - 1) out.push({ kind: "pagebreak" });
  }

  return out;
}

function classifyLine(
  ln: RawLine,
  bodySize: number,
):
  | { kind: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; line: RawLine }
  | { kind: "li"; ordered: boolean; line: RawLine }
  | { kind: "p"; line: RawLine } {
  const m = parseListMarker(ln.text);
  if (m) {
    return {
      kind: "li",
      ordered: m.ordered,
      line: { ...ln, text: m.remainder, runs: trimLeadingRun(ln.runs, m.marker.length) },
    };
  }

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

  if (
    ln.bold &&
    !ln.italic &&
    ln.text.length < 80 &&
    /^[A-Z]/.test(ln.text) &&
    !/[.!?]$/.test(ln.text)
  ) {
    return { kind: "h", level: 4, line: ln };
  }

  return { kind: "p", line: ln };
}

function trimLeadingRun(runs: InlineRun[], charCount: number): InlineRun[] {
  let remaining = charCount;
  const out: InlineRun[] = [];
  for (const r of runs) {
    if (remaining <= 0) {
      out.push(r);
      continue;
    }
    if (r.text.length <= remaining) {
      remaining -= r.text.length;
      continue;
    }
    out.push({ ...r, text: r.text.slice(remaining) });
    remaining = 0;
  }
  return out;
}

function parseListMarker(
  text: string,
): { ordered: boolean; marker: string; remainder: string } | null {
  const trimmed = text.trimStart();
  if (!trimmed) return null;

  const bullet = trimmed[0];
  if (BULLET_CHARS.includes(bullet) && /^\s/.test(trimmed[1] ?? " ")) {
    return {
      ordered: false,
      marker: bullet,
      remainder: trimmed.slice(1).trimStart(),
    };
  }

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

function dehyphenateJoinRuns(
  prev: InlineRun[],
  next: InlineRun[],
  isLineContinuation = false,
): InlineRun[] {
  if (prev.length === 0) return next;
  if (next.length === 0) return prev;
  const lastPrev = prev[prev.length - 1];
  const firstNext = next[0];
  const tPrev = lastPrev.text.replace(/\s+$/, "");
  const tNext = firstNext.text.replace(/^\s+/, "");
  // Same style and both monospace: NO space (preserve code layout).
  const sameStyle =
    lastPrev.bold === firstNext.bold &&
    lastPrev.italic === firstNext.italic &&
    lastPrev.code === firstNext.code;
  if (
    /[A-Za-zÀ-ÿ]-$/.test(tPrev) &&
    /^[a-zà-ÿ]/.test(tNext) &&
    sameStyle
  ) {
    const merged = tPrev.slice(0, -1) + tNext;
    const newPrev = prev.slice(0, -1);
    newPrev.push({ ...lastPrev, text: merged });
    return [...newPrev, ...next.slice(1)];
  }
  if (sameStyle && (lastPrev.code || firstNext.code)) {
    // Code-to-code: no extra space, but if this is a line continuation
    // (separate lines joined into a paragraph), insert a newline so each
    // code line ends up on its own row inside the ``` block. Strip trailing
    // whitespace from prev and leading whitespace from next so the lines
    // don't accumulate stray spaces.
    if (isLineContinuation) {
      // Replace trailing whitespace in last run with newline.
      const trimmedPrev = prev.slice(0, -1);
      const lastT = lastPrev.text.replace(/\s+$/, "");
      if (lastT) trimmedPrev.push({ ...lastPrev, text: lastT });
      // Strip leading whitespace from first run of next.
      const trimmedNext: InlineRun[] = [];
      for (let j = 0; j < next.length; j++) {
        const r = next[j];
        if (j === 0) {
          const t = r.text.replace(/^\s+/, "");
          if (t) trimmedNext.push({ ...r, text: t });
        } else {
          trimmedNext.push(r);
        }
      }
      const out2 = [...trimmedPrev, { text: "\n" }, ...trimmedNext];
      return out2;
    }
    return [...prev, ...next];
  }
  if (prev.length && next.length) {
    const sep = /\s$/.test(lastPrev.text) || /^\s/.test(firstNext.text) ? "" : " ";
    return [
      ...prev,
      ...(sep ? [{ text: sep } as InlineRun] : []),
      ...next,
    ];
  }
  return [...prev, ...next];
}

function looksLikeHorizontalRule(text: string): boolean {
  const t = text.trim();
  if (t.length < 5) return false;
  return /^([-_*=])\1{2,}$/.test(t);
}

function looksLikeCodeBlock(runs: InlineRun[]): boolean {
  // Use plain concatenated text (no space-padding) so embedded \n stay intact.
  const text = runs.map((r) => r.text).join("");
  if (text.length < 30) return false;
  // Real content runs (ignore pure whitespace separators).
  const real = runs.filter((r) => r.text.trim().length > 0);
  if (real.length === 0) return false;
  // A paragraph of monospace counts as code.
  if (real.every((r) => r.code)) return true;
  // Symbol/digit heavy.
  const letters = text.replace(/[^A-Za-z]/g, "").length;
  return letters / text.length < 0.3;
}

// --- Table detection --------------------------------------------------------

type Classified =
  | { kind: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; line: RawLine }
  | { kind: "li"; ordered: boolean; line: RawLine }
  | { kind: "p"; line: RawLine };

function tryBuildTableFrom(
  classified: Classified[],
  start: number,
): { header: InlineRun[][]; rows: InlineRun[][][]; consumed: number } | null {
  if (start >= classified.length) return null;
  const first = classified[start];
  if (first.kind !== "p") return null;
  // Get X-clustering from the first line: round each item x to nearest 4pt.
  const firstXs = first.line.items.map((it) => Math.round(it.bbox[0] / 4) * 4);
  if (firstXs.length < TABLE_MIN_COLS) return null;
  // Build initial column guess by clustering unique Xs.
  const cols = clusterColumns(firstXs);
  if (cols.length < TABLE_MIN_COLS) return null;

  // Try to extend: count how many subsequent lines also match the column pattern.
  let end = start + 1;
  while (end < classified.length) {
    const c = classified[end];
    if (c.kind !== "p") break;
    const xs = c.line.items.map((it) => Math.round(it.bbox[0] / 4) * 4);
    if (xs.length < cols.length) break;
    // Each column must appear in this row (within tolerance).
    let matches = 0;
    for (const col of cols) {
      if (xs.some((x) => Math.abs(x - col) <= TABLE_COL_GAP_TOLERANCE)) matches++;
    }
    if (matches < cols.length) break;
    end++;
  }

  const totalRows = end - start;
  if (totalRows < TABLE_MIN_ROWS) return null;

  // Build table rows.
  const rows: InlineRun[][][] = [];
  for (let i = start; i < end; i++) {
    const items = classified[i].line.items;
    const cells: InlineRun[][] = cols.map(() => []);
    for (const it of items) {
      let bestCol = 0;
      let bestDist = Infinity;
      for (let ci = 0; ci < cols.length; ci++) {
        const d = Math.abs(it.bbox[0] - cols[ci]);
        if (d < bestDist) {
          bestDist = d;
          bestCol = ci;
        }
      }
      if (bestDist <= TABLE_COL_GAP_TOLERANCE) {
        cells[bestCol].push(toRun(it));
      }
    }
    rows.push(cells);
  }

  const header = rows.shift()!;
  return { header, rows, consumed: end - start };
}

function clusterColumns(xs: number[]): number[] {
  const sorted = [...xs].sort((a, b) => a - b);
  const cols: number[] = [];
  for (const x of sorted) {
    if (cols.length === 0 || x - cols[cols.length - 1] > TABLE_COL_GAP_TOLERANCE * 2) {
      cols.push(x);
    }
  }
  return cols;
}

function toRun(it: BBoxItem): InlineRun {
  return {
    text: (it.text ?? "").trim(),
    bold: isBoldFromName(it.fontName),
    italic: isItalicFromName(it.fontName),
    code: isMonoFromName(it.fontName),
  };
}

// --- Typography conversion --------------------------------------------------

const TYPOGRAPHY: [RegExp, string][] = [
  [/---/g, "—"], // em-dash
  [/--/g, "–"], // en-dash
  [/\.{3}/g, "…"], // ellipsis
  [/(^|[\s(\[{<])"/g, "$1“"], // open double
  [/"/g, "”"], // close double
  [/(^|[\s(\[{<])'/g, "$1‘"], // open single
  [/'/g, "’"], // close single
];

function applyTypography(s: string): string {
  let out = s;
  for (const [re, repl] of TYPOGRAPHY) out = out.replace(re, repl);
  return out;
}

// --- Rendering --------------------------------------------------------------

function renderMarkdown(blocks: Block[], opts: MarkdownOptions): string {
  const out: string[] = [];
  if (opts.title) {
    out.push(`# ${applyTypography(opts.title)}`);
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
        out.push(`${"#".repeat(b.level)} ${applyTypography(b.text)}`);
        out.push("");
        break;
      case "p":
        out.push(renderRuns(b.runs));
        out.push("");
        break;
      case "ul":
        for (const it of b.items) out.push(`- ${renderRuns(it)}`);
        out.push("");
        break;
      case "ol":
        b.items.forEach((it, idx) =>
          out.push(`${idx + 1}. ${renderRuns(it)}`),
        );
        out.push("");
        break;
      case "hr":
        out.push("---");
        out.push("");
        break;
      case "code":
        // For code blocks, preserve the run structure (don't insert extra
        // spaces around \n) by joining the runs without whitespace padding.
        out.push("```");
        out.push(b.text);
        out.push("```");
        out.push("");
        break;
      case "table":
        out.push(renderTable(b.header, b.rows));
        out.push("");
        break;
      case "pagebreak":
        out.push("---");
        out.push("");
        break;
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function renderRuns(runs: InlineRun[]): string {
  if (runs.length === 0) return "";
  let out = "";
  for (const r of runs) {
    let t = applyTypography(r.text);
    if (r.code) t = `\`${t}\``;
    if (r.italic) t = `*${t}*`;
    if (r.bold) t = `**${t}**`;
    if (r.strike) t = `~~${t}~~`;
    out += t;
  }
  return out.replace(/\s+/g, " ").trim();
}

function renderTable(header: InlineRun[][], rows: InlineRun[][][]): string {
  const nCols = Math.max(header.length, ...rows.map((r) => r.length));
  const cellWidths = new Array<number>(nCols).fill(3);
  const flatHeader = expandCells(header, nCols).map((cell) => renderRuns(cell));
  const flatRows = rows.map((r) =>
    expandCells(r, nCols).map((cell) => renderRuns(cell)),
  );
  for (let i = 0; i < nCols; i++) {
    cellWidths[i] = Math.max(
      cellWidths[i],
      flatHeader[i]?.length ?? 0,
      ...flatRows.map((r) => r[i]?.length ?? 0),
    );
  }
  const sep = (n: number) => "-".repeat(Math.max(3, n));
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
  const fmtRow = (cells: string[]) =>
    "| " + cells.map((c, i) => pad(c, cellWidths[i])).join(" | ") + " |";
  const lines: string[] = [];
  lines.push(fmtRow(flatHeader));
  lines.push("| " + cellWidths.map(sep).join(" | ") + " |");
  for (const r of flatRows) lines.push(fmtRow(r));
  return lines.join("\n");
}

function expandCells<T>(cells: T[], n: number): T[] {
  const out: T[] = [...cells];
  while (out.length < n) {
    out.push({ text: "" } as unknown as T);
  }
  return out;
}
