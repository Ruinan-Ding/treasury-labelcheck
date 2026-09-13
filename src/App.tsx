import { ChangeEvent, useMemo, useState } from "react";
import { DEFAULT_CONCURRENCY, MAX_BATCH_SIZE, processBatch } from "./lib/batch";
import { compareFields, FIELD_DEFINITIONS } from "./lib/verification";
import { extractLabelFields } from "./lib/extract";
import { recognizeLabel, terminateOcr } from "./lib/ocr";
import {
  csvCell,
  makeApplicationOnlyCase,
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

interface PendingApplication {
  file: File;
  fields: LabelFields;
  key: string;
}

type HumanDecision = "accept" | "review" | "reject";

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

const compareCase = (item: LabelCase) =>
  compareFields(item.application, item.label, { ocr: item.ocrStatus === "ocr" });

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
  const [cases, setCases] = useState<LabelCase[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [decisions, setDecisions] = useState<Record<string, HumanDecision>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [pendingApplications, setPendingApplications] = useState<PendingApplication[]>([]);
  const [pendingImages, setPendingImages] = useState<File[]>([]);

  const selected = cases.find((item) => item.id === selectedId) || cases[0];
  // One pass per case list rather than one per case per render: the sidebar and the
  // CSV export both read from here.
  const summaries = useMemo(
    () => new Map(cases.map((item) => [item.id, compareCase(item)] as const)),
    [cases]
  );
  const summary = selected ? summaries.get(selected.id) : undefined;

  async function loadApplicationFiles(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const files = Array.from(input.files || []).slice(0, MAX_BATCH_SIZE);
    const records: PendingApplication[] = [];
    const structured: LabelCase[] = [];
    const invalid: string[] = [];
    for (const file of files) {
      try {
        if (file.size > MAX_UPLOAD_BYTES) {
          invalid.push(`${file.name} exceeds 10 MB`);
          continue;
        }
        const value = JSON.parse(await file.text());
        const record = parseApplicationRecord(value);
        if (record) {
          records.push({ file, fields: record, key: pairingKey(file.name) });
          continue;
        }
        const parsed = parseStructuredCase(value, file.name);
        if (parsed) structured.push(parsed);
        else invalid.push(`${file.name} is not an application record or complete structured case`);
      } catch {
        invalid.push(`${file.name} could not be parsed`);
      }
    }
    if (structured.length > 0) {
      setCases((current) => [...structured, ...current]);
      setSelectedId(structured[0].id);
    }
    setPendingApplications((current) => [...current, ...records]);
    setNotice({
      tone: invalid.length > 0 ? "warn" : "info",
      text: `${records.length} application record${records.length === 1 ? "" : "s"} staged for comparison.${structured.length > 0 ? ` ${structured.length} complete structured case${structured.length === 1 ? "" : "s"} loaded.` : ""}${invalid.length > 0 ? ` ${invalid.join("; ")}.` : ""}`
    });
    input.value = "";
  }

  function stageImageFiles(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const selectedFiles = Array.from(input.files || []);
    const accepted = selectedFiles.filter((file) => file.type.startsWith("image/"));
    const rejected = selectedFiles.filter((file) => !file.type.startsWith("image/")).map((file) => file.name);
    setPendingImages((current) => [...current, ...accepted].slice(0, MAX_BATCH_SIZE));
    setNotice({
      tone: rejected.length > 0 ? "warn" : "info",
      text: `${accepted.length} image${accepted.length === 1 ? "" : "s"} staged for comparison.${rejected.length > 0 ? ` Unsupported files ignored: ${rejected.join(", ")}.` : ""}`
    });
    input.value = "";
  }

  async function compareStagedFiles() {
    if (pendingImages.length === 0) return;
    setNotice(null);
    setIsProcessing(true);
    setProgress({ done: 0, total: pendingImages.length });
    try {
      const applications = new Map(pendingApplications.map((item) => [item.key, item] as const));
      const paired = new Set<string>();
      let done = 0;
      const read = await processBatch(pendingImages, async (file) => {
        const startedAt = performance.now();
        const record = applications.get(pairingKey(file.name));
        try {
          if (file.size > MAX_UPLOAD_BYTES) {
            return timed(makeStubCase(file, "rejected", "File exceeds the 10 MB local-demo limit."), startedAt);
          }
          if (record) paired.add(record.key);
          const ocr = await recognizeLabel(file);
          return timed(makeOcrCase({
            file,
            imageUrl: URL.createObjectURL(file),
            text: ocr.text,
            confidence: ocr.confidence,
            label: extractLabelFields(ocr.text),
            application: record?.fields ?? null,
            applicationSource: record?.file.name
          }), startedAt);
        } catch {
          return timed(makeStubCase(
            file,
            "unreadable",
            "This image could not be read. Human review is required.",
            record?.fields,
            record?.file.name
          ), startedAt);
        } finally {
          done += 1;
          setProgress({ done, total: pendingImages.length });
        }
      }, DEFAULT_CONCURRENCY);
      const orphanApplications = pendingApplications.filter((item) => !paired.has(item.key));
      const orphanCases = orphanApplications.map((item) => makeApplicationOnlyCase(item.file, item.fields));
      const unmatchedImages = read.filter((item) => !item.applicationSource).length;
      const warnings = [
        orphanApplications.length > 0 ? `${orphanApplications.length} application record${orphanApplications.length === 1 ? "" : "s"} had no matching image and were not checked.` : "",
        unmatchedImages > 0 ? `${unmatchedImages} image${unmatchedImages === 1 ? "" : "s"} had no matching application record and remain review-only.` : ""
      ].filter(Boolean);
      setCases((current) => [...read, ...orphanCases, ...current]);
      if (read[0] || orphanCases[0]) setSelectedId((read[0] || orphanCases[0]).id);
      setNotice({
        tone: warnings.length > 0 ? "warn" : "info",
        text: `${read.length} label${read.length === 1 ? "" : "s"} compared. ${paired.size} pair${paired.size === 1 ? "" : "s"} matched by filename.${warnings.length > 0 ? ` ${warnings.join(" ")}` : ""}`
      });
      setPendingApplications([]);
      setPendingImages([]);
    } finally {
      setIsProcessing(false);
      setProgress(null);
    }
  }

  function selectCase(id: string) {
    setSelectedId(id);
    setNotice(null);
  }

  function removeApplication(key: string) {
    setPendingApplications((current) => current.filter((item) => item.key !== key));
  }

  function removeImage(file: File) {
    setPendingImages((current) => current.filter((item) => item !== file));
  }

  function resetWorkspace() {
    // Object URLs are never reclaimed on their own. Revoked here rather than inside the
    // state updater, which React requires to be pure and invokes twice in StrictMode.
    cases.forEach((item) => {
      if (item.imageUrl && item.imageUrl.startsWith("blob:")) URL.revokeObjectURL(item.imageUrl);
    });
    setCases([]);
    setSelectedId(null);
    setDecisions({});
    setPendingApplications([]);
    setPendingImages([]);
    // Hands back the ~3 MB language model and the WASM core the OCR worker is holding.
    void terminateOcr();
    setNotice({ tone: "info", text: "Workspace reset." });
  }

  function setDecision(decision: HumanDecision) {
    if (!selected) return;
    setDecisions((current) => ({ ...current, [selected.id]: decision }));
    setNotice({ tone: "info", text: `${decision === "accept" ? "Accepted" : decision === "reject" ? "Rejected" : "Marked as needing review"} for this session. You can change this decision at any time.` });
  }

  function exportQueue() {
    const header = ["Case", "Overall status", "Matches", "Mismatches", "Needs review", "Processing time (ms)", "Human decision"];
    const rows = cases.map((item) => {
      const itemSummary = summaries.get(item.id) ?? compareCase(item);
      // A refused file was never compared, so it has no field counts to report.
      const refused = item.ocrStatus === "rejected";
      return [
        item.name,
        refused ? "Not processed" : statusLabel(itemSummary.overall),
        refused ? "" : itemSummary.matched,
        refused ? "" : itemSummary.mismatched,
        refused ? "" : itemSummary.needsReview,
        item.processingTimeMs ?? "",
        decisions[item.id] ?? ""
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

  if (!selected || !summary) return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-icon" aria-hidden="true">LC</div>
          <div><p className="eyebrow">Compliance workspace</p><h1>LabelCheck</h1></div>
        </div>
        <div className="topbar-meta"><span className="local-pill"><span className="online-dot" /> Local demo</span><span>On-device OCR · no network</span></div>
      </header>
      <div className="layout">
        <aside className="sidebar" aria-label="Cases and uploads">
          <div className="sidebar-heading"><div><p className="eyebrow">Verification queue</p><h2>Cases</h2></div><span className="count-badge">0</span></div>
          <div className="upload-heading">Prepare a batch</div>
          <label className="upload-box"><span className="upload-icon" aria-hidden="true">↑</span><strong>Upload application JSON files</strong><span>Stage records here before comparison</span><input type="file" accept=".json,application/json" multiple onChange={loadApplicationFiles} disabled={isProcessing} aria-label="Upload application JSON files" /></label>
          <div className="pending-files">{pendingApplications.length === 0 ? <span>No application records staged</span> : pendingApplications.map((item) => <span className="pending-file" key={item.key}><span>{item.file.name}</span><button type="button" onClick={() => removeApplication(item.key)} aria-label={`Remove ${item.file.name}`}>x</button></span>)}</div>
          <label className="upload-box"><span className="upload-icon" aria-hidden="true">↑</span><strong>Upload label images</strong><span>Read locally with OCR · max {MAX_BATCH_SIZE}</span><input type="file" accept="image/*" multiple onChange={stageImageFiles} disabled={isProcessing} aria-label="Upload label images" /></label>
          <div className="pending-files">{pendingImages.length === 0 ? <span>No label images staged</span> : pendingImages.map((file) => <span className="pending-file" key={`${file.name}-${file.lastModified}`}><span>{file.name}</span><button type="button" onClick={() => removeImage(file)} aria-label={`Remove ${file.name}`}>x</button></span>)}</div>
          <button className="primary-button compare-button" type="button" onClick={compareStagedFiles} disabled={isProcessing || pendingImages.length === 0}>{isProcessing && progress ? `Comparing ${progress.done} of ${progress.total}...` : "Compare uploaded files"}</button>
          {(pendingApplications.length > 0 || pendingImages.length > 0) && <button className="reset-button" type="button" onClick={resetWorkspace} disabled={isProcessing}>Reset workspace</button>}
          <div className="sidebar-footnote"><strong>Bounded batch processing</strong><span>Up to {MAX_BATCH_SIZE} items, {DEFAULT_CONCURRENCY} in-process workers.</span></div>
        </aside>
        <main className="content empty-state"><div className="empty-card"><p className="eyebrow">Ready for review</p><h2>Start with a real batch</h2><p>Stage application JSON files and label images in the two upload boxes, then compare them. Nothing is preloaded.</p></div></main>
      </div>
    </div>
  );

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

          <div className="upload-heading">Prepare a batch</div>
          <label className="upload-box">
            <span className="upload-icon" aria-hidden="true">↑</span>
            <strong>Upload application JSON files</strong>
            <span>Stage records here before comparison</span>
            <input type="file" accept=".json,application/json" multiple onChange={loadApplicationFiles} disabled={isProcessing} aria-label="Upload application JSON files" />
          </label>
          <div className="pending-files">
            {pendingApplications.length === 0 ? <span>No application records staged</span> : pendingApplications.map((item) => <span className="pending-file" key={item.key}><span>{item.file.name}</span><button type="button" onClick={() => removeApplication(item.key)} aria-label={`Remove ${item.file.name}`}>x</button></span>)}
          </div>
          <label className="upload-box">
            <span className="upload-icon" aria-hidden="true">↑</span>
            <strong>Upload label images</strong>
            <span>Read locally with OCR · max {MAX_BATCH_SIZE}</span>
            <input type="file" accept="image/*" multiple onChange={stageImageFiles} disabled={isProcessing} aria-label="Upload label images" />
          </label>
          <div className="pending-files">
            {pendingImages.length === 0 ? <span>No label images staged</span> : pendingImages.map((file) => <span className="pending-file" key={`${file.name}-${file.lastModified}`}><span>{file.name}</span><button type="button" onClick={() => removeImage(file)} aria-label={`Remove ${file.name}`}>x</button></span>)}
          </div>
          <button className="primary-button compare-button" type="button" onClick={compareStagedFiles} disabled={isProcessing || pendingImages.length === 0}>
            {isProcessing && progress ? `Comparing ${progress.done} of ${progress.total}...` : "Compare uploaded files"}
          </button>
          {(pendingApplications.length > 0 || pendingImages.length > 0) && <button className="reset-button" type="button" onClick={resetWorkspace} disabled={isProcessing}>Reset workspace</button>}

          <div className="fixture-label">Verification cases</div>
          <nav className="case-list">
            {cases.map((item) => {
              const overall = summaries.get(item.id)?.overall ?? "review";
              return (
                <button
                  className={`case-button ${item.id === selected.id ? "active" : ""}`}
                  key={item.id}
                  aria-current={item.id === selected.id ? "true" : undefined}
                  onClick={() => selectCase(item.id)}
                >
                  {decisions[item.id] && <span className={`decision-dot decision-${decisions[item.id]}`} aria-label={`Human decision: ${decisions[item.id]}`} />}
                  <span className={`mini-status mini-${item.pairingStatus === "unmatched" ? "mismatch" : overall}`} aria-hidden="true">{item.pairingStatus === "unmatched" ? "!" : statusIcon(overall)}</span>
                  <span className="visually-hidden">{item.pairingStatus === "unmatched" ? "Unmatched file: " : `${statusLabel(overall)}: `}</span>
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
              {cases.length > 0 && (
                // Disabled mid-batch: terminating the OCR worker strands the jobs still queued
                // on it, so the batch would never finish and the upload box would stay locked.
                <button className="reset-button" type="button" onClick={resetWorkspace} disabled={isProcessing}>Reset workspace</button>
              )}
              <span className={`overall-chip chip-${refused ? "review" : summary.overall}`}>
                <span aria-hidden="true">{refused ? "!" : statusIcon(summary.overall)}</span>{" "}
                {refused ? "Not processed" : statusLabel(summary.overall)}
              </span>
              {decisions[selected.id] && <span className={`decision-chip decision-chip-${decisions[selected.id]}`}>{decisions[selected.id] === "accept" ? "Accepted" : decisions[selected.id] === "reject" ? "Rejected" : "Needs review"}</span>}
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
              <div className="decision-actions" aria-label="Human case decision">
                <button className={`decision-button decision-accept ${decisions[selected.id] === "accept" ? "selected" : ""}`} onClick={() => setDecision("accept")}>Accept</button>
                <button className={`decision-button decision-review ${decisions[selected.id] === "review" ? "selected" : ""}`} onClick={() => setDecision("review")}>Needs review</button>
                <button className={`decision-button decision-reject ${decisions[selected.id] === "reject" ? "selected" : ""}`} onClick={() => setDecision("reject")}>Reject</button>
              </div>
            </aside>
          </div>
          {notice && <div className={`notice notice-${notice.tone}`} role="status">{notice.text}</div>}
        </main>
      </div>
    </div>
  );
}
