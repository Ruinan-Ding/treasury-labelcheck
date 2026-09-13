import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_CONCURRENCY, MAX_BATCH_SIZE, processBatch } from "./lib/batch";
import {
  makeApplicationOnlyCase,
  makeOcrCase,
  makeStubCase,
  MAX_UPLOAD_BYTES,
  pairingKey,
  parseApplicationRecord,
  parseStructuredCase
} from "./lib/cases";
import { buildReviewCsv } from "./lib/csv";
import { extractLabelFields } from "./lib/extract";
import { caseDisplayNames, decisionLabel, inputStatusLabel, plural, statusLabel, tierLabel } from "./lib/labels";
import { recognizeLabel, terminateOcr } from "./lib/ocr";
import { FIELD_DEFINITIONS, summarizeCase } from "./lib/verification";
import { clearWorkspace, loadWorkspace, saveWorkspace } from "./lib/workspace-store";
import type { FieldResult, HumanDecision, LabelCase, LabelFields, VerificationStatus } from "./types";

interface Notice {
  tone: "info" | "warn";
  text: string;
}

interface PendingApplication {
  id: number;
  file: File;
  fields: LabelFields;
  key: string;
}

// Saved as two records so selecting a case or recording a decision does not rewrite
// every stored image.
interface SavedQueue {
  version: number;
  cases: LabelCase[];
  pendingApplications: PendingApplication[];
  pendingImages: File[];
}

interface SavedView {
  version: number;
  selectedId: string | null;
  decisions: Record<string, HumanDecision>;
  notice: Notice | null;
}

// The committed files under public/samples/. The unpaired ones exercise the `↔` paths.
const SAMPLE_PAIRS = [
  "old-tom", "stones-throw", "harbor-mist", "abv-mismatch", "volume-mismatch", "warning-titlecase",
  "warning-punctuation", "missing-warning", "brand-difference", "normalized-units", "fluid-ounce-volume",
  "import-origin", "missing-fields", "low-contrast-review", "unreadable-review"
];
const SAMPLE_JSON = [...SAMPLE_PAIRS, "application-only-a", "application-only-b"].map((name) => `${name}.json`);
const SAMPLE_IMAGES = [...SAMPLE_PAIRS, "label-only-a", "label-only-b"].map((name) => `${name}.png`);

let stagedApplicationSequence = 0;

function statusIcon(status: VerificationStatus): string {
  return status === "match" ? "✓" : status === "mismatch" ? "!" : "?";
}

// Clearing the input lets the same file be chosen again after it is removed.
function takeFiles(event: ChangeEvent<HTMLInputElement>): File[] {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  return files;
}

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

function ResultCard({ result }: { result: FieldResult }) {
  return (
    <article className={`result-card result-${result.status}`}>
      <div className="result-heading">
        <span className="status-mark" aria-hidden="true">{statusIcon(result.status)}</span>
        <div>
          <h3>{result.label}</h3>
          <p>
            {statusLabel(result.status)} · {tierLabel(result.matchTier)}{" "}
            <span className="confidence">{Math.round(result.confidence * 100)}% confidence</span>
          </p>
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
  const [decisions, setDecisions] = useState<Record<string, HumanDecision>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingApplications, setPendingApplications] = useState<PendingApplication[]>([]);
  const [pendingImages, setPendingImages] = useState<File[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [storage, setStorage] = useState<"loading" | "ready" | "unavailable">("loading");
  const [loadingSamples, setLoadingSamples] = useState(false);
  // A ref as well as state: two clicks can land before React re-renders the button.
  const samplesInFlight = useRef(false);
  const isProcessing = progress !== null;

  useEffect(() => {
    Promise.all([loadWorkspace<SavedQueue>("queue"), loadWorkspace<SavedView>("view")])
      .then(([queue, view]) => {
        if (queue) {
          // Object URLs die with the page, so previews are recreated from the stored files.
          setCases(queue.cases.map((item) => (item.imageFile ? { ...item, imageUrl: URL.createObjectURL(item.imageFile) } : item)));
          setPendingApplications(queue.pendingApplications);
          setPendingImages(queue.pendingImages);
          stagedApplicationSequence = Math.max(stagedApplicationSequence, ...queue.pendingApplications.map((item) => item.id));
        }
        if (view) {
          setSelectedId(view.selectedId);
          setDecisions(view.decisions);
          setNotice(view.notice);
        }
        setStorage("ready");
      })
      .catch(() => {
        setStorage("unavailable");
        setNotice({ tone: "warn", text: "This browser is not allowing local storage, so refreshing the page will clear the workspace." });
      });
  }, []);

  // If agents work in several tabs at once, the last tab to save wins.
  useEffect(() => {
    if (storage !== "ready") return;
    saveWorkspace("queue", { cases, pendingApplications, pendingImages }).catch(() =>
      setNotice({ tone: "warn", text: "The workspace could not be saved in this browser, so refreshing the page may lose recent work." })
    );
  }, [storage, cases, pendingApplications, pendingImages]);

  useEffect(() => {
    if (storage === "ready") saveWorkspace("view", { selectedId, decisions, notice }).catch(() => undefined);
  }, [storage, selectedId, decisions, notice]);

  const displayNames = useMemo(() => caseDisplayNames(cases), [cases]);
  const summaries = useMemo(() => new Map(cases.map((item) => [item.id, summarizeCase(item)])), [cases]);
  const selected = cases.find((item) => item.id === selectedId) ?? cases[0];
  const summary = selected && summaries.get(selected.id);
  const hasStagedFiles = pendingApplications.length > 0 || pendingImages.length > 0;

  async function stageApplicationFiles(selectedFiles: File[]) {
    const files = selectedFiles.slice(0, Math.max(0, MAX_BATCH_SIZE - pendingApplications.length));
    const omitted = selectedFiles.length - files.length;
    const records: PendingApplication[] = [];
    const structured: LabelCase[] = [];
    const invalid: string[] = [];
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        invalid.push(`${file.name} exceeds 10 MB`);
        continue;
      }
      try {
        const value: unknown = JSON.parse(await file.text());
        const record = parseApplicationRecord(value);
        const structuredCase = record ? null : parseStructuredCase(value, file.name);
        if (record) records.push({ id: ++stagedApplicationSequence, file, fields: record, key: pairingKey(file.name) });
        else if (structuredCase) structured.push(structuredCase);
        else invalid.push(`${file.name} is not an application record or complete structured case`);
      } catch {
        invalid.push(`${file.name} could not be parsed`);
      }
    }
    if (structured.length > 0) {
      setCases((current) => [...structured, ...current]);
      setSelectedId(structured[0].id);
    }
    setPendingApplications((current) => [...current, ...records].slice(0, MAX_BATCH_SIZE));
    setNotice({
      tone: invalid.length > 0 || omitted > 0 ? "warn" : "info",
      text: [
        `${plural(records.length, "application record")} staged for comparison.`,
        structured.length > 0 && `${plural(structured.length, "complete structured case")} loaded.`,
        invalid.length > 0 && `${invalid.join("; ")}.`,
        omitted > 0 && `${plural(omitted, "file")} omitted because the ${MAX_BATCH_SIZE}-file staging limit was reached.`
      ].filter(Boolean).join(" ")
    });
  }

  function stageImageFiles(selectedFiles: File[]) {
    const images = selectedFiles.filter((file) => file.type.startsWith("image/"));
    const unsupported = selectedFiles.filter((file) => !file.type.startsWith("image/")).map((file) => file.name);
    const staged = images.slice(0, Math.max(0, MAX_BATCH_SIZE - pendingImages.length));
    const omitted = images.length - staged.length;
    setPendingImages((current) => [...current, ...staged].slice(0, MAX_BATCH_SIZE));
    setNotice({
      tone: unsupported.length > 0 || omitted > 0 ? "warn" : "info",
      text: [
        `${plural(staged.length, "image")} staged for comparison.`,
        unsupported.length > 0 && `Unsupported files ignored: ${unsupported.join(", ")}.`,
        omitted > 0 && `${plural(omitted, "image")} omitted because the ${MAX_BATCH_SIZE}-file staging limit was reached.`
      ].filter(Boolean).join(" ")
    });
  }

  // Stages the committed samples through the same path as a manual upload, so a reviewer
  // can try the deployed app without downloading anything. It is only offered while
  // nothing is staged, so the samples cannot hit the staging limit or hide an upload warning.
  async function stageSampleBatch() {
    if (samplesInFlight.current) return;
    samplesInFlight.current = true;
    setLoadingSamples(true);
    const fetchSample = async (name: string, type: string) => {
      const response = await fetch(`${import.meta.env.BASE_URL}samples/${name}`);
      if (!response.ok) throw new Error(`${name} returned ${response.status}`);
      return new File([await response.blob()], name, { type });
    };
    try {
      const [records, images] = await Promise.all([
        Promise.all(SAMPLE_JSON.map((name) => fetchSample(name, "application/json"))),
        Promise.all(SAMPLE_IMAGES.map((name) => fetchSample(name, "image/png")))
      ]);
      await stageApplicationFiles(records);
      stageImageFiles(images);
      setNotice({ tone: "info", text: `${records.length} sample application records and ${images.length} label images are staged, including two of each with no partner. Click Compare uploaded files to check them.` });
    } catch {
      setNotice({ tone: "warn", text: "The sample batch could not be loaded. Files can still be uploaded from the two boxes on the left." });
    } finally {
      samplesInFlight.current = false;
      setLoadingSamples(false);
    }
  }

  async function compareStagedFiles() {
    if (!hasStagedFiles) return;
    setNotice(null);
    setProgress({ done: 0, total: pendingImages.length });
    try {
      // Records are matched to images by filename; duplicates pair in upload order.
      const recordsByKey = new Map<string, PendingApplication[]>();
      for (const record of pendingApplications) {
        recordsByKey.set(record.key, [...(recordsByKey.get(record.key) ?? []), record]);
      }
      const paired = new Set<number>();
      let done = 0;

      // Recognition queues on the single OCR worker, but decoding the next images overlaps
      // it: 17 samples take 13 s this way against 30 s one at a time. Each label's reported
      // time therefore includes its wait in that queue.
      const read = await processBatch(pendingImages, async (file) => {
        const startedAt = performance.now();
        const record = recordsByKey.get(pairingKey(file.name))?.shift();
        if (record) paired.add(record.id);
        try {
          if (file.size > MAX_UPLOAD_BYTES) {
            return timed(makeStubCase(file, "rejected", "File exceeds the 10 MB limit.", record?.fields, record?.file.name), startedAt);
          }
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
          return timed(makeStubCase(file, "unreadable", "This image could not be read. Human review is required.", record?.fields, record?.file.name), startedAt);
        } finally {
          done += 1;
          setProgress({ done, total: pendingImages.length });
        }
      }, DEFAULT_CONCURRENCY);

      const orphanCases = pendingApplications
        .filter((record) => !paired.has(record.id))
        .map((record) => makeApplicationOnlyCase(record.file, record.fields));
      const unmatchedImages = read.filter((item) => !item.applicationSource).length;
      const warnings = [
        orphanCases.length > 0 && `${plural(orphanCases.length, "application record")} had no matching image and ${orphanCases.length === 1 ? "was" : "were"} added for review.`,
        unmatchedImages > 0 && `${plural(unmatchedImages, "image")} had no matching application record, so only the statutory warning could be checked.`
      ].filter(Boolean);

      const added = [...read, ...orphanCases];
      setCases((current) => [...added, ...current]);
      if (added[0]) setSelectedId(added[0].id);
      setNotice({
        tone: warnings.length > 0 ? "warn" : "info",
        text: [`${plural(read.length, "label")} compared, ${plural(paired.size, "pair")} matched by filename.`, ...warnings].join(" ")
      });
      setPendingApplications([]);
      setPendingImages([]);
    } finally {
      setProgress(null);
    }
  }

  function selectCase(id: string) {
    setSelectedId(id);
    setNotice(null);
  }

  function resetWorkspace() {
    // Revoked here rather than inside a state updater, which React requires to be pure.
    cases.forEach((item) => {
      if (item.imageUrl?.startsWith("blob:")) URL.revokeObjectURL(item.imageUrl);
    });
    setCases([]);
    setSelectedId(null);
    setDecisions({});
    setPendingApplications([]);
    setPendingImages([]);
    setNotice({ tone: "info", text: "Workspace reset." });
    clearWorkspace().catch(() =>
      setNotice({ tone: "warn", text: "The workspace was cleared from the screen, but the browser could not clear its saved copy." })
    );
    // Hands back the ~3 MB language model and WASM core the OCR worker holds.
    void terminateOcr();
  }

  function recordDecision(decision: HumanDecision) {
    if (!selected) return;
    setDecisions((current) => ({ ...current, [selected.id]: decision }));
    const label = decision === "review" ? "Marked as needing review" : decisionLabel(decision);
    setNotice({ tone: "info", text: `${label}. You can change this decision at any time.` });
  }

  function exportQueue() {
    const url = URL.createObjectURL(new Blob([buildReviewCsv(cases, decisions)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "labelcheck-review-queue.csv";
    link.click();
    // Revoked later: some browsers start the download after click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setNotice({ tone: "info", text: "Review queue exported locally. No files or results were sent anywhere." });
  }

  // Rendering before the saved workspace is read would flash the empty state on refresh.
  if (storage === "loading") return null;

  const noticeBanner = notice && <div className={`notice notice-${notice.tone}`} role="status">{notice.text}</div>;
  const resetButton = (
    // Disabled mid-batch: terminating the OCR worker would strand the jobs queued on it.
    <button className="reset-button" type="button" onClick={resetWorkspace} disabled={isProcessing}>Reset workspace</button>
  );
  // A refused file never reached the comparison rules; seven "Not available" rows would
  // imply a review that never happened.
  const refused = selected?.ocrStatus === "rejected";

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
          <span className="local-pill"><span className="online-dot" /> Browser-only processing</span>
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
            <input type="file" accept=".json,application/json" multiple onChange={(event) => void stageApplicationFiles(takeFiles(event))} disabled={isProcessing} aria-label="Upload application JSON files" />
          </label>
          <div className="pending-files">
            {pendingApplications.length === 0 ? <span>No application records staged</span> : pendingApplications.map((record) => (
              <span className="pending-file" key={record.id}>
                <span>{record.file.name}</span>
                <button type="button" onClick={() => setPendingApplications((current) => current.filter((item) => item.id !== record.id))} aria-label={`Remove ${record.file.name}`}>x</button>
              </span>
            ))}
          </div>
          <label className="upload-box">
            <span className="upload-icon" aria-hidden="true">↑</span>
            <strong>Upload label images</strong>
            <span>Read locally with OCR · max {MAX_BATCH_SIZE}</span>
            <input type="file" accept="image/*" multiple onChange={(event) => stageImageFiles(takeFiles(event))} disabled={isProcessing} aria-label="Upload label images" />
          </label>
          <div className="pending-files">
            {pendingImages.length === 0 ? <span>No label images staged</span> : pendingImages.map((file, index) => (
              <span className="pending-file" key={`${file.name}-${file.lastModified}-${index}`}>
                <span>{file.name}</span>
                <button type="button" onClick={() => setPendingImages((current) => current.filter((item) => item !== file))} aria-label={`Remove ${file.name}`}>x</button>
              </span>
            ))}
          </div>
          <button className="primary-button compare-button" type="button" onClick={compareStagedFiles} disabled={isProcessing || !hasStagedFiles}>
            {progress ? `Comparing ${progress.done} of ${progress.total}...` : "Compare uploaded files"}
          </button>
          {hasStagedFiles && resetButton}

          {cases.length > 0 && (
            <>
              <div className="queue-label">Verification cases</div>
              <nav className="case-list" aria-label="Verification cases">
                {cases.map((item) => {
                  const overall = summaries.get(item.id)?.overall ?? "review";
                  const unmatched = item.pairingStatus === "unmatched";
                  const decision = decisions[item.id];
                  return (
                    <button
                      className={`case-button ${item.id === selected?.id ? "active" : ""}`}
                      key={item.id}
                      type="button"
                      aria-current={item.id === selected?.id ? "true" : undefined}
                      onClick={() => selectCase(item.id)}
                    >
                      {decision && <span className={`decision-dot decision-${decision}`} aria-label={`Human decision: ${decisionLabel(decision)}`} />}
                      <span className={`mini-status mini-${unmatched ? "unmatched" : overall}`} aria-hidden="true">{unmatched ? "↔" : statusIcon(overall)}</span>
                      <span className="visually-hidden">{unmatched ? "Unmatched pairing: " : `${statusLabel(overall)}: `}</span>
                      <span className="case-button-text">
                        <strong>{displayNames.get(item.id) ?? item.name}</strong>
                        <small>{item.sourceName && item.sourceName !== item.name ? item.sourceName : item.description}</small>
                      </span>
                      <span className="chevron" aria-hidden="true">›</span>
                    </button>
                  );
                })}
              </nav>
            </>
          )}

          <div className="sidebar-footnote">
            <strong>Bounded batch processing</strong>
            <span>Up to {MAX_BATCH_SIZE} items, read on this device by one reused OCR worker.</span>
          </div>
        </aside>

        {!selected || !summary ? (
          <main className="content empty-state">
            <div className="empty-card">
              {noticeBanner}
              <p className="eyebrow">Ready for review</p>
              <h2>Start with a real batch</h2>
              <p>Stage application JSON files and label images in the two upload boxes, then compare them. Nothing is preloaded.</p>
              {!hasStagedFiles && (
                <>
                  <p>First time here? Stage the sample batch of {SAMPLE_IMAGES.length} labels, then click <strong>Compare uploaded files</strong>.</p>
                  <button className="primary-button" type="button" onClick={stageSampleBatch} disabled={isProcessing || loadingSamples}>
                    {loadingSamples ? "Staging samples..." : "Stage sample batch"}
                  </button>
                </>
              )}
            </div>
          </main>
        ) : (
          <main className="content">
            {noticeBanner}
            <section className="page-heading">
              <div>
                <p className="eyebrow">Case review</p>
                <h2>{displayNames.get(selected.id) ?? selected.name}</h2>
                <p className="subheading">{selected.description}</p>
              </div>
              <div className="heading-actions">
                <button className="secondary-button" type="button" onClick={exportQueue}>Export CSV</button>
                {resetButton}
                <span className={`overall-chip chip-${refused ? "review" : summary.overall}`}>
                  <span aria-hidden="true">{refused ? "!" : statusIcon(summary.overall)}</span>{" "}
                  {refused ? "Not processed" : statusLabel(summary.overall)}
                </span>
                {decisions[selected.id] && (
                  <span className={`decision-chip decision-chip-${decisions[selected.id]}`}>{decisionLabel(decisions[selected.id])}</span>
                )}
              </div>
            </section>

            <section className="overview-grid">
              <div className="stat-card"><span className="stat-number stat-green">{refused ? "-" : summary.matched}</span><span>Matches</span></div>
              <div className="stat-card"><span className="stat-number stat-red">{refused ? "-" : summary.mismatched}</span><span>Mismatches</span></div>
              <div className="stat-card"><span className="stat-number stat-amber">{refused ? "-" : summary.needsReview}</span><span>Needs review</span></div>
              <div className="stat-card stat-context">
                <span className="stat-context-label">Input status</span>
                <strong>{inputStatusLabel(selected.ocrStatus)}</strong>
                <span>{evidenceDetail(selected)}</span>
              </div>
            </section>

            <div className="workspace-grid">
              <section className="results-section">
                <div className="section-heading">
                  <div>
                    <h2>Field comparison</h2>
                    <p>Automated checks are suggestions for a compliance agent.</p>
                  </div>
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
                  <div>
                    <h2>Label evidence</h2>
                    <p>{selected.imageUrl ? "Uploaded image preview" : selected.ocrStatus === "structured" ? "Structured input preview" : "No preview available"}</p>
                  </div>
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
                    <span>{selected.ocrStatus === "structured" ? "Compared locally without OCR" : selected.description}</span>
                  </div>
                )}
                {selected.ocrText !== undefined && (
                  <details className="ocr-text">
                    <summary>Show recognised text</summary>
                    <pre>{selected.ocrText.trim() || "No text was recognised in this image."}</pre>
                  </details>
                )}
                <div className="evidence-note">
                  <span className="info-icon" aria-hidden="true">i</span>
                  <p>Unreadable, low-confidence, or presentation-sensitive fields remain <strong>Review</strong> so an agent can decide.</p>
                </div>
                <div className="decision-actions" role="group" aria-label="Human case decision">
                  {(["accept", "review", "reject"] as const).map((decision) => (
                    <button
                      key={decision}
                      type="button"
                      className={`decision-button decision-${decision} ${decisions[selected.id] === decision ? "selected" : ""}`}
                      aria-pressed={decisions[selected.id] === decision}
                      onClick={() => recordDecision(decision)}
                    >
                      {decision === "accept" ? "Accept" : decision === "reject" ? "Reject" : "Needs review"}
                    </button>
                  ))}
                </div>
              </aside>
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
