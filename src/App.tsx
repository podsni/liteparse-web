import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FileText,
  Upload,
  Loader2,
  X,
  Download,
  ChevronLeft,
  ChevronRight,
  Type,
  Search,
  ZoomIn,
  ZoomOut,
  Sun,
  Moon,
  ExternalLink,
} from "lucide-react";

/** Inline brand mark — lucide dropped GH icon in v1.x. */
type GithubProps = Omit<React.SVGProps<SVGSVGElement>, "children"> & {
  size?: number;
};
function Github({ size = 16, ...rest }: GithubProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden
      {...rest}
    >
      <path d="M12 .5C5.6.5.5 5.6.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.4-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.2 1.2.9-.3 1.9-.4 2.9-.4 1 0 2 .1 2.9.4 2.2-1.5 3.2-1.2 3.2-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.3.8 1 .8 2v3c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.6 18.4.5 12 .5z" />
    </svg>
  );
}
import {
  parsePdf,
  renderPagePng,
  type BBoxItem,
  type PageData,
  type ParseResult,
} from "./lib/liteparse";
import { useTheme } from "./lib/use-theme";
import { cn } from "./lib/cn";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ACCEPTED_TYPES = ["application/pdf"];
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

// ---------------------------------------------------------------------------
// Tiny hook for file picker + drag/drop
// ---------------------------------------------------------------------------
function useFileDrop(onFile: (file: File) => void) {
  const [active, setActive] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setActive(false);
      const f = e.dataTransfer.files?.[0];
      if (f) onFile(f);
    },
    [onFile],
  );

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setActive(true);
  }, []);

  const onDragLeave = useCallback(() => setActive(false), []);

  return { active, inputRef, onDrop, onDragOver, onDragLeave };
}

// ---------------------------------------------------------------------------
// Root App
// ---------------------------------------------------------------------------
export default function App() {
  const { theme, toggle } = useTheme();
  const [file, setFile] = useState<File | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [result, setResult] = useState<ParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [view, setView] = useState<"text" | "canvas">("text");
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const [activeItem, setActiveItem] = useState<{ p: number; i: number } | null>(
    null,
  );

  const onFile = useCallback(async (f: File) => {
    setError(null);
    setResult(null);
    setQuery("");
    setActiveItem(null);
    setPage(1);
    if (!ACCEPTED_TYPES.includes(f.type)) {
      setError(`Unsupported file type: ${f.type || "unknown"}. Please upload a PDF.`);
      return;
    }
    if (f.size > MAX_FILE_BYTES) {
      setError(`File too large: ${(f.size / 1024 / 1024).toFixed(1)} MB (max ${MAX_FILE_BYTES / 1024 / 1024} MB).`);
      return;
    }
    setFile(f);
    const buf = new Uint8Array(await f.arrayBuffer());
    setBytes(buf);
    void runParse(buf);
  }, []);

  const runParse = useCallback(async (buf: Uint8Array) => {
    setParsing(true);
    setError(null);
    setProgress("Loading WASM module…");
    const t0 = performance.now();
    try {
      setProgress("Parsing PDF…");
      const r = await parsePdf(buf);
      const ms = Math.round(performance.now() - t0);
      setResult(r);
      setProgress(null);
      setParsing(false);
      console.log(`[liteparse] parsed in ${ms} ms, ${r.pages.length} pages, ${r.text.length} chars`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Parse failed: ${msg}`);
      setProgress(null);
      setParsing(false);
    }
  }, []);

  const onPickUrl = useCallback(
    async (url: string) => {
      setError(null);
      setFile(null);
      setResult(null);
      setQuery("");
      setPage(1);
      setProgress(`Fetching ${url}…`);
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const ct = r.headers.get("content-type") || "";
        if (!ct.includes("pdf")) {
          throw new Error(`URL did not return a PDF (content-type: ${ct || "unknown"})`);
        }
        const buf = new Uint8Array(await r.arrayBuffer());
        const fakeName = url.split("/").pop() || "remote.pdf";
        const f = new File([buf], fakeName, { type: "application/pdf" });
        setFile(f);
        setBytes(buf);
        await runParse(buf);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`Fetch failed: ${msg}`);
        setProgress(null);
      }
    },
    [runParse],
  );

  const reset = useCallback(() => {
    setFile(null);
    setBytes(null);
    setResult(null);
    setError(null);
    setProgress(null);
    setParsing(false);
    setQuery("");
    setActiveItem(null);
    setPage(1);
  }, []);

  // -----------------------------------------------------------------------
  // Derived data
  // -----------------------------------------------------------------------
  const currentPage: PageData | null = useMemo(() => {
    if (!result || result.pages.length === 0) return null;
    return result.pages[Math.min(page - 1, result.pages.length - 1)];
  }, [result, page]);

  const highlightItems: BBoxItem[] = useMemo(() => {
    if (!query.trim() || !currentPage) return [];
    const q = query.toLowerCase();
    return currentPage.items.filter((it) => it.text.toLowerCase().includes(q));
  }, [query, currentPage]);

  // -----------------------------------------------------------------------
  // Effects
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (activeItem && currentPage && activeItem.p === page) {
      const el = document.querySelector(
        `[data-item-idx="${activeItem.i}"]`,
      );
      if (el && "scrollIntoView" in el) {
        (el as HTMLElement).scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }
    }
  }, [activeItem, page, currentPage]);

  // -----------------------------------------------------------------------
  // Keyboard shortcuts
  // -----------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA") {
        if (e.key === "Escape") (e.target as HTMLInputElement).blur();
        return;
      }
      if (e.key === "Escape") {
        if (activeItem) setActiveItem(null);
        else if (query) setQuery("");
      } else if (e.key === "/") {
        e.preventDefault();
        document.getElementById("search-input")?.focus();
      } else if (e.key === "ArrowLeft" && result && page > 1) {
        setPage((p) => p - 1);
        setActiveItem(null);
      } else if (
        e.key === "ArrowRight" &&
        result &&
        page < result.pages.length
      ) {
        setPage((p) => p + 1);
        setActiveItem(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, result, activeItem, query]);

  return (
    <div className="min-h-dvh">
      <Header theme={theme} onToggleTheme={toggle} />
      <main className="mx-auto max-w-[1180px] px-4 sm:px-6 lg:px-10 pb-24">
        {!file && !parsing && (
          <Hero
            onFile={onFile}
            onUrl={onPickUrl}
            error={error}
          />
        )}
        {parsing && (
          <ParsingState progress={progress} file={file} />
        )}
        {file && !parsing && result && (
          <Results
            file={file}
            bytes={bytes!}
            result={result}
            page={page}
            setPage={setPage}
            view={view}
            setView={setView}
            query={query}
            setQuery={setQuery}
            zoom={zoom}
            setZoom={setZoom}
            currentPage={currentPage}
            highlightItems={highlightItems}
            activeItem={activeItem}
            setActiveItem={setActiveItem}
            onReset={reset}
          />
        )}
        {error && file && !parsing && (
          <div className="mt-8 surface p-6 fade-in" role="alert">
            <p className="kicker text-accent">Error</p>
            <p className="mt-2 text-base">{error}</p>
            <button type="button" className="btn mt-4" onClick={reset}>
              <X size={16} aria-hidden /> Start over
            </button>
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header / masthead
// ---------------------------------------------------------------------------
function Header({
  theme,
  onToggleTheme,
}: {
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  return (
    <header className="border-b border-[color:var(--color-rule-soft)] dark:border-[color:var(--color-rule-d-soft)]">
      <div className="mx-auto max-w-[1180px] px-4 sm:px-6 lg:px-10 py-3 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2.5 group" aria-label="LiteParse Playground home">
          <span
            className="font-display text-[1.5rem] sm:text-[1.625rem] tracking-[-0.025em] leading-none"
            aria-hidden
          >
            Lite<span className="italic-verb text-accent">Parse</span>
          </span>
          <span className="hidden sm:inline-flex kicker border-l border-[color:var(--color-rule)] dark:border-[color:var(--color-rule-d)] pl-2.5 ml-0.5">
            Playground
          </span>
        </a>
        <nav className="flex items-center gap-1 sm:gap-2">
          <a
            href="https://github.com/run-llama/liteparse"
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost btn-icon"
            aria-label="LiteParse on GitHub"
            title="LiteParse on GitHub"
          >
            <Github size={16} aria-hidden />
          </a>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onToggleTheme}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
            title={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
          >
            {theme === "light" ? <Moon size={16} aria-hidden /> : <Sun size={16} aria-hidden />}
          </button>
        </nav>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Hero / dropzone
// ---------------------------------------------------------------------------
function Hero({
  onFile,
  onUrl,
  error,
}: {
  onFile: (f: File) => void;
  onUrl: (u: string) => void;
  error: string | null;
}) {
  const drop = useFileDrop(onFile);
  const [url, setUrl] = useState("");
  const [showUrl, setShowUrl] = useState(false);

  return (
    <section className="pt-12 sm:pt-20 pb-8 fade-in">
      <div className="grid lg:grid-cols-[1.2fr_1fr] gap-10 lg:gap-16 items-start">
        <div>
          <p className="kicker text-accent">Local PDF parsing</p>
          <h1 className="font-display text-[2.5rem] sm:text-[3.25rem] lg:text-[4rem] leading-[1.02] tracking-[-0.03em] mt-3">
            Read a PDF.
            <br />
            <span className="italic-verb">Without</span> leaving the browser.
          </h1>
          <p className="mt-6 text-[1.0625rem] leading-[1.55] text-muted max-w-[44ch]">
            Drop a PDF, get layout-aware text with bounding boxes back.
            Powered by{" "}
            <a
              href="https://github.com/run-llama/liteparse"
              target="_blank"
              rel="noreferrer"
              className="text-accent underline decoration-[color:var(--color-rule)] underline-offset-4 hover:decoration-current"
            >
              LiteParse
            </a>{" "}
            compiled to WebAssembly. Nothing is uploaded. Nothing leaves your
            machine.
          </p>
          <ul className="mt-7 space-y-2 text-[0.9375rem] text-[color:var(--color-ink-2)] dark:text-[color:var(--color-ink-d-2)]">
            {[
              "Spatial text extraction via PDFium",
              "Bounding boxes for every text item",
              "Optional OCR (Tesseract) for scanned pages",
              "Works offline once loaded",
            ].map((line) => (
              <li key={line} className="flex items-baseline gap-3">
                <span
                  className="mt-[0.55em] inline-block w-1.5 h-1.5 rounded-full bg-[color:var(--color-accent)] flex-shrink-0"
                  aria-hidden
                />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="lg:pt-4">
          <div
            {...drop}
            className={cn("dropzone p-8 sm:p-10 text-center cursor-pointer", drop.active && "dropzone-active")}
            role="button"
            tabIndex={0}
            onClick={() => drop.inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                drop.inputRef.current?.click();
              }
            }}
            aria-label="Drop a PDF here or click to choose a file"
          >
            <div className="flex justify-center mb-4">
              <span
                className="inline-flex items-center justify-center w-12 h-12 rounded-full border border-[color:var(--color-rule)] dark:border-[color:var(--color-rule-d)]"
                aria-hidden
              >
                <Upload size={20} className="text-accent" />
              </span>
            </div>
            <p className="font-display text-[1.25rem] tracking-[-0.02em]">
              Drop a PDF here
            </p>
            <p className="mt-1.5 text-sm text-muted">
              or <span className="text-accent underline decoration-[color:var(--color-rule)] underline-offset-4">click to browse</span>
            </p>
            <p className="mt-4 text-xs text-muted">
              Up to {MAX_FILE_BYTES / 1024 / 1024} MB · PDF only
            </p>
            <input
              ref={drop.inputRef}
              type="file"
              accept=".pdf,application/pdf"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
              }}
            />
          </div>

          <div className="mt-3 flex items-center gap-3">
            <span className="kicker flex-shrink-0">or</span>
            <span className="flex-1 h-px bg-[color:var(--color-rule-soft)] dark:bg-[color:var(--color-rule-d-soft)]" />
            <button
              type="button"
              className="btn btn-ghost flex-shrink-0"
              onClick={() => onUrl("./sample.pdf")}
            >
              <FileText size={14} aria-hidden /> Try sample
            </button>
          </div>

          <div className="mt-4">
            <button
              type="button"
              className="btn btn-ghost w-full justify-center"
              onClick={() => setShowUrl((s) => !s)}
              aria-expanded={showUrl}
              aria-controls="url-picker"
            >
              <ExternalLink size={14} aria-hidden />
              {showUrl ? "Hide URL input" : "Or paste a PDF URL"}
            </button>
            {showUrl && (
              <form
                id="url-picker"
                className="mt-3 flex gap-2 fade-in"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (url.trim()) onUrl(url.trim());
                }}
              >
                <input
                  type="url"
                  required
                  placeholder="https://example.com/file.pdf"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-[4px] border border-[color:var(--color-rule)] dark:border-[color:var(--color-rule-d)] bg-transparent text-sm font-mono focus:border-[color:var(--color-accent)] outline-none"
                  aria-label="PDF URL"
                />
                <button type="submit" className="btn btn-primary">
                  Fetch
                </button>
              </form>
            )}
          </div>

          {error && (
            <div className="mt-4 surface p-4 text-sm fade-in" role="alert">
              <p className="text-accent">{error}</p>
            </div>
          )}
        </div>
      </div>

      <SampleDocs />
    </section>
  );
}

function SampleDocs() {
  return (
    <section className="mt-16 sm:mt-24">
      <div className="flex items-baseline justify-between border-b border-[color:var(--color-rule)] dark:border-[color:var(--color-rule-d)] pb-2 mb-4">
        <h2 className="font-display text-[1.5rem] tracking-[-0.02em]">
          Try it on <span className="italic-verb">your</span> files
        </h2>
        <span className="kicker">Drag · Drop · Done</span>
      </div>
      <p className="text-sm text-muted max-w-[60ch]">
        For now, sample remote URLs are limited because most public servers
        don't expose PDFs with CORS. Best bet: download any PDF from your
        machine and drag it in. Works offline afterwards.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Parsing state (loading)
// ---------------------------------------------------------------------------
function ParsingState({
  progress,
  file,
}: {
  progress: string | null;
  file: File | null;
}) {
  return (
    <section className="pt-16 sm:pt-24 pb-8 fade-in">
      <div className="surface p-8 sm:p-12 text-center max-w-2xl mx-auto">
        <div className="flex justify-center mb-5">
          <Loader2 size={28} className="text-accent animate-spin" aria-hidden />
        </div>
        <p className="kicker text-accent">Working</p>
        <h2 className="font-display text-[1.875rem] sm:text-[2.25rem] mt-2 tracking-[-0.02em]">
          Parsing your <span className="italic-verb">document</span>
        </h2>
        <p className="mt-3 text-sm text-muted">
          {file ? (
            <>
              <span className="font-mono">{file.name}</span> ·{" "}
              {(file.size / 1024).toFixed(0)} KB
            </>
          ) : (
            "Fetching…"
          )}
        </p>
        {progress && (
          <p className="mt-4 text-sm font-mono text-[color:var(--color-ink-2)] dark:text-[color:var(--color-ink-d-2)]">
            {progress}
          </p>
        )}
        <div className="mt-8 space-y-2">
          <div className="skeleton-line" style={{ width: "85%" }} />
          <div className="skeleton-line" style={{ width: "70%" }} />
          <div className="skeleton-line" style={{ width: "92%" }} />
          <div className="skeleton-line" style={{ width: "55%" }} />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Results: file info + tabs + page nav + text/canvas view
// ---------------------------------------------------------------------------
function Results(props: {
  file: File;
  bytes: Uint8Array;
  result: ParseResult;
  page: number;
  setPage: (n: number) => void;
  view: "text" | "canvas";
  setView: (v: "text" | "canvas") => void;
  query: string;
  setQuery: (q: string) => void;
  zoom: number;
  setZoom: (z: number) => void;
  currentPage: PageData | null;
  highlightItems: BBoxItem[];
  activeItem: { p: number; i: number } | null;
  setActiveItem: (a: { p: number; i: number } | null) => void;
  onReset: () => void;
}) {
  const {
    file,
    bytes,
    result,
    page,
    setPage,
    view,
    setView,
    query,
    setQuery,
    zoom,
    setZoom,
    currentPage,
    highlightItems,
    activeItem,
    setActiveItem,
    onReset,
  } = props;

  return (
    <section className="pt-8 sm:pt-12 pb-8 fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-[color:var(--color-rule)] dark:border-[color:var(--color-rule-d)]">
        <div className="min-w-0">
          <p className="kicker text-accent">Parsed</p>
          <h2 className="font-display text-[1.5rem] sm:text-[1.875rem] mt-1.5 tracking-[-0.02em] truncate">
            {file.name}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {(file.size / 1024).toFixed(0)} KB · {result.pages.length}{" "}
            {result.pages.length === 1 ? "page" : "pages"} ·{" "}
            {result.text.length.toLocaleString()} chars
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={URL.createObjectURL(
              new Blob([result.text], { type: "text/plain" }),
            )}
            download={`${file.name.replace(/\.pdf$/i, "")}.txt`}
            className="btn"
          >
            <Download size={14} aria-hidden /> Text
          </a>
          <a
            href={URL.createObjectURL(
              new Blob(
                [
                  JSON.stringify(
                    {
                      file: file.name,
                      pages: result.pages,
                      text: result.text,
                    },
                    null,
                    2,
                  ),
                ],
                { type: "application/json" },
              ),
            )}
            download={`${file.name.replace(/\.pdf$/i, "")}.json`}
            className="btn"
          >
            <Download size={14} aria-hidden /> JSON
          </a>
          <button type="button" className="btn btn-ghost" onClick={onReset}>
            <X size={14} aria-hidden /> Reset
          </button>
        </div>
      </div>

      {/* Toolbar: tabs + search + page nav */}
      <div className="flex flex-wrap items-center gap-2 sm:gap-3 py-4">
        <div className="inline-flex rounded-[4px] border border-[color:var(--color-rule)] dark:border-[color:var(--color-rule-d)] overflow-hidden">
          <button
            type="button"
            role="tab"
            aria-selected={view === "text"}
            className={cn("chip rounded-none border-0", view === "text" && "chip-active")}
            onClick={() => setView("text")}
          >
            <Type size={13} aria-hidden /> Text
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "canvas"}
            className={cn("chip rounded-none border-0", view === "canvas" && "chip-active")}
            onClick={() => setView("canvas")}
          >
            <FileText size={13} aria-hidden /> Page
          </button>
        </div>

        <div className="flex-1 min-w-[180px] relative">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
            aria-hidden
          />
          <input
            id="search-input"
            type="search"
            placeholder="Highlight text in current page…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2.5 rounded-[4px] border border-[color:var(--color-rule)] dark:border-[color:var(--color-rule-d)] bg-transparent text-sm focus:border-[color:var(--color-accent)] outline-none"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <PageNav
          page={page}
          total={result.pages.length}
          onChange={setPage}
        />
      </div>

      {/* View */}
      {view === "text" && currentPage ? (
        <TextView
          page={currentPage}
          query={query}
          highlightItems={highlightItems}
          activeItem={activeItem}
          setActiveItem={setActiveItem}
        />
      ) : currentPage ? (
        <CanvasView
          bytes={bytes}
          page={currentPage}
          query={query}
          highlightItems={highlightItems}
          activeItem={activeItem}
          setActiveItem={setActiveItem}
          zoom={zoom}
          setZoom={setZoom}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page nav
// ---------------------------------------------------------------------------
function PageNav({
  page,
  total,
  onChange,
}: {
  page: number;
  total: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 surface-flush p-1 rounded-[4px]">
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        aria-label="Previous page"
        title="Previous page (←)"
      >
        <ChevronLeft size={16} aria-hidden />
      </button>
      <span className="text-sm font-mono px-2 select-none">
        <span className="text-accent">{page}</span>
        <span className="text-muted mx-1">/</span>
        {total}
      </span>
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        disabled={page >= total}
        onClick={() => onChange(page + 1)}
        aria-label="Next page"
        title="Next page (→)"
      >
        <ChevronRight size={16} aria-hidden />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text view with bbox highlights
// ---------------------------------------------------------------------------
function TextView({
  page,
  query,
  highlightItems,
  activeItem,
  setActiveItem,
}: {
  page: PageData;
  query: string;
  highlightItems: BBoxItem[];
  activeItem: { p: number; i: number } | null;
  setActiveItem: (a: { p: number; i: number } | null) => void;
}) {
  const out = useMemo(() => {
    if (!query.trim()) {
      return (
        <pre className="parsed-output fade-in">
          {page.items.map((it) => it.text).join("\n") ||
            "No text extracted from this page."}
        </pre>
      );
    }
    const q = query.toLowerCase();
    const hits = new Set<number>();
    const hitTexts: string[] = [];
    page.items.forEach((it, idx) => {
      const t = it.text;
      const lower = t.toLowerCase();
      if (lower.includes(q)) {
        hits.add(idx);
        hitTexts.push(t);
      }
    });
    const highlighted = page.items.map((it, idx) => {
      if (!hits.has(idx)) return escapeHtml(it.text);
      return `<mark class="bbox-hit" data-item-idx="${idx}">${escapeHtml(it.text)}</mark>`;
    });
    return (
      <pre
        className="parsed-output fade-in"
        dangerouslySetInnerHTML={{
          __html: highlighted.join("\n") || "(no match on this page)",
        }}
        onClick={(e) => {
          const t = e.target as HTMLElement | null;
          if (!t) return;
          const mark = t.closest("mark.bbox-hit") as HTMLElement | null;
          if (mark) {
            const idx = Number(mark.dataset.itemIdx);
            setActiveItem({ p: page.pageNumber, i: idx });
            // Also scroll the matched bbox into view in canvas if needed.
            const rect = mark.getBoundingClientRect();
            window.scrollBy({ top: rect.top - 120, behavior: "smooth" });
          }
        }}
      />
    );
  }, [page, query, setActiveItem]);

  return (
    <div className="grid lg:grid-cols-[1fr_280px] gap-5">
      <div className="surface p-5 sm:p-7 max-h-[70vh] overflow-auto">
        {out}
      </div>
      <aside className="surface p-5 max-h-[70vh] overflow-auto">
        <p className="kicker text-accent">
          Items · {query ? highlightItems.length : page.items.length}
        </p>
        <p className="mt-1 text-xs text-muted">
          {query ? `Matching "${query}"` : "Click any item to inspect"}
        </p>
        <ul className="mt-4 space-y-2 text-sm">
          {(query ? highlightItems : page.items).map((it, idx) => {
            const itemIdx = query
              ? page.items.findIndex((x) => x === it)
              : idx;
            const isActive =
              activeItem?.p === page.pageNumber && activeItem?.i === itemIdx;
            return (
              <li key={`${idx}-${it.text.slice(0, 20)}`}>
                <button
                  type="button"
                  className={cn(
                    "w-full text-left p-2 rounded-[3px] hover:bg-[color:var(--color-paper-2)] dark:hover:bg-[color:var(--color-paper-d-2)] transition-colors",
                    isActive && "bg-[color:var(--color-accent-soft)] dark:bg-[color:var(--color-accent-d-soft)]",
                  )}
                  onClick={() => {
                    setActiveItem({ p: page.pageNumber, i: itemIdx });
                    const el = document.querySelector(
                      `[data-item-idx="${itemIdx}"]`,
                    );
                    if (el && "scrollIntoView" in el) {
                      (el as HTMLElement).scrollIntoView({
                        behavior: "smooth",
                        block: "center",
                      });
                    }
                  }}
                >
                  <p className="font-mono text-[0.8125rem] leading-snug truncate">
                    {it.text || <span className="text-muted">·</span>}
                  </p>
                  <p className="mt-1 text-[0.6875rem] text-muted font-mono">
                    {formatBbox(it.bbox)}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Canvas view: render page to PNG, overlay bboxes
// ---------------------------------------------------------------------------
function CanvasView({
  bytes,
  page,
  query,
  highlightItems,
  activeItem,
  setActiveItem,
  zoom,
  setZoom,
}: {
  bytes: Uint8Array;
  page: PageData;
  query: string;
  highlightItems: BBoxItem[];
  activeItem: { p: number; i: number } | null;
  setActiveItem: (a: { p: number; i: number } | null) => void;
  zoom: number;
  setZoom: (z: number) => void;
}) {
  const [png, setPng] = useState<{ dataUrl: string; width: number; height: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRenderError(null);
    renderPagePng(bytes, page.pageNumber, 150)
      .then((r) => {
        if (!cancelled) setPng(r);
      })
      .catch((e) => {
        if (!cancelled)
          setRenderError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bytes, page.pageNumber]);

  // Convert PDF bbox (points) to image-px coords. PDF origin = top-left in
  // LiteParse, so no y-flip needed for our overlay.
  const overlayRects = useMemo(() => {
    if (!png) return [] as { idx: number; left: number; top: number; width: number; height: number; active: boolean; text: string; isMatch: boolean }[];
    const sx = png.width / page.width;
    const sy = png.height / page.height;
    const highlightSet = new Set(highlightItems);
    return page.items
      .map((it, idx) => {
        const [x1, y1, x2, y2] = it.bbox;
        const left = x1 * sx;
        const top = y1 * sy;
        const width = Math.max(2, (x2 - x1) * sx);
        const height = Math.max(2, (y2 - y1) * sy);
        const isMatch = query ? highlightSet.has(it) : true;
        const active = activeItem?.p === page.pageNumber && activeItem?.i === idx;
        return { idx, left, top, width, height, active, text: it.text, isMatch };
      })
      .filter((r) => r.isMatch || query);
  }, [png, page, highlightItems, query, activeItem]);

  return (
    <div className="grid lg:grid-cols-[1fr_300px] gap-5">
      <div className="surface p-3 sm:p-5 overflow-auto max-h-[78vh]">
        {loading && (
          <div className="flex items-center justify-center p-12">
            <Loader2 size={20} className="text-accent animate-spin" aria-hidden />
          </div>
        )}
        {renderError && (
          <div className="p-6 text-sm">
            <p className="text-accent">Render failed: {renderError}</p>
          </div>
        )}
        {png && (
          <div
            className="page-canvas-wrap mx-auto"
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: "top left",
            }}
          >
            <img
              src={png.dataUrl}
              alt={`Page ${page.pageNumber}`}
              width={png.width}
              height={png.height}
            />
            <div className="bbox-overlay" aria-hidden>
              {overlayRects.map((r) => (
                <div
                  key={r.idx}
                  className={cn("bbox-rect", r.active && "is-active")}
                  style={{
                    left: `${r.left}px`,
                    top: `${r.top}px`,
                    width: `${r.width}px`,
                    height: `${r.height}px`,
                    opacity: query && r.isMatch ? 1 : 0.6,
                  }}
                  onClick={() =>
                    setActiveItem({ p: page.pageNumber, i: r.idx })
                  }
                  title={r.text}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      <aside className="surface p-5 flex flex-col gap-4">
        <div>
          <p className="kicker text-accent">Page canvas</p>
          <p className="text-sm text-muted mt-1">
            Rendered via PDF.js. Bounding boxes from LiteParse, overlaid in
            the same coordinate space.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => setZoom(Math.max(0.4, zoom - 0.15))}
            aria-label="Zoom out"
          >
            <ZoomOut size={14} aria-hidden />
          </button>
          <span className="font-mono text-xs text-muted">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => setZoom(Math.min(2.5, zoom + 0.15))}
            aria-label="Zoom in"
          >
            <ZoomIn size={14} aria-hidden />
          </button>
        </div>
        <div className="border-t border-[color:var(--color-rule-soft)] dark:border-[color:var(--color-rule-d-soft)] pt-4">
          <p className="kicker">Items on page</p>
          <ul className="mt-2 space-y-1 max-h-[40vh] overflow-auto text-sm">
            {page.items.map((it, idx) => {
              const isActive =
                activeItem?.p === page.pageNumber && activeItem?.i === idx;
              const isMatch = query ? it.text.toLowerCase().includes(query.toLowerCase()) : false;
              return (
                <li key={idx}>
                  <button
                    type="button"
                    className={cn(
                      "w-full text-left p-1.5 rounded-[3px] hover:bg-[color:var(--color-paper-2)] dark:hover:bg-[color:var(--color-paper-d-2)] transition-colors",
                      isActive && "bg-[color:var(--color-accent-soft)] dark:bg-[color:var(--color-accent-d-soft)]",
                      query && isMatch && "ring-1 ring-[color:var(--color-accent)]/40",
                    )}
                    onClick={() => setActiveItem({ p: page.pageNumber, i: idx })}
                  >
                    <p className="font-mono text-[0.75rem] truncate">
                      {it.text || <span className="text-muted">·</span>}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------
function Footer() {
  return (
    <footer className="border-t border-[color:var(--color-rule-soft)] dark:border-[color:var(--color-rule-d-soft)] mt-12">
      <div className="mx-auto max-w-[1180px] px-4 sm:px-6 lg:px-10 py-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-muted">
        <p>
          Powered by{" "}
          <a
            href="https://github.com/run-llama/liteparse"
            target="_blank"
            rel="noreferrer"
            className="text-accent underline decoration-[color:var(--color-rule)] underline-offset-2 hover:decoration-current"
          >
            LiteParse
          </a>{" "}
          (Apache 2.0) · rendered with{" "}
          <a
            href="https://mozilla.github.io/pdf.js/"
            target="_blank"
            rel="noreferrer"
            className="text-accent underline decoration-[color:var(--color-rule)] underline-offset-2 hover:decoration-current"
          >
            PDF.js
          </a>
        </p>
        <p className="font-mono">
          <kbd className="kbd">/</kbd> search · <kbd className="kbd">←</kbd>/
          <kbd className="kbd">→</kbd> page · <kbd className="kbd">Esc</kbd>{" "}
          clear
        </p>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatBbox(b: [number, number, number, number]): string {
  return `[${b[0].toFixed(1)}, ${b[1].toFixed(1)}, ${b[2].toFixed(1)}, ${b[3].toFixed(1)}]`;
}
