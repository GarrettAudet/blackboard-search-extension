import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packDirs = [path.join(repoRoot, "resource-packs", "schwarzman-c11")];
const MAX_TEXT_CHARS = 20000;
const TRANSCRIPT_PRIVACY_PATTERNS = [
  ["transcription boilerplate", /\b(?:Transcribed by|TurboScribe|Otter\.ai|otter\.ai|This file is longer than \d+ minutes)\b/i],
  ["speaker word", /\bspeakers?\b/i],
  ["self-introduction with name", /\b(?:I'm|I\u2019m|I am|My name is)\s+[A-Z][A-Za-z.'-]+/],
  ["handoff with name", /\b(?:turn|pass|hand)(?:ing)?(?:\s+it)?\s+(?:over|back)\s+to\s+[A-Z][A-Za-z.'-]+/],
  ["thanks with name", /\b(?:Thanks?|Thank you),?\s+[A-Z][A-Za-z.'-]+/],
  ["glued speaker label", /(?:^|\n)\s*(?:\[[0-9:.]+\]\s*)?(?:[\p{L}.'()\uFF08\uFF09-]+\s+){0,3}[\p{L}.'()\uFF08\uFF09-]{2,40}(?=(?:Um|Uhm|Okay|Hello|Hi|Perfect|Hey|Great|Oh|Yay|Yes|Yeah|She|He|I|So|Thank|Sorry|Welcome)\b)/mu],
  ["glued lower-case speaker label", /(?:^|\n)\s*(?:\[[0-9:.]+\]\s*)?(?:[\p{L}.'()\uFF08\uFF09-]+\s+){0,3}[\p{L}.'()\uFF08\uFF09-]{2,40}(?=(?:about|calling|well|she|still|can|until)\b)/mu]
];
const failures = [];
let checkedResources = 0;
let checkedTranscriptChunks = 0;

function fail(message) {
  failures.push(message);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${path.relative(repoRoot, filePath)} is not valid JSON: ${error.message}`);
    return null;
  }
}

function packRelative(packDir, filePath) {
  return path.relative(packDir, filePath).replace(/\\/g, "/");
}

function repoRelative(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

function isRemoteRef(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function resolvePackRef(packDir, ref, field, resourceId) {
  if (!ref || isRemoteRef(ref)) return null;
  const resolved = path.resolve(packDir, ref);
  const relative = path.relative(packDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${resourceId}.${field} escapes the pack directory: ${ref}`);
    return null;
  }
  if (!fs.existsSync(resolved)) {
    fail(`${resourceId}.${field} points to a missing file: ${ref}`);
  }
  return resolved;
}

function listFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const output = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...listFilesRecursive(fullPath));
    else output.push(fullPath);
  }
  return output;
}

function isTranscriptResource(resource) {
  const haystack = [
    resource.id,
    resource.title,
    resource.section,
    resource.page_title,
    resource.document_id,
    resource.document_title,
    resource.text_url,
    resource.description
  ].filter(Boolean).join(" ");
  return /\b(webinar|workshop|transcript)\b/i.test(haystack);
}

function scanTranscriptText(resource, textPath, text) {
  const label = `${resource.id} (${packRelative(path.dirname(path.dirname(textPath)), textPath)})`;
  for (const [name, pattern] of TRANSCRIPT_PRIVACY_PATTERNS) {
    if (pattern.test(text)) fail(`${label} contains ${name}; transcript chunks must not identify who is speaking.`);
  }

  const allowedSingleLabels = new Set(["A", "Q", "Question", "Answer", "Note", "Tip", "Agenda", "Summary"]);
  const singleLabel = /(?:^|\n)\s*(?:\[[0-9:.]+\]\s*)?([A-Z][A-Za-z.'-]{1,30})\s*:/g;
  for (const match of text.matchAll(singleLabel)) {
    if (!allowedSingleLabels.has(match[1])) {
      fail(`${label} has a possible speaker label near line ${lineNumberAt(text, match.index)}.`);
      break;
    }
  }

  const multiLabel = /(?:^|\n)\s*(?:\[[0-9:.]+\]\s*)?[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,4}\s*:/;
  if (multiLabel.test(text)) fail(`${label} has a possible multi-word speaker label.`);

  if (/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/.test(resource.page_range || "")) {
    const firstContentLine = text.split(/\r?\n/).find((line) => line.trim());
    if (firstContentLine && !/^\[\d{1,2}:\d{2}/.test(firstContentLine.trim())) {
      fail(`${label} is a timed chunk but does not start with a timestamp.`);
    }
  }
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

const privacyFixtures = [
  "00:10\nExampleNameOkay, welcome.",
  "00:10\nAliasabout now?"
];
for (const fixture of privacyFixtures) {
  if (!TRANSCRIPT_PRIVACY_PATTERNS.some(([, pattern]) => pattern.test(fixture))) {
    fail("Transcript privacy detector missed synthetic glued speaker-label fixture.");
  }
}
const safePrivacyFixture = "00:10\nOkay, welcome to the session.";
if (TRANSCRIPT_PRIVACY_PATTERNS.some(([, pattern]) => pattern.test(safePrivacyFixture))) {
  fail("Transcript privacy detector rejected a timestamp-only speaker-free fixture.");
}

for (const packDir of packDirs) {
  const manifestPath = path.join(packDir, "pack.json");
  const pack = readJson(manifestPath);
  if (!pack) continue;
  if (!pack.id) fail(`${repoRelative(manifestPath)} is missing id.`);
  if (!pack.title) fail(`${repoRelative(manifestPath)} is missing title.`);
  if (!Array.isArray(pack.resources) || !pack.resources.length) {
    fail(`${repoRelative(manifestPath)} has no resources.`);
    continue;
  }

  const filesDir = path.join(packDir, "files");
  for (const filePath of listFilesRecursive(filesDir)) {
    if (/\.(?:txt|docx?|rtf|vtt|srt)$/i.test(filePath)) {
      fail(`${repoRelative(filePath)} is a raw text/transcript-like source in the distributable files folder; put sanitized text under texts/ and keep originals private.`);
    }
  }

  const ids = new Set();
  for (const resource of pack.resources) {
    checkedResources += 1;
    if (!resource || typeof resource !== "object") {
      fail(`${repoRelative(manifestPath)} has a non-object resource.`);
      continue;
    }
    if (!resource.id) fail("A pack resource is missing id.");
    else if (ids.has(resource.id)) fail(`Duplicate resource id: ${resource.id}`);
    else ids.add(resource.id);
    if (!resource.title) fail(`${resource.id || "unknown"} is missing title.`);
    if (!resource.type) fail(`${resource.id || "unknown"} is missing type.`);
    if (!resource.url) fail(`${resource.id || "unknown"} is missing url.`);
    const transcriptResource = isTranscriptResource(resource);
    const provenance = String(resource.provenance || "").trim();
    if (!provenance) fail((resource.id || "unknown") + " is missing provenance.");
    if (transcriptResource && provenance.toLowerCase() !== "program webinar transcript") {
      fail((resource.id || "unknown") + " must use program webinar transcript provenance.");
    }

    resolvePackRef(packDir, resource.url, "url", resource.id || "unknown");
    const textPath = resolvePackRef(packDir, resource.text_url, "text_url", resource.id || "unknown");
    if (!resource.text_url && !resource.content) {
      fail(`${resource.id || "unknown"} has no prepared searchable text_url/content.`);
    }
    if (textPath && fs.existsSync(textPath)) {
      const text = fs.readFileSync(textPath, "utf8");
      if (text.length > MAX_TEXT_CHARS) {
        fail(`${repoRelative(textPath)} is ${text.length} chars; keep prepared chunks <= ${MAX_TEXT_CHARS}.`);
      }
      if (transcriptResource) {
        checkedTranscriptChunks += 1;
        scanTranscriptText(resource, textPath, text);
      }
    }
  }
}

if (failures.length) {
  console.error("resource-pack-check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`resource-pack-check passed (${checkedResources} resources, ${checkedTranscriptChunks} transcript chunks)`);




