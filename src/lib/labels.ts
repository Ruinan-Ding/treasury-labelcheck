import type { HumanDecision, LabelCase, MatchTier, OcrStatus, VerificationStatus } from "../types";

// Display wording shared by the review screen and the CSV export, so both say the same thing.

export const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function statusLabel(status: VerificationStatus): string {
  return status === "match" ? "Match" : status === "mismatch" ? "Mismatch" : "Review";
}

export function tierLabel(tier: MatchTier): string {
  return tier === "exact" ? "Exact" : tier === "normalized" ? "Normalized match" : tier === "mismatch" ? "Mismatch" : "Needs review";
}

export function decisionLabel(decision: HumanDecision): string {
  return decision === "accept" ? "Accepted" : decision === "reject" ? "Rejected" : "Needs review";
}

export function inputStatusLabel(status: OcrStatus): string {
  switch (status) {
    case "structured":
      return "Structured record";
    case "ocr":
      return "Label read by OCR";
    case "rejected":
      return "File rejected";
    case "no-image":
      return "No label image";
    case "unreadable":
      return "Unreadable input";
  }
}

/**
 * Names each case after its file. A paired case drops the extension; an unpaired file keeps
 * it so the missing partner is visible. Repeated names get "(2)", "(3)", and so on.
 */
export function caseDisplayNames(cases: LabelCase[]): Map<string, string> {
  const seen = new Map<string, number>();
  return new Map(
    cases.map((item) => {
      const base = item.pairingStatus === "unmatched" ? item.name : item.name.replace(/\.[^.]+$/, "");
      const occurrence = (seen.get(base) ?? 0) + 1;
      seen.set(base, occurrence);
      return [item.id, occurrence === 1 ? base : `${base} (${occurrence})`];
    })
  );
}
