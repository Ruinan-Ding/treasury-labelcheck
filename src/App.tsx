import { ChangeEvent, useMemo, useState } from "react";
import { fixtureCases } from "./data/fixtures";
import { DEFAULT_CONCURRENCY, MAX_BATCH_SIZE, processBatch } from "./lib/batch";
import { compareFields, FIELD_DEFINITIONS } from "./lib/verification";
import { extractLabelFields } from "./lib/extract";
import { recognizeLabel, terminateOcr } from "./lib/ocr";
import {
  csvCell,
  makeOcrCase,
  makeStubCase,
  MAX_UPLOAD_BYTES,
  pairingKey,
  parseApplicationRecord,
  parseStructuredCase
} from "./lib/cases";
import type { LabelCase, LabelFields, OcrStatus, VerificationStatus } from "./types";

interface Notice {
  tone: "info" | "warn";
  text: string;
}

function statusLabel(status: VerificationStatus): string {
  return status === "match" ? "Match" : status === "mismatch" ? "Mismatch" : "Review";
}

function statusIcon(status: VerificationStatus): string {
  return status === "match" ? "✓" : status === "mismatch" ? "!" : "?";
}

function tierLabel(tier: ReturnType<typeof compareFields>["results"][number]["matchTier"]): string {
  return tier === "exact" ? "Exact" : tier === "normalized" ? "Normalized match" : tier === "mismatch" ? "Mismatch" : "Needs review";
}

function inputStatusLabel(status: OcrStatus): string {
  return status === "structured"
    ? "Structured record"
    : status === "ocr"
      ? "Label read by OCR"
      : status === "rejected"
        ? "File rejected"
        : "Unreadable input";
}

const isJsonFile = (file: File): boolean =>
  file.type === "application/json" || file.name.toLowerCase().endsWith(".json");

const timed = (item: LabelCase, startedAt: number): LabelCase => ({
  ...item,
  processingTimeMs: Math.round(performance.now() - startedAt)
});

function evidenceDetail(item: LabelCase): string {
  if (item.ocrConfidence !== undefined) {
    const elapsed = item.processingTimeMs === undefined ? "" : ` · read in ${item.processingTimeMs} ms`;
    return `${Math.round(item.ocrConfidence * 100)}% mean character confidence${elapsed}`;
  }
  if (item.processingTimeMs !== undefined) return `Loaded in ${item.processingTimeMs} ms`;
  return "Confidence is field-specific";
}

function FieldValue({ value }: { value: string | null }) {
  return <span className={value ? "" : "muted-value"}>{value || "Not available"}</span>;
}

function ResultCard({ result }: { result: ReturnType<typeof compareFields>["results"][number] }) {
  return (
    <article className={`result-card result-${result.status}`}>
      <div className="result-heading">
        <span className="status-mark" aria-hidden="true">{statusIcon(result.status)}</span>
        <div>
          <h3>{result.label}</h3>
          <p>{statusLabel(result.status)} · {tierLabel(result.matchTier)} <span className="confidence">{Math.round(result.confidence * 100)}% confidence</span></p>
        </div>
      </div>
      <div className="value-grid">
        <div><span className="value-label">Application</span><FieldValue value={result.applicationValue} /></div>
        <div><span className="value-label">Label evidence</span><FieldValue value={result.labelValue} /></div>
      </div>
      <p className="result-note">{result.note}</p>
    </article>
  );
}

export default function App() {
  const [cases, setCases] = useState<LabelCase[]>(fixtureCases);
  const [selectedId, setSelectedId] = useState(fixtureCases[0].id);
  const [isProcessing, setIsProcessing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const selected = cases.find((item) => item.id === selectedId) || cases[0];
  // One pass per case list rather than one per case per render: the sidebar and the
  // CSV export both read from here.
  const summaries = useMemo(
    () => new Map(cases.map((item) => [item.id, compareFields(item.application, item.label)] as const)),
    [cases]
  );
  const summary = selected ? summaries.get(selected.id) : undefined;

  async function loadFiles(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const selectedFiles = Array.from(input.files || []);
    if (selectedFiles.length === 0) return;
    const files = selectedFiles.slice(0, MAX_BATCH_SIZE);
    const skipped = selectedFiles.length - files.length;
    setNotice(null);
    setIsProcessing(true);
    setProgress(null);
    try {
      // JSON is read first. A file carrying only an `application` object is not a case on
      // its own - it is the record a label image uploaded beside it is compared against,
      // so every record has to be in hand before any image is read.
      const structured: LabelCase[] = [];
      const applications = new Map<string, { fields: LabelFields; sourceName: string }>();

      for (const file of files.filter(isJsonFile)) {
        const startedAt = performance.now();
        try {
          if (file.size > MAX_UPLOAD_BYTES) {
            structured.push(timed(makeStubCase(file, "rejected", "File exceeds the 10 MB local-demo limit."), startedAt));
            continue;
          }
          const value = JSON.parse(await file.text());
          const record = parseApplicationRecord(value);
          if (record) {
            applications.set(pairingKey(file.name), { fields: record, sourceName: file.name });
            continue;
          }
          const parsed = parseStructuredCase(value, file.name);
          structured.push(timed(parsed || makeStubCase(file, "unreadable", "JSON was readable, but it held neither an application/label pair nor an application record."), startedAt));
        } catch {
          structured.push(timed(makeStubCase(file, "unreadable", "This file could not be read or parsed. Human review is required."), startedAt));
        }
      }

      const images = files.filter((file) => !isJsonFile(file));
      const paired = new Set<string>();
      let done = 0;
      if (images.length > 0) setProgress({ done: 0, total: images.length });

      const read = await processBatch(images, async (file) => {
        const startedAt = performance.now();
        // Isolated per file: one unreadable image must not discard the whole batch.
        try {
          if (file.size > MAX_UPLOAD_BYTES) {
            return timed(makeStubCase(file, "rejected", "File exceeds the 10 MB local-demo limit."), startedAt);
          }
          if (!file.type.startsWith("image/")) {
            return timed(makeStubCase(file, "rejected", "Unsupported file type. Upload a JSON case or a label image."), startedAt);
          }
          const ocr = await recognizeLabel(file);
          const key = pairingKey(file.name);
          const record = applications.get(key);
          if (record) paired.add(key);
          return timed(
            makeOcrCase({
              file,
              imageUrl: URL.createObjectURL(file),
              text: ocr.text,
              confidence: ocr.confidence,
              label: extractLabelFields(ocr.text),
              application: record?.fields ?? null,
              applicationSource: record?.sourceName
            }),
            startedAt
          );
        } catch {
          return timed(makeStubCase(file, "unreadable", "This image could not be read. Human review is required."), startedAt);
        } finally {
          done += 1;
          setProgress({ done, total: images.length });
        }
      }, DEFAULT_CONCURRENCY);

      const loaded = [...read, ...structured];
      setCases((current) => [...loaded, ...current]);
      if (loaded[0]) setSelectedId(loaded[0].id);

      // An application record whose image never arrived would otherwise disappear without
      // a trace, leaving the agent no way to tell that it was never checked.
      const orphans = [...applications.entries()].filter(([key]) => !paired.has(key));
      const warnings = [
        skipped > 0
          ? `${skipped} file${skipped === 1 ? " was" : "s were"} NOT processed - this prototype accepts ${MAX_BATCH_SIZE} files per batch.`
          : "",
        orphans.length > 0
          ? `${orphans.length} application record${orphans.length === 1 ? "" : "s"} (${orphans.map(([, value]) => value.sourceName).join(", ")}) had no label image with a matching filename and ${orphans.length === 1 ? "was" : "were"} not checked.`
          : ""
      ].filter(Boolean);

      const pairedText = paired.size > 0
        ? ` ${paired.size} label${paired.size === 1 ? " was" : "s were"} matched to an application record by filename.`
        : "";
      const loadedText = `${loaded.length} case${loaded.length === 1 ? "" : "s"} loaded.${pairedText} Everything stays in this browser; no files are sent anywhere.`;
      setNotice(
        warnings.length > 0
          ? { tone: "warn", text: `${loadedText} ${warnings.join(" ")}` }
          : { tone: "info", text: loadedText }
      );
    } finally {
      setIsProcessing(false);
      setProgress(null);
      input.value = "";
    }
  }

  function selectFixture(id: string) {
    setSelectedId(id);
    setNotice(null);
  }

  function clearUploads() {
    // Object URLs are never reclaimed on their own. Revoked here rather than inside the
    // state updater, which React requires to be pure and invokes twice in StrictMode.
    cases.forEach((item) => {
      if (item.imageUrl && item.imageUrl.startsWith("blob:")) URL.revokeObjectURL(item.imageUrl);
    });
    setCases(fixtureCases);
    setSelectedId(fixtureCases[0].id);
    setReviewed({});
    // Hands back the ~3 MB language model and the WASM core the OCR worker is holding.
    void terminateOcr();
    setNotice({ tone: "info", text: "Uploaded cases cleared. The sample cases remain." });
  }

  function markReviewed() {
    if (!selected) return;
    setReviewed((current) => ({ ...current, [selected.id]: true }));
    setNotice({ tone: "info", text: "Review recorded for this session. No automated decision replaces the agent." });
  }

  function exportQueue() {
    const header = ["Case", "Overall status", "Matches", "Mismatches", "Needs review", "Processing time (ms)", "Review recorded"];
    const rows = cases.map((item) => {
      const itemSummary = summaries.get(item.id) ?? compareFields(item.application, item.label);
      // A refused file was never compared, so it has no field counts to report.
      const refused = item.ocrStatus === "rejected";
      return [
        item.name,
        refused ? "Not processed" : statusLabel(itemSummary.overall),
        refused ? "" : itemSummary.matched,
        refused ? "" : itemSummary.mismatched,
        refused ? "" : itemSummary.needsReview,
        item.processingTimeMs ?? "",
        reviewed[item.id] ? "Yes" : "No"
      ];
    });
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "labelcheck-review-queue.csv";
    link.click();
    URL.revokeObjectURL(url);
    setNotice({ tone: "info", text: "Review queue exported locally. No files or results were sent anywhere." });
  }

  if (!selected || !summary) return <main className="empty-state">No cases available.</main>;

  // A refused file never reached the comparison rules; showing seven "Not available"
  // rows for it would imply a review that never happened.
  const refused = selected.ocrStatus === "rejected";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-icon" aria-hidden="true">LC</div>
          <div>
            <p className="eyebrow">Compliance workspace</p>
            <h1>LabelCheck</h1>
          </div>
        </div>
        <div className="topbar-meta">
          <span className="local-pill"><span className="online-dot" /> Local demo</span>
          <span>On-device OCR · no network</span>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar" aria-label="Cases and uploads">
          <div className="sidebar-heading">
            <div>
              <p className="eyebrow">Verification queue</p>
              <h2>Cases</h2>
            </div>
            <span className="count-badge">{cases.length}</span>
          </div>

          <label className="upload-box">
            <span className="upload-icon" aria-hidden="true">↑</span>
            <strong>
              {isProcessing
                ? progress
                  ? `Reading labels... ${progress.done} of ${progress.total}`
                  : "Processing..."
                : "Upload label images or JSON"}
            </strong>
            <span>Images are read on this device · max {MAX_BATCH_SIZE} per batch</span>
            <input
              type="file"
              accept=".json,image/*"
              multiple
              onChange={loadFiles}
              disabled={isProcessing}
              aria-label="Upload JSON cases or label images"
            />
          </label>

          <div className="fixture-label">{cases.length > fixtureCases.length ? "Uploaded and sample cases" : "Sample cases"}</div>
          <nav className="case-list">
            {cases.map((item) => {
              const overall = summaries.get(item.id)?.overall ?? "review";
              return (
                <button
                  className={`case-button ${item.id === selected.id ? "active" : ""}`}
                  key={item.id}
                  aria-current={item.id === selected.id ? "true" : undefined}
                  onClick={() => selectFixture(item.id)}
                >
                  <span className={`mini-status mini-${overall}`} aria-hidden="true">{statusIcon(overall)}</span>
                  <span className="visually-hidden">{statusLabel(overall)}: </span>
                  <span className="case-button-text">
                    <strong>{item.name}</strong>
                    <small>{item.sourceName && item.sourceName !== item.name ? item.sourceName : item.description}</small>
                  </span>
                  <span className="chevron" aria-hidden="true">›</span>
                </button>
              );
            })}
          </nav>
          <div className="sidebar-footnote">
            <strong>Bounded batch processing</strong>
            <span>Up to {MAX_BATCH_SIZE} items, {DEFAULT_CONCURRENCY} in-process workers.</span>
          </div>
        </aside>

        <main className="content">
          <section className="page-heading">
            <div>
              <p className="eyebrow">Case review</p>
              <h2>{selected.name}</h2>
              <p className="subheading">{selected.description}</p>
            </div>
            <div className="heading-actions">
              <button className="secondary-button" type="button" onClick={exportQueue}>Export CSV</button>
              {cases.length > fixtureCases.length && (
                <button className="secondary-button" type="button" onClick={clearUploads}>Clear uploads</button>
              )}
              <span className={`overall-chip chip-${refused ? "review" : summary.overall}`}>
                <span aria-hidden="true">{refused ? "!" : statusIcon(summary.overall)}</span>{" "}
                {refused ? "Not processed" : statusLabel(summary.overall)}
              </span>
              {reviewed[selected.id] && <span className="reviewed-chip">Reviewed</span>}
            </div>
          </section>

          <section className="overview-grid">
            <div className="stat-card"><span className="stat-number stat-green">{refused ? "-" : summary.matched}</span><span>Matches</span></div>
            <div className="stat-card"><span className="stat-number stat-red">{refused ? "-" : summary.mismatched}</span><span>Mismatches</span></div>
            <div className="stat-card"><span className="stat-number stat-amber">{refused ? "-" : summary.needsReview}</span><span>Needs review</span></div>
            <div className="stat-card stat-context"><span className="stat-context-label">Input status</span><strong>{inputStatusLabel(selected.ocrStatus)}</strong><span>{evidenceDetail(selected)}</span></div>
          </section>

          <div className="workspace-grid">
            <section className="results-section">
              <div className="section-heading">
                <div><h2>Field comparison</h2><p>Automated checks are suggestions for a compliance agent.</p></div>
                <span className="field-count">{FIELD_DEFINITIONS.length} required fields</span>
              </div>
              {refused ? (
                <div className="refused-panel">
                  <span className="status-mark" aria-hidden="true">!</span>
                  <div>
                    <strong>No comparison was performed</strong>
                    <p>{selected.description} Nothing on this file has been checked against an application.</p>
                  </div>
                </div>
              ) : (
                <div className="result-list">
                  {summary.results.map((result) => <ResultCard key={result.key} result={result} />)}
                </div>
              )}
            </section>

            <aside className="evidence-panel">
              <div className="section-heading">
                <div><h2>Label evidence</h2><p>{selected.imageUrl ? "Uploaded image preview" : selected.ocrStatus === "structured" ? "Structured input preview" : "No preview available"}</p></div>
              </div>
              {selected.imageUrl ? (
                <div className="image-preview">
                  <img src={selected.imageUrl} alt={`Uploaded label for ${selected.name}`} />
                  {selected.ocrConfidence !== undefined && (
                    <div className="image-overlay">
                      Read on this device
                      <br />
                      <small>{Math.round(selected.ocrConfidence * 100)}% mean character confidence</small>
                    </div>
                  )}
                </div>
              ) : (
                <div className="structured-preview">
                  <div className="document-icon" aria-hidden="true">▤</div>
                  <strong>{selected.ocrStatus === "structured" ? "Structured input loaded" : "No label evidence available"}</strong>
                  <span>{selected.ocrStatus === "structured" ? "Deterministic local comparison · no external credentials" : selected.description}</span>
                </div>
              )}
              {selected.ocrText && (
                <details className="ocr-text">
                  <summary>Show recognised text</summary>
                  <pre>{selected.ocrText.trim() || "No text was recognised in this image."}</pre>
                </details>
              )}
              <div className="evidence-note">
                <span className="info-icon" aria-hidden="true">i</span>
                <p>Unreadable, low-confidence, or presentation-sensitive fields remain <strong>Review</strong> so an agent can decide.</p>
              </div>
              <button className="primary-button" onClick={markReviewed}>
                {reviewed[selected.id] ? "Review recorded" : "Mark case reviewed"}
              </button>
            </aside>
          </div>
          {notice && <div className={`notice notice-${notice.tone}`} role="status">{notice.text}</div>}
        </main>
      </div>
    </div>
  );
}
