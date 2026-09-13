import { describe, expect, it } from "vitest";
import { compareFields } from "./verification";
import { nextCaseId, parseStructuredCase, toLabelFields } from "./cases";

describe("nextCaseId", () => {
  it("stays unique across ids minted in the same millisecond", () => {
    const ids = Array.from({ length: 500 }, () => nextCaseId("upload"));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("parseStructuredCase", () => {
  const minimal = { application: { brandName: "A" }, label: { brandName: "A" } };

  it("ignores an id supplied by the uploaded file", () => {
    // A colliding id makes the wrong case open and lets one click decide two cases.
    const first = parseStructuredCase({ ...minimal, id: "pass" }, "a.json")!;
    const second = parseStructuredCase({ ...minimal, id: "pass" }, "a.json")!;
    expect(first.id).not.toBe("pass");
    expect(first.id).not.toBe(second.id);
  });

  it("coerces non-string fields instead of letting them reach compareFields", () => {
    const parsed = parseStructuredCase(
      { application: { netContents: 750 }, label: { netContents: "750 mL" } },
      "numeric.json"
    )!;
    expect(parsed.application.netContents).toBe("750");
    expect(() => compareFields(parsed.application, parsed.label)).not.toThrow();
  });

  it("drops structurally wrong values rather than trusting them", () => {
    const fields = toLabelFields({ brandName: { nested: true }, classType: ["x"], warningBold: "yes" });
    expect(fields.brandName).toBeNull();
    expect(fields.classType).toBeNull();
    expect(fields.warningBold).toBeUndefined();
  });

  it("rejects input that is not a case", () => {
    expect(parseStructuredCase(null, "x.json")).toBeNull();
    expect(parseStructuredCase("a string", "x.json")).toBeNull();
    expect(parseStructuredCase({ application: {} }, "x.json")).toBeNull();
  });
});
