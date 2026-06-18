# Blackboard Transcript Search Extension

Blackboard Transcript Search is an independent local Chrome extension for
searching Blackboard resources and optional video transcripts. It is not a fork
of another extension. It follows the same general personal-search pattern: each
user logs into Blackboard in Chrome, the extension indexes what their browser can
already see, and everything stays in the user's browser storage.

This repo is intentionally separate from the WhatsApp bot. The extension can be
used as a standalone personal search tool or as an admin ingestion helper for
preparing transcript/index data.

## What It Does

- Scans the active Blackboard tab for pages, links, files, embedded videos, and
  MP4/audio resources.
- Crawls nested Blackboard pages under an allowed URL prefix so course folders
  and subfolders can be indexed without clicking every page manually.
- Stores the local resource index in Chrome storage.
- Lets the user import a prepared transcript JSON bundle.
- Automatically attaches transcripts to discovered videos when titles, URLs, or
  source hints match.
- Lets the user manually attach a transcript to a video when matching is
  ambiguous.
- Searches normal resources and video transcript segments together in a chat-like
  local retrieval view.
- Includes a setup screen for provider/model/API key settings. External AI
  answering is intentionally not enabled until the extension manifest is updated
  with explicit third-party API permissions.

## What It Does Not Do Yet

- It does not automatically transcribe MP4 files inside Chrome.
- It does not upload course content or transcripts to a shared backend.
- It does not bypass Blackboard permissions; it only sees pages the user's
  logged-in browser can access.

## User Flow

1. Install the extension locally:
   - Open `chrome://extensions`.
   - Enable Developer mode.
   - Click Load unpacked.
   - Select this repo folder: `C:\repos\BlackboardSearchExtension`.
2. Open Blackboard and log in normally.
3. Navigate to a course/resource page.
4. Open the extension side panel.
5. Click `Crawl`.
   - Leave `Seed URL` blank to use the active tab.
   - Leave `Allowed URL prefix` blank for the current Blackboard site, or paste a
     narrower folder/course prefix to keep the crawl focused.
6. Use `Scan Active Tab` for a quick one-page refresh when needed.
7. Search the indexed resources.
8. If videos are found, import a transcript bundle:
   - Click `Import Transcripts`.
   - Select a JSON transcript bundle.
   - The extension auto-attaches transcripts where it can.
   - If a video still says `Transcript missing`, choose a transcript from the
     dropdown and click `Attach`.
9. Future searches include transcript segments instantly. The MP4 does not need
   to be transcribed again.

## API Setup

The setup screen stores the selected provider, model, and API key in local Chrome
storage. In the current build, chat answers still use local retrieval only. To
turn on synthesized AI answers, the extension must explicitly add host
permissions for the selected API provider. That is a privacy boundary: the user's
question and top retrieved Blackboard snippets/transcript segments would be sent
to that provider.

## Video Transcript Workflow

The extension treats transcript creation as a one-time preparation step:

```text
MP4 or embedded video
-> transcribe once outside the extension
-> save transcript JSON with timestamps
-> import transcript JSON into the extension
-> transcript is cached locally and searched forever
```

This avoids forcing every search to re-process the MP4. For a shared group, one
admin can transcribe important videos once and distribute the transcript bundle.

## Transcript Bundle Format

The extension accepts either an array of transcript records or an object with a
`transcripts` array.

```json
{
  "version": 1,
  "transcripts": [
    {
      "id": "c11-international-scholars-webinar-2026-04-28",
      "title": "C11 International Scholars Webinar",
      "source_hint": "April 28, 2026",
      "video_url": "",
      "segments": [
        {
          "start": "00:12:04",
          "end": "00:12:39",
          "text": "The X1 visa is valid for 30 days after entering China..."
        }
      ]
    }
  ]
}
```

Matching uses:

- `video_url`, when available.
- transcript `title` versus discovered video title/context.
- `source_hint`, such as date, course, or session name.
- manual attachment from the side panel when automatic matching is not confident.

## Repo Layout

```text
manifest.json                    Chrome extension manifest
background/service-worker.js      crawler, local storage, transcript import, matching
content/scraper.js                Blackboard page/resource/video detector
sidepanel/                        search and transcript UI
docs/                             additional notes
sample-data/                      example transcript bundle
```

## Development Notes

There is no build step. After editing files, reload the extension from
`chrome://extensions` and reopen the side panel.

Useful local validation:

```powershell
node --check background\service-worker.js
node --check content\scraper.js
node --check sidepanel\sidepanel.js
powershell -Command "Get-Content manifest.json | ConvertFrom-Json | Out-Null"
```

## Privacy

Resources, transcript bundles, and search history stay in local Chrome storage.
The current version does not call any LLM or transcription API. If transcription
support is added later, it should be explicit, opt-in, and cached.
