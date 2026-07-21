#!/usr/bin/env python3
"""Rebuild sanitized, time-ranged Schwarzman C11 webinar transcript chunks."""

from __future__ import annotations

import json
import hashlib
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from zipfile import ZipFile


REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = REPO_ROOT.parent / "private-resource-sources" / "schwarzman-c11"
PACK_DIR = REPO_ROOT / "resource-packs" / "schwarzman-c11"
TEXT_DIR = PACK_DIR / "texts"
MANIFEST_PATH = PACK_DIR / "pack.json"
PACK_VERSION = "2026.07.8"
TARGET_CHARS = 17_500
MAX_CHARS = 19_500
WORD_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
TIMECODE = r"\d{1,3}:\d{2}(?::\d{2})?(?:,\d+)?"
RANGE_RE = re.compile(
    rf"^\s*({TIMECODE})\s*-->\s*({TIMECODE})(?:\s*\[[^\]]+\])?\s*(?:\n\s*)?(.*?)\s*$",
    re.DOTALL,
)


@dataclass(frozen=True)
class TranscriptSpec:
    document_id: str
    title: str
    source_file: str
    description: str


@dataclass(frozen=True)
class Segment:
    start_seconds: float
    end_seconds: float
    text: str


TRANSCRIPTS = (
    TranscriptSpec(
        "student-life-webinar",
        "C11 Student Life Webinar transcript",
        "C11 Student Life Webinar_20260707.docx",
        "Sanitized searchable transcript from the C11 Student Life webinar. Speaker names were removed before packaging.",
    ),
    TranscriptSpec(
        "international-logistics-webinar",
        "C11 International Scholars Logistics Webinar transcript",
        "C11 International Scholars Logistics Webinar.docx",
        "Sanitized searchable transcript from the C11 international scholars logistics webinar. Speaker names were removed before packaging.",
    ),
    TranscriptSpec(
        "academic-webinar",
        "C11 Academic Webinar transcript",
        "C11 Academic Webinar_260617.docx",
        "Sanitized searchable transcript from the C11 academic webinar. Speaker names were removed before packaging.",
    ),
    TranscriptSpec(
        "beijing-transportation-workshop",
        "Beijing Public Transportation Webinar transcript",
        "Student Webinar - Public Transportation in Beijing.docx",
        "Sanitized searchable transcript from the Beijing public transportation webinar. Speaker names were removed before packaging.",
    ),
    TranscriptSpec(
        "discovering-beijing-webinar",
        "Discovering Beijing Webinar transcript",
        "Student Webinar - Discovering Beijing.docx",
        "Sanitized searchable transcript from the Discovering Beijing student webinar. Speaker names were removed before packaging.",
    ),
)


def fail(message: str) -> None:
    raise RuntimeError(message)


def read_docx_paragraphs(path: Path) -> list[str]:
    if not path.is_file():
        fail(f"Missing private transcript source: {path.name}")
    with ZipFile(path) as archive:
        document = ET.fromstring(archive.read("word/document.xml"))
    paragraphs: list[str] = []
    for paragraph in document.iter(WORD_NS + "p"):
        pieces: list[str] = []
        for node in paragraph.iter():
            if node.tag == WORD_NS + "t" and node.text:
                pieces.append(node.text)
            elif node.tag == WORD_NS + "tab":
                pieces.append("\t")
            elif node.tag == WORD_NS + "br":
                pieces.append("\n")
        text = "".join(pieces).strip()
        if text:
            paragraphs.append(text)
    return paragraphs


def timecode_seconds(value: str) -> float:
    raw = value.strip().replace(",", ".")
    parts = raw.split(":")
    if len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    fail(f"Invalid transcript timecode: {value}")


def display_time(seconds: float) -> str:
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def sanitize_utterance(value: str) -> str:
    text = re.sub(r"\s*\[Speaker\s+\d+\]\s*", " ", value, flags=re.IGNORECASE)
    text = re.sub(
        r"^(?:[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,4})\s*:\s*",
        "",
        text,
    )
    text = re.sub(r"\b(?:Transcribed by|TurboScribe|Otter\.ai|otter\.ai)\b.*$", "", text, flags=re.IGNORECASE)
    text = re.sub(
        r"\b(?:My name is|I am|I'm|I’m)\s+[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)?",
        "I am a program team member",
        text,
    )
    text = re.sub(
        r"\b((?:turn|pass|hand)(?:ing)?(?:\s+it)?\s+(?:over|back)\s+to)\s+[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)?",
        r"\1 the next presenter",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"\b(Thanks?|Thank you),?\s+[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)?",
        r"\1",
        text,
    )
    text = re.sub(r"\bspeakers\b", "presenters", text, flags=re.IGNORECASE)
    text = re.sub(r"\bspeaker\b", "presenter", text, flags=re.IGNORECASE)
    text = re.sub(r"\bWudaoko\b", "Wudaokou", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def parse_ranged_transcript(path: Path) -> list[Segment]:
    paragraphs = read_docx_paragraphs(path)
    segments: list[Segment] = []
    index = 0
    while index < len(paragraphs):
        match = RANGE_RE.match(paragraphs[index])
        if not match:
            index += 1
            continue
        start, end, body = match.groups()
        if not body and index + 1 < len(paragraphs) and not RANGE_RE.match(paragraphs[index + 1]):
            index += 1
            body = paragraphs[index]
        body = sanitize_utterance(body)
        if body:
            start_seconds = timecode_seconds(start)
            end_seconds = timecode_seconds(end)
            if end_seconds < start_seconds:
                fail(f"Reversed transcript range in {path.name}: {start} --> {end}")
            segments.append(Segment(start_seconds, end_seconds, body))
        index += 1
    if not segments:
        fail(f"No timestamped transcript segments found in {path.name}")
    for previous, current in zip(segments, segments[1:]):
        if current.start_seconds + 0.01 < previous.start_seconds:
            fail(f"Non-monotonic transcript timestamps in {path.name}")
    return segments


def render_segment(segment: Segment) -> str:
    return f"[{display_time(segment.start_seconds)}] {segment.text}"


def chunk_segments(segments: list[Segment]) -> list[list[Segment]]:
    chunks: list[list[Segment]] = []
    current: list[Segment] = []
    current_chars = 0
    for segment in segments:
        rendered = render_segment(segment)
        added = len(rendered) + (2 if current else 0)
        if current and current_chars + added > TARGET_CHARS:
            chunks.append(current)
            current = []
            current_chars = 0
            added = len(rendered)
        if len(rendered) > MAX_CHARS:
            fail("A single transcript segment exceeds the pack chunk safety ceiling")
        current.append(segment)
        current_chars += added
    if current:
        chunks.append(current)
    return chunks


def page_range_for_chunk(chunk: list[Segment]) -> str:
    return f"{display_time(chunk[0].start_seconds)}-{display_time(chunk[-1].end_seconds)}"


def resource_for_chunk(spec: TranscriptSpec, chunk: list[Segment], index: int) -> dict[str, str]:
    chunk_id = f"{spec.document_id}-{index:03d}"
    text_url = f"texts/{chunk_id}.txt"
    return {
        "id": chunk_id,
        "title": spec.title,
        "type": "document",
        "url": text_url,
        "text_url": text_url,
        "description": spec.description,
        "section": "Optional webinar transcripts - Schwarzman C11",
        "page_title": spec.title,
        "document_id": spec.document_id,
        "document_title": spec.title,
        "page_range": page_range_for_chunk(chunk),
        "provenance": "program webinar transcript",
    }


def write_generated_transcript(spec: TranscriptSpec) -> list[dict[str, str]]:
    segments = parse_ranged_transcript(SOURCE_DIR / spec.source_file)
    chunks = chunk_segments(segments)
    for existing in TEXT_DIR.glob(f"{spec.document_id}-*.txt"):
        existing.unlink()
    resources: list[dict[str, str]] = []
    for index, chunk in enumerate(chunks, start=1):
        resource = resource_for_chunk(spec, chunk, index)
        body = "\n\n".join(render_segment(segment) for segment in chunk).strip() + "\n"
        if len(body) > MAX_CHARS:
            fail(f"Generated chunk exceeds {MAX_CHARS} characters: {resource['id']}")
        (PACK_DIR / resource["text_url"]).write_text(body, encoding="utf-8", newline="\n")
        resources.append(resource)
    print(
        f"{spec.document_id}: {len(segments)} segments, {len(chunks)} chunks, "
        f"{display_time(segments[0].start_seconds)}-{display_time(segments[-1].end_seconds)}"
    )
    return resources


def timestamp_range_from_pack_text(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    timestamps = [
        timecode_seconds(match.group(1))
        for match in re.finditer(rf"^\s*\[?({TIMECODE})\]?\s*$", text, re.MULTILINE)
    ]
    if not timestamps:
        fail(f"Existing sanitized transcript lacks timestamps: {path.name}")
    return f"{display_time(timestamps[0])}-{display_time(timestamps[-1])}"


def preserved_life_in_china_resources(manifest: dict) -> list[dict]:
    resources = [
        dict(resource)
        for resource in manifest.get("resources", [])
        if resource.get("document_id") == "life-in-china-webinar"
    ]
    if not resources:
        fail("The existing sanitized Life in China transcript is missing from the pack")
    previous_end = ""
    for resource in resources:
        text_path = PACK_DIR / resource["text_url"]
        text = text_path.read_text(encoding="utf-8")
        first_content_line = next((line.strip() for line in text.splitlines() if line.strip()), "")
        if previous_end and not re.match(rf"^\[?{TIMECODE}\]?$", first_content_line):
            text = f"{previous_end}\n\n{text.lstrip()}"
            text_path.write_text(text, encoding="utf-8", newline="\n")
        resource["page_range"] = timestamp_range_from_pack_text(text_path)
        previous_end = resource["page_range"].rsplit("-", 1)[-1]
    return resources


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_survival_guide_source() -> None:
    private_pdf = SOURCE_DIR / "Schwarzman Scholars Survival Guide.pdf"
    packaged_pdf = PACK_DIR / "files" / "Schwarzman Scholars Survival Guide.pdf"
    if not private_pdf.is_file() or not packaged_pdf.is_file():
        fail("The private or packaged Schwarzman Scholars Survival Guide PDF is missing")
    if sha256_file(private_pdf) != sha256_file(packaged_pdf):
        fail("The Survival Guide PDF changed; regenerate its page text before publishing the pack")
    print("survival-guide: private and packaged PDFs match")


def main() -> int:
    if not SOURCE_DIR.is_dir():
        fail(f"Private source directory not found: {SOURCE_DIR}")
    verify_survival_guide_source()
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    guide_resources = [
        resource for resource in manifest.get("resources", []) if resource.get("document_id") == "survival-guide"
    ]
    life_resources = preserved_life_in_china_resources(manifest)
    generated_by_document = {
        spec.document_id: write_generated_transcript(spec) for spec in TRANSCRIPTS
    }
    ordered_documents = (
        "student-life-webinar",
        "international-logistics-webinar",
        "academic-webinar",
        "life-in-china-webinar",
        "beijing-transportation-workshop",
        "discovering-beijing-webinar",
    )
    transcript_resources: list[dict] = []
    for document_id in ordered_documents:
        if document_id == "life-in-china-webinar":
            transcript_resources.extend(life_resources)
        else:
            transcript_resources.extend(generated_by_document[document_id])
    manifest["version"] = PACK_VERSION
    manifest["resources"] = guide_resources + transcript_resources
    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"pack: {len(manifest['resources'])} resources, version {PACK_VERSION}")
    print("alternate Student Life transcription excluded: Webinars Class of 2026-2027 Pre-program.mp4.docx")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"build-schwarzman-c11-pack failed: {error}", file=sys.stderr)
        sys.exit(1)
