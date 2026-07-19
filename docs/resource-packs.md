# Optional Resource Packs

Optional resource packs let students add prepared resources to the same local index used for Blackboard content. A pack is installed by a maintainer-registered hidden command, and its searchable text is stored in `chrome.storage.local`. Do not advertise hidden pack commands in user-facing intro, help, setup, or empty-state text.

Pack installation requires an active Blackboard session in the same Chrome profile. The extension verifies that session before it fetches the manifest or any pack file. This is a usage prerequisite, not cryptographic access control: files bundled with the extension package can still be inspected by someone who has the package.

The extension should not clone private repos or ship private credentials. Use a private repo as the authoring source if needed, then copy only distributable manifests and prepared files into the extension.

## Manifest

Each pack has a `pack.json` file:

```json
{
  "id": "example-class",
  "title": "Example Class Optional Resources",
  "version": "2026.07.1",
  "description": "Optional community-collated class resources.",
  "resources": [
    {
      "id": "arrival-guide-pages-001-010",
      "title": "Arrival Guide.pdf",
      "type": "document",
      "url": "texts/arrival-guide-pages-001-010.txt",
      "text_url": "texts/arrival-guide-pages-001-010.txt",
      "document_id": "arrival-guide",
      "document_title": "Arrival Guide.pdf",
      "page_range": "1-10",
      "provenance": "community-authored guide"
    }
  ]
}
```

Resource fields:

- `id`: stable identifier for this prepared resource or chunk.
- `title`: fallback source title.
- `type`: `pdf`, `document`, `slides`, `spreadsheet`, `page`, or `link`.
- `url`: bundled or hosted source URL. Relative paths resolve next to `pack.json`.
- `text_url`: prepared plain text used instead of browser extraction.
- `content`: optional inline searchable text for small resources.
- `document_id`: stable parent-document identifier shared by all chunks from one document.
- `document_title`: parent title shown in the single deduplicated source card.
- `page_range`: page range, timestamp range, or internal chunk label.
- `provenance`: concise origin category used in source display and ranking.
- `description`: optional source context.
- `section` / `page_title`: optional labels shown in source cards.

Every resource must declare provenance. Prepared webinar or workshop transcripts use `program webinar transcript`; community-authored material should use a clear category such as `community-authored guide`.

## Adding A PDF

1. Put the distributable PDF under `resource-packs/<pack-id>/files/`, or generate prepared text under `texts/`.
2. Add the resource to `pack.json`.
3. Give every chunk the same `document_id` and `document_title`.
4. Give each chunk its actual page range.
5. Add accurate provenance.
6. Reload the unpacked extension and sign in to Blackboard.
7. Run the maintainer-provided hidden trigger.
8. Ask a query that should hit multiple sections and confirm only one parent-document source card appears.

For large or scanned PDFs, generate text outside the extension and reference it with `text_url`. Browser PDF extraction only works for PDFs with readable embedded text.

## Transcript Privacy

Do not package raw transcript exports. Keep original `.txt`, `.docx`, `.vtt`, `.srt`, or similar files in a private source folder. Commit only sanitized prepared text under `resource-packs/<pack-id>/texts/`.

For timestamped transcripts, preserve markers such as `[00:00]` or `00:00` and remove every speaker label and speaker name. Also remove names from introductions, handoffs, thanks, chat references, and labels glued to the first spoken word. For untimed exports, use speaker-free chunks and `page_range` values such as `chunk 1`; do not invent timestamps that were not present in the source.

A human quality pass is required after automated sanitization. Search the prepared transcript set for every speaker name observed in the private source, then read the beginning, every speaker transition, and the end of each prepared chunk.

Run the focused pack check:

```powershell
node scripts\resource-pack-check.mjs
```

The check rejects missing files, oversized prepared chunks, raw transcript-like files, missing provenance, transcription-service boilerplate, speaker labels, introductions, handoffs, and glued speaker-label artifacts. It also runs synthetic privacy fixtures so the detector itself cannot silently regress.

The full every-version release gate is:

```powershell
node scripts\prepublish-check.mjs
```

## Registering Commands

Hidden pack commands are registered in `OPTIONAL_RESOURCE_PACKS` in `sidepanel/sidepanel.js`. Keep this list small and explicit:

```js
{
  id: "example-class",
  command: "/<hidden-pack-command>",
  title: "Example Class Optional Resources",
  manifestPath: "resource-packs/example-class/pack.json"
}
```

The handler must confirm an authenticated Blackboard session before calling the installer. The command value should be shared out of band only with the intended cohort.

If a hosted URL is used instead of `manifestPath`, the manifest and files must be fetchable by the extension and allowed by `manifest.json` host permissions. Never embed GitHub tokens, private repository credentials, API keys, or signed URLs that should remain secret.
