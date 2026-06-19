// Generate sample.pdf showcasing every feature the Markdown converter
// understands: H1/H2 headings, paragraphs, bulleted + ordered lists, bold
// paragraph, italic run, inline code block, and a simple 3-column table.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync } from "node:fs";

const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]); // US Letter
const helv = await doc.embedFont(StandardFonts.Helvetica);
const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
const helvOblique = await doc.embedFont(StandardFonts.HelveticaOblique);
const courier = await doc.embedFont(StandardFonts.Courier);

const margin = 72;
let y = 740;

// Title (h1)
page.drawText("LiteParse Sample Document", {
  x: margin,
  y,
  size: 22,
  font: helvBold,
  color: rgb(0.07, 0.07, 0.07),
});
y -= 30;

// Subtitle
page.drawText("Demonstrating layout-aware text extraction", {
  x: margin,
  y,
  size: 12,
  font: helv,
  color: rgb(0.4, 0.4, 0.4),
});
y -= 36;

// Body paragraph 1
const para1 = `This is paragraph one. LiteParse extracts text with bounding boxes for every word on every page. Each character carries spatial coordinates so downstream apps can highlight, search, or build citation links back to the source.`;
drawWrapped(page, para1, helv, 11, margin, y, 480, 14);
y -= 14 * 4 + 10;

// Body paragraph 2
const para2 = `A second paragraph follows. Notice how multiple lines form a single block with aligned margins. Numbers like 1, 2, 3 and symbols like @, #, $ should be preserved exactly as they appear in the original document.`;
drawWrapped(page, para2, helv, 11, margin, y, 480, 14);
y -= 14 * 4 + 20;

// Heading 2
page.drawText("Key features", {
  x: margin,
  y,
  size: 14,
  font: helvBold,
  color: rgb(0.07, 0.07, 0.07),
});
y -= 24;

// Bullet list — each on its own line, with bullet glyph
const bullets = [
  "Local processing — nothing leaves your browser",
  "Layout-aware — preserves positions of every word",
  "Fast — parses this PDF in under one second",
  "Open source — Apache 2.0 license",
];
for (const b of bullets) {
  page.drawText("•", { x: margin, y, size: 11, font: helv });
  page.drawText(b, { x: margin + 14, y, size: 11, font: helv });
  y -= 16;
}
y -= 16;

// Heading 2
page.drawText("Performance numbers", {
  x: margin,
  y,
  size: 14,
  font: helvBold,
  color: rgb(0.07, 0.07, 0.07),
});
y -= 22;

// Ordered list
const ordered = [
  "Drop a PDF in the dropzone",
  "Click Parse to run extraction",
  "Switch to Markdown, Text, or JSON view",
  "Copy or download the result",
];
for (let i = 0; i < ordered.length; i++) {
  page.drawText(`${i + 1}.`, { x: margin, y, size: 11, font: helv });
  page.drawText(ordered[i], { x: margin + 18, y, size: 11, font: helv });
  y -= 16;
}
y -= 18;

// Italic run + paragraph
page.drawText("Note. ", {
  x: margin,
  y,
  size: 11,
  font: helvBold,
});
page.drawText("This paragraph mixes a bold label with an ", {
  x: margin + 40,
  y,
  size: 11,
  font: helv,
});
page.drawText("italic phrase", {
  x: margin + 40 + helv.widthOfTextAtSize("This paragraph mixes a bold label with an ", 11),
  y,
  size: 11,
  font: helvOblique,
});
page.drawText(" and a ", {
  x: margin + 40 +
    helv.widthOfTextAtSize("This paragraph mixes a bold label with an ", 11) +
    helvOblique.widthOfTextAtSize("italic phrase", 11),
  y,
  size: 11,
  font: helv,
});
page.drawText("monospace `npm install`", {
  x: margin + 40 +
    helv.widthOfTextAtSize("This paragraph mixes a bold label with an ", 11) +
    helvOblique.widthOfTextAtSize("italic phrase", 11) +
    helv.widthOfTextAtSize(" and a ", 11),
  y,
  size: 11,
  font: courier,
});
page.drawText(" call to illustrate inline code rendering.", {
  x: margin + 40 +
    helv.widthOfTextAtSize("This paragraph mixes a bold label with an ", 11) +
    helvOblique.widthOfTextAtSize("italic phrase", 11) +
    helv.widthOfTextAtSize(" and a ", 11) +
    courier.widthOfTextAtSize("monospace `npm install`", 11),
  y,
  size: 11,
  font: helv,
});
y -= 28;

// Code block
page.drawText("Quickstart", {
  x: margin,
  y,
  size: 14,
  font: helvBold,
  color: rgb(0.07, 0.07, 0.07),
});
y -= 22;

const codeLines = [
  "$ npm i @llamaindex/liteparse-wasm",
  "$ pnpm add pdf-lib",
  "$ bun run dev",
];
for (const line of codeLines) {
  page.drawText(line, { x: margin, y, size: 10, font: courier });
  y -= 14;
}
y -= 14;

// Simple 3-column table
page.drawText("Library sizes", {
  x: margin,
  y,
  size: 14,
  font: helvBold,
  color: rgb(0.07, 0.07, 0.07),
});
y -= 22;

const tableTop = y;
const col1X = margin;
const col2X = margin + 130;
const col3X = margin + 280;
const rowHeight = 16;

// Header row
page.drawText("Package", { x: col1X, y, size: 11, font: helvBold });
page.drawText("Gzipped", { x: col2X, y, size: 11, font: helvBold });
page.drawText("Notes", { x: col3X, y, size: 11, font: helvBold });
y -= rowHeight;

// Data rows
const rows = [
  ["liteparse.wasm", "2.3 MB", "PDF + OCR ready"],
  ["pdf.worker.min", "1.2 MB", "PDF.js renderer"],
  ["tesseract.js", "0.4 MB", "OCR fallback (lazy)"],
];
for (const row of rows) {
  page.drawText(row[0], { x: col1X, y, size: 11, font: helv });
  page.drawText(row[1], { x: col2X, y, size: 11, font: helv });
  page.drawText(row[2], { x: col3X, y, size: 11, font: helv });
  y -= rowHeight;
}

const bytes = await doc.save();
writeFileSync("public/sample.pdf", bytes);
console.log("wrote public/sample.pdf", bytes.length, "bytes");

function drawWrapped(page, text, font, size, x, y, maxWidth, lineHeight) {
  const words = text.split(/\s+/);
  let line = "";
  let curY = y;
  for (const w of words) {
    const test = line ? line + " " + w : w;
    const width = font.widthOfTextAtSize(test, size);
    if (width > maxWidth && line) {
      page.drawText(line, { x, y: curY, size, font });
      curY -= lineHeight;
      line = w;
    } else {
      line = test;
    }
  }
  if (line) page.drawText(line, { x, y: curY, size, font });
}
