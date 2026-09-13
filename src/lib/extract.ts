import { NET_CONTENTS_PATTERN } from "./verification";
import type { LabelFields } from "../types";

/**
 * Turns the raw text Tesseract read off a label into the same `LabelFields` shape a
 * structured upload produces, so both inputs meet the identical comparison rules.
 *
 * Every rule here is anchored to wording that TTB actually mandates on a label - the
 * statutory warning, a percentage next to an alcohol term, a volume next to a real unit,
 * a "bottled by" statement, a "product of" statement. Nothing is guessed from position
 * alone except the brand name, which is the one field with no required phrasing.
 * A field this cannot find stays null and is reported as Review rather than invented.
 */

const NET_CONTENTS = new RegExp(NET_CONTENTS_PATTERN.source, "i");

const WARNING_PREFIX = /government\s+warning\s*:?/i;
// The statutory statement ends here; a label often prints more text below it.
const WARNING_TAIL = /health\s+problems\s*\.?/i;

const ALCOHOL_TERM = /\b(?:alc(?:ohol)?|abv|by\s+vol(?:ume)?|vol(?:ume)?|proof)\b/i;
const PERCENTAGE = /\d+(?:\.\d+)?\s*%/;

const CLASS_TERMS =
  /\b(?:whisk(?:e)?y|bourbon|rye|scotch|vodka|gin|rum|tequila|mezcal|brandy|cognac|liqueur|cordial|wine|chardonnay|merlot|cabernet|riesling|pinot|zinfandel|sauvignon|champagne|prosecco|sherry|port|vermouth|sake|beer|ale|lager|stout|porter|pilsner|cider|perry|mead|malt\s+beverage|spirits?)\b/i;

const PRODUCER_LEAD =
  /^(?:bottled|produced|distilled|brewed|vinted|blended|packed|imported|manufactured)(?:\s*(?:,|and|&)?\s*(?:bottled|produced|distilled|brewed|vinted|blended|packed|imported))*\s+(?:by|for|in)\s*:?\s*/i;

const ORIGIN_PATTERNS = [
  /\bproduct\s+of\s*:?\s*(.+)/i,
  /\bcountry\s+of\s+origin\s*:?\s*(.+)/i,
  /\bimported\s+from\s*:?\s*(.+)/i,
  /\bmade\s+in\s*:?\s*(.+)/i
];

// OCR emits stray punctuation for rules, borders, and glare. A line that carries no
// letters or digits is never a field value.
function meaningfulLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 1 && /[A-Za-z0-9]/.test(line));
}

function extractWarning(text: string): { value: string | null; allCaps: boolean } {
  const start = text.search(WARNING_PREFIX);
  if (start === -1) return { value: null, allCaps: false };

  const rest = text.slice(start);
  const tail = rest.match(WARNING_TAIL);
  const value = (tail?.index === undefined ? rest : rest.slice(0, tail.index + tail[0].length))
    .replace(/\s+/g, " ")
    .trim();

  // Jenny Park's rejection case: the wording can be perfect while "Government Warning"
  // is in title case. Read the capitalisation off the source text, before normalising.
  const prefix = rest.match(WARNING_PREFIX)?.[0] ?? "";
  const letters = prefix.replace(/[^A-Za-z]/g, "");
  return { value, allCaps: letters.length > 0 && letters === letters.toUpperCase() };
}

export function extractLabelFields(text: string): LabelFields {
  const lines = meaningfulLines(text);
  const claimed = new Set<number>();
  const claim = (index: number, value: string): string => {
    claimed.add(index);
    return value;
  };

  const warning = extractWarning(text);

  // Drop every line the warning statement occupies so it cannot also be read as the
  // brand or the class - it is long, and it mentions neither.
  if (warning.value) {
    lines.forEach((line, index) => {
      if (WARNING_PREFIX.test(line) || (line.length > 40 && warning.value!.includes(line.slice(0, 40)))) {
        claimed.add(index);
      }
    });
  }

  let alcoholContent: string | null = null;
  let netContents: string | null = null;
  let bottlerProducer: string | null = null;
  let countryOfOrigin: string | null = null;

  lines.forEach((line, index) => {
    if (claimed.has(index)) return;

    if (!alcoholContent && PERCENTAGE.test(line) && ALCOHOL_TERM.test(line)) {
      alcoholContent = claim(index, line);
      return;
    }

    const producer = line.match(PRODUCER_LEAD);
    if (!bottlerProducer && producer) {
      const remainder = line.slice(producer[0].length).trim();
      // The application records the firm, not the "Bottled by" lead-in, so the phrase is
      // dropped rather than compared. A bare lead-in with nothing after it is not a value.
      if (remainder) {
        bottlerProducer = claim(index, remainder);
        return;
      }
    }

    if (!countryOfOrigin) {
      for (const pattern of ORIGIN_PATTERNS) {
        const match = line.match(pattern);
        if (match?.[1]?.trim()) {
          countryOfOrigin = claim(index, match[1].trim());
          return;
        }
      }
    }

    if (!netContents && NET_CONTENTS.test(line)) {
      netContents = claim(index, line);
    }
  });

  // Class and brand are both free text with no mandated phrasing, so they are resolved
  // last, from whatever no stronger rule has claimed. The class is identified by its
  // beverage term; the brand is the first line left over, which is where labels put it.
  let classType: string | null = null;
  let brandName: string | null = null;

  lines.forEach((line, index) => {
    if (claimed.has(index) || classType) return;
    if (CLASS_TERMS.test(line)) classType = claim(index, line);
  });

  lines.forEach((line, index) => {
    if (claimed.has(index) || brandName) return;
    brandName = claim(index, line);
  });

  const fields: LabelFields = {
    brandName,
    classType,
    alcoholContent,
    netContents,
    bottlerProducer,
    countryOfOrigin,
    governmentWarning: warning.value
  };

  // Only asserted when the statement was actually found. Bold is never set: weight is a
  // visual property that recognised text does not carry, so it stays unknown and the
  // comparison holds the warning for human confirmation.
  if (warning.value) fields.warningPrefixAllCaps = warning.allCaps;
  return fields;
}
