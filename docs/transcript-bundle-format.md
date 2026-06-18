# Transcript Bundle Format

Transcript bundles connect prepared transcript text to videos discovered by the
extension. A transcript can match a video automatically or be manually attached
from the side panel.

## Minimal Bundle

```json
{
  "transcripts": [
    {
      "title": "C11 International Scholars Webinar",
      "source_hint": "April 28, 2026",
      "segments": [
        {
          "start": "00:00:10",
          "end": "00:00:28",
          "text": "Welcome to the international scholars webinar..."
        }
      ]
    }
  ]
}
```

## Fields

- `id`: optional stable transcript ID. If missing, the extension generates one.
- `title`: human-readable video/session title. This is the most important
  matching field.
- `source_hint`: optional date, course, section, or session clue.
- `video_url`: optional exact video URL. Use this only if the URL is stable.
- `segments`: required list of timestamped transcript chunks.

Segment fields:

- `start`: optional timestamp such as `00:12:04`.
- `end`: optional timestamp such as `00:12:39`.
- `text`: required transcript text.

## Matching Behavior

Automatic matching scores discovered videos against transcript records using:

- exact URL match,
- normalized title match,
- title overlap,
- `source_hint` found in the video title/page/context.

If the score is high enough, the transcript is attached automatically. If not,
the video remains marked `Transcript missing` and the user can manually attach a
transcript from the dropdown in the side panel.

## Recommended Admin Process

1. Download or locate the MP4.
2. Transcribe it once outside the extension.
3. Save timestamped transcript segments as JSON.
4. Share the transcript bundle with users.
5. Users import the bundle once; future searches are instant.
