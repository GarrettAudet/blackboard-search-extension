# Testing Guide

Use this checklist before publishing `main` and before merging any feature branch back into `main`.

## Automated Gate

Run this from the repo root:

```powershell
node scripts\prepublish-check.mjs
```

This verifies:

- `manifest.json` parses.
- Background, content, and sidepanel JavaScript parse.
- Core RAG regression cases still pass.
- To-do extraction avoids duplicate/noisy tasks.
- Mandarin/resource retrieval excludes unrelated English-language hits.
- Course-list retrieval prioritizes calendar/schedule sources.
- PDF/document readiness fails closed when file body text is unreadable.
- Citation numbering stays compact with no gaps.
- Raw Blackboard URL sections are stripped from main answers.
- `/feedback` builds a pre-filled feedback form URL when configured.
- `/index` and `/reindex` are treated as commands.

## Clean Install Smoke Test

1. Check out `main`.
2. Open `chrome://extensions`.
3. Remove the old unpacked extension or click reload.
4. Load unpacked from the repo folder.
5. Open Blackboard and log in.
6. Open the extension side panel.
7. Confirm the first assistant message tells the user to run `/index` for first use.
8. Send `/index` and confirm indexing starts without exposing maintenance buttons.
9. Wait for indexing to finish.
10. Confirm the header shows indexed resources and searchable bodies.

## Core Question Set

Ask these after indexing real Blackboard content:

- `What are the current to do tasks?`
- `What should I pack for China?`
- `What do I need for the Chinese visa?`
- `Have they released the list of courses?`
- `Where are the Mandarin grammar structures and vocab for each level?`
- `Are there career resources for finding a job in consulting?`
- `What can this tool do?`

For each answer, verify:

- It answers from the indexed material rather than only naming a document.
- It does not say `downloaded resources`.
- It does not include an inline `Sources:` block in the text body.
- Source numbers are compact and do not skip numbers.
- Sources are unique enough to be useful, not repeated shell links.
- Expanding sources shows relevant files/pages.
- `Open source` opens the expected Blackboard page or document.

## Feedback Test

Before packaging, set `FEEDBACK_FORM_URL` in `sidepanel/sidepanel.js` if you want live feedback collection. For Google Forms, also set the `FEEDBACK_FORM_FIELD_MAP` values to the form's `entry.<id>` field names.

Send:

```text
/feedback Test feedback from launch QA
```

Expected behavior:

- If configured, the extension opens the feedback form with the note and metadata attached.
- Metadata includes extension version, indexed resource count, searchable body count, and timestamp.
- If no form URL is configured, the extension tells the user to send the note directly to the maintainer.
- No private write tokens or GitHub tokens are embedded in the extension.

## Video Branch Merge Gate

Before merging `video-functionality` into `main`:

1. Run `node scripts\prepublish-check.mjs` on the video branch.
2. Repeat the clean install smoke test.
3. Repeat the core question set and compare quality against `main`.
4. Confirm normal text/PDF answers are not degraded by video/transcript results.
5. Confirm video UI is grouped, closed by default, and does not overflow at narrow side-panel widths.
6. Confirm duplicate video detections and duplicate transcript rows are deduped.
7. Confirm unsupported/oversized media fails with a clear message and does not poison text/PDF retrieval.

Do not merge video functionality until the core text/PDF answers remain at least as good as `main`.
