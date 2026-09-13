import type { LabelCase, LabelFields } from "../types";

export const STANDARD_WARNING =
  "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";

const baseApplication: LabelFields = {
  brandName: "OLD TOM DISTILLERY",
  classType: "Kentucky Straight Bourbon Whiskey",
  alcoholContent: "45% Alc./Vol. (90 Proof)",
  netContents: "750 mL",
  bottlerProducer: "Old Tom Distillery, Frankfort, KY",
  countryOfOrigin: "United States",
  governmentWarning: STANDARD_WARNING
};

// Defaults first so a case can actually override the presentation flags; spreading
// them last silently forced every label to a compliant prefix.
const completeLabel = (overrides: Partial<LabelFields> = {}): LabelFields => ({
  ...baseApplication,
  warningPrefixAllCaps: true,
  warningBold: true,
  ...overrides
});

export const fixtureCases: LabelCase[] = [
  {
    id: "pass",
    name: "Pass - all fields match",
    description: "A clean structured extraction with the exact warning presentation.",
    application: baseApplication,
    label: completeLabel(),
    ocrStatus: "structured"
  },
  {
    id: "mismatch",
    name: "Mismatch - ABV and contents",
    description: "The label is readable, but the extracted values differ from the application.",
    application: baseApplication,
    label: completeLabel({
      alcoholContent: "40% Alc./Vol. (80 Proof)",
      netContents: "1 L"
    }),
    ocrStatus: "structured"
  },
  {
    id: "warning-failure",
    name: "Warning failure",
    description: "The warning wording is incomplete and the required prefix is not presented correctly.",
    application: baseApplication,
    label: completeLabel({
      governmentWarning:
        "Government Warning: Consumption of alcoholic beverages impairs your ability to drive.",
      warningPrefixAllCaps: false,
      warningBold: false
    }),
    ocrStatus: "structured"
  },
  {
    id: "brand-normalization",
    name: "Brand normalization",
    description: "Capitalization and punctuation differ, but the brand identity is the same.",
    application: baseApplication,
    label: completeLabel({ brandName: "Old Tom Distillery" }),
    ocrStatus: "structured"
  },
  {
    id: "uncertain",
    name: "Unreadable label image",
    description: "No text could be recognised on this label, so every field is held for an agent.",
    application: baseApplication,
    label: {
      brandName: null,
      classType: null,
      alcoholContent: null,
      netContents: null,
      bottlerProducer: null,
      countryOfOrigin: null,
      governmentWarning: null
    },
    ocrStatus: "unreadable"
  }
];
