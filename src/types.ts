export type VerificationStatus = "match" | "mismatch" | "review";
export type MatchTier = "exact" | "normalized" | "mismatch" | "review";

export type FieldKey =
  | "brandName"
  | "classType"
  | "alcoholContent"
  | "netContents"
  | "bottlerProducer"
  | "countryOfOrigin"
  | "governmentWarning";

export type OcrStatus = "structured" | "ocr" | "unreadable" | "rejected";

export interface LabelFields {
  brandName: string | null;
  classType: string | null;
  alcoholContent: string | null;
  netContents: string | null;
  bottlerProducer: string | null;
  countryOfOrigin: string | null;
  governmentWarning: string | null;
  warningPrefixAllCaps?: boolean;
  warningBold?: boolean;
}

export interface LabelCase {
  id: string;
  name: string;
  description: string;
  application: LabelFields;
  label: LabelFields;
  imageUrl?: string;
  /** The uploaded image itself, kept so `imageUrl` can be recreated after a refresh. */
  imageFile?: Blob;
  ocrStatus: OcrStatus;
  sourceName?: string;
  processingTimeMs?: number;
  /** Mean per-character confidence Tesseract reported, 0-1. Only set for OCR cases. */
  ocrConfidence?: number;
  /** Raw recognised text, kept so an agent can see what the reader actually saw. */
  ocrText?: string;
  /** File the application record was paired from, when an image was matched to one. */
  applicationSource?: string;
  /** Whether the uploaded JSON and image could be associated by filename. */
  pairingStatus?: "matched" | "unmatched";
}

export interface FieldResult {
  key: FieldKey;
  label: string;
  status: VerificationStatus;
  matchTier: MatchTier;
  applicationValue: string | null;
  labelValue: string | null;
  confidence: number;
  note: string;
}

export interface VerificationSummary {
  results: FieldResult[];
  overall: VerificationStatus;
  matched: number;
  mismatched: number;
  needsReview: number;
}
