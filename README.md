# LabelCheck

A prototype that helps a TTB compliance agent verify an alcohol beverage label against
its application. Upload the label artwork and the application record; the app reads the
label on the spot, compares every mandated field, and tells the agent which fields it is
confident about and which ones a human still has to decide.

Built for the Treasury IT Specialist (AI) take-home assignment. The brief it answers is
in [`docs/ASSIGNMENT.md`](docs/ASSIGNMENT.md).

**Live prototype:** [treasury-labelcheck.vercel.app](https://treasury-labelcheck.vercel.app/)

**It runs entirely in the browser.** OCR, comparison, and export all happen on the
reviewer's machine. There is no backend and no API key, and the app never contacts any
host other than the one it was loaded from — the constraint Marcus Williams described,
where the TTB firewall blocked the last vendor's cloud ML endpoints. The site is publicly
hosted, but label data is processed only in the browser, which is why the interface says
**Browser-only processing**.

## Try it in a minute

1. Open the [live prototype](https://treasury-labelcheck.vercel.app/).
2. Click **Stage sample batch**. Seventeen label images and seventeen application records
   appear in the two upload lists on the left; two of each have no partner.
3. Click **Compare uploaded files**. The batch takes about 13 seconds on a laptop,
   including the one-time model load. Select any case in the queue to see its field-by-field result.

| Sample | What it demonstrates | Expected result |
| --- | --- | --- |
| `old-tom` | A clean, compliant label | 6 match; warning held for review (bold cannot be proven from an image) |
| `stones-throw` | Dave Morrison's case: `STONE'S THROW` on the label, `Stone's Throw` in the application | Brand is a **normalized match** |
| `harbor-mist` | Jenny Park's case: `Government Warning:` in title case, plus a wrong ABV and volume | 3 mismatches |
| `abv-mismatch` | Label says 37.5%, application says 40% | Alcohol content mismatch |
| `volume-mismatch` | Net contents differ | Net contents mismatch |
| `warning-titlecase` | Correct wording, title-case prefix | Government warning mismatch |
| `warning-punctuation` | The warning ends `problems!` instead of `problems.` | Warning held for review with "does not exactly match" |
| `missing-warning` | No government warning printed at all | Warning held for review; it may be absent or unreadable |
| `brand-difference` | Label says `SILVER CREEK`, application says `SILVER CROWN` | Brand held for review; OCR cannot tell a different name from a misread |
| `normalized-units` | `0.75 L` and `45% ABV` against `750 mL` and `45% Alc./Vol.` | Normalized matches |
| `fluid-ounce-volume` | `25.4 fl oz` in the application, `750 mL` on the label | Normalized match |
| `import-origin` | An imported gin with origin and producer statements | Origin matches; `Ltd.` vs `LTD` held for review |
| `missing-fields` | No country-of-origin statement on the label | Country held for review, never guessed |
| `low-contrast-review` | Faded grey text on a cream background | Read correctly after contrast stretching |
| `unreadable-review` | Noise, no text | Every field held for review |
| `label-only-a`, `label-only-b` | Label images with no application record | `↔`; only the statutory warning can be checked |
| `application-only-a`, `application-only-b` | Application records with no label image | `↔`; every field held for review |

[`public/samples/structured-case.json`](public/samples/structured-case.json) is not part
of the batch. Upload it in the application box to see a complete structured case, which
is compared at once without OCR.

## Run it locally

Requires Node.js 20.19+ or 22.12+ (Vite 7) and npm.

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm test         # 63 tests
npm run build    # type-check and produce dist/
npm run preview  # serve the production build
```

`npm install` pulls the OCR engine; `npm run dev` and `npm run build` then copy its
worker, WASM core, and English model into `public/tesseract/` automatically. There is no
manual step, and no network access is needed once `npm install` has finished.

## Using it

**Upload.** Application records go in the first box, label images in the second. Files
can be added at different times, and each staged file can be removed with its `x`.
Nothing is compared until **Compare uploaded files** is clicked. An image is paired with
the record whose filename matches, ignoring case and extension, so `old-tom.png` is
compared against `old-tom.json`. Up to 300 files can be staged, and anything over the
limit is reported as omitted.

Unpaired files are still processed rather than dropped. A lone label image is checked
against the statutory warning, which comes from law rather than from the application. A
lone record becomes a review case saying no image arrived. Both are marked `↔` in the
queue.

**Read the queue.** `✓` means every field matched, `!` means at least one field is a
confirmed mismatch, `?` means nothing is wrong but something needs a human, and `↔`
means the files did not pair. A confirmed mismatch outranks a pending review, so a
problem label is never hidden behind a `?`.

**Decide.** **Accept**, **Needs review**, and **Reject** record the agent's own decision,
shown as a coloured dot in the queue. They never overwrite the automated result.

**Export.** **Export CSV** writes the whole queue locally, one row per case: source files,
pairing, OCR confidence and recognised text, the overall result, the human decision, and
for each of the seven fields the application value, label evidence, status, tier,
confidence, and explanatory note. Values use the same words as the screen (`Mismatch`,
`Normalized match`, `Accepted`). The file opens cleanly in Excel, including accented
text, and cells a spreadsheet would execute as formulas are escaped.

**Refresh or reset.** The queue, staged files, and decisions are kept in this browser's
IndexedDB, so a page refresh loses nothing. **Reset workspace** clears it all.

### Application record format

The brief scopes out COLA integration, so the application arrives as a JSON file:

```json
{
  "application": {
    "brandName": "OLD TOM DISTILLERY",
    "classType": "Kentucky Straight Bourbon Whiskey",
    "alcoholContent": "45% Alc./Vol. (90 Proof)",
    "netContents": "750 mL",
    "bottlerProducer": "Old Tom Distillery, Frankfort, KY",
    "countryOfOrigin": "United States",
    "governmentWarning": "GOVERNMENT WARNING: (1) According to the Surgeon General, ..."
  }
}
```

Any field may be missing or `null`; it is then reported as Review. A file that also
carries a `label` object with the same keys is a complete structured case and is compared
directly without OCR. It may assert `warningPrefixAllCaps` and `warningBold`, which an
image cannot prove. [`structured-case.json`](public/samples/structured-case.json) is an
example.

## Approach

The core loop in the stakeholder interviews is *an agent looks at the label artwork and
checks it against the application*. So the prototype had to actually read a label, not
ask the agent to transcribe one.

**Reading the label.** Tesseract compiled to WebAssembly runs in the browser. A cloud OCR
API was never viable given the firewall. The worker, WASM core, and ~2.9 MB English model
are served from the app's own origin; `scripts/vendor-ocr.mjs` copies them out of
`node_modules` at build time, which also keeps ~23 MB of binaries out of git. Each image
is converted to grayscale and contrast-stretched first, which recovers flatly under- or
over-exposed photographs.

**Reading the fields.** `src/lib/extract.ts` turns recognised text into the same
`LabelFields` shape a JSON upload produces, so both inputs meet identical comparison
rules. Every rule is anchored to wording TTB mandates: the statutory warning, a
percentage beside an alcohol term, a volume beside a real unit, a "bottled by" statement,
a "product of" statement. Class/type is the line carrying a beverage term, and the brand
is the first line no other rule claimed. **A field that cannot be found stays empty and is
reported as Review; it is never guessed.**

**Deciding.** `src/lib/verification.ts` holds every comparison rule. Each field gets a
status (Match / Mismatch / Review), a tier (exact / normalized), and a confidence figure.
The app never decides a case. It sorts the obvious from the ones needing judgment, which
is what Sarah Chen said her agents need.

### How each field is judged

- **Government warning:** checked verbatim against 27 CFR 16.21. Wording, capitalization,
  and punctuation must match; only the way the text wraps is ignored. A title-case prefix
  is a mismatch. Because the statute governs the label rather than the application, a lone
  label image is still checked against it.
- **Brand name:** case, punctuation, and accents are normalized, so `STONE'S THROW` and
  `Stone's Throw` are the same brand. Accents are stripped from their base letter rather
  than deleting the character, so `MÖET` and `MÄET` stay different.
- **Alcohol content:** common notations are treated alike (`45% by volume`,
  `45% Alc./Vol.`, `45% ABV`) without converting or inferring any value.
- **Net contents:** converted to millilitres when the unit is explicit, and matched within
  1 mL. When a fluid-ounce figure is involved the slack is 1.5 mL, because labels round
  ounces to one decimal (750 mL prints as 25.4 fl oz, which is 751.2 mL). In
  `750 mL (25.4 FL OZ)` the unit is read beside the first number, so it counts as 750 mL.
- **Everything else:** whitespace and case normalization only.
- **Labels read by OCR:** recognised text cannot tell a misread from a misprint, so a
  difference in wording is Review, not Mismatch. Only what a misread cannot plausibly
  produce stays a mismatch: two cleanly read percentages or volumes that disagree, or a
  warning prefix set mostly in lowercase. A single stray lowercase letter (`WARNiNG`) is
  treated as a misread.
- **Missing values:** a blank on either side is Review, never a mismatch.

Confidence reports how certain a rule is about its verdict: an exact match is 0.99, a
normalized match 0.90, a mismatch 0.95, and anything held for a human 0.35. It is a
transparent rule-based signal, **not** a calibrated model probability.

### Meeting the interview constraints

| Constraint | How it is met |
| --- | --- |
| Results in ~5 seconds (Sarah) | The 17-label sample batch finishes in about 13 s including the one-time model load, under 0.8 s per label. A single upload returns in about 2 s. Each case shows its elapsed time, which in a batch includes its wait for the shared OCR worker. |
| Usable by a 73-year-old; half the team is 50+ (Sarah) | One upload box per input, one Compare button, and a one-click sample batch. Text meets WCAG AA contrast, status is carried by words and glyphs as well as colour, every control has a visible focus ring, and a batch reports progress instead of going quiet. |
| Batches of 200–300 (Sarah, Janet) | Up to 300 files per batch, paired by filename. One unreadable or oversized file becomes its own review case and never discards the batch. |
| No cloud APIs; firewall blocks egress (Marcus) | No request leaves the app's own origin. OCR assets are served from it. |
| No PII, no COLA integration (Marcus) | No server, credentials, or telemetry. The workspace lives only in the agent's own browser and **Reset workspace** erases it. |
| Judgment, not blind pattern matching (Dave) | Normalization tiers separate an exact match from a harmless formatting difference, and anything uncertain goes to the agent rather than being auto-decided. |
| Warning exact, all caps, and bold (Jenny) | Verbatim statutory comparison plus a separate capitalization check. Bold is treated as unprovable from an image; see below. |
| Imperfect images (Jenny) | Contrast stretching handles bad exposure. Skew, perspective, and glare are not corrected. |

## Tools used

| Tool | Why |
| --- | --- |
| React 18 + TypeScript + Vite | A static single-page app needs no server, which makes the no-egress constraint easy to satisfy and deployment a plain file copy. |
| tesseract.js 7 (+ `@tesseract.js-data/eng`) | A mature OCR engine that runs fully client-side. Pinned to the LSTM engine with automatic page segmentation. |
| Vitest | Same toolchain as Vite; no extra configuration. |
| IndexedDB (browser built-in) | Keeps the workspace, including image files, across a refresh without a server. |

The only runtime dependencies are React, React DOM, and tesseract.js, and `npm audit`
reports no vulnerabilities. GitHub Copilot and Claude Code were used as coding assistants
during development.

## Assumptions and trade-offs

- **The application arrives as a JSON file**, paired with its label by filename. COLA
  integration is out of scope, and a folder of artwork plus records is how an importer's
  batch would realistically be handed over.
- **Bold cannot be proven from recognised text**, so a warning read from an image is never
  auto-passed. It is held for human confirmation with the reason stated. Claiming to have
  verified something the reader cannot see would be worse than saying so.
- **OCR is a reading aid, not a decision-maker.** The recognised text is shown in full
  beside the artwork, so an agent who disagrees with a field can see exactly what was read.
- **Uploaded files are untrusted.** JSON is validated field by field, non-string values
  are coerced or dropped, case IDs are always minted by the app, and uploads are limited
  to 10 MB and JSON or image types.
- **A refused file reports `Not processed`**, not seven Review rows, because it never
  reached the comparison rules.
- **Normalization is deliberately narrow.** It never infers a missing value or guesses a
  unit from a bare number.

## Limitations and what I would do next

- **No manual entry form.** Application data must come from a JSON file; a form would suit
  one-off checks.
- **Geometry is not corrected.** A label photographed at an angle or with glare reads
  poorly. Deskew and perspective correction are the natural next step.
- **A misread digit is still a mismatch.** `750 mL` read as `150 mL` reports Mismatch,
  because numbers are the one thing the OCR rule trusts. Gating on Tesseract's per-word
  confidence would catch it.
- **Brand and class are positional.** A label with decorative text above the brand can
  mislead the extractor; the recognised-text panel lets an agent catch that.
- **Punctuation outside the brand counts.** `Ltd.` against `LTD` in a producer address is
  held for review rather than matched.
- **OCR runs on one worker.** Three labels are prepared at a time while it reads, which
  more than halves batch time, but a 300-label batch is still a background job of about
  four minutes. A worker pool sized to the machine's cores would be the next optimization.
- **English only.**
- **Persistence is per browser.** Work lives in one browser on one machine until reset. If
  two tabs are open, the last to save wins, and a refresh mid-batch leaves the files
  staged to be compared again. Real use would need a shared review record, which raises
  the retention and PII questions Marcus flagged.

## Testing

63 tests across five files, run on every push by GitHub Actions
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) along with a production build.

| File | Covers |
| --- | --- |
| `src/lib/verification.test.ts` | Comparison rules: warning validation, alcohol notation, pass/mismatch/review outcomes. |
| `src/lib/regressions.test.ts` | Edge cases pinned after they were found: statutory wording, dual-unit, fluid-ounce and comma-grouped volumes, accented brands, blank values, statute-only warning checks, confidence ordering. |
| `src/lib/extract.test.ts` | OCR field extraction, including title-case detection, brand and class separation, "Bottled in Bond", the warning's closing punctuation, and misreads captured from the deployed app. |
| `src/lib/cases.test.ts` | The untrusted-upload boundary: CSV formula escaping, ID uniqueness, malformed JSON. |
| `src/lib/batch.test.ts` | Input-order preservation, the cap, bounded concurrency, error propagation. |

## Project layout

```
src/
  App.tsx                review workspace, upload flow, CSV export
  ErrorBoundary.tsx      recovers from a render failure without a blank page
  lib/ocr.ts             Tesseract worker, preprocessing, asset wiring
  lib/extract.ts         recognised text -> LabelFields
  lib/verification.ts    all comparison rules
  lib/cases.ts           untrusted-input boundary, filename pairing
  lib/batch.ts           bounded batch processing
  lib/workspace-store.ts IndexedDB persistence
  data/fixtures.ts       test fixtures and the 27 CFR 16.21 warning text
public/samples/          sample label artwork and application records
scripts/vendor-ocr.mjs   copies OCR assets from node_modules at build time
docs/ASSIGNMENT.md       the original brief
```

## Deployment

The build output is static, so any static host can serve it. The live prototype is on
Vercel, which rebuilds from `main` using [`vercel.json`](vercel.json). No environment
variables or credentials are needed. `dist/` includes ~23 MB of OCR assets; that is the
cost of running OCR without egress, and a given browser fetches only the model and one
WASM core (~6 MB).
