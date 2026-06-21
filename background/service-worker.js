const RESOURCE_KEY = "resource_index";
const TRANSCRIPT_KEY = "transcript_store";
const CONTENT_KEY = "content_store";
const META_KEY = "index_meta";
const DETECTED_MEDIA_KEY = "detected_media_store";
const IGNORED_MEDIA_KEY = "ignored_media_store";
const DEFAULT_CRAWL_SEED_URL =
  "https://lms.sc.tsinghua.edu.cn/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1";
const BLOCKED_EXTERNAL_MEDIA_HOST_PATTERN = /(^|\.)(youtube\.com|youtu\.be|googlevideo\.com|vimeo\.com)$/i;
const ALLOWED_TRANSCRIPT_MEDIA_HOST_PATTERN = /(^|\.)(tsinghua\.edu\.cn|blackboard\.com|bbcollab\.com|kaltura\.com|panopto\.com|echo360\.org|echo360\.com|yuja\.com|mediasite\.com)$/i;

setupMediaRequestObservers();

try {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
} catch (_error) {
  // Older Chromium builds may not expose sidePanel behavior controls.
}

const captionImportInflight = new Set();
let activeCrawlPromise = null;

function setupMediaRequestObservers() {
  if (!chrome.webRequest || !chrome.webRequest.onBeforeRequest) return;
  const filter = {
    urls: ["https://*/*"],
    types: ["media", "xmlhttprequest", "other", "sub_frame", "object"]
  };
  chrome.webRequest.onBeforeRequest.addListener((details) => {
    captureMediaRequest(details).catch(() => {});
  }, filter);
  chrome.webRequest.onHeadersReceived.addListener((details) => {
    captureMediaRequest(details, responseContentType(details.responseHeaders)).catch(() => {});
  }, filter, ["responseHeaders"]);
}

function responseContentType(headers = []) {
  const header = (headers || []).find((item) => /^content-type$/i.test(item.name || ""));
  return cleanText(header && header.value, 160).toLowerCase();
}

async function captureMediaRequest(details, contentType = "") {
  if (!details || !details.url || details.tabId < 0) return;
  if (!isTsinghuaMediaUrl(details.url)) return;
  const classification = classifyMediaRequest(details, contentType);
  if (!classification) return;
  const mediaKey = mediaCandidateKey(details.url);

  const tab = await getTabSnapshot(details.tabId);
  const title = cleanText(fileNameFromUrl(details.url) || tab.title || classification.kind, 240);
  const seed = {
    url: details.url,
    document_url: details.documentUrl || details.frameUrl || "",
    initiator: details.initiator || "",
    page_url: tab.url || details.documentUrl || details.initiator || "",
    page_title: tab.title || "",
    title
  };
  const canonicalKey = canonicalVideoKey(seed) || (mediaKey ? `media:${mediaKey}` : "");
  if ((canonicalKey && (await isIgnoredMediaKey(canonicalKey))) || (mediaKey && (await isIgnoredMediaKey(mediaKey)))) return;

  const detection = {
    id: stableId(["detected_media", classification.kind, canonicalKey || mediaKey || details.url]),
    canonical_key: canonicalKey || mediaKey,
    kind: classification.kind,
    url: details.url,
    content_type: contentType || classification.contentType || "",
    request_type: details.type || "",
    document_url: seed.document_url,
    initiator: seed.initiator,
    tab_id: details.tabId,
    page_url: seed.page_url,
    page_title: seed.page_title,
    title,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    seen_count: 1
  };

  const stored = await storeDetectedMedia(detection);
  if (classification.kind === "caption") {
    importDetectedCaption(stored).catch(() => {});
  }
  if (classification.kind === "direct_media") {
    mergeDetectedDirectMedia(stored).catch(() => {});
  }
}

function classifyMediaRequest(details, contentType = "") {
  const url = String(details.url || "");
  const lower = url.toLowerCase();
  const type = String(details.type || "").toLowerCase();
  const content = String(contentType || "").toLowerCase();
  if (isLikelyChunkUrl(lower)) return null;

  if (/\.(vtt|srt|ttml|dfxp)(?:[?#]|$)/i.test(lower) || /text\/vtt|application\/x-subrip|application\/ttml\+xml/i.test(content)) {
    return { kind: "caption", contentType: content };
  }
  if (/(caption|captions|subtitle|subtitles|transcript|texttrack|timedtext|cue)/i.test(lower) && !/\.css(?:[?#]|$)/i.test(lower)) {
    return { kind: "caption", contentType: content };
  }
  if (/\.(m3u8|mpd)(?:[?#]|$)/i.test(lower) || /mpegurl|dash\+xml/i.test(content)) {
    return { kind: "manifest", contentType: content };
  }
  if (/\.(mp4|mov|m4v|webm|mp3|m4a|wav|aac|ogg)(?:[?#]|$)/i.test(lower) || /^(audio|video)\//i.test(content) || type === "media") {
    return { kind: "direct_media", contentType: content };
  }
  return null;
}

function isLikelyChunkUrl(lowerUrl) {
  return /\.(m4s|cmfv|cmfa|ts)(?:[?#]|$)/i.test(lowerUrl) || /(?:segment|frag|chunk)[-_]?\d+/i.test(lowerUrl);
}

function isTsinghuaMediaUrl(url) {
  const raw = String(url || "");
  if (/(youtube\.com|youtu\.be|googlevideo\.com|vimeo\.com)/i.test(raw)) return false;
  const host = hostnameFromUrl(raw);
  if (!host) return /(tsinghua\.edu\.cn|blackboard\.com|bbcollab\.com|panopto|kaltura|echo360|yuja|mediasite)/i.test(raw);
  if (BLOCKED_EXTERNAL_MEDIA_HOST_PATTERN.test(host)) return false;
  return ALLOWED_TRANSCRIPT_MEDIA_HOST_PATTERN.test(host);
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_error) {
    return "";
  }
}

function pruneDetectedMediaToTsinghua(records) {
  return (Array.isArray(records) ? records : []).filter((item) => isTsinghuaMediaUrl(item && item.url));
}
async function getTabSnapshot(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url || "", title: tab.title || "" };
  } catch (_error) {
    return { url: "", title: "" };
  }
}

async function storeDetectedMedia(detection) {
  const data = await chrome.storage.local.get([DETECTED_MEDIA_KEY, IGNORED_MEDIA_KEY]);
  const ignoredKeys = ignoredMediaKeys(data[IGNORED_MEDIA_KEY]);
  if (mediaCandidateIsIgnored(detection, ignoredKeys)) return detection;
  const current = Array.isArray(data[DETECTED_MEDIA_KEY]) ? data[DETECTED_MEDIA_KEY] : [];
  const byId = new Map(current.map((item) => [item.id, item]));
  const previous = byId.get(detection.id);
  const next = previous
    ? {
        ...previous,
        ...withoutEmpty(detection),
        first_seen_at: previous.first_seen_at || detection.first_seen_at,
        last_seen_at: new Date().toISOString(),
        seen_count: (previous.seen_count || 1) + 1
      }
    : detection;
  byId.set(next.id, next);
  const records = Array.from(byId.values())
    .sort((a, b) => String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || "")))
    .slice(0, 300);
  await chrome.storage.local.set({ [DETECTED_MEDIA_KEY]: records });
  emitMediaDetected(next);
  return next;
}

async function importDetectedCaptions() {
  const data = await chrome.storage.local.get(DETECTED_MEDIA_KEY);
  const detections = Array.isArray(data[DETECTED_MEDIA_KEY]) ? data[DETECTED_MEDIA_KEY] : [];
  let imported = 0;
  let failed = 0;
  for (const detection of detections.filter((item) => item.kind === "caption" && !item.imported_transcript_id)) {
    try {
      const result = await importDetectedCaption(detection);
      if (result && result.imported) imported += 1;
    } catch (_error) {
      failed += 1;
    }
  }
  return { ok: true, imported, failed };
}

async function importDetectedCaption(detection) {
  if (!detection || !detection.url || captionImportInflight.has(detection.id)) return { imported: false };
  captionImportInflight.add(detection.id);
  try {
    const data = await chrome.storage.local.get([RESOURCE_KEY, DETECTED_MEDIA_KEY]);
    const detections = Array.isArray(data[DETECTED_MEDIA_KEY]) ? data[DETECTED_MEDIA_KEY] : [];
    const current = detections.find((item) => item.id === detection.id) || detection;
    if (current.imported_transcript_id) return { imported: false, transcript_id: current.imported_transcript_id };

    const response = await fetch(detection.url, { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const segments = parseCaptionSegments(text);
    if (!segments.length) throw new Error("No timed caption cues found.");

    const resources = data[RESOURCE_KEY] || [];
    const matched = bestResourceForDetection(detection, resources);
    const transcriptId = stableId(["detected_caption", detection.url]);
    const transcript = {
      id: transcriptId,
      title: detection.page_title || detection.title || "Detected video captions",
      source_hint: "Detected caption file",
      video_url: detection.document_url || detection.page_url || detection.url,
      matched_resource_ids: matched ? [matched.id] : [],
      segments
    };
    const result = await importTranscripts({ transcripts: [transcript] });
    await updateDetectedMedia(detection.id, {
      imported_transcript_id: transcriptId,
      transcript_status: result.ok ? "imported" : "failed",
      transcript_error: result.ok ? "" : result.error || "Import failed"
    });
    return { imported: true, transcript_id: transcriptId };
  } catch (error) {
    await updateDetectedMedia(detection.id, {
      transcript_status: "failed",
      transcript_error: String(error && error.message ? error.message : error).slice(0, 240)
    });
    throw error;
  } finally {
    captionImportInflight.delete(detection.id);
  }
}

async function updateDetectedMedia(id, patch) {
  const data = await chrome.storage.local.get(DETECTED_MEDIA_KEY);
  const detections = Array.isArray(data[DETECTED_MEDIA_KEY]) ? data[DETECTED_MEDIA_KEY] : [];
  const next = detections.map((item) => (item.id === id ? { ...item, ...patch, last_seen_at: new Date().toISOString() } : item));
  await chrome.storage.local.set({ [DETECTED_MEDIA_KEY]: next });
  const updated = next.find((item) => item.id === id);
  if (updated) emitMediaDetected(updated);
}

function emitMediaDetected(payload) {
  chrome.runtime.sendMessage({ type: "MEDIA_DETECTED", payload }, () => {
    void chrome.runtime.lastError;
  });
}

async function mergeDetectedDirectMedia(detection) {
  if (!detection || !detection.url) return;
  if (await isIgnoredMediaUrl(detection.url)) return;
  const type = /audio\//i.test(detection.content_type || "") || /\.(mp3|m4a|wav|aac|ogg)(?:[?#]|$)/i.test(detection.url)
    ? "audio"
    : "video";
  const sourceTitle = detectedMediaSourceTitle(detection);
  const canonicalKey = canonicalVideoKey(detection) || (mediaCandidateKey(detection.url) ? `media:${mediaCandidateKey(detection.url)}` : detection.url);
  const result = await mergeScrape({
    resources: [
      {
        id: stableId(["resource", "video_resource", canonicalKey]),
        canonical_key: canonicalKey,
        type,
        title: sourceTitle,
        url: detection.url,
        preserve_url: true,
        page_url: detection.page_url || detection.document_url || detection.url,
        page_title: sourceTitle,
        section: sourceTitle,
        context: ["Detected while playing video", detection.document_url, detection.initiator].filter(Boolean).join(" - "),
        discovered_at: new Date().toISOString()
      }
    ]
  });
  emitMediaDetected({ ...detection, resource_status: result.ok ? "indexed" : "index_failed" });
}

function detectedMediaSourceTitle(detection) {
  const candidates = [detection?.page_title, detection?.title, fileNameFromUrl(detection?.url), "Blackboard video"];
  for (const candidate of candidates) {
    const cleaned = cleanText(candidate, 240);
    if (cleaned && !/^(detected media request|detected media|fragmented\.mp4|index\.m3u8|master\.m3u8)$/i.test(cleaned)) {
      return cleaned;
    }
  }
  return "Blackboard video";
}

function bestResourceForDetection(detection, resources) {
  const videos = resources.filter(isVideoResource);
  const detectionKey = canonicalVideoKey(detection);
  const pageUrl = normalizeUrl(detection.page_url || "");
  const documentUrl = normalizeUrl(detection.document_url || "");
  return (
    videos.find((resource) => detectionKey && canonicalVideoKey(resource) === detectionKey) ||
    videos.find((resource) => normalizeUrl(resource.url || "") === documentUrl) ||
    videos.find((resource) => normalizeUrl(resource.page_url || "") === pageUrl) ||
    videos.find((resource) => normalizeText(resource.page_title || "") === normalizeText(detection.page_title || "")) ||
    null
  );
}

function parseCaptionSegments(text) {
  const clean = String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/^WEBVTT[^\n]*\n/i, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const blocks = clean.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => /-->/i.test(line));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex].match(/([\d:. ,]+)\s*-->\s*([\d:. ,]+)/);
    if (!timing) continue;
    const cueText = lines
      .slice(timingIndex + 1)
      .join(" ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
    if (!cueText) continue;
    segments.push({
      id: String(segments.length),
      start: normalizeCaptionTimestamp(timing[1]),
      end: normalizeCaptionTimestamp(timing[2]),
      speaker: "Speaker 1",
      text: cueText
    });
  }
  return mergeTranscriptSegments([], segments);
}

function normalizeCaptionTimestamp(value) {
  const normalized = String(value || "").replace(",", ".").trim().split(/\s+/)[0];
  const parts = normalized.split(":");
  if (parts.length === 2) return `00:${parts[0].padStart(2, "0")}:${parts[1].padStart(6, "0")}`;
  if (parts.length === 3) return `${parts[0].padStart(2, "0")}:${parts[1].padStart(2, "0")}:${parts[2].padStart(6, "0")}`;
  return normalized;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
  return true;
});

async function handleMessage(message) {
  if (!message || !message.type) return { ok: false, error: "missing_message_type" };
  switch (message.type) {
    case "SCRAPE_PAGE":
      return mergeScrape(message.payload || {});
    case "GET_INDEX":
      return getIndex();
    case "STORE_CONTENT":
      return storeContent(message.payload || {});
    case "CLEAR_INDEX":
      return clearIndex();
    case "SCAN_ACTIVE_TAB":
      return scanActiveTab();
    case "CRAWL_SITE":
      return startCrawlSite(message.payload || {});
    case "IMPORT_TRANSCRIPTS":
      return importTranscripts(message.payload || {});
    case "IMPORT_DETECTED_CAPTIONS":
      return importDetectedCaptions();
    case "DISMISS_MEDIA_CANDIDATE":
      return dismissMediaCandidate(message.payload || {});
    case "RESTORE_DISMISSED_MEDIA":
      return restoreDismissedMedia();
    case "SEARCH_VIDEO_RESULTS":
      return searchVideoResults(message.payload || {});
    case "MANUAL_ATTACH_TRANSCRIPT":
      return manualAttachTranscript(message.payload || {});
    default:
      return { ok: false, error: `unknown_message_type:${message.type}` };
  }
}

async function dismissMediaCandidate(payload) {
  const data = await chrome.storage.local.get([DETECTED_MEDIA_KEY, IGNORED_MEDIA_KEY]);
  const detections = Array.isArray(data[DETECTED_MEDIA_KEY]) ? data[DETECTED_MEDIA_KEY] : [];
  const ignored = Array.isArray(data[IGNORED_MEDIA_KEY]) ? data[IGNORED_MEDIA_KEY] : [];

  const detection = detections.find((item) => item.id === payload.id || item.id === payload.detected_media_id || item.id === payload.detectedMediaId);
  const selectedRecords = [payload, detection].filter(Boolean);
  const keyValues = uniqueStrings(selectedRecords.flatMap(mediaCandidateKeys));
  const selectedUrls = uniqueStrings([payload.url, payload.video_url, payload.videoUrl, detection?.url].filter(Boolean).map(normalizeUrl));

  const ignoredByKey = new Map(ignored.map((item) => [item.key, item]));
  for (const key of keyValues) {
    ignoredByKey.set(key, {
      key,
      url: payload.url || detection?.url || "",
      title: cleanText(payload.title || detection?.title || detection?.page_title || "Dismissed media", 240),
      ignored_at: new Date().toISOString()
    });
  }

  const matchesKeys = (candidate) => keyValues.length && mediaCandidateKeys(candidate).some((key) => keyValues.includes(key));
  const exactUrlMatch = (candidate) => selectedUrls.includes(normalizeUrl(candidate?.url || ""));
  const nextDetections = detections.filter((item) => item.id !== detection?.id && !(detection && (matchesKeys(item) || exactUrlMatch(item))));

  await chrome.storage.local.set({
    [DETECTED_MEDIA_KEY]: nextDetections,
    [IGNORED_MEDIA_KEY]: Array.from(ignoredByKey.values()).slice(-500)
  });
  return {
    ok: true,
    ignored: keyValues.length,
    removed_resources: 0,
    removed_detections: detections.length - nextDetections.length
  };
}

async function restoreDismissedMedia() {
  const data = await chrome.storage.local.get(IGNORED_MEDIA_KEY);
  const ignored = Array.isArray(data[IGNORED_MEDIA_KEY]) ? data[IGNORED_MEDIA_KEY] : [];
  await chrome.storage.local.set({ [IGNORED_MEDIA_KEY]: [] });
  return { ok: true, restored_ignored: ignored.length };
}
async function getIndex() {
  const data = await chrome.storage.local.get([RESOURCE_KEY, TRANSCRIPT_KEY, CONTENT_KEY, META_KEY, DETECTED_MEDIA_KEY, IGNORED_MEDIA_KEY]);
  let resources = data[RESOURCE_KEY] || [];
  let transcripts = data[TRANSCRIPT_KEY] || [];
  const contentStore = data[CONTENT_KEY] || {};
  const detectedMedia = data[DETECTED_MEDIA_KEY] || [];
  const ignoredRecords = Array.isArray(data[IGNORED_MEDIA_KEY]) ? data[IGNORED_MEDIA_KEY] : [];
  const ignoredKeys = ignoredMediaKeys(ignoredRecords);
  const prunedDetectedMedia = pruneDetectedMediaToTsinghua(detectedMedia).filter((item) => !mediaCandidateIsIgnored(item, ignoredKeys));
  const deduped = dedupeTranscriptIndex(resources, transcripts);
  resources = deduped.resources;
  transcripts = deduped.transcripts;
  if (deduped.changed) {
    matchTranscriptsToResources(resources, transcripts);
    await saveIndex(resources, transcripts, contentStore);
  }
  const meta = data[META_KEY] || { resource_count: resources.length, transcript_count: transcripts.length };
  return {
    ok: true,
    resources,
    transcripts,
    detected_media: prunedDetectedMedia,
    ignored_media_keys: Array.from(ignoredKeys),
    ignored_media_count: ignoredRecords.length,
    content_store: contentStore,
    meta
  };
}

async function clearIndex() {
  await chrome.storage.local.set({
    [RESOURCE_KEY]: [],
    [TRANSCRIPT_KEY]: [],
    [CONTENT_KEY]: {},
    [DETECTED_MEDIA_KEY]: [],
    [IGNORED_MEDIA_KEY]: [],
    [META_KEY]: {
      resource_count: 0,
      transcript_count: 0,
      content_count: 0,
      content_char_count: 0,
      last_updated: new Date().toISOString()
    }
  });
  return { ok: true };
}

async function mergeScrape(payload) {
  const scrapedResources = Array.isArray(payload.resources) ? payload.resources : [];
  const scrapedTranscripts = normalizeTranscriptBundle(payload.transcripts || []);
  const data = await chrome.storage.local.get([RESOURCE_KEY, TRANSCRIPT_KEY, CONTENT_KEY, IGNORED_MEDIA_KEY]);
  const ignoredKeys = ignoredMediaKeys(data[IGNORED_MEDIA_KEY]);
  const currentResources = data[RESOURCE_KEY] || [];
  let transcripts = data[TRANSCRIPT_KEY] || [];
  const contentStore = data[CONTENT_KEY] || {};
  const byId = new Map(currentResources.map((resource) => [resource.id, resource]));

  for (const raw of scrapedResources) {
    const normalized = normalizeResource(raw);
    if (!normalized.url && !normalized.title) continue;
    if (mediaCandidateIsIgnored(normalized, ignoredKeys)) continue;
    const resource = resourceMetadataFrom(normalized);
    const content = searchableContentFrom(normalized);
    if (content) contentStore[resource.id] = content;
    const existing = byId.get(resource.id);
    if (existing) {
      byId.set(resource.id, {
        ...existing,
        ...withoutEmpty(resource),
        transcript_ids: uniqueStrings([...(existing.transcript_ids || []), ...(resource.transcript_ids || [])]),
        first_seen_at: existing.first_seen_at || resource.discovered_at,
        last_seen_at: new Date().toISOString()
      });
    } else {
      byId.set(resource.id, {
        ...resource,
        transcript_ids: uniqueStrings(resource.transcript_ids || []),
        first_seen_at: resource.discovered_at || new Date().toISOString(),
        last_seen_at: new Date().toISOString()
      });
    }
  }

  if (scrapedTranscripts.length) {
    const transcriptById = new Map(transcripts.map((transcript) => [transcript.id, transcript]));
    for (const transcript of scrapedTranscripts) {
      transcriptById.set(transcript.id, mergeTranscriptRecords(transcriptById.get(transcript.id), transcript));
    }
    transcripts = Array.from(transcriptById.values());
  }

  let resources = Array.from(byId.values());
  const deduped = dedupeTranscriptIndex(resources, transcripts);
  resources = deduped.resources;
  transcripts = deduped.transcripts;
  matchTranscriptsToResources(resources, transcripts);
  await saveIndex(resources, transcripts, contentStore);
  return {
    ok: true,
    added_or_updated: scrapedResources.length,
    transcripts_imported: scrapedTranscripts.length,
    resource_count: resources.length,
    transcript_count: transcripts.length,
    content_count: Object.keys(contentStore).length
  };
}
async function importTranscripts(payload) {
  const incoming = normalizeTranscriptBundle(payload);
  if (!incoming.length) return { ok: false, error: "no_transcripts_found" };

  const data = await chrome.storage.local.get([RESOURCE_KEY, TRANSCRIPT_KEY]);
  const resources = data[RESOURCE_KEY] || [];
  const existing = data[TRANSCRIPT_KEY] || [];
  const byId = new Map(existing.map((transcript) => [transcript.id, transcript]));

  for (const transcript of incoming) {
    byId.set(transcript.id, mergeTranscriptRecords(byId.get(transcript.id), transcript));
  }

  let transcripts = Array.from(byId.values());
  const deduped = dedupeTranscriptIndex(resources, transcripts);
  transcripts = deduped.transcripts;
  const matchSummary = matchTranscriptsToResources(resources, transcripts);
  await saveIndex(resources, transcripts);
  return {
    ok: true,
    imported: incoming.length,
    segment_count: incoming.reduce((sum, transcript) => sum + (transcript.segments || []).length, 0),
    transcript_count: transcripts.length,
    auto_attached: matchSummary.autoAttached,
    unmatched: transcripts.filter((transcript) => !(transcript.matched_resource_ids || []).length).length
  };
}
async function manualAttachTranscript(payload) {
  const resourceId = String(payload.resource_id || "").trim();
  const transcriptId = String(payload.transcript_id || "").trim();
  if (!resourceId || !transcriptId) return { ok: false, error: "missing_resource_or_transcript" };

  const data = await chrome.storage.local.get([RESOURCE_KEY, TRANSCRIPT_KEY]);
  const resources = data[RESOURCE_KEY] || [];
  const transcripts = data[TRANSCRIPT_KEY] || [];
  const resource = resources.find((item) => item.id === resourceId);
  const transcript = transcripts.find((item) => item.id === transcriptId);
  if (!resource || !transcript) return { ok: false, error: "resource_or_transcript_not_found" };

  resource.transcript_ids = uniqueStrings([...(resource.transcript_ids || []), transcriptId]);
  transcript.matched_resource_ids = uniqueStrings([...(transcript.matched_resource_ids || []), resourceId]);
  transcript.updated_at = new Date().toISOString();
  await saveIndex(resources, transcripts);
  return { ok: true };
}

async function searchVideoResults(payload) {
  const query = cleanText(payload.query || "", 240);
  const videos = (Array.isArray(payload.videos) ? payload.videos : [])
    .map((video) => ({
      id: cleanText(video.id || video.resource_id || "", 120),
      title: cleanText(video.title || video.name || "Video", 240),
      url: normalizeUrl(video.url || video.video_url || video.href || ""),
      page_title: cleanText(video.page_title || "", 240),
      section: cleanText(video.section || "", 240)
    }))
    .filter((video) => video.url && /^https?:\/\//i.test(video.url))
    .slice(0, 3);

  if (!query || !videos.length) {
    return { ok: true, searched: 0, transcripts_imported: 0, segment_count: 0, failures: [] };
  }

  const transcripts = [];
  const failures = [];
  for (const video of videos) {
    try {
      const transcript = await searchSingleVideoResults(video, query);
      if (transcript && transcript.segments && transcript.segments.length) transcripts.push(transcript);
    } catch (error) {
      failures.push({
        title: video.title,
        url: video.url,
        error: String(error && error.message ? error.message : error)
      });
    }
  }

  if (!transcripts.length) {
    return { ok: true, searched: videos.length, transcripts_imported: 0, segment_count: 0, failures };
  }

  const importResult = await importTranscripts({ transcripts });
  return {
    ok: true,
    searched: videos.length,
    transcripts_imported: importResult.imported || transcripts.length,
    segment_count: importResult.segment_count || transcripts.reduce((sum, transcript) => sum + transcript.segments.length, 0),
    transcript_count: importResult.transcript_count,
    auto_attached: importResult.auto_attached,
    failures
  };
}

async function searchSingleVideoResults(video, query) {
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: video.url, active: false });
    if (!tab || !tab.id) throw new Error("Could not open video tab for search.");
    await waitForTabComplete(tab.id, 45000);
    await sleep(2500);

    const frameResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: searchVisibleVideoResultsInPage,
      args: [query]
    });

    const rawSegments = [];
    let title = video.title;
    for (const frame of frameResults || []) {
      const result = frame && frame.result;
      if (!result) continue;
      if ((!title || title === "Video") && result.title) title = cleanText(result.title, 240);
      for (const segment of result.segments || []) rawSegments.push(segment);
    }

    const segments = mergeTranscriptSegments([], normalizeSegments(rawSegments)).map((segment, index) => ({
      ...segment,
      id: String(index)
    }));
    if (!segments.length) return null;

    return {
      id: stableId(["video_player_results", video.id || video.url]),
      title: title || "Video search results",
      source_hint: `Player search results for "${query}"`,
      video_url: video.url,
      matched_resource_ids: video.id ? [video.id] : [],
      segments
    };
  } finally {
    if (tab && tab.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (_error) {
        // The user or browser may already have closed the temporary tab.
      }
    }
  }
}

function waitForTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };

    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(() => finish(), timeoutMs);
    chrome.tabs.get(tabId)
      .then((tab) => {
        if (tab && tab.status === "complete") finish();
      })
      .catch((error) => fail(error));
  });
}

async function searchVisibleVideoResultsInPage(query) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const cleanText = (value, limit = 600) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit);
  const isVisible = (node) => {
    if (!node || !node.getBoundingClientRect) return false;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle ? window.getComputedStyle(node) : null;
    return rect.width > 0 && rect.height > 0 && (!style || (style.display !== "none" && style.visibility !== "hidden"));
  };
  const normalizeTimestamp = (value) => {
    const parts = String(value || "").split(":").map((part) => Number.parseInt(part, 10));
    if (parts.some((part) => !Number.isFinite(part))) return String(value || "");
    if (parts.length === 2) return `00:${String(parts[0]).padStart(2, "0")}:${String(parts[1]).padStart(2, "0")}`;
    if (parts.length === 3) return parts.map((part) => String(part).padStart(2, "0")).join(":");
    return String(value || "");
  };
  const secondsFromTimestamp = (value) => {
    const parts = String(value || "").split(":").map((part) => Number.parseInt(part, 10));
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return 0;
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  };
  const setInputValue = (input, value) => {
    input.focus();
    if (input.isContentEditable) {
      input.textContent = value;
    } else {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (setter && input instanceof window.HTMLInputElement) setter.call(input, value);
      else input.value = value;
    }
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
  };
  const clickSearchButton = (input) => {
    const inputRect = input.getBoundingClientRect();
    const formButton = input.closest("form")?.querySelector("button,[role='button'],input[type='submit']");
    const buttons = Array.from(document.querySelectorAll("button,[role='button'],input[type='submit'],input[type='button']"))
      .filter(isVisible)
      .map((button) => {
        const rect = button.getBoundingClientRect();
        const label = cleanText([button.textContent, button.getAttribute("aria-label"), button.getAttribute("title"), button.value].join(" "), 120);
        const verticalOverlap = rect.bottom >= inputRect.top && rect.top <= inputRect.bottom;
        const toRight = rect.left >= inputRect.left;
        const distance = Math.abs(rect.left - inputRect.right) + Math.abs(rect.top - inputRect.top);
        let score = 0;
        if (/search|find|go|submit/i.test(label)) score += 10;
        if (/clear|close|cancel|hide/i.test(label)) score -= 10;
        if (verticalOverlap) score += 4;
        if (toRight) score += 2;
        score += Math.max(0, 4 - Math.floor(distance / 80));
        return { button, score };
      })
      .sort((a, b) => b.score - a.score);
    const button = formButton || buttons.find((candidate) => candidate.score > 0)?.button;
    if (button && typeof button.click === "function") button.click();
  };
  const chooseSearchInput = () => {
    const inputs = Array.from(
      document.querySelectorAll("input[type='search'],input[type='text'],input:not([type]),textarea,[role='searchbox'],[contenteditable='true']")
    ).filter(isVisible);
    return inputs
      .map((input) => {
        const label = cleanText([
          input.getAttribute("aria-label"),
          input.getAttribute("placeholder"),
          input.getAttribute("title"),
          input.closest("form")?.textContent,
          input.parentElement?.textContent
        ].join(" "), 240);
        let score = 0;
        if (/search|find|transcript|caption|result/i.test(label)) score += 5;
        if (input.matches("input[type='search'],[role='searchbox']")) score += 3;
        return { input, score };
      })
      .sort((a, b) => b.score - a.score)[0]?.input;
  };
  const collectSegments = () => {
    const rowSelectors = [
      "[role='listitem']",
      "li",
      "tr",
      "[class*='result' i]",
      "[class*='transcript' i]",
      "[class*='caption' i]",
      "[class*='search' i]"
    ];
    const timestampPattern = /\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b/g;
    const seen = new Set();
    const segments = [];
    document.querySelectorAll(rowSelectors.join(",")).forEach((node) => {
      if (!isVisible(node)) return;
      const text = cleanText(node.innerText || node.textContent, 900);
      const timestamps = text.match(timestampPattern) || [];
      if (!timestamps.length || !/[a-zA-Z]{4,}/.test(text)) return;
      if (/^(details|discussion|notes|bookmarks|results|hide|search all|sort by relevance)\b/i.test(text)) return;
      const timestamp = timestamps[timestamps.length - 1];
      const snippet = cleanText(
        text
          .replace(timestampPattern, " ")
          .replace(/\b(Search all|Sort by relevance|Results|Hide|Details|Discussion|Notes|Bookmarks)\b/gi, " "),
        650
      );
      if (snippet.length < 12) return;
      const key = `${timestamp}|${snippet.toLowerCase().slice(0, 180)}`;
      if (seen.has(key)) return;
      seen.add(key);
      segments.push({ start: normalizeTimestamp(timestamp), end: "", speaker: "", text: snippet });
    });
    return segments.sort((a, b) => secondsFromTimestamp(a.start) - secondsFromTimestamp(b.start));
  };

  const input = chooseSearchInput();
  if (input) {
    setInputValue(input, query);
    clickSearchButton(input);
    await sleep(3500);
  }

  return {
    title: cleanText(document.title || "Video search results", 240),
    url: location.href,
    searched: Boolean(input),
    segments: collectSegments()
  };
}

async function scanActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return { ok: false, error: "no_active_tab" };

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "REQUEST_SCRAPE" });
    return {
      ok: true,
      source: "content_script",
      resource_count: Array.isArray(response?.resources) ? response.resources.length : 0
    };
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/scraper.js"]
    });
    const response = await chrome.tabs.sendMessage(tab.id, { type: "REQUEST_SCRAPE" });
    return {
      ok: true,
      source: "injected_content_script",
      resource_count: Array.isArray(response?.resources) ? response.resources.length : 0
    };
  }
}

async function storeContent(payload) {
  const resourceId = cleanText(payload.resource_id || payload.resourceId || "", 120);
  const content = cleanBodyText(payload.content || payload.text || "", 20000);
  if (!resourceId || !content) return { ok: false, error: "missing_resource_or_content" };

  const data = await chrome.storage.local.get([RESOURCE_KEY, TRANSCRIPT_KEY, CONTENT_KEY]);
  const resources = data[RESOURCE_KEY] || [];
  const transcripts = data[TRANSCRIPT_KEY] || [];
  const contentStore = data[CONTENT_KEY] || {};
  if (!resources.some((resource) => resource.id === resourceId)) {
    return { ok: false, error: "resource_not_found" };
  }

  contentStore[resourceId] = content;
  await saveIndex(resources, transcripts, contentStore);
  return { ok: true, resource_id: resourceId, content_length: content.length };
}

function startCrawlSite(payload) {
  if (activeCrawlPromise) return { ok: false, error: "crawl_already_running" };
  activeCrawlPromise = crawlSite(payload)
    .catch((error) => {
      emitCrawlProgress({
        status: "error",
        error: String(error && error.message ? error.message : error)
      });
    })
    .finally(() => {
      activeCrawlPromise = null;
    });
  return { ok: true, started: true };
}
async function crawlSite(payload) {
  const seedUrl = normalizeUrlFrom(payload.seed_url || payload.seedUrl || DEFAULT_CRAWL_SEED_URL, DEFAULT_CRAWL_SEED_URL);
  if (!seedUrl || !/^https?:\/\//i.test(seedUrl)) return { ok: false, error: "missing_or_invalid_seed_url" };

  const allowedPrefix = normalizeUrlFrom(
    payload.allowed_prefix || payload.allowedPrefix || defaultAllowedPrefix(seedUrl),
    seedUrl
  );
  const maxPages = clampInteger(payload.max_pages || payload.maxPages, 1, 2000, 1500);
  const delayMs = clampInteger(payload.delay_ms || payload.delayMs, 0, 3000, 120);
  const seedOrigin = new URL(seedUrl).origin;
  const queue = [seedUrl];
  const queued = new Set(queue);
  const visited = new Set();
  const resources = [];
  const failures = [];
  const uniqueCandidateIds = new Set();
  let rawCandidatesSeen = 0;
  let lastSavedResourceCount = 0;
  let lastCheckpointPage = 0;

  function recordCandidateResources(pageResources) {
    const items = Array.isArray(pageResources) ? pageResources : [];
    rawCandidatesSeen += items.length;
    for (const item of items) {
      const normalized = normalizeResource(item);
      if (!normalized.url && !normalized.title) continue;
      uniqueCandidateIds.add(normalized.id);
    }
  }

  function crawlProgress(extra = {}) {
    return {
      pages: visited.size,
      queued: queue.length,
      candidates_seen: uniqueCandidateIds.size,
      unique_candidates_seen: uniqueCandidateIds.size,
      raw_candidates_seen: rawCandidatesSeen,
      resource_count: lastSavedResourceCount,
      ...extra
    };
  }

  emitCrawlProgress({ status: "started", ...crawlProgress({ pages: 0, queued: queue.length, current_url: seedUrl }) });

  async function checkpointResources(force = false) {
    if (!resources.length) {
      return { resource_count: lastSavedResourceCount };
    }
    const shouldSave = force || resources.length >= 80 || visited.size - lastCheckpointPage >= 25;
    if (!shouldSave) {
      return { resource_count: lastSavedResourceCount };
    }
    const batch = resources.splice(0, resources.length);
    const mergeResult = await mergeScrape({ resources: batch });
    lastSavedResourceCount = mergeResult.resource_count || lastSavedResourceCount;
    lastCheckpointPage = visited.size;
    emitCrawlProgress({
      status: force ? "saving" : "checkpoint",
      ...crawlProgress({
        pages: visited.size,
        queued: queue.length,
        resource_count: lastSavedResourceCount
      })
    });
    return mergeResult;
  }

  while (queue.length && visited.size < maxPages) {
    const currentUrl = queue.shift();
    if (!currentUrl || visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    emitCrawlProgress({
      status: "fetching",
      ...crawlProgress({ current_url: currentUrl })
    });

    try {
      const page = await fetchCrawlPage(currentUrl);
      const pageResources = Array.isArray(page.resources) ? page.resources : [];
      resources.push(...pageResources);
      recordCandidateResources(pageResources);
      await checkpointResources(false);

      const candidateUrls = page.portal_entry_urls?.length && isDefaultPortalUrl(currentUrl) ? page.portal_entry_urls : page.child_urls;
      for (const candidate of candidateUrls) {
        const childUrl = normalizeUrlFrom(candidate, page.final_url || currentUrl);
        if (!canQueuePage(childUrl, { allowedPrefix, seedOrigin, visited, queued })) continue;
        queued.add(childUrl);
        queue.push(childUrl);
      }
    } catch (error) {
      failures.push({
        url: currentUrl,
        error: String(error && error.message ? error.message : error)
      });
    }

    if (delayMs) await sleep(delayMs);
  }

  const mergeResult = await checkpointResources(true);
  const response = {
    ok: true,
    pages_crawled: visited.size,
    candidates_seen: uniqueCandidateIds.size,
    unique_candidates_seen: uniqueCandidateIds.size,
    raw_candidates_seen: rawCandidatesSeen,
    resources_seen: rawCandidatesSeen,
    resource_count: mergeResult.resource_count,
    queued_remaining: queue.length,
    failures: failures.slice(0, 20)
  };
  emitCrawlProgress({
    status: "complete",
    ...crawlProgress({
      pages: visited.size,
      queued: queue.length,
      resource_count: mergeResult.resource_count
    })
  });
  return response;
}

async function fetchCrawlPage(url) {
  const response = await fetch(url, {
    credentials: "include",
    redirect: "follow",
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const finalUrl = normalizeUrlFrom(response.url || url, url);
  const contentType = response.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    return {
      final_url: finalUrl,
      resources: [
        normalizeResource({
          type: inferType(finalUrl, finalUrl),
          title: fileNameFromUrl(finalUrl) || finalUrl,
          url: finalUrl,
          page_url: finalUrl,
          page_title: finalUrl,
          context: contentType
        })
      ],
      child_urls: []
    };
  }

  const html = await response.text();
  return extractResourcesFromHtml(html, finalUrl);
}

function extractResourcesFromHtml(html, pageUrl) {
  if (typeof DOMParser === "undefined") return extractResourcesFromHtmlFallback(html, pageUrl);

  const document = new DOMParser().parseFromString(html, "text/html");
  const pageTitle = cleanText(document.title || pageUrl, 240);
  const section = breadcrumbTextFromDocument(document);
  const resources = [];
  const childUrls = [];
  const portalEntryUrls = portalEntryUrlsFromDocument(document, pageUrl);
  const seen = new Set();

  function add(resource) {
    if (!resource) return;
    const normalized = normalizeResource(resource);
    const key = `${normalized.type}|${normalized.url}|${normalized.title}`;
    if (seen.has(key)) return;
    seen.add(key);
    resources.push(normalized);
  }

  document.querySelectorAll("a[href]").forEach((anchor) => {
    const href = anchor.getAttribute("href") || "";
    const url = normalizeUrlFrom(href, pageUrl);
    if (!url || isIgnoredProtocol(url)) return;
    const title = cleanText(anchor.textContent || anchor.getAttribute("title") || anchor.getAttribute("aria-label") || url, 240);
    const type = inferType(url, title);
    childUrls.push(url);
    if (shouldStoreAnchorResource(url, title, type, pageUrl)) {
      add({
        type,
        title,
        url,
        page_url: pageUrl,
        page_title: pageTitle,
        section,
        context: nearestContextFromDocument(anchor),
        discovered_at: new Date().toISOString()
      });
    }
  });

  document.querySelectorAll("video[src], video source[src], audio[src], audio source[src]").forEach((media) => {
    const host = media.closest("video,audio") || media;
    const rawUrl = media.getAttribute("src") || "";
    const url = normalizeUrlFrom(rawUrl, pageUrl);
    const title =
      cleanText(host.getAttribute("title") || host.getAttribute("aria-label") || nearestContextFromDocument(host) || pageTitle, 240);
    add({
      type: media.closest("audio") ? "audio" : "video",
      title,
      url,
      page_url: pageUrl,
      page_title: pageTitle,
      section,
      context: nearestContextFromDocument(host),
      discovered_at: new Date().toISOString()
    });
  });

  document.querySelectorAll("iframe[src], embed[src], object[data]").forEach((frame) => {
    const rawUrl = frame.getAttribute("src") || frame.getAttribute("data") || "";
    const url = normalizeUrlFrom(rawUrl, pageUrl);
    const title =
      cleanText(frame.getAttribute("title") || frame.getAttribute("aria-label") || nearestContextFromDocument(frame) || pageTitle, 240);
    const type = inferType(url, title);
    if (type === "video_embed" || type === "video" || type === "audio") {
      add({
        type,
        title,
        url,
        page_url: pageUrl,
        page_title: pageTitle,
        section,
        context: nearestContextFromDocument(frame),
        discovered_at: new Date().toISOString()
      });
    }
  });

  panoptoViewerUrlsFromHtml(html, pageUrl).forEach((url) => {
    add({
      type: "video_embed",
      title: fileNameFromUrl(url) || pageTitle,
      url,
      page_url: pageUrl,
      page_title: pageTitle,
      section,
      context: pageTitle,
      discovered_at: new Date().toISOString()
    });
  });

  const pageText = extractMainTextFromDocument(document, 10000);
  if (pageText) {
    add({
      type: "page",
      title: pageTitle,
      url: pageUrl,
      page_url: pageUrl,
      page_title: pageTitle,
      section,
      context: pageText,
      discovered_at: new Date().toISOString()
    });
  }

  return {
    final_url: pageUrl,
    resources,
    child_urls: uniqueStrings([...portalEntryUrls, ...childUrls]),
    portal_entry_urls: uniqueStrings(portalEntryUrls),
    course_urls: uniqueStrings(portalEntryUrls)
  };
}

function panoptoViewerUrlsFromHtml(html, pageUrl) {
  const text = decodeHtmlUrlText(html);
  const urls = [];
  const patterns = [
    /https?:\/\/[^"'<>\s)]+\/Panopto\/Pages\/Viewer\.aspx\?[^"'<>\s)]+/gi,
    /\/Panopto\/Pages\/Viewer\.aspx\?[^"'<>\s)]+/gi
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match) {
      const url = normalizeUrlFrom(match[0], pageUrl);
      if (url) urls.push(url);
      match = pattern.exec(text);
    }
  }
  return uniqueStrings(urls);
}

function decodeHtmlUrlText(value) {
  return String(value || "")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}
function shouldStoreAnchorResource(url, title, type, pageUrl) {
  if (!url) return false;
  const resourceType = String(type || "").toLowerCase();
  if (/^(pdf|document|slides|spreadsheet|video|audio|video_embed|announcement)$/.test(resourceType)) return true;
  if (isCourseOrOrganizationUrl(url)) return false;
  if (isSameBlackboardOrigin(url, pageUrl)) return false;
  return Boolean(cleanText(title, 80));
}

function isSameBlackboardOrigin(url, pageUrl) {
  try {
    const parsed = new URL(url);
    const page = new URL(pageUrl);
    return parsed.origin === page.origin && /\/webapps\/blackboard\//i.test(parsed.pathname);
  } catch (_error) {
    return false;
  }
}

function extractResourcesFromHtmlFallback(html, pageUrl) {
  const title = cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || pageUrl, 240);
  const text = cleanText(stripHtml(html), 3000);
  const urls = [];
  const resources = [];
  const attrPattern = /\s(?:href|src|data)=["']([^"']+)["']/gi;
  let match = attrPattern.exec(html);
  while (match) {
    const url = normalizeUrlFrom(match[1], pageUrl);
    if (url && !isIgnoredProtocol(url)) {
      const type = inferType(url, fileNameFromUrl(url));
      const resourceTitle = fileNameFromUrl(url) || url;
      urls.push(url);
      if (shouldStoreAnchorResource(url, resourceTitle, type, pageUrl)) {
        resources.push(
          normalizeResource({
            type,
            title: resourceTitle,
            url,
            page_url: pageUrl,
            page_title: title,
            context: title,
            discovered_at: new Date().toISOString()
          })
        );
      }
    }
    match = attrPattern.exec(html);
  }
  if (text) {
    resources.push(
      normalizeResource({
        type: "page",
        title,
        url: pageUrl,
        page_url: pageUrl,
        page_title: title,
        context: text,
        discovered_at: new Date().toISOString()
      })
    );
  }
  return { final_url: pageUrl, resources, child_urls: uniqueStrings(urls), course_urls: [] };
}

async function saveIndex(resources, transcripts, contentStore = null) {
  let nextContentStore = contentStore;
  if (!nextContentStore) {
    const data = await chrome.storage.local.get(CONTENT_KEY);
    nextContentStore = data[CONTENT_KEY] || {};
  }
  nextContentStore = pruneContentStore(nextContentStore, resources);
  await chrome.storage.local.set({
    [RESOURCE_KEY]: resources,
    [TRANSCRIPT_KEY]: transcripts,
    [CONTENT_KEY]: nextContentStore,
    [META_KEY]: {
      resource_count: resources.length,
      transcript_count: transcripts.length,
      transcript_segment_count: transcripts.reduce((sum, transcript) => sum + transcript.segments.length, 0),
      content_count: Object.keys(nextContentStore).length,
      content_char_count: Object.values(nextContentStore).reduce((sum, text) => sum + String(text || "").length, 0),
      video_count: resources.filter(isVideoResource).length,
      last_updated: new Date().toISOString()
    }
  });
}

function pruneContentStore(contentStore, resources) {
  const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));
  return Object.fromEntries(
    Object.entries(contentStore || {})
      .filter(([id, text]) => {
        const resource = resourcesById.get(id);
        if (!resource || !String(text || "").trim()) return false;
        if (isFileLikeResource(resource) && !isReadableStoredFileBodyText(resource, text)) return false;
        return true;
      })
      .map(([id, text]) => [id, cleanBodyText(text, 20000)])
  );
}

function isReadableStoredFileBodyText(resource, storedContent) {
  const text = String(storedContent || "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  const words = text.toLowerCase().match(/[a-z0-9']+/g) || [];
  if (words.length < 45) return false;
  if (/\bPage\s+\d+:/i.test(text) && words.length >= 45) return true;
  const title = normalizeText(resource.title || "");
  const sourceBits = normalizeText([resource.section, resource.page_title].filter(Boolean).join(" "));
  const normalized = normalizeText(text);
  const mentionsTitle = title && normalized.includes(title);
  const mentionsSource = sourceBits && normalized.includes(sourceBits);
  const hasListingSignals = /\b(resources?|content|attached files?|blackboard|class of|pre-program|click|open|pdf)\b/i.test(text);
  const hasDetailSignals = /\b(passport|jw202|admission notice|visa application|physical exam|medication|prescription|packing|pack|clothing|toiletries|adapter|cash|bank card|residence permit|registration|insurance|vaccination|luggage|documents to bring)\b/i.test(text);
  if (words.length < 110 && (mentionsTitle || mentionsSource || hasListingSignals) && !hasDetailSignals) return false;
  return words.length >= 110 || text.length >= 900;
}

function defaultAllowedPrefix(seedUrl) {
  try {
    const parsed = new URL(seedUrl);
    return `${parsed.origin}/`;
  } catch (_error) {
    return seedUrl;
  }
}

function isDefaultPortalUrl(url) {
  try {
    const parsed = new URL(url);
    const defaultUrl = new URL(DEFAULT_CRAWL_SEED_URL);
    return parsed.origin === defaultUrl.origin && parsed.pathname === defaultUrl.pathname;
  } catch (_error) {
    return false;
  }
}

function portalEntryUrlsFromDocument(document, pageUrl) {
  const candidates = [];
  const headingSelectors = [
    "h1",
    "h2",
    "h3",
    "h4",
    ".moduleTitle",
    ".module-title",
    ".portlet-title",
    ".moduleHeader",
    "[id*='module']"
  ];
  const headings = Array.from(document.querySelectorAll(headingSelectors.join(","))).filter((node) =>
    /^my\s+(courses|organizations)$/i.test(cleanText(node.textContent, 80))
  );

  for (const heading of headings) {
    let container = heading.closest(".module, .portlet, .moduleWrapper, .containerPortal, section, article, div") || heading.parentElement;
    for (let depth = 0; container && depth < 5; depth += 1) {
      const links = Array.from(container.querySelectorAll("a[href]"))
        .map((anchor) => normalizeUrlFrom(anchor.getAttribute("href") || "", pageUrl))
        .filter(isCourseOrOrganizationUrl);
      candidates.push(...links);
      if (links.length) break;
      container = container.parentElement;
    }
  }

  if (!candidates.length) {
    document.querySelectorAll("a[href]").forEach((anchor) => {
      const url = normalizeUrlFrom(anchor.getAttribute("href") || "", pageUrl);
      const text = cleanText(anchor.textContent || anchor.getAttribute("title") || "", 200);
      if (isCourseOrOrganizationUrl(url) || /class of|pre-program|course|organization|language learning resources/i.test(text)) {
        candidates.push(url);
      }
    });
  }

  return uniqueStrings(candidates.filter(Boolean));
}

function isCourseOrOrganizationUrl(url) {
  if (!url) return false;
  return /\/webapps\/blackboard\/(execute\/launcher|content\/listContent|execute\/courseMain|course\/toc)|course_id=|course_id%3D|org_id=|org_id%3D|organization_id=|organization_id%3D|type=(course|organization)/i.test(
    url
  );
}

function canQueuePage(url, options) {
  if (!url || isIgnoredProtocol(url)) return false;
  if (options.visited.has(url) || options.queued.has(url)) return false;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== options.seedOrigin) return false;
    if (options.allowedPrefix && !url.startsWith(options.allowedPrefix)) return false;
    if (isLikelyFileResource(parsed.pathname)) return false;
    if (/(logout|logoff|signout|sign-out|download|calendar|gradebook)/i.test(url)) return false;
    return true;
  } catch (_error) {
    return false;
  }
}

function isLikelyFileResource(pathname) {
  return /\.(pdf|doc|docx|rtf|odt|ppt|pptx|xls|xlsx|csv|zip|rar|7z|mp4|mov|m4v|webm|avi|mkv|mp3|m4a|wav|aac|ogg|png|jpe?g|gif|webp|svg)$/i.test(
    pathname || ""
  );
}

function isIgnoredProtocol(url) {
  return /^(javascript|mailto|tel|data|blob):/i.test(String(url || ""));
}

function breadcrumbTextFromDocument(document) {
  const selectors = [
    "[aria-label*='breadcrumb' i]",
    ".breadcrumb",
    "#breadcrumbs",
    ".path",
    ".locationPane"
  ];
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    const text = cleanText(node && node.textContent, 300);
    if (text) return text;
  }
  return "";
}

function extractMainTextFromDocument(document, limit = 10000) {
  try {
    const clone = document.cloneNode(true);
    clone.querySelectorAll("script,style,noscript,nav,header,footer,aside").forEach((node) => node.remove());
    const selectors = [
      "#content",
      "#contentPanel",
      ".contentBox",
      ".vtbegenerated",
      ".contentList",
      "main",
      "article",
      "[role='main']"
    ];
    let root = null;
    for (const selector of selectors) {
      root = clone.querySelector(selector);
      if (root) break;
    }
    if (!root) root = clone.body || clone.documentElement;
    return cleanBodyText(readableTextFromNode(root), limit);
  } catch (_error) {
    return "";
  }
}

function readableTextFromNode(root) {
  if (!root) return "";
  const blockTags = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "BLOCKQUOTE",
    "BR",
    "DD",
    "DIV",
    "DL",
    "DT",
    "FIELDSET",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "FORM",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "HR",
    "LI",
    "MAIN",
    "NAV",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "TABLE",
    "TBODY",
    "TD",
    "TFOOT",
    "TH",
    "THEAD",
    "TR",
    "UL"
  ]);
  const parts = [];

  function walk(node) {
    if (!node) return;
    if (node.nodeType === 3) {
      const text = String(node.nodeValue || "").replace(/\s+/g, " ").trim();
      if (text) parts.push(text);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return;
    if (tag === "IMG") {
      const alt = cleanText(node.getAttribute("alt") || "", 160);
      if (alt) parts.push(alt);
      return;
    }
    if (tag === "A") {
      const text = cleanText(node.textContent || node.getAttribute("href") || "", 240);
      if (text) parts.push(text);
      return;
    }
    if (blockTags.has(tag)) parts.push("\n");
    for (const child of node.childNodes || []) walk(child);
    if (blockTags.has(tag)) parts.push("\n");
  }

  walk(root);
  return parts.join(" ");
}

function nearestContextFromDocument(element) {
  const container = element.closest("li, article, section, div") || element;
  const titleNode = container.querySelector("h1,h2,h3,h4,.item,.title,.name");
  const title = cleanText(titleNode && titleNode.textContent, 180);
  const text = cleanText(container.textContent, 320);
  return [title, text && text !== title ? text : ""].filter(Boolean).join(" - ");
}

function normalizeUrlFrom(rawUrl, baseUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  try {
    const parsed = baseUrl ? new URL(value, baseUrl) : new URL(value);
    ["session", "cache", "nonce", "token", "auth", "one_hash", "x-bb-session", "download"].forEach((key) =>
      parsed.searchParams.delete(key)
    );
    parsed.hash = "";
    return parsed.href;
  } catch (_error) {
    return "";
  }
}

function fileNameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const name = decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "");
    return cleanText(name.replace(/(\.[a-z0-9]{2,5})\1$/i, "$1"), 240);
  } catch (_error) {
    return "";
  }
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitCrawlProgress(payload) {
  chrome.runtime.sendMessage({ type: "CRAWL_PROGRESS", payload }, () => {
    void chrome.runtime.lastError;
  });
}

function normalizeResource(raw) {
  const rawUrl = String(raw.url || raw.href || raw.src || "").trim();
  const rawTitle = raw.title || raw.name || raw.label || rawUrl || "Untitled resource";
  const preliminaryType = cleanText(raw.type || inferType(rawUrl, rawTitle), 80);
  const preserveUrl = Boolean(raw.preserve_url || raw.preserveUrl);
  const url = preserveUrl ? rawUrl : normalizeUrl(rawUrl);
  const title = cleanText(rawTitle || url || "Untitled resource", 240);
  const type = preliminaryType || cleanText(inferType(url, title), 80);
  const mediaKey = /^(audio|video|video_embed)$/.test(type)
    ? canonicalVideoKey({ ...raw, url, title, context: raw.context || raw.description || "" })
    : "";
  const resource = {
    id: cleanText(raw.id || stableId(["resource", mediaKey ? "video_resource" : type, mediaKey || url, mediaKey ? "" : title]), 120),
    canonical_key: mediaKey || cleanText(raw.canonical_key || raw.canonicalKey || "", 240),
    type,
    title,
    url,
    page_url: normalizeUrl(raw.page_url || ""),
    page_title: cleanText(raw.page_title || "", 240),
    section: cleanText(raw.section || "", 240),
    context:
      type === "page"
        ? cleanBodyText(raw.context || raw.description || "", 10000)
        : cleanText(raw.context || raw.description || "", 1800),
    discovered_at: cleanText(raw.discovered_at || new Date().toISOString(), 80),
    transcript_ids: uniqueStrings(raw.transcript_ids || raw.transcriptIds || [])
  };
  return resource;
}

function searchableContentFrom(resource) {
  if (isFileLikeResource(resource)) return "";
  const content = cleanBodyText(resource.context || "", resource.type === "page" ? 20000 : 5000);
  if (!content) return "";
  return [resource.title, resource.section, resource.page_title, content].filter(Boolean).join("\n\n");
}

function isFileLikeResource(resource) {
  const type = String(resource?.type || "").toLowerCase();
  const hint = [resource?.title, resource?.url, resource?.document_url].filter(Boolean).join(" ");
  return ["pdf", "document", "slides", "spreadsheet"].includes(type) || /\.(pdf|docx|pptx|xlsx)(?:[?#]|$|\s)/i.test(hint);
}

function resourceMetadataFrom(resource) {
  return {
    ...resource,
    context: cleanBodyText(resource.context || "", resource.type === "page" ? 900 : 500)
  };
}

function normalizeTranscriptBundle(payload) {
  let records = [];
  if (Array.isArray(payload)) records = payload;
  if (Array.isArray(payload.transcripts)) records = payload.transcripts;
  if (payload.transcript || payload.segments || payload.text) records = [payload.transcript || payload];

  return records
    .map(normalizeTranscript)
    .filter((transcript) => transcript.title && transcript.segments.length);
}

function normalizeTranscript(raw) {
  const title = cleanText(raw.title || raw.video_title || raw.videoTitle || raw.name || raw.file_name || "", 240);
  const sourceHint = cleanText(raw.source_hint || raw.sourceHint || raw.date || raw.session || "", 240);
  const videoUrl = normalizeUrl(raw.video_url || raw.videoUrl || raw.url || raw.url_hint || raw.urlHint || "");
  const segments = normalizeSegments(raw.segments || raw.chunks || raw.items || raw.text || "");
  const id = cleanText(raw.id || stableId(["transcript", title, sourceHint, videoUrl, segments[0]?.text || ""]), 120);
  return {
    id,
    title,
    video_title: title,
    source_hint: sourceHint,
    video_url: videoUrl,
    segments,
    matched_resource_ids: uniqueStrings(raw.matched_resource_ids || raw.matchedResourceIds || []),
    imported_at: cleanText(raw.imported_at || new Date().toISOString(), 80)
  };
}

function mergeTranscriptRecords(previous, transcript) {
  const now = new Date().toISOString();
  if (!previous) {
    return {
      ...transcript,
      segments: mergeTranscriptSegments([], transcript.segments || []),
      matched_resource_ids: uniqueStrings(transcript.matched_resource_ids || []),
      imported_at: transcript.imported_at || now,
      updated_at: now
    };
  }

  return {
    ...previous,
    ...withoutEmpty(transcript),
    segments: mergeTranscriptSegments(previous.segments || [], transcript.segments || []),
    matched_resource_ids: uniqueStrings([
      ...(previous.matched_resource_ids || []),
      ...(transcript.matched_resource_ids || [])
    ]),
    source_hint: mergeSourceHints(previous.source_hint, transcript.source_hint),
    imported_at: previous.imported_at || transcript.imported_at || now,
    updated_at: now
  };
}

function mergeSourceHints(previous, next) {
  return uniqueStrings([previous, next]).join(" | ").slice(0, 240);
}

function mergeTranscriptSegments(existing, incoming) {
  const byKey = new Map();
  for (const segment of [...(existing || []), ...(incoming || [])]) {
    const text = cleanText(segment.text || "", 5000);
    if (!text) continue;
    const normalized = {
      id: cleanText(segment.id || String(byKey.size), 80),
      start: cleanText(segment.start || "", 40),
      end: cleanText(segment.end || "", 40),
      speaker: cleanText(segment.speaker || "", 80),
      text
    };
    const key = `${normalized.start}|${normalizeText(normalized.text).slice(0, 200)}`;
    if (!byKey.has(key)) byKey.set(key, normalized);
  }
  return Array.from(byKey.values()).sort((a, b) => secondsFromTimestamp(a.start) - secondsFromTimestamp(b.start));
}

function secondsFromTimestamp(value) {
  const parts = String(value || "").split(":").map((part) => Number.parseInt(part, 10));
  if (parts.length === 2 && parts.every((part) => Number.isFinite(part))) return parts[0] * 60 + parts[1];
  if (parts.length === 3 && parts.every((part) => Number.isFinite(part))) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function normalizeSegments(rawSegments) {
  if (typeof rawSegments === "string") {
    const text = cleanText(rawSegments, 100000);
    return text ? [{ start: "", end: "", speaker: "Speaker 1", text }] : [];
  }
  if (!Array.isArray(rawSegments)) return [];
  const speakerMap = new Map();
  return rawSegments
    .map((segment, index) => {
      if (typeof segment === "string") {
        return { id: String(index), start: "", end: "", speaker: "Speaker 1", text: cleanText(segment, 5000) };
      }
      const rawSpeaker = segment.speaker || segment.speaker_label || segment.speakerLabel || segment.name || segment.role || "Speaker 1";
      return {
        id: cleanText(segment.id || String(index), 80),
        start: cleanText(segment.start || segment.start_time || segment.startTime || "", 40),
        end: cleanText(segment.end || segment.end_time || segment.endTime || "", 40),
        speaker: anonymizedSpeakerLabel(rawSpeaker, speakerMap),
        text: cleanText(segment.text || segment.transcript || segment.caption || "", 5000)
      };
    })
    .filter((segment) => segment.text);
}

function anonymizedSpeakerLabel(rawSpeaker, speakerMap) {
  const key = cleanText(rawSpeaker || "Speaker 1", 120).toLowerCase();
  if (!speakerMap.has(key)) speakerMap.set(key, `Speaker ${speakerMap.size + 1}`);
  return speakerMap.get(key);
}

function dedupeTranscriptIndex(resources, transcripts) {
  const next = [];
  const byKey = new Map();
  const idRemap = new Map();

  for (const transcript of transcripts || []) {
    const key = transcriptDedupeKey(transcript) || `id:${transcript.id}`;
    const existingIndex = byKey.get(key);
    if (existingIndex === undefined) {
      byKey.set(key, next.length);
      next.push(transcript);
      continue;
    }

    const keeper = next[existingIndex];
    const keeperId = keeper.id;
    const merged = mergeTranscriptRecords(keeper, transcript);
    next[existingIndex] = { ...merged, id: keeperId };
    if (transcript.id && transcript.id !== keeperId) idRemap.set(transcript.id, keeperId);
  }

  if (!idRemap.size) return { resources, transcripts: next, changed: next.length !== (transcripts || []).length };

  for (const resource of resources || []) {
    resource.transcript_ids = uniqueStrings((resource.transcript_ids || []).map((id) => idRemap.get(id) || id));
  }
  for (const transcript of next) {
    transcript.matched_resource_ids = uniqueStrings(transcript.matched_resource_ids || []);
  }
  return { resources, transcripts: next, changed: true };
}

function transcriptDedupeKey(transcript) {
  const videoKey = canonicalVideoKey(transcript);
  if (videoKey) return `video:${videoKey}`;
  const title = normalizeText(transcript?.title || transcript?.video_title || "");
  if (!title) return "";
  return `title:${title}|content:${transcriptContentFingerprint(transcript) || normalizeText(transcript?.source_hint || "")}`;
}

function transcriptContentFingerprint(transcript) {
  const text = (transcript?.segments || []).slice(0, 8).map((segment) => segment.text || "").join(" ");
  return normalizeText(text).slice(0, 320);
}
function matchTranscriptsToResources(resources, transcripts) {
  let autoAttached = 0;
  for (const transcript of transcripts) {
    const best = bestTranscriptMatch(transcript, resources);
    if (!best || best.score < 45) continue;
    const resource = best.resource;
    const alreadyAttached = (resource.transcript_ids || []).includes(transcript.id);
    resource.transcript_ids = uniqueStrings([...(resource.transcript_ids || []), transcript.id]);
    transcript.matched_resource_ids = uniqueStrings([...(transcript.matched_resource_ids || []), resource.id]);
    if (!alreadyAttached) autoAttached += 1;
  }
  return { autoAttached };
}

function bestTranscriptMatch(transcript, resources) {
  let best = null;
  for (const resource of resources.filter(isVideoResource)) {
    const score = transcriptMatchScore(transcript, resource);
    if (!best || score > best.score) best = { resource, score };
  }
  return best;
}

function transcriptMatchScore(transcript, resource) {
  let score = 0;
  const resourceText = normalizeText(
    [resource.title, resource.url, resource.page_title, resource.section, resource.context].join(" ")
  );
  const transcriptTitle = normalizeText(transcript.title || transcript.video_title || "");
  const resourceTitle = normalizeText(resource.title || "");
  const hint = normalizeText(transcript.source_hint || "");
  const transcriptUrl = normalizeUrl(transcript.video_url || "");
  const resourceUrl = normalizeUrl(resource.url || "");

  if (transcriptUrl && resourceUrl && transcriptUrl === resourceUrl) score += 100;
  if (transcriptTitle && resourceTitle && transcriptTitle === resourceTitle) score += 70;
  if (transcriptTitle && resourceText.includes(transcriptTitle)) score += 45;
  if (resourceTitle && transcriptTitle.includes(resourceTitle)) score += 35;
  if (hint && resourceText.includes(hint)) score += 25;
  score += Math.min(30, tokenOverlap(transcriptTitle, resourceText) * 6);
  return score;
}

function isVideoResource(resource) {
  return /video|audio|recording|media|webinar/i.test(`${resource.type || ""} ${resource.title || ""} ${resource.url || ""}`);
}

function inferType(url, title) {
  const text = `${url} ${title}`.toLowerCase();
  if (/\.(mp4|mov|m4v|webm|avi|mkv)(\?|$)/.test(text)) return "video";
  if (/\.(mp3|m4a|wav|aac|ogg)(\?|$)/.test(text)) return "audio";
  if (/(kaltura|panopto|echo360|yuja|mediasite|bbcollab)/.test(text)) return "video_embed";
  if (/\.pdf(\?|$)/.test(text)) return "pdf";
  if (/\.(doc|docx|rtf|odt)(\?|$)/.test(text)) return "document";
  if (/\.(ppt|pptx)(\?|$)/.test(text)) return "slides";
  if (/\.(xls|xlsx|csv)(\?|$)/.test(text)) return "spreadsheet";
  return "link";
}

function withoutEmpty(object) {
  return Object.fromEntries(Object.entries(object).filter(([_key, value]) => value !== "" && value !== null && value !== undefined));
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean)));
}

function cleanText(value, limit = 500) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function cleanBodyText(value, limit = 5000) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, limit);
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(c11|class|webinar|recording|video|mp4|pdf|docx?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    ["session", "cache", "nonce", "token", "auth", "one_hash", "x-bb-session", "download"].forEach((key) =>
      parsed.searchParams.delete(key)
    );
    parsed.hash = "";
    return parsed.href;
  } catch (_error) {
    return value;
  }
}

function mediaCandidateKey(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    let path = decodeURIComponent(parsed.pathname || "/")
      .replace(/\/+/g, "/")
      .replace(/\/(index|master)\.m3u8$/i, "")
      .replace(/\/fragmented\.mp4$/i, "")
      .replace(/\/$/, "")
      .toLowerCase();
    return `${host}${path}`;
  } catch (_error) {
    return value
      .split(/[?#]/)[0]
      .replace(/^https?:\/\//i, "")
      .replace(/\/+/g, "/")
      .replace(/\/fragmented\.mp4$/i, "")
      .replace(/\/(index|master)\.m3u8$/i, "")
      .replace(/\/$/, "")
      .toLowerCase();
  }
}

function canonicalVideoKey(record) {
  const panoptoKey = panoptoSessionKey(record);
  if (panoptoKey) return panoptoKey;
  const existing = String(record?.canonical_key || "");
  if (/^(panopto|media):/i.test(existing)) return existing.toLowerCase();
  const mediaKey = mediaCandidateKey(existing || record?.url || record?.video_url || record?.videoUrl || "");
  if (mediaKey) return `media:${mediaKey}`;
  return normalizeText([record?.page_title, record?.section, record?.title, record?.video_title, record?.source_hint].filter(Boolean).join(" "));
}

function panoptoSessionKey(record) {
  const values = [
    record?.canonical_key,
    record?.url,
    record?.video_url,
    record?.videoUrl,
    record?.page_url,
    record?.document_url,
    record?.initiator,
    record?.context
  ]
    .filter(Boolean)
    .join(" ");
  const viewer = values.match(/\/Panopto\/Pages\/Viewer\.aspx\?[^#\s]*\bid=([0-9a-f-]{20,})/i);
  if (viewer) return `panopto:${viewer[1].toLowerCase()}`;
  const content = values.match(/\/Panopto\/Content\/Sessions\d*\/([0-9a-f-]{20,})/i);
  if (content) return `panopto:${content[1].toLowerCase()}`;
  return "";
}

function mediaCandidateKeys(candidate) {
  const keys = [];
  const canonical = canonicalVideoKey(candidate);
  if (/^(panopto|media):/i.test(canonical)) keys.push(canonical.toLowerCase());
  for (const value of [candidate?.canonical_key, candidate?.url, candidate?.video_url, candidate?.videoUrl]) {
    const raw = String(value || "");
    if (!raw) continue;
    if (/^(panopto|media):/i.test(raw)) keys.push(raw.toLowerCase());
    else {
      const mediaKey = mediaCandidateKey(raw);
      if (mediaKey) keys.push(mediaKey);
    }
  }
  return uniqueStrings(keys);
}

function ignoredMediaKeys(records) {
  return new Set((Array.isArray(records) ? records : []).map((item) => item && item.key).filter(Boolean));
}

function mediaCandidateIsIgnored(candidate, ignoredKeys) {
  return mediaCandidateKeys(candidate).some((key) => ignoredKeys.has(key));
}

async function isIgnoredMediaUrl(url) {
  const key = mediaCandidateKey(url);
  if (!key) return false;
  return isIgnoredMediaKey(key);
}

async function isIgnoredMediaKey(key) {
  const data = await chrome.storage.local.get(IGNORED_MEDIA_KEY);
  return ignoredMediaKeys(data[IGNORED_MEDIA_KEY]).has(key);
}

function tokenOverlap(query, text) {
  const queryTokens = new Set(normalizeText(query).split(" ").filter((token) => token.length > 2));
  if (!queryTokens.size) return 0;
  const textTokens = new Set(normalizeText(text).split(" ").filter((token) => token.length > 2));
  let matches = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) matches += 1;
  }
  return matches;
}

function stableId(parts) {
  return `id_${hashString(parts.map((part) => String(part || "")).join("|"))}`;
}

function hashString(value) {
  let hash = 2166136261;
  const input = String(value || "");
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(36);
}
