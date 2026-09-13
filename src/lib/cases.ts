import { FIELD_DEFINITIONS } from "./verification";
import type { LabelCase, LabelFields, OcrStatus } from "../types";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const emptyLabel: LabelFields = {
  brandName: null,
  classType: null,
  alcoholContent: null,
  netContents: null,
  bottlerProducer: null,
  countryOfOrigin: null,
  governmentWarning: null
};

// Ids are always minted here: one taken from an uploaded JSON could collide with a second
// upload of the same file. The counter keeps ids minted in the same millisecond apart,
// and the timestamp keeps them apart from ids restored from a saved workspace.
let caseSequence = 0;
export function nextCaseId(prefix: string): string {
  caseSequence += 1;
  return `${prefix}-${Date.now()}-${caseSequence}`;
}

function asFieldValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

// Uploaded JSON is untrusted. Without this, a non-string field reaches compareFields
// and throws during render.
export function toLabelFields(value: unknown): LabelFields {
  const raw = (value || {}) as Record<string, unknown>;
  const fields: LabelFields = { ...emptyLabel };
  for (const { key } of FIELD_DEFINITIONS) {
    fields[key] = asFieldValue(raw[key]);
  }
  if (typeof raw.warningPrefixAllCaps === "boolean") fields.warningPrefixAllCaps = raw.warningPrefixAllCaps;
  if (typeof raw.warningBold === "boolean") fields.warningBold = raw.warningBold;
  return fields;
}

export function parseStructuredCase(value: unknown, sourceName: string): LabelCase | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (!candidate.application || !candidate.label) return null;
  return {
    id: nextCaseId("upload"),
    name: typeof candidate.name === "string" ? candidate.name : sourceName,
    description: typeof candidate.description === "string" ? candidate.description : "Uploaded structured case.",
    application: toLabelFields(candidate.application),
    label: toLabelFields(candidate.label),
    ocrStatus: "structured",
    sourceName
  };
}

/**
 * Key used to pair a label image with its application record.
 *
 * A peak-season batch arrives as a folder of artwork plus the matching records, so
 * `old-tom.jpg` is compared against `old-tom.json`. Matching on the name the submitter
 * already uses avoids inventing an upload order or a manifest format for a prototype.
 */
export function pairingKey(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").trim().toLowerCase();
}

/**
 * Reads a JSON file that carries only an `application` object. Such a file is not a case
 * on its own - it is the record an uploaded label image gets compared against.
 */
export function parseApplicationRecord(value: unknown): LabelFields | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (!candidate.application || candidate.label) return null;
  return toLabelFields(candidate.application);
}

export interface OcrCaseInput {
  file: File;
  imageUrl: string;
  text: string;
  confidence: number;
  label: LabelFields;
  application: LabelFields | null;
  applicationSource?: string;
}

export function makeOcrCase(input: OcrCaseInput): LabelCase {
  const readAnything = FIELD_DEFINITIONS.some(({ key }) => input.label[key] !== null);
  const description = !readAnything
    ? "No label text could be recognised in this image. Human review is required."
    : input.applicationSource
      ? `Label read locally by OCR and compared with the application record in ${input.applicationSource}.`
      : "Label read locally by OCR. No application record was uploaded with it, so only the statutory warning could be checked.";

  return {
    id: nextCaseId("ocr"),
    name: input.file.name,
    description,
    application: input.application ?? emptyLabel,
    label: input.label,
    imageUrl: input.imageUrl,
    imageFile: input.file,
    ocrStatus: readAnything ? "ocr" : "unreadable",
    sourceName: input.file.name,
    ocrConfidence: input.confidence,
    ocrText: input.text,
    applicationSource: input.applicationSource,
    pairingStatus: input.applicationSource ? "matched" : "unmatched"
  };
}

export function makeApplicationOnlyCase(file: File, application: LabelFields): LabelCase {
  return {
    id: nextCaseId("application"),
    name: file.name,
    description: "Application record parsed, but no matching label image was uploaded. Human review is required.",
    application,
    label: emptyLabel,
    // The record was read fine; there was just no artwork to read it against.
    ocrStatus: "no-image",
    sourceName: file.name,
    pairingStatus: "unmatched"
  };
}

export function makeStubCase(
  file: File,
  ocrStatus: OcrStatus,
  description: string,
  application: LabelFields = emptyLabel,
  applicationSource?: string
): LabelCase {
  return {
    id: nextCaseId(ocrStatus),
    name: file.name,
    description,
    application,
    label: emptyLabel,
    ocrStatus,
    sourceName: file.name,
    applicationSource,
    pairingStatus: applicationSource ? "matched" : "unmatched"
  };
}
