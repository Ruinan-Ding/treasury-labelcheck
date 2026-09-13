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
