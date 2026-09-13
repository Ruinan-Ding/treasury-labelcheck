import { describe, expect, it } from "vitest";
import { buildReviewCsv, csvCell } from "./csv";
import { makeStubCase } from "./cases";
import { fixtureCases } from "../test/fixtures";

// Enough of RFC 4180 to read back what buildReviewCsv writes.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\r" && text[i + 1] === "\n") {
      rows.push([...row, cell]);
      row = [];
      cell = "";
      i += 1;
    } else cell += char;
  }
  return [...rows, [...row, cell]];
}

describe("csvCell", () => {
  it("neutralizes spreadsheet formulas built from uploaded filenames", () => {
    expect(csvCell("=cmd|'/c calc'!A1")).toBe(`"'=cmd|'/c calc'!A1"`);
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      expect(csvCell(`${lead}HYPERLINK("http://evil")`).startsWith(`"'`)).toBe(true);
    }
  });

  it("still escapes quotes and leaves ordinary values alone", () => {
    expect(csvCell('Stone"s Throw')).toBe('"Stone""s Throw"');
    expect(csvCell("OLD TOM DISTILLERY")).toBe('"OLD TOM DISTILLERY"');
    expect(csvCell(42)).toBe('"42"');
  });
});

describe("buildReviewCsv", () => {
  const [pass, mismatch] = fixtureCases;
  const refused = makeStubCase(new File([""], "huge.png"), "rejected", "File exceeds the 10 MB limit.");
  const csv = buildReviewCsv([pass, mismatch, refused], { [mismatch.id]: "reject" });
  const [header, ...rows] = parseCsv(csv.slice(1));
  const column = (row: string[], name: string) => row[header.indexOf(name)];

  it("starts with a byte-order mark so Excel reads UTF-8", () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("writes one full-width row per case", () => {
    expect(rows).toHaveLength(3);
    expect(new Set([header, ...rows].map((row) => row.length)).size).toBe(1);
  });

  it("uses the screen's wording for results and decisions", () => {
    expect(column(rows[0], "Overall status")).toBe("Match");
    expect(column(rows[0], "Brand name - Tier")).toBe("Exact");
    expect(column(rows[1], "Overall status")).toBe("Mismatch");
    expect(column(rows[1], "Human decision")).toBe("Rejected");
    expect(column(rows[1], "Alcohol content - Status")).toBe("Mismatch");
  });

  it("leaves a refused file's results blank instead of implying a review", () => {
    expect(column(rows[2], "Overall status")).toBe("Not processed");
    expect(column(rows[2], "Matches")).toBe("");
    expect(column(rows[2], "Brand name - Status")).toBe("");
  });
});
