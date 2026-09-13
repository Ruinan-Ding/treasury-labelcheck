# LabelCheck

A prototype that helps a TTB compliance agent verify an alcohol beverage label against
its COLA application. Upload the label artwork; the app reads it on the spot, compares
every mandated field against the application record, and tells the agent which fields it
is confident about and which ones a human still has to decide.

Built for the Treasury IT Specialist (AI) take-home assignment. The brief it answers is
in [`docs/ASSIGNMENT.md`](docs/ASSIGNMENT.md).

**It runs entirely in the browser.** OCR, comparison, and export all happen on the
reviewer's machine. Nothing is uploaded, no API key is required, and the app makes no
outbound request of any kind after the page loads.

---

## Quick start

Requires Node.js 18+ and npm.

```bash
npm install
npm run dev
```

Open the URL Vite prints (normally `http://localhost:5173`).

```bash
npm test         # 57 tests
npm run build    # type-check and produce dist/
npm run preview  # serve the production build
```

`npm install` pulls the OCR engine; `npm run dev` and `npm run build` then copy its
worker, WASM core, and English model into `public/tesseract/` automatically. No manual
step, and no network access is needed once `npm install` has finished.

## Try it

The [`public/samples/`](public/samples) directory contains a synthetic, copyright-safe
batch of paired PNG label artworks and application JSON records. Stage the JSON files
in the **application** upload box and the images in the **label** upload box, then
click **Compare uploaded files**. The app pairs them by matching base filename:

| Upload | What it demonstrates |
| --- | --- |
| `old-tom.png` + `old-tom.json` | A clean pass. Six fields verify; the warning is held for a human because bold cannot be proven from an image. |
| `stones-throw.png` + `stones-throw.json` | Dave Morrison's judgment case: the label says `STONE'S THROW`, the application says `Stone's Throw`. Reported as a **normalized match**, not a mismatch. |
| `harbor-mist.png` + `harbor-mist.json` | Jenny Park's rejection case: correct warning wording in title case is a **mismatch**, alongside a genuine ABV and volume discrepancy. |

Additional paired cases cover:

- `abv-mismatch` — a numeric alcohol-content discrepancy.
- `volume-mismatch` — a net-content discrepancy.
- `warning-titlecase` and `warning-punctuation` — strict warning failures.
- `normalized-units` and `fluid-ounce-volume` — equivalent labels and explicit volume units.
- `import-origin` — imported-product origin and producer fields.
- `missing-fields` — an unavailable country-of-origin field held for review.
- `low-contrast-review` — a deliberately degraded but readable image.
- `unreadable-review` — a noisy image that should remain review-only.

These are demo inputs, not additional Treasury requirements. They make the
important decision paths reproducible without external image downloads.

Upload a label image on its own and it is still read and checked against the statutory
warning — that requirement comes from law, not from the application record.

`sample-case.json` exercises the structured path with no image at all.

The queue starts blank so the first screen reflects the real review workflow.
For a reproducible demo, stage the paired JSON records and label images from
`public/samples/` in their separate upload boxes and click **Compare uploaded
files**. This exercises the same OCR and filename-pairing path as a real batch.

The two upload boxes intentionally keep staged application records and label artwork
separate. Files may be added at different times; comparison starts only when the agent
clicks the compare button. Matching is case-insensitive and uses the filename before
the final extension. Unmatched records and images remain explicitly review-only rather
than being paired by upload order.

## Approach

The core loop the stakeholder interviews describe is: *an agent looks at the label
artwork and checks it against the application*. So the prototype had to actually read a
label, not ask the agent to transcribe one.

**Reading the label.** Tesseract is compiled to WebAssembly and runs in the browser.
Marcus Williams' notes say the TTB network blocks outbound traffic to most domains, and
that the previous vendor pilot failed for exactly that reason, so a cloud OCR API was
never a viable choice. The worker, the WASM core, and the ~2.9 MB English model are
served from the app's own origin — `scripts/vendor-ocr.mjs` copies them out of
`node_modules` at build time, which also keeps ~23 MB of binaries out of git.

**Reading the fields.** `src/lib/extract.ts` turns recognised text into the same
`LabelFields` shape a JSON upload produces, so both inputs meet identical comparison
rules. Every rule is anchored to wording TTB actually mandates — the statutory warning, a
percentage beside an alcohol term, a volume beside a real unit, a "bottled by" statement,
a "product of" statement. Only the brand name is resolved positionally, because it is the
one field with no required phrasing. **A field that cannot be found stays null and is
reported as Review; it is never guessed.**

**Pairing.** A peak-season batch arrives as a folder of artwork plus the matching
records, so `old-tom.png` is compared against `old-tom.json`. Matching on the filename the
submitter already uses avoids inventing a manifest format for a prototype. An application
record whose image never arrived is reported, not silently dropped.

**Deciding.** `src/lib/verification.ts` holds every comparison rule. Each field gets a
status (Match / Mismatch / Review), a tier (exact / normalized), and a confidence figure.
The app never decides a case — it sorts the obvious from the ones needing judgment, which
is what Sarah Chen said her agents actually need.

### How each field is judged

- **Government warning** — checked verbatim against 27 CFR 16.21: wording,
  capitalization, and punctuation must match, and only differences in how the source
  wrapped whitespace are tolerated. Title case in the prefix is a mismatch. Because the
  statute governs the label rather than the application, a lone label image is still
  checked against it.
- **Brand name** — accents are decomposed so they are stripped from their base letter
  rather than erasing the character (`MÖET` and `MÄET` must not normalize alike), then
  case and punctuation are normalized. This is what makes `STONE'S THROW` and
  `Stone's Throw` the same brand.
- **Net contents** — converted to millilitres when the unit is explicit. The unit is read
  from the text beside the matched number, so `750 mL (25.4 FL OZ)` reads as 750 mL, not
  as its parenthetical equivalent. A comma is a thousands separator when it groups three
  digits and a decimal separator otherwise. Equivalent volumes match within 1 mL.
- **Alcohol content** — common notations are normalized (`45% by volume`, `45% Alc./Vol.`,
  `45% ABV`) without converting or inferring any value.
- **Everything else** — whitespace and case normalization only.
- **Labels read by OCR** — recognised text cannot tell a misread from a misprint, so a
  difference in wording is Review, not Mismatch. Only what a misread cannot plausibly
  produce stays a mismatch: two cleanly read percentages or volumes that disagree, or a
  warning prefix set mostly in lowercase. A single stray lowercase letter (`WARNiNG`) is
  treated as a misread.
- **Missing values** — a blank on either side is Review, never a mismatch. A gap in the
  application is a data-entry problem for an agent, not evidence against the label.

Confidence reports how certain a rule is about the verdict it returned: an exact string
verify (0.99) outranks one that needed normalization (0.90); a mismatch is 0.95 and
anything held for a human is 0.35. A fuzzier judgement never outranks a stricter one. It
is a transparent rule-based signal, **not** a calibrated model probability.

### Meeting the interview constraints

| Constraint | How it is met |
| --- | --- |
| Results in ~5 seconds (Sarah) | 1.0–2.3 s per label measured end to end, including field extraction. Each case reports its own time. The OCR worker is created once and reused, so the model load is paid once per session rather than per label. |
| Usable by a 73-year-old; half the team is 50+ (Sarah) | Every text colour meets WCAG AA contrast, body and comparison text is at least 11px, status is carried by text and glyph as well as colour, every control has a visible focus ring, and the batch reports progress instead of going quiet. |
| Batch of 200–300 (Sarah, Janet) | Cap is 300, above the largest batch described. Three workers run concurrently, input order is preserved, and one bad file never discards the batch. |
| No cloud APIs; firewall blocks egress (Marcus) | Zero outbound requests after page load. OCR assets are same-origin. |
| No PII, no COLA integration (Marcus) | No persistence, no network, no credentials. Object URLs are released when the queue is cleared. |
| Judgment, not blind pattern matching (Dave) | Normalization tiers separate an exact verify from a harmless formatting difference, and anything uncertain is handed to the agent rather than auto-decided. |
| Warning exact, all-caps and bold (Jenny) | Verbatim statutory comparison plus a separate capitalization check. Bold is treated as unprovable from an image — see below. |
| Imperfect images (Jenny) | Grayscale plus a contrast stretch recovers text from flatly under- or over-exposed photographs. Skew, perspective, and glare are not corrected. |

## Tools used

| Tool | Why |
| --- | --- |
| React 18 + TypeScript + Vite | A static SPA needs no server, which makes the no-egress constraint trivially satisfiable and the deployment a plain file copy. |
| tesseract.js 7 (+ `@tesseract.js-data/eng`) | The only mature OCR engine that runs fully client-side. Pinned to the LSTM engine, with page segmentation set to `AUTO`. |
| Vitest | Same toolchain as Vite; no extra configuration. |

Runtime dependencies are React, React DOM, and tesseract.js. Everything else is a build or
test dependency, and `npm audit` reports no vulnerabilities.

## Assumptions and trade-offs

- **Bold cannot be proven from recognised text**, so the warning on an image is never
  auto-passed — it is held for human confirmation with the reason stated. This is
  deliberate: Jenny Park's requirement is that the prefix be all caps *and* bold, and
  claiming to have verified something the reader cannot see would be worse than saying so.
  A structured upload may assert `warningBold` explicitly.
- **OCR is a reading aid, not a decision-maker.** Recognised text is shown in full beside
  the artwork so an agent who disagrees with a field can see exactly what the reader saw.
- **The application record is trusted input; uploaded files are not.** Uploaded JSON is
  validated into `LabelFields`, non-string values are coerced or dropped, and case ids are
  always minted by the app so an uploaded file cannot collide with another case. CSV cells
  beginning `=`, `+`, `-`, or `@` are quoted so a spreadsheet will not execute them as
  formulas.
- **A refused file reports `Not processed`, not seven Review rows** — it never reached the
  comparison rules, and implying a review that never happened would be misleading. An
  unreadable *label* is different: it lists its fields, because an agent does have to look.
- **Uploads are capped at 10 MB and must be JSON or an image.** Batches over 300 report
  how many files were not processed rather than silently truncating.
- **Confidence is a UI signal, not a probability.** See above.
- **Normalization is deliberately narrow.** It covers harmless brand formatting,
  whitespace and case, and explicitly labelled units. It never infers a missing value or
  guesses a unit from a bare number.

## Limitations and what I would do next

- **Geometry is not corrected.** A label photographed at an angle or with glare will read
  poorly. Deskew and perspective correction are the natural next step and were out of
  scope here.
- **A misread digit is still a mismatch.** `750 mL` read as `150 mL` reports Mismatch,
  because numbers are the one thing the OCR rule trusts. Gating on Tesseract's per-word
  confidence would catch it.
- **Brand name is positional.** It is the first line no stronger rule claimed. A label
  with heavy decorative text above the brand could mislead it; the recognised-text panel
  exists partly so an agent can catch that.
- **OCR is serialized on one worker.** It is CPU-bound, so a 300-image batch is a
  background job, not an interactive wait. A worker pool sized to `hardwareConcurrency`
  would be the first optimization if throughput mattered.
- **English only**, and no COLA integration — Marcus explicitly scoped that out.
- **Nothing persists.** Reload and the queue is empty. Real use would need a review
  record, which brings the retention and PII questions Marcus flagged.

## Testing

57 tests across five files:

| File | Covers |
| --- | --- |
| `src/lib/verification.test.ts` | Comparison rules: warning validation, alcohol notation, pass/mismatch/review outcomes. |
| `src/lib/regressions.test.ts` | Edge cases pinned after they were found: statutory wording, dual-unit and comma-grouped volumes, accented brands, locale-invariant folding, blank values, statute-only warning checks, confidence ordering. |
| `src/lib/extract.test.ts` | OCR field extraction, including the title-case rejection and refusing to read a proof number as a volume; misreads captured from the deployed app held for review, while Harbor Mist's real discrepancies still mismatch. |
| `src/lib/cases.test.ts` | The untrusted-upload boundary: CSV formula escaping, id uniqueness, malformed JSON. |
| `src/lib/batch.test.ts` | Input-order preservation, the cap, bounded concurrency, error propagation. |

## Project layout

```
src/
  App.tsx              review workspace, upload flow, CSV export
  ErrorBoundary.tsx    keeps a render failure from discarding the queue
  lib/ocr.ts           Tesseract worker, preprocessing, asset wiring
  lib/extract.ts       recognised text -> LabelFields
  lib/verification.ts  all comparison rules
  lib/cases.ts         untrusted-input boundary, filename pairing
  lib/batch.ts         bounded concurrent batch processing
  data/fixtures.ts     sample cases and the 27 CFR 16.21 warning text
scripts/vendor-ocr.mjs copies OCR assets from node_modules at build time
public/samples/        sample label artwork and application records
```

## Deployment

The build output is static; any static host will serve it.

```bash
npm run build   # writes dist/
```

`vercel.json` is included for a zero-configuration Vercel deploy. No environment
variables or credentials are required at runtime. Note that `dist/` includes ~23 MB of
OCR assets — that is the cost of running OCR without egress, and only the model plus one
WASM core (~6 MB) is fetched by any given browser.

GitHub Pages is also configured through `.github/workflows/deploy-pages.yml`.
Enable **Settings → Pages → Source: GitHub Actions** in the repository, then
push to `main` or run the workflow manually. The published site will be:

```text
https://treasurytakehome-rgb.github.io/instructions/
```

The Vite build automatically uses `/instructions/` as its asset base on GitHub
Actions builds, so the bundled OCR worker, WASM, and language model resolve
correctly from the project site. Local development continues to use `/`.
