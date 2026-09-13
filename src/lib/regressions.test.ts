import { describe, expect, it } from "vitest";
import sampleCase from "../../public/samples/structured-case.json";
import { fixtureCases, STANDARD_WARNING } from "../data/fixtures";
import type { LabelFields } from "../types";
import { compareFields, normalizeBrandName } from "./verification";

const application = fixtureCases[0].application;
const label = fixtureCases[0].label;

function field(app: Partial<LabelFields>, lbl: Partial<LabelFields>, key: Parameters<typeof compareFields> extends never ? never : "brandName" | "netContents" | "alcoholContent" | "governmentWarning") {
  const result = compareFields({ ...application, ...app }, { ...label, ...lbl });
  return result.results.find((item) => item.key === key)!;
}

describe("government warning", () => {
  it("uses the statutory 27 CFR 16.21 wording, so a compliant label passes", () => {
    // The README points a reviewer at this exact file as the structured-case example.
    const result = compareFields(sampleCase.application as LabelFields, sampleCase.label as LabelFields);
    expect(result.overall).toBe("match");
    expect(STANDARD_WARNING).toContain("birth defects. (2) Consumption");
  });

  it("tolerates how the source wrapped whitespace but not how it worded the text", () => {
    const rewrapped = STANDARD_WARNING.replace("GOVERNMENT WARNING: (1)", "GOVERNMENT WARNING:\n  (1)");
    expect(field({}, { governmentWarning: rewrapped }, "governmentWarning").status).toBe("match");
  });

  it("rejects title case in the prefix even when the rest is verbatim", () => {
    const titleCase = STANDARD_WARNING.replace("GOVERNMENT WARNING:", "Government Warning:");
    expect(field({ governmentWarning: titleCase }, { governmentWarning: titleCase }, "governmentWarning").status).toBe("mismatch");
  });

  it("does not report a match when the application records different warning text", () => {
    // The label is compliant, but the two values are shown side by side, so a green
    // Match beside two visibly different strings would mislead the agent.
    const result = field({ governmentWarning: "See attached." }, {}, "governmentWarning");
    expect(result.status).toBe("review");
    expect(result.note).toContain("application records different warning text");
  });

  it("does not soften wrong wording to review when presentation metadata is absent", () => {
    const short = "GOVERNMENT WARNING: drinking is bad.";
    const result = field(
      { governmentWarning: short },
      { governmentWarning: short, warningPrefixAllCaps: undefined, warningBold: undefined },
      "governmentWarning"
    );
    expect(result.status).toBe("mismatch");
    expect(result.note).not.toContain("matches");
  });

  it("still asks for review when the wording is right and only presentation is unknown", () => {
    const result = field({}, { warningPrefixAllCaps: undefined, warningBold: undefined }, "governmentWarning");
    expect(result.status).toBe("review");
  });
});

describe("government warning without an application record", () => {
  // A label image read by OCR arrives with no application record unless one was uploaded
  // beside it. The warning is fixed by statute, so it is still checkable on its own.
  it("checks a lone label against the statute instead of skipping the field", () => {
    const result = field({ governmentWarning: "" }, {}, "governmentWarning");
    expect(result.status).toBe("match");
    expect(result.note).toContain("statute alone");
    expect(result.note).not.toContain("nothing to compare");
  });

  it("still rejects title case when no application record was supplied", () => {
    const titleCase = STANDARD_WARNING.replace("GOVERNMENT WARNING:", "Government Warning:");
    const result = field(
      { governmentWarning: "" },
      { governmentWarning: titleCase, warningPrefixAllCaps: false },
      "governmentWarning"
    );
    expect(result.status).toBe("mismatch");
    expect(result.note).toContain("all caps");
  });

  it("holds the field for review when the label itself carries no warning", () => {
    const result = field({ governmentWarning: "" }, { governmentWarning: null }, "governmentWarning");
    expect(result.status).toBe("review");
    expect(result.note).toContain("Neither the application nor the label");
  });

  it("does not extend statute-only handling to any other field", () => {
    const result = field({ brandName: "" }, {}, "brandName");
    expect(result.status).toBe("review");
    expect(result.note).toContain("nothing to compare");
  });
});

describe("fixtures", () => {
  it("lets a case override the warning presentation flags", () => {
    // The 'Warning failure' case is the demo of Jenny's title-case rejection; it has to
    // actually carry the failing presentation, not just failing wording.
    const failing = fixtureCases.find((item) => item.id === "warning-failure")!;
    expect(failing.label.warningPrefixAllCaps).toBe(false);
    expect(failing.label.warningBold).toBe(false);

    const result = compareFields(failing.application, failing.label);
    const warning = result.results.find((item) => item.key === "governmentWarning")!;
    expect(warning.status).toBe("mismatch");
    expect(warning.note).toContain("all caps");
    expect(warning.note).toContain("bold");
  });

  it("keeps the compliant fixtures compliant", () => {
    for (const id of ["pass", "brand-normalization"]) {
      const item = fixtureCases.find((c) => c.id === id)!;
      expect(item.label.warningPrefixAllCaps).toBe(true);
      expect(compareFields(item.application, item.label).overall).toBe("match");
    }
  });
});

describe("net contents", () => {
  it("reads the unit next to the number, not a parenthetical equivalent", () => {
    expect(field({ netContents: "750 mL" }, { netContents: "750 mL (25.4 FL OZ)" }, "netContents").status).toBe("match");
    expect(field({ netContents: "1 L" }, { netContents: "1 L (33.8 fl oz)" }, "netContents").status).toBe("match");
    // 25.4 fl oz is the rounded label equivalent of 750 mL; 25.3 fl oz is not.
    expect(field({ netContents: "25.4 fl oz" }, { netContents: "750 mL" }, "netContents").status).toBe("match");
    expect(field({ netContents: "25.3 fl oz" }, { netContents: "750 mL" }, "netContents").status).toBe("mismatch");
    // The ounce slack follows the unit that was compared, not a parenthetical beside it.
    expect(field({ netContents: "750 mL" }, { netContents: "751.4 mL (25.4 fl oz)" }, "netContents").status).toBe("mismatch");
  });

  it("treats a comma as a thousands separator, not a decimal point", () => {
    expect(field({ netContents: "1,500 mL" }, { netContents: "1500 mL" }, "netContents").status).toBe("match");
  });

  it("still reads a comma as a decimal separator where it is one", () => {
    expect(field({ netContents: "0,75 L" }, { netContents: "750 mL" }, "netContents").status).toBe("match");
  });

  it("does not match materially different volumes", () => {
    expect(field({ netContents: "750 mL" }, { netContents: "1,500 mL" }, "netContents").status).toBe("mismatch");
  });
});

describe("alcohol content", () => {
  it("normalizes '% by volume' against '% ABV'", () => {
    expect(field({ alcoholContent: "45% by volume" }, { alcoholContent: "45% ABV" }, "alcoholContent").status).toBe("match");
  });
});

describe("brand name", () => {
  it("strips accents from their base letter instead of erasing the character", () => {
    expect(normalizeBrandName("MÖET")).toBe("MOET");
    expect(normalizeBrandName("MÖET")).not.toBe(normalizeBrandName("MÄET"));
    expect(field({ brandName: "MÖET" }, { brandName: "MÄET" }, "brandName").status).toBe("mismatch");
    expect(field({ brandName: "MÖET" }, { brandName: "Moet" }, "brandName").status).toBe("match");
  });

  it("does not depend on the reviewer's locale", () => {
    // toLocaleUpperCase("tr") maps "i" to a dotted capital that the A-Z filter drops.
    expect(normalizeBrandName("Miller")).toBe("MILLER");
  });
});

describe("missing values", () => {
  it("asks for review when the application field is blank rather than asserting a mismatch", () => {
    const result = field({ brandName: "" }, {}, "brandName");
    expect(result.status).toBe("review");
    expect(result.confidence).toBeLessThan(0.5);
  });
});

describe("confidence", () => {
  it("ranks an exact verify above a normalized one, and never below a mismatch", () => {
    const exact = field({}, {}, "brandName");
    const normalized = field({}, { brandName: "Old Tom Distillery" }, "brandName");
    const mismatch = field({}, { brandName: "Other Distillery" }, "brandName");
    expect(exact.confidence).toBeGreaterThan(normalized.confidence);
    expect(exact.confidence).toBeGreaterThanOrEqual(mismatch.confidence);

    const validWarning = field({}, {}, "governmentWarning");
    const invalidWarning = field({ governmentWarning: "nope" }, { governmentWarning: "nope" }, "governmentWarning");
    expect(validWarning.confidence).toBeGreaterThanOrEqual(invalidWarning.confidence);
  });
});
