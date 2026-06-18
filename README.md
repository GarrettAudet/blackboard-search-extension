# Blackboard Search Extension

Blackboard Search Extension is an independent local Chrome extension for
crawling Blackboard, searching resources, importing video transcripts, and
answering questions with a user-provided API key. It is not a fork of another
extension. It follows the same general personal-search pattern: each user logs
into Blackboard in Chrome, the extension indexes what their browser can already
see, and everything stays in the user's browser storage except the matched
snippets sent to the selected API provider for synthesized answers.

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
- Shows detected videos that do not have transcripts and can transcribe direct
  audio/video files through OpenAI, then cache the searchable transcript locally.
- Searches normal resources and video transcript segments together in a chat-like
  local retrieval view.
- Includes a setup screen for OpenAI, DeepSeek, or OpenRouter API settings.
  OpenRouter users can specify the exact sub-model in the model field.

## What It Does Not Do Yet

- It does not guarantee transcription for every embedded player. If Blackboard
  only exposes a player page instead of a direct audio/video file, import a
  prepared transcript JSON bundle instead.
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
3. Open the extension side panel.
4. Click `Library`, then `Index Blackboard`.
   - Crawling starts from the Blackboard portal page and looks for links under
     `My Courses`.
   - Course links are crawled first, then sub-links, resource pages, embedded
     videos, and file links inside those course areas are indexed.
   - The default crawl limit is fixed at 1500 pages.
5. Use `Scan Current Page` for a quick one-page refresh when needed.
6. Search the indexed resources.
7. If videos are found, open `Library`.
   - Videos without transcripts appear under `Videos Needing Transcripts`.
   - Select OpenAI in Setup and save an API key to use `Transcribe` or
     `Transcribe All` for direct audio/video files.
   - Or click `Import Transcripts` and select a prepared JSON transcript bundle.
8. Future searches include transcript segments instantly. The MP4 does not need
   to be transcribed again.

## API Setup

The setup screen stores the selected provider, model, and API key in local Chrome
storage. The chat retrieves top local Blackboard matches first, then sends the
user's question plus those matched snippets/transcript segments to the selected
provider for a synthesized answer.

Supported providers:

- OpenAI: use an OpenAI model name such as `gpt-4.1-mini`.
- DeepSeek: use a DeepSeek model name such as `deepseek-chat`.
- OpenRouter: use an OpenRouter route or sub-model, such as `openrouter/auto`,
  `openai/gpt-4.1-mini`, or `deepseek/deepseek-chat`.

Video transcription currently uses OpenAI audio transcription. The extension
downloads the detected media with the user's logged-in Blackboard session,
sends that media to OpenAI, checks that the returned transcript looks usable,
and stores the resulting searchable transcript locally.

## Video Transcript Workflow

The extension treats transcript creation as a one-time preparation step:

```text
Detected direct media file
-> transcribe once with OpenAI from the Library tab
-> quality-check and chunk transcript text
-> store transcript locally in Chrome
-> transcript is cached locally and searched forever
```

For embedded players that do not expose a direct audio/video file, prepare a
transcript outside the extension and import it as JSON. This avoids forcing
every search to re-process the MP4. For a shared group, one admin can transcribe
important videos once and distribute the transcript bundle.

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
LLM answering sends only the user's question plus top matched snippets to the
selected provider. Video transcription is explicit and opt-in from the Library
tab; generated transcripts are cached locally.
