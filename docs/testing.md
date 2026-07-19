# Testing Guide

Use this checklist before publishing `main`, before merging a feature branch, and for every extension version.

## Automated Gate

Run this from the repo root:

```powershell
node scripts\prepublish-check.mjs
```

This is the required release gate. It verifies:

- `manifest.json` parses and all extension/library JavaScript passes syntax checks.
- Logged-in, logged-out, redirected-login, wrong-origin, and failed Blackboard session responses are classified correctly.
- Both full Blackboard indexing and optional pack installation check the Blackboard session before starting.
- Blackboard page requests have a bounded timeout; an unresponsive page is aborted, reported, and skipped while the remaining queue continues. Checkpoint saves also emit heartbeats and fail clearly while retaining earlier saves.
- Provider requests enforce token limits, deterministic temperatures, timeouts, authentication, provenance boundaries, and useful error reporting.
- A 23-question prepared-corpus evaluation, including the previously failed language, dining, payment, class-start, visa, packing, visitor/club, baggage, event-approval, and hospital questions, maintains at least 75% top-one accuracy and 0.85 MRR while retaining answer-bearing evidence.
- Candidate retrieval retains the exhaustive search winner within the top three.
- Chunks from one parent document collapse to one source while preserving distinct excerpts needed for multi-part questions.
- A mocked end-to-end answer pipeline runs query planning, retrieval, parent-document deduplication, generation, reviewer repair, citation alignment, claim validation, and final display enforcement against the real optional-pack text.
- API-mode evidence selection builds a bounded raw/facet/planner candidate pool, uses opaque candidate IDs and strict JSON validation, rejects prompt-injection or unknown-ID output, preserves semantic selection order, and can deep-read at most one provider-nominated parent document in bounded batches. Invalid selector or provider output falls back to deterministic evidence selection, never to an extractive snippet answer.
- The frozen V2 candidate-pool ceiling runs 180 shuffled executions and requires 100% expected-parent retention, at least 95% complete keyed-evidence executions, no zero-pass logical case, and bounded prompt size.
- Uncited or malformed model output fails closed; raw page-label and retrieval-snippet dumps are rejected.
- Malformed reviewer output is never displayed: the suite reproduces the leaked internal-critique failure, requires one clean recovery attempt, verifies valid reviewer JSON does not retry, and verifies repeated malformed output fails closed.
- The exact `Any advice for living in Beijing`, `How should I travel in Beijing`, and `Any recommendations for how to navigate travel in the program?` prompts are answered deterministically from the real packaged webinar files, with parent-document citations and no API dependency.
- A 960-resource synthetic corpus stays within the 2.5-second cold and 250-ms warm-query performance budgets.
- Pack manifests, prepared files, provenance, and transcript privacy checks pass.
- Transcript checks reject speaker labels, self-identifications, handoffs, transcription-service boilerplate, and glued-label artifacts.
- Core RAG, task extraction, course-list, language routing, document readiness, feedback, answer cleanup, citation numbering, and command regression cases pass.
- Screenshot-derived task tests exclude `Current Notification Setting` and `Change Settings` pages before ranking, require a settings-only corpus to yield zero task evidence, preserve the live There is no content to display To Do state as a grounded no-current-items answer, reject notification vocabulary as task fields, and collapse duplicate Blackboard pages with different URLs into one source.

The automated suite is deterministic and does not call a live API or Blackboard server.

## Authenticated Access Smoke Test

1. Reload the unpacked extension in `chrome://extensions`.
2. Sign out of Blackboard, then open the side panel.
3. Send `/index`.
4. Confirm the extension asks the user to log in and does not start a crawl.
5. Log in to Blackboard in the same Chrome profile.
6. Send `/index` again and confirm indexing starts.
7. Wait for indexing to finish. Confirm a slow page shows an increasing wait time rather than frozen progress.
8. Confirm the queue reaches zero or the configured page cap, and that any timed-out pages are reported as skipped.
9. Confirm the header reports indexed resources and searchable bodies.

This live browser check is still required because redirects and institutional SSO behavior cannot be fully reproduced by the offline test suite.

## Optional Pack Smoke Test

Use the maintainer-provided hidden pack trigger without adding it to visible help or introductory text.

1. Record the indexed-resource count before the test.
2. Sign out of Blackboard and enter the hidden trigger.
3. Confirm the status first says that the Blackboard session is being checked.
4. Confirm the extension then asks the user to log in.
5. Confirm the pack was not fetched or installed and the resource count did not change.
6. Sign in to Blackboard and enter the same trigger again.
7. Confirm the status says community-collated class resources are being indexed.
8. Confirm installation completes and the indexed-resource count increases.
9. Ask a question that requires two different chunks from one transcript or PDF.
10. Confirm the answer has one source card for the parent document, with the relevant evidence retained.

The session requirement is a usage gate. Bundled pack files are part of the extension package and are not encrypted access-controlled content.

## Core Question Set

Ask these after indexing real Blackboard content:

- `What are the current to do tasks?`
- `What should I pack for China?`
- `What do I need for the Chinese visa?`
- `What do I need for my Residence visa?`
- `Any tips for living in Beijing?`
- `How should I travel in Beijing?`
- `Any recommendations for how to navigate travel in the program?`
- `Have they released the list of courses?`
- `Where are the Mandarin grammar structures and vocab for each level?`
- `Are there career resources for finding a job in consulting?`
- `What can this tool do?`

For each answer, verify:

- It answers coherently from indexed material rather than only naming a document or pasting search excerpts.
- Material claims have compact bracket citations such as `[1]`.
- Citation numbers map to the displayed source cards and do not skip numbers.
- Sources are distinct parent documents, not repeated internal chunks or shell links.
- Expanding a source shows the passage needed to support the answer.
- `Open source` opens the expected Blackboard page, file, or pack document.
- The answer body does not include raw page labels, truncated retrieval snippets, a raw `Sources:` section, or raw Blackboard URLs.
- It does not say `downloaded resources`.
- It never displays reviewer analysis, draft critique, source-by-source deliberation, JSON, or phrases such as `Let's re-evaluate`.
- When official Blackboard material conflicts with community-collated material, the answer favors the official source and states the conflict.

## API Provider Smoke Test

Run once with each provider configuration supported by the release:

1. Ask one straightforward question with a strong indexed answer.
2. Ask one question for which the index has no answer.
3. Confirm the first response is sourced and the second does not invent an answer.
4. Temporarily use an invalid API key and confirm the provider error is readable.
5. Confirm a stalled request times out rather than leaving the side panel pending indefinitely.
6. Remove the key and confirm local evidence fallback still works.

The automated suite mocks provider calls; this smoke test covers the real network/provider contract.

## Randomized RAG Holdout Gate

The prepublish command now runs the version-locked, answer-keyed holdout automatically. To run it directly with a reproducible shuffle:

```powershell
node scripts\holdout-eval.mjs --seed release-a --repeats 3
```

The production `R1` lane is the release gate. It always uses fused multi-route retrieval, including deterministic facet routes when the live query planner is unavailable. `R0` is reported as a single-route ablation baseline; it is not the shipped answer path.

The holdout rotates three independently written paraphrases per logical case, shuffles resource insertion order, requires the expected parent documents and complete answer-bearing evidence, rejects any zero-pass case, and requires at least 95% case consistency. Do not tune production with a final blind suite and then describe that suite as unseen; create a new versioned suite for a fresh generalization check.

The live runner exercises the real planner, fused retrieval, LLM synthesis, reviewer/recovery, citation validation, and answer-key scoring. First verify its network-free wiring:

```powershell
node scripts\live-holdout-eval.mjs --suite v1 --self-test
node scripts\live-holdout-eval.mjs --suite v2 --self-test
```

Then run it with a real provider before upload. For example:

```powershell
$env:OPENAI_API_KEY = "..."
node scripts\live-holdout-eval.mjs --provider openai --model gpt-4.1-mini --seed release-a --repeats 3 --judge
```

The answer key is withheld from all production prompts and is used only after the final answer is generated. API keys are never printed. A three-repeat judged run can make several provider calls per case, so use `--case-limit` for a cheap smoke test before the full release gate.

## Feedback Test

Before packaging, configure the feedback form in `sidepanel/sidepanel.js`, then send:

```text
/feedback Test feedback from launch QA
```

Expected behavior:

- If configured, the form opens and the note prefills the first question.
- If no form URL is configured, the extension explains that feedback collection is not live.
- No private write token, GitHub token, API key, or service credential is embedded in the extension.

## Release Checklist

1. Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1`. This runs the full prepublish gate before creating an artifact.
2. Reload the generated `dist\BlackboardSearchExtension-<version>-unpacked` directory in Chrome.
3. For an upgraded legacy index, run `/reindex` while signed in and confirm Blackboard content refreshes without deleting the optional pack or API settings.
4. Repeat the authenticated-access and optional-pack smoke tests.
5. Run the live API-provider holdout gate and one end-to-end side-panel smoke question.
6. Inspect expanded source cards for provenance, relevance, and parent-document deduplication.
7. Confirm store screenshots and sample data reveal no private student information.
8. Confirm the builder reports the expected Schwarzman-pack file count and a SHA-256, then upload only the matching `dist\BlackboardSearchExtension-<version>.zip`.

## Video Branch Merge Gate

Before merging video functionality:

1. Run the full prepublish gate.
2. Repeat all browser smoke tests.
3. Compare the core question set against `main`.
4. Confirm text/PDF answers are not degraded by video or transcript results.
5. Confirm video UI stays grouped, closed by default, and usable at narrow side-panel widths.
6. Confirm duplicate media and transcript rows are deduplicated.
7. Confirm unsupported or oversized media fails clearly without poisoning text/PDF retrieval.

Do not merge video functionality until the core text and document answers remain at least as good as `main`.
