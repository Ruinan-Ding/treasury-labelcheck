import { describe, expect, it } from "vitest";
import { fixtureCases, STANDARD_WARNING } from "../data/fixtures";
import { compareFields, normalizeBrandName, validateGovernmentWarning } from "./verification";

describe("brand normalization", () => {
  it("ignores harmless capitalization and punctuation differences", () => {
    expect(normalizeBrandName("Stone's Throw")).toBe(normalizeBrandName("STONES THROW"));
    expect(normalizeBrandName("  Old Tom Distillery ")).toBe("OLD TOM DISTILLERY");
  });
});

describe("government warning validation", () => {
  it("requires exact wording, all-caps prefix, and bold presentation", () => {
    expect(
      validateGovernmentWarning({
        ...fixtureCases[0].label,
        governmentWarning: STANDARD_WARNING,
        warningPrefixAllCaps: true,
        warningBold: true
      }).valid
    ).toBe(true);

    const invalid = validateGovernmentWarning({
      ...fixtureCases[0].label,
      governmentWarning: "Government Warning: shortened text",
      warningPrefixAllCaps: false,
      warningBold: false
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.reasons).toHaveLength(3);
  });

  it("requests review when presentation metadata is unavailable", () => {
    const result = validateGovernmentWarning({ ...fixtureCases[0].label, warningPrefixAllCaps: undefined, warningBold: undefined });
    expect(result.exactText).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.reasons).toHaveLength(2);
  });
});

describe("field comparison", () => {
  it("passes a complete case", () => {
    const summary = compareFields(fixtureCases[0].application, fixtureCases[0].label);
    expect(summary.overall).toBe("match");
    expect(summary.matched).toBe(7);
  });

  it("normalizes a brand while retaining strict warning validation", () => {
    const summary = compareFields(fixtureCases[3].application, fixtureCases[3].label);
    expect(summary.results.find((result) => result.key === "brandName")?.status).toBe("match");
    expect(summary.overall).toBe("match");
  });

  it("flags mismatches and unreadable fields separately", () => {
    const mismatch = compareFields(fixtureCases[1].application, fixtureCases[1].label);
    expect(mismatch.overall).toBe("mismatch");
    expect(mismatch.mismatched).toBe(2);

    const uncertain = compareFields(fixtureCases[4].application, fixtureCases[4].label);
    expect(uncertain.overall).toBe("review");
    expect(uncertain.needsReview).toBe(7);

    const noPresentation = { ...fixtureCases[0].label, warningPrefixAllCaps: undefined, warningBold: undefined };
    const presentationReview = compareFields(fixtureCases[0].application, noPresentation);
    expect(presentationReview.results.find((result) => result.key === "governmentWarning")?.status).toBe("review");
  });

  it("normalizes common alcohol-content notation without converting units", () => {
    const application = { ...fixtureCases[0].application, alcoholContent: "45% Alc./Vol. (90 Proof)" };
    const label = { ...fixtureCases[0].label, alcoholContent: "45% ABV (90 proof)" };
    const result = compareFields(application, label);
    expect(result.results.find((item) => item.key === "alcoholContent")?.status).toBe("match");
  });

  it("does not treat different alcohol values as equivalent", () => {
    const application = { ...fixtureCases[0].application, alcoholContent: "45% Alc./Vol." };
    const label = { ...fixtureCases[0].label, alcoholContent: "40% ABV" };
    const result = compareFields(application, label);
    expect(result.results.find((item) => item.key === "alcoholContent")?.status).toBe("mismatch");
  });

  it("does not treat proof as interchangeable with a different ABV value", () => {
    const application = { ...fixtureCases[0].application, alcoholContent: "90 Proof" };
    const label = { ...fixtureCases[0].label, alcoholContent: "45% ABV" };
    const result = compareFields(application, label);
    expect(result.results.find((item) => item.key === "alcoholContent")?.status).toBe("mismatch");
  });

  it("matches equivalent net-content units without changing the declared quantity", () => {
    const application = { ...fixtureCases[0].application, netContents: "750 mL" };
    const label = { ...fixtureCases[0].label, netContents: "0.75 L" };
    const result = compareFields(application, label);
    expect(result.results.find((item) => item.key === "netContents")?.status).toBe("match");
    expect(result.results.find((item) => item.key === "netContents")?.matchTier).toBe("normalized");
  });

  it("does not match materially different net contents", () => {
    const application = { ...fixtureCases[0].application, netContents: "750 mL" };
    const label = { ...fixtureCases[0].label, netContents: "1 L" };
    const result = compareFields(application, label);
    expect(result.results.find((item) => item.key === "netContents")?.status).toBe("mismatch");
  });
});
