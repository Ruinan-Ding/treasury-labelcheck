import { caseDisplayNames, decisionLabel, inputStatusLabel, statusLabel, tierLabel } from "./labels";
import { FIELD_DEFINITIONS, summarizeCase } from "./verification";
import type { HumanDecision, LabelCase } from "../types";

const FIELD_COLUMNS = ["Application", "Label evidence", "Status", "Tier", "Confidence", "Note"];

// Excel evaluates a leading =, +, - or @ when the file is opened, and these cells carry
// filenames and JSON supplied by whoever submitted the label.
export function csvCell(value: string | number): string {
  const text = String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

const percent = (value: number) => `${Math.round(value * 100)}%`;
const yesNo = (value: boolean | undefined) => (value === undefined ? "" : value ? "Yes" : "No");

/** The whole review queue as CSV, one row per case, in the same wording as the screen. */
export function buildReviewCsv(cases: LabelCase[], decisions: Record<string, HumanDecision>): string {
  const names = caseDisplayNames(cases);
  const header = [
    "Case",
    "Case ID",
    "Source file",
    "Application source",
    "Description",
    "Input status",
    "Pairing status",
    "OCR confidence",
    "Recognized text",
    "Label warning prefix all caps",
    "Label warning bold",
    "Overall status",
    "Matches",
    "Mismatches",
    "Needs review",
    "Processing time (ms)",
    "Human decision",
    ...FIELD_DEFINITIONS.flatMap(({ label }) => FIELD_COLUMNS.map((column) => `${label} - ${column}`))
  ];

  const rows = cases.map((item) => {
    const summary = summarizeCase(item);
    // A refused file never reached the comparison rules, so it has no results to report.
    const refused = item.ocrStatus === "rejected";
    const fields = FIELD_DEFINITIONS.flatMap(({ key }) => {
      const result = summary.results.find((candidate) => candidate.key === key);
      return refused || !result
        ? FIELD_COLUMNS.map(() => "")
        : [result.applicationValue ?? "", result.labelValue ?? "", statusLabel(result.status), tierLabel(result.matchTier), percent(result.confidence), result.note];
    });
    return [
      names.get(item.id) ?? item.name,
      item.id,
      item.sourceName ?? item.name,
      item.applicationSource ?? "",
      item.description,
      inputStatusLabel(item.ocrStatus),
      item.pairingStatus === "matched" ? "Matched" : item.pairingStatus === "unmatched" ? "Unmatched" : "Not applicable",
      item.ocrConfidence === undefined ? "" : percent(item.ocrConfidence),
      item.ocrText?.trim() ?? "",
      yesNo(item.label.warningPrefixAllCaps),
      yesNo(item.label.warningBold),
      refused ? "Not processed" : statusLabel(summary.overall),
      refused ? "" : summary.matched,
      refused ? "" : summary.mismatched,
      refused ? "" : summary.needsReview,
      item.processingTimeMs ?? "",
      decisions[item.id] ? decisionLabel(decisions[item.id]) : "",
      ...fields
    ];
  });

  // The byte-order mark makes Excel read the file as UTF-8 rather than the Windows
  // codepage, so curly apostrophes and accented brand names survive.
  const bom = String.fromCharCode(0xfeff);
  return bom + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
