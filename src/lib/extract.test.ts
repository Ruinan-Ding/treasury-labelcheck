import { describe, expect, it } from "vitest";
import { STANDARD_WARNING } from "../data/fixtures";
import { extractLabelFields } from "./extract";
import { compareFields, validateGovernmentWarning } from "./verification";

const LABEL_TEXT = `OLD TOM DISTILLERY
KENTUCKY STRAIGHT BOURBON WHISKEY
45% Alc./Vol. (90 Proof)
750 mL
BOTTLED BY OLD TOM DISTILLERY, FRANKFORT, KY
PRODUCT OF UNITED STATES
${STANDARD_WARNING}`;

describe("extractLabelFields", () => {
  it("reads every mandated field off a well-formed label", () => {
    const fields = extractLabelFields(LABEL_TEXT);
    expect(fields.brandName).toBe("OLD TOM DISTILLERY");
    expect(fields.classType).toBe("KENTUCKY STRAIGHT BOURBON WHISKEY");
    expect(fields.alcoholContent).toBe("45% Alc./Vol. (90 Proof)");
    expect(fields.netContents).toBe("750 mL");
    expect(fields.countryOfOrigin).toBe("UNITED STATES");
  });

  it("drops the 'Bottled by' lead-in so the firm matches the application record", () => {
    // The application records the firm alone; keeping the lead-in would fail the compare.
    expect(extractLabelFields(LABEL_TEXT).bottlerProducer).toBe("OLD TOM DISTILLERY, FRANKFORT, KY");
  });

  it("recovers the statutory warning verbatim enough to satisfy the exact-text rule", () => {
    const fields = extractLabelFields(LABEL_TEXT);
    expect(validateGovernmentWarning({ ...fields, warningBold: true }).exactText).toBe(true);
  });

  it("stops the warning at the end of the statutory statement", () => {
    const fields = extractLabelFields(`${LABEL_TEXT}\nPLEASE DRINK RESPONSIBLY\nwww.oldtom.example`);
    expect(fields.governmentWarning).not.toContain("RESPONSIBLY");
    expect(validateGovernmentWarning({ ...fields, warningBold: true }).exactText).toBe(true);
  });

  it("reports title case in the prefix, which is Jenny Park's rejection case", () => {
    const titleCase = LABEL_TEXT.replace("GOVERNMENT WARNING:", "Government Warning:");
    expect(extractLabelFields(titleCase).warningPrefixAllCaps).toBe(false);
    expect(extractLabelFields(LABEL_TEXT).warningPrefixAllCaps).toBe(true);
  });

  it("never claims to know bold, so a read label still reaches a human", () => {
    const fields = extractLabelFields(LABEL_TEXT);
    expect(fields.warningBold).toBeUndefined();
    expect(validateGovernmentWarning(fields).valid).toBe(false);
  });

  it("leaves a field null rather than inventing one when the label omits it", () => {
    const fields = extractLabelFields("SOME BRAND\n750 mL");
    expect(fields.alcoholContent).toBeNull();
    expect(fields.countryOfOrigin).toBeNull();
    expect(fields.governmentWarning).toBeNull();
    expect(fields.warningPrefixAllCaps).toBeUndefined();
  });

  it("ignores rule and border noise instead of reading it as the brand", () => {
    const fields = extractLabelFields(`~~~~\n|\n- -\nOLD TOM DISTILLERY\n750 mL`);
    expect(fields.brandName).toBe("OLD TOM DISTILLERY");
  });

  it("keeps a firm name ending in 'Spirits' from displacing the class", () => {
    // Read off the abv-mismatch sample: the brand swallowed the class and vice versa.
    const fields = extractLabelFields("RIVER BEND SPIRITS\nDistilled Vodka\n750 mL");
    expect(fields.brandName).toBe("RIVER BEND SPIRITS");
    expect(fields.classType).toBe("Distilled Vodka");
  });

  it("still reads a class printed above the brand", () => {
    const fields = extractLabelFields("Kentucky Straight Bourbon Whiskey\nOLD TOM\nFinished in port casks\n750 mL");
    expect(fields.classType).toBe("Kentucky Straight Bourbon Whiskey");
    expect(fields.brandName).toBe("OLD TOM");
  });

  it("does not take 'Bottled in Bond' as the bottler", () => {
    const fields = extractLabelFields("OLD TOM\nBottled in Bond\nBottled by Old Tom Distillery, Frankfort, KY");
    expect(fields.bottlerProducer).toBe("Old Tom Distillery, Frankfort, KY");
  });

  it("reports the warning's closing punctuation as printed", () => {
    const fields = extractLabelFields(LABEL_TEXT.replace("health problems.", "health problems!"));
    expect(fields.governmentWarning?.endsWith("health problems!")).toBe(true);
    expect(validateGovernmentWarning({ ...fields, warningBold: true }).exactText).toBe(false);
  });

  it("does not read the proof number as a volume", () => {
    // "(90 Proof)" sits next to the ABV; only a real unit may become net contents.
    expect(extractLabelFields("BRAND\n45% Alc./Vol. (90 Proof)").netContents).toBeNull();
  });

  it("feeds the comparison rules directly, matching a clean application record", () => {
    const application = {
      brandName: "Old Tom Distillery",
      classType: "Kentucky Straight Bourbon Whiskey",
      alcoholContent: "45% Alc./Vol. (90 Proof)",
      netContents: "750 mL",
      bottlerProducer: "Old Tom Distillery, Frankfort, KY",
      countryOfOrigin: "United States",
      governmentWarning: STANDARD_WARNING
    };
    const summary = compareFields(application, { ...extractLabelFields(LABEL_TEXT), warningBold: true });
    expect(summary.mismatched).toBe(0);
    expect(summary.matched).toBe(7);
  });
});

describe("comparing a label read by OCR", () => {
  const application = {
    brandName: "Old Tom Distillery",
    classType: "Kentucky Straight Bourbon Whiskey",
    alcoholContent: "45% Alc./Vol. (90 Proof)",
    netContents: "750 mL",
    bottlerProducer: "Old Tom Distillery, Frankfort, KY",
    countryOfOrigin: "United States",
    governmentWarning: STANDARD_WARNING
  };
  const status = (text: string, key: string) =>
    compareFields(application, extractLabelFields(text), { ocr: true }).results.find((r) => r.key === key)!.status;

  // Each misread below was produced by the deployed app from a degraded copy of old-tom.png.
  it("holds a misread warning for review instead of rejecting a compliant label", () => {
    expect(status(LABEL_TEXT.replace("birth", "bith"), "governmentWarning")).toBe("review");
    expect(status(LABEL_TEXT.replace("WARNING:", "WARNiNG:"), "governmentWarning")).toBe("review");
  });

  it("holds a stray line picked up as the brand for review", () => {
    expect(status(LABEL_TEXT.replace("OLD TOM DISTILLERY\n", "ee,\n"), "brandName")).toBe("review");
  });

  it("holds noisy ABV notation for review when the percentage itself agrees", () => {
    expect(status(LABEL_TEXT.replace("Alc./Vol.", "Ale./\\Vol."), "alcoholContent")).toBe("review");
  });

  it("still rejects what a misread cannot produce - Harbor Mist's discrepancies", () => {
    const harborMist = LABEL_TEXT.replace("45% Alc./Vol. (90 Proof)", "40% Alc./Vol. (80 Proof)")
      .replace("750 mL", "1L")
      .replace("GOVERNMENT WARNING:", "Government Warning:");
    expect(status(harborMist, "alcoholContent")).toBe("mismatch");
    expect(status(harborMist, "netContents")).toBe("mismatch");
    expect(status(harborMist, "governmentWarning")).toBe("mismatch");
  });

  it("leaves structured input judged as strictly as before", () => {
    const label = { ...extractLabelFields(LABEL_TEXT.replace("OLD TOM DISTILLERY\n", "ee,\n")), warningBold: true };
    expect(compareFields(application, label).results[0].status).toBe("mismatch");
  });
});
