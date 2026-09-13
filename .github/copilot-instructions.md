# Copilot instructions

## Repository status

- The implementation is a Vite React TypeScript app. Use `npm install`, `npm run dev`, `npm test`, and `npm run build`.
- The browser entry point is `src/main.tsx`; the primary workspace is `src/App.tsx`.
- Comparison rules and warning validation live in `src/lib/verification.ts`; fixtures are in `src/data/fixtures.ts`; bounded batch processing is in `src/lib/batch.ts`.
- OCR runs in the browser via `src/lib/ocr.ts` (tesseract.js, LSTM engine, page segmentation `AUTO`). `src/lib/extract.ts` turns recognised text into the same `LabelFields` shape a JSON upload produces, so both inputs meet identical comparison rules.
- OCR assets are served same-origin from `public/tesseract/`, copied out of `node_modules` by `scripts/vendor-ocr.mjs` on `npm run dev` and `npm run build`. That directory is gitignored - never commit it, and never point OCR at a CDN: the target network blocks outbound traffic.
- Keep brand normalization more permissive than the strict government-warning check. Alcohol-content comparison may normalize equivalent labels such as `Alc./Vol.` and `ABV`, but must not silently convert units or numeric values. Missing or unreadable values must remain `Review`.
- Field results expose `exact`, `normalized`, `mismatch`, or `review` tiers in addition to the overall status. Preserve that distinction when changing result presentation. A case's overall status is `mismatch` if any field mismatches, otherwise `review` if any field needs review.
- Net-content matching allows 1 mL, or 1.5 mL when a fluid-ounce figure is involved, because labels round ounces to one decimal (`25.4 fl oz` is 750 mL).
- Net-content comparison may normalize explicitly labeled mL, L, cL, and fluid-ounce values to milliliters with a small tolerance; do not infer units from bare numbers.
- Uploaded JSON must remain self-contained: missing application fields become unavailable and must not inherit values from sample fixtures.
- Upload handling accepts JSON or image files up to 10 MB and rejects unsupported/oversized files explicitly. A label image is paired with an application record by filename (`old-tom.png` <- `old-tom.json`); a JSON carrying only an `application` object is staged until Compare and becomes an explicit application-only review case if no image is uploaded. Duplicate staged records are preserved and matched in filename order; per-file removal must not remove other duplicate stems. Files beyond the 300-file staging limit must be reported as omitted rather than silently dropped.
- A field the extractor cannot find stays `null` and surfaces as `Review`. Never invent a value. `warningBold` must stay unknown for OCR input - weight cannot be read from recognised text - so an image never auto-passes the warning check.
- The government warning is fixed by 27 CFR 16.21, so a label with no application record is still checked against the statute. Do not extend that statute-only handling to any other field.
- The queue's CSV export is generated in the browser. The workspace persists only in the browser's IndexedDB (`src/lib/workspace-store.ts`) so a refresh loses nothing, and Reset workspace clears it; bump `WORKSPACE_VERSION` when a saved shape changes. Do not add server-side persistence or external upload behavior without an explicit requirement.
- The empty state's **Stage sample batch** button fetches the files named by `SAMPLE_PAIRS`, `SAMPLE_JSON`, and `SAMPLE_IMAGES` (`src/App.tsx`) from `public/samples/` and stages them through the normal upload path. It is offered only while nothing is staged and is guarded against double clicks. Keep those lists and the README sample table in sync with the files.
- Per-batch OCR concurrency stays at `DEFAULT_CONCURRENCY` (3): recognition queues on one worker, but overlapping image decoding more than halves batch time (measured 13 s vs 30 s for 17 samples).
- GitHub Actions (`.github/workflows/ci.yml`) runs `npm test` and `npm run build` on every push; the live prototype deploys from `main` on Vercel.
- The CSV includes case metadata and each field's application value, label evidence, status, tier, and confidence. Rejected files must leave field-level export columns blank because no comparison ran. Paired display names use filename stems; unmatched files retain extensions; duplicate names receive `(2)`, `(3)`, and so on.
- Human decisions are separate from automated statuses: Accept, Needs review, or Reject persist with the workspace, are switchable, shown as colored queue dots, and exported without overwriting Match/Mismatch/Review.
- `vitest.config.ts` limits the root test command to this app's `src/**/*.test.ts` and `src/**/*.test.tsx` files; do not accidentally include reference projects or unrelated nested test suites.
- Tests run with Vitest and live in `src/lib/verification.test.ts` (comparison rules), `src/lib/regressions.test.ts` (comparison edge cases, statute-only warning checks, fixture integrity), `src/lib/extract.test.ts` (OCR field extraction), `src/lib/cases.test.ts` (the untrusted-upload boundary), and `src/lib/batch.test.ts` (batching). The narrowest useful test command is `npm test -- src/lib/verification.test.ts`.
- `vercel.json` describes a static Vite deployment. No credentials or external OCR service are required; `dist/` carries ~23 MB of OCR assets by design.
- Sample label artwork and matching application records are in `public/samples/`. They were generated once and committed; there is no generator dependency in `package.json`.

## Product context

The repository describes a standalone proof-of-concept for AI-assisted alcohol label verification. It is not intended to integrate directly with the TTB COLA system in this prototype.

The take-home assessment expects a complete source repository and a deployed application that Treasury can access. The project README should include setup and run instructions plus a brief account of the approach, tools used, assumptions, and meaningful trade-offs.

The core workflow should help a compliance agent compare an application with label artwork, including:

- Brand name
- Class/type designation
- Alcohol content
- Net contents
- Bottler/producer name and address
- Country of origin for imports
- Required government health warning

The README calls out these product constraints:

- Results should be available in about five seconds to be useful in the agent workflow.
- The interface should be obvious for agents with mixed technical comfort levels.
- Batch uploads matter because importers may submit hundreds of applications at once.
- The government warning requires exact wording; `GOVERNMENT WARNING:` must be all caps and bold.
- Brand-name comparisons need judgment rather than only case-sensitive string equality; formatting differences such as capitalization may still represent the same name.
- Poor image quality, skew, lighting, and glare are useful future considerations. `src/lib/ocr.ts` does grayscale plus a contrast stretch, which handles flat exposure; skew and perspective are deliberately not corrected.

## Architecture and integration boundaries

- Keep the prototype standalone unless the repository gains an explicit integration design. The README says direct COLA integration is out of scope.
- Avoid introducing cloud or external ML dependencies. The target network blocks outbound traffic, and the app must make no request of any kind after page load; anything added has to run locally and be vendored the way the OCR runtime is.
- Treat uploaded labels and applications as potentially sensitive in any future implementation. Do not add unnecessary persistence, external transmission, or telemetry without documenting the decision and its implications.
- Preserve a clear path for human review. The README emphasizes that label matching can require judgment, so automated results should not silently replace an agent’s decision.

## Working conventions

- Use the README as the source of truth for product requirements until implementation-specific documentation is added.
- Prefer a focused, reliable core workflow over ambitious incomplete features, matching the README’s evaluation guidance.
- When adding a framework, service, or tool, add its setup and validation commands to the project README and update this file only with repository-specific usage that future sessions need.
- When adding tests, document the full-suite command and the narrowest command for running one test or test file here.
