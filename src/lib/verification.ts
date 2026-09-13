import { STANDARD_WARNING } from "../data/fixtures";
import type {
  FieldKey,
  FieldResult,
  MatchTier,
  LabelFields,
  VerificationStatus,
  VerificationSummary
} from "../types";

export const FIELD_DEFINITIONS: Array<{ key: FieldKey; label: string }> = [
  { key: "brandName", label: "Brand name" },
  { key: "classType", label: "Class / type" },
  { key: "alcoholContent", label: "Alcohol content" },
  { key: "netContents", label: "Net contents" },
  { key: "bottlerProducer", label: "Bottler / producer" },
  { key: "countryOfOrigin", label: "Country of origin" },
  { key: "governmentWarning", label: "Government warning" }
];

export interface WarningValidation {
  valid: boolean;
  exactText: boolean;
  prefixAllCaps: boolean;
  bold: boolean;
  prefixKnown: boolean;
  boldKnown: boolean;
  reasons: string[];
}

// Confidence reports how certain a rule is about the verdict it just returned,
// so an exact string verify always outranks one that needed normalization to get
// there. It is a rule-based UI signal, not a calibrated model probability.
export const CONFIDENCE = {
  exact: 0.99,
  normalized: 0.9,
  mismatch: 0.95,
  review: 0.35
} as const;

// Decompose first so an accent is dropped from its base letter instead of the
// whole character being erased: MÖET and MÄET must not normalize alike.
export function normalizeBrandName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/['’]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeComparable(value: string): string {
  return collapseWhitespace(value.normalize("NFKC")).toLowerCase();
}

function normalizeAlcoholContent(value: string): string {
  return normalizeComparable(value)
    .replace(/(?:alc(?:ohol)?\.?\s*\/\s*vol(?:ume)?\.?|alc(?:ohol)?\.?\s+vol(?:ume)?\.?)/g, "abv")
    .replace(/%\s*by\s*(?:volume|vol\.?)/g, "% abv")
    .replace(/\bvol(?:ume)?\.?\b/g, "abv")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

// Exported so the OCR extractor recognises a net-contents declaration with exactly the
// units the comparison rules can later convert, instead of keeping a second list.
export const NET_CONTENTS_PATTERN =
  /(\d+(?:[.,]\d+)?)\s*(milliliters?|millilitres?|ml|centiliters?|centilitres?|cl|liters?|litres?|l|fl\.?\s*oz\.?|fluid ounces?)\b/;

function normalizeNetContents(value: string): number | null {
  // "1,500 mL" is 1500, not 1.5 - only strip a comma that groups thousands.
  const normalized = value.normalize("NFKC").toLowerCase().replace(/(\d),(?=\d{3}\b)/g, "$1");
  const match = normalized.match(NET_CONTENTS_PATTERN);
  if (!match) return null;

  const amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount)) return null;

  // Unit is read next to the matched number, so "750 mL (25.4 FL OZ)" is 750 mL.
  const unit = match[2].replace(/[.\s]/g, "");
  if (unit.startsWith("ml") || unit.startsWith("milli")) return amount;
  if (unit.startsWith("cl") || unit.startsWith("centi")) return amount * 10;
  if (unit.startsWith("fl") || unit.startsWith("fluid")) return amount * 29.5735;
  return amount * 1000;
}

export function validateGovernmentWarning(fields: LabelFields): WarningValidation {
  // Exact on wording, capitalization, and punctuation - Jenny rejects title case -
  // but tolerant of how the source happened to wrap its whitespace.
  const exactText =
    fields.governmentWarning !== null &&
    collapseWhitespace(fields.governmentWarning) === collapseWhitespace(STANDARD_WARNING);
  const prefixKnown = typeof fields.warningPrefixAllCaps === "boolean";
  const boldKnown = typeof fields.warningBold === "boolean";
  const prefixAllCaps = fields.warningPrefixAllCaps === true;
  const bold = fields.warningBold === true;
  const reasons: string[] = [];

  if (!exactText) reasons.push("Warning text does not exactly match the required statement.");
  if (prefixKnown && !prefixAllCaps) reasons.push("The required `GOVERNMENT WARNING:` prefix is not all caps.");
  if (!prefixKnown) reasons.push("Prefix capitalization was not provided by the input.");
  if (boldKnown && !bold) reasons.push("The required warning prefix is not marked bold.");
  if (!boldKnown) reasons.push("Warning bold presentation was not provided by the input.");

  return { valid: exactText && prefixAllCaps && bold, exactText, prefixAllCaps, bold, prefixKnown, boldKnown, reasons };
}

function resultForText(
  key: FieldKey,
  label: string,
  applicationValue: string | null,
  labelValue: string | null,
  confidence: number,
  note: string,
  status: VerificationStatus,
  matchTier: MatchTier
): FieldResult {
  return { key, label, applicationValue, labelValue, confidence, note, status, matchTier };
}

function percentOf(value: string | null): number | null {
  const match = value?.match(/(\d+(?:[.,]\d+)?)\s*%/);
  return match ? Number(match[1].replace(",", ".")) : null;
}

// Recognised text cannot tell a misread from a misprint: "bith" for "birth", a stray
// line picked up as the brand. Only differences a misread cannot plausibly produce stay
// a mismatch - two cleanly read numbers that disagree, or a warning prefix set mostly in
// lowercase. Everything else is held for an agent to check against the artwork.
// ponytail: a misread digit still reports Mismatch; gate on per-word OCR confidence if that shows up.
function mismatchSurvivesOcr(result: FieldResult, label: LabelFields): boolean {
  switch (result.key) {
    case "governmentWarning":
      return label.warningPrefixAllCaps === false;
    case "alcoholContent": {
      const expected = percentOf(result.applicationValue);
      const read = percentOf(result.labelValue);
      return expected !== null && read !== null && expected !== read;
    }
    case "netContents":
      return (
        normalizeNetContents(result.applicationValue ?? "") !== null &&
        normalizeNetContents(result.labelValue ?? "") !== null
      );
    default:
      return false;
  }
}

export function compareFields(
  application: LabelFields,
  label: LabelFields,
  options: { ocr?: boolean } = {}
): VerificationSummary {
  const compared = FIELD_DEFINITIONS.map(({ key, label: fieldLabel }) => {
    const applicationValue = application[key];
    const labelValue = label[key];

    const applicationMissing = applicationValue === null || applicationValue.trim() === "";
    const labelMissing = labelValue === null || labelValue.trim() === "";

    // Resolved before the generic missing-value guard. The warning statement is fixed by
    // 27 CFR 16.21 rather than by the application, so a label that carries one can still
    // be checked when no application record was uploaded beside it - the normal case for
    // a label image read by OCR on its own.
    if (key === "governmentWarning" && !labelMissing) {
      const statuteOnly = applicationMissing;
      const statuteNote = statuteOnly
        ? " Checked against the statute alone; no application record was uploaded with this label."
        : "";
      const validation = validateGovernmentWarning(label);

      if (validation.valid) {
        // The statute governs the label, but the two panels are shown side by side, so a
        // divergent application value has to be surfaced rather than reported as a match.
        if (!statuteOnly && collapseWhitespace(applicationValue as string) !== collapseWhitespace(labelValue as string)) {
          return resultForText(
            key,
            fieldLabel,
            applicationValue,
            labelValue,
            CONFIDENCE.review,
            "The label carries the required statement, but the application records different warning text. Human review is required.",
            "review",
            "review"
          );
        }
        return resultForText(
          key,
          fieldLabel,
          applicationValue,
          labelValue,
          CONFIDENCE.exact,
          `Required wording, all-caps prefix, and bold presentation verified.${statuteNote}`,
          "match",
          "exact"
        );
      }

      // Wrong wording is a decision the rule can make on its own; missing presentation
      // metadata is not, so only the latter is downgraded to review.
      const presentationRejected =
        (validation.prefixKnown && !validation.prefixAllCaps) || (validation.boldKnown && !validation.bold);
      if (validation.exactText && !presentationRejected) {
        return resultForText(
          key,
          fieldLabel,
          applicationValue,
          labelValue,
          CONFIDENCE.review,
          `${validation.reasons.join(" ")}${statuteNote}`,
          "review",
          "review"
        );
      }
      return resultForText(
        key,
        fieldLabel,
        applicationValue,
        labelValue,
        CONFIDENCE.mismatch,
        `${validation.reasons.join(" ")}${statuteNote}`,
        "mismatch",
        "mismatch"
      );
    }

    if (applicationMissing || labelMissing) {
      return resultForText(
        key,
        fieldLabel,
        applicationValue,
        labelValue,
        CONFIDENCE.review,
        applicationMissing && labelMissing
          ? "Neither the application nor the label supplied this value. Human review is required."
          : applicationMissing
            ? "The application did not supply this value, so there is nothing to compare the label against. Human review is required."
            : "The label value is missing or unreadable. Human review is required.",
        "review",
        "review"
      );
    }

    if (key === "brandName") {
      const exact = applicationValue === labelValue;
      const matches = exact || normalizeBrandName(applicationValue) === normalizeBrandName(labelValue);
      return resultForText(
        key,
        fieldLabel,
        applicationValue,
        labelValue,
        matches ? (exact ? CONFIDENCE.exact : CONFIDENCE.normalized) : CONFIDENCE.mismatch,
        matches
          ? exact
            ? "Brand name matches the application exactly."
            : "Matches after harmless capitalization and punctuation normalization."
          : "Brand names do not normalize to the same value.",
        matches ? "match" : "mismatch",
        matches ? (exact ? "exact" : "normalized") : "mismatch"
      );
    }

    const normalizedApplication = key === "alcoholContent"
      ? normalizeAlcoholContent(applicationValue)
      : normalizeComparable(applicationValue);
    const normalizedLabel = key === "alcoholContent"
      ? normalizeAlcoholContent(labelValue)
      : normalizeComparable(labelValue);
    const applicationVolume = key === "netContents" ? normalizeNetContents(applicationValue) : null;
    const labelVolume = key === "netContents" ? normalizeNetContents(labelValue) : null;
    const matches = key === "netContents" && applicationVolume !== null && labelVolume !== null
      ? Math.abs(applicationVolume - labelVolume) < 1
      : normalizedApplication === normalizedLabel;
    const exact = applicationValue === labelValue;
    return resultForText(
      key,
      fieldLabel,
      applicationValue,
      labelValue,
      matches ? (exact ? CONFIDENCE.exact : CONFIDENCE.normalized) : CONFIDENCE.mismatch,
      matches
        ? exact
          ? "Matches the application exactly."
          : key === "alcoholContent"
            ? "Alcohol notation matches after normalizing common ABV labels."
            : key === "netContents"
              ? "Volume matches after converting equivalent units to milliliters."
              : "Values match after whitespace and capitalization normalization."
        : "Values differ and should be resolved by an agent.",
      matches ? "match" : "mismatch",
      matches ? (exact ? "exact" : "normalized") : "mismatch"
    );
  });

  const results = compared.map((result): FieldResult =>
    options.ocr && result.status === "mismatch" && !mismatchSurvivesOcr(result, label)
      ? {
          ...result,
          status: "review",
          matchTier: "review",
          confidence: CONFIDENCE.review,
          note: `${result.note} The label was read by OCR, which can misread characters, so an agent should confirm this against the artwork.`
        }
      : result
  );

  const matched = results.filter((result) => result.status === "match").length;
  const mismatched = results.filter((result) => result.status === "mismatch").length;
  const needsReview = results.filter((result) => result.status === "review").length;
  const overall: VerificationStatus = needsReview > 0 ? "review" : mismatched > 0 ? "mismatch" : "match";
  return { results, overall, matched, mismatched, needsReview };
}
