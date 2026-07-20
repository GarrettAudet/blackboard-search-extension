importScripts("../lib/blackboard-session.js");

const RESOURCE_KEY = "resource_index";
const TRANSCRIPT_KEY = "transcript_store";
const CONTENT_KEY = "content_store";
const MAX_INDEXED_BODY_CHARS = 500000;
const LOCAL_RESOURCE_MAX_FILES = 200;
const LOCAL_RESOURCE_MAX_EXTRACTED_CHARS = 10 * 1000 * 1000;
const MAX_SCRAPED_PAGE_CHARS = 200000;
const CONTENT_SCHEMA_VERSION = 2;
const LEGACY_INDEXED_BODY_CHARS = 20000;
const INDEXED_TEXT_TRUNCATION_PREFIX = '[Blackboard Search: indexed text truncated';
const META_KEY = "index_meta";
const RESOURCE_PACK_KEY = "resource_pack_store";
const DETECTED_MEDIA_KEY = "detected_media_store";
const IGNORED_MEDIA_KEY = "ignored_media_store";
const DEFAULT_CRAWL_SEED_URL =
  "https://lms.sc.tsinghua.edu.cn/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1";
const DEFAULT_CRAWL_PAGE_TIMEOUT_MS = 20000;
const CRAWL_HEARTBEAT_MS = 5000;
const CRAWL_CHECKPOINT_TIMEOUT_MS = 60000;
const BLACKBOARD_SESSION_TIMEOUT_MS = 15000;
const REINDEX_MIN_RESOURCE_RETENTION_RATIO = 0.65;
const REINDEX_MIN_PAGE_RETENTION_RATIO = 0.6;
const REINDEX_MIN_RESOURCE_IDENTITY_OVERLAP_RATIO = 0.65;
const REINDEX_MIN_PAGE_IDENTITY_OVERLAP_RATIO = 0.6;
const REINDEX_MIN_BODY_COUNT_RETENTION_RATIO = 0.65;
const REINDEX_MIN_BODY_IDENTITY_OVERLAP_RATIO = 0.65;
const REINDEX_MIN_BODY_CHAR_RETENTION_RATIO = 0.65;
const REINDEX_MIN_BODY_SEMANTIC_RETENTION_RATIO = 0.45;
const REINDEX_MIN_BODY_SEMANTIC_IDENTITY_PASS_RATIO = 0.6;
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
let crawlStartInProgress = false;
let activeCrawlMode = "";
let indexMutationTail = Promise.resolve();
let indexMutationSequence = 0;
let mediaMutationTail = Promise.resolve();

function runMediaMutation(operation) {
  const current = mediaMutationTail.catch(() => {}).then(operation);
  mediaMutationTail = current.then(() => undefined, () => undefined);
  return current;
}

function runIndexMutation(label, operation, options = {}) {
  const previous = indexMutationTail.catch(() => {});
  let releaseQueue = () => {};
  const queueSlot = new Promise((resolve) => {
    releaseQueue = resolve;
  });
  indexMutationTail = previous.then(() => queueSlot);
  const token = createIndexMutationToken(label);
  const timeoutMs = Math.max(0, Number(options.timeoutMs || 0));

  return (async () => {
    await previous;
    let timeoutId = 0;
    try {
      const operationPromise = Promise.resolve().then(async () => {
        if (options.captureRevision) {
          const data = await chrome.storage.local.get(META_KEY);
          assertIndexMutationActive(token);
          token.expectedRevision = Math.max(0, Number(data[META_KEY]?.index_revision || 0));
        }
        return operation(token);
      });
      if (!timeoutMs) return await operationPromise;
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          if (token.commitStarted) return;
          token.revoked = true;
          const error = new Error(`Index mutation ${label} did not finish before its revocable commit deadline.`);
          error.name = "TimeoutError";
          error.code = "mutation_timeout";
          reject(error);
        }, timeoutMs);
      });
      return await Promise.race([operationPromise, timeout]);
    } catch (error) {
      if (error?.code !== "mutation_timeout") console.warn(`Index mutation failed (${label}).`, error);
      throw error;
    } finally {
      clearTimeout(timeoutId);
      releaseQueue();
    }
  })();
}

function createIndexMutationToken(label) {
  const token = {
    id: `mutation_${++indexMutationSequence}`,
    label,
    revoked: false,
    commitStarted: false,
    expectedRevision: null,
    assertActive() { assertIndexMutationActive(token); },
    beginCommit() {
      assertIndexMutationActive(token);
      token.commitStarted = true;
    }
  };
  return token;
}

function assertIndexMutationActive(token) {
  if (!token || token.revoked) {
    const error = new Error("Index mutation was revoked before commit.");
    error.code = "mutation_revoked";
    throw error;
  }
}

function officialMutationBlockedByReindex() {
  return activeCrawlMode === "atomic_reindex";
}

function indexBusyResponse() {
  return { ok: false, error: "index_already_running" };
}

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
  return runMediaMutation(async () => {
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
  });
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
      collection_kind: "blackboard_detected",
      content_origin: "blackboard_caption",
      source_class: "official_blackboard",
      segments
    };
    const result = await runIndexMutation("import_detected_transcript", () => importTranscripts({ transcripts: [transcript] }));
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
  return runMediaMutation(async () => {
    const data = await chrome.storage.local.get(DETECTED_MEDIA_KEY);
    const detections = Array.isArray(data[DETECTED_MEDIA_KEY]) ? data[DETECTED_MEDIA_KEY] : [];
    const next = detections.map((item) => (item.id === id ? { ...item, ...patch, last_seen_at: new Date().toISOString() } : item));
    await chrome.storage.local.set({ [DETECTED_MEDIA_KEY]: next });
    const updated = next.find((item) => item.id === id);
    if (updated) emitMediaDetected(updated);
    return updated;
  });
}

function emitMediaDetected(payload) {
  chrome.runtime.sendMessage({ type: "MEDIA_DETECTED", payload }, () => {
    void chrome.runtime.lastError;
  });
}

async function mergeDetectedDirectMedia(detection) {
  if (!detection || !detection.url) return;
  if (await isIgnoredMediaUrl(detection.url)) return;
  if (officialMutationBlockedByReindex()) return;
  const type = /audio\//i.test(detection.content_type || "") || /\.(mp3|m4a|wav|aac|ogg)(?:[?#]|$)/i.test(detection.url)
    ? "audio"
    : "video";
  const sourceTitle = detectedMediaSourceTitle(detection);
  const canonicalKey = canonicalVideoKey(detection) || (mediaCandidateKey(detection.url) ? `media:${mediaCandidateKey(detection.url)}` : detection.url);
  const result = await runIndexMutation("merge_detected_media", () => {
    if (officialMutationBlockedByReindex()) return indexBusyResponse();
    return mergeScrape({ resources: [
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
    ] });
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
    case "SCRAPE_PAGE": {
      if (officialMutationBlockedByReindex()) return indexBusyResponse();
      return runIndexMutation("merge_scrape", (token) => officialMutationBlockedByReindex() ? indexBusyResponse() : mergeScrape(message.payload || {}, token));
    }
    case "GET_INDEX":
      return runIndexMutation("get_index_cleanup", () => getIndex());
    case "STORE_CONTENT": {
      if (officialMutationBlockedByReindex()) return indexBusyResponse();
      return runIndexMutation("store_content", () => officialMutationBlockedByReindex() ? indexBusyResponse() : storeContent(message.payload || {}));
    }
    case "STORE_CONTENT_BATCH": {
      if (officialMutationBlockedByReindex()) return indexBusyResponse();
      return runIndexMutation("store_content_batch", () => officialMutationBlockedByReindex() ? indexBusyResponse() : storeContentBatch(message.payload || {}));
    }
    case "CLEAR_INDEX": {
      if (activeCrawlPromise || crawlStartInProgress) return { ok: false, error: "index_already_running" };
      return runIndexMutation("clear_index", () => (activeCrawlPromise || crawlStartInProgress) ? indexBusyResponse() : clearIndex(message.payload || {}));
    }
    case "SCAN_ACTIVE_TAB":
      return scanActiveTab();
    case "CHECK_BLACKBOARD_SESSION":
      return checkBlackboardSession(message.payload || {});
    case "CRAWL_SITE":
      return startCrawlSite(message.payload || {});
    case "REINDEX_SITE":
      return startReindexSite(message.payload || {});
    case "IMPORT_TRANSCRIPTS":
      return runIndexMutation("import_transcripts", () => importTranscripts(message.payload || {}));
    case "INSTALL_RESOURCE_PACK":
      return installResourcePack(message.payload || {});
    case "UPSERT_LOCAL_RESOURCES":
      return upsertLocalResources(message.payload || {});
    case "REMOVE_LOCAL_RESOURCE":
      return removeLocalResource(message.payload || {});
    case "IMPORT_DETECTED_CAPTIONS":
      return importDetectedCaptions();
    case "DISMISS_MEDIA_CANDIDATE":
      return dismissMediaCandidate(message.payload || {});
    case "RESTORE_DISMISSED_MEDIA":
      return restoreDismissedMedia();
    case "SEARCH_VIDEO_RESULTS":
      return searchVideoResults(message.payload || {});
    case "MANUAL_ATTACH_TRANSCRIPT":
      return runIndexMutation("manual_attach_transcript", () => manualAttachTranscript(message.payload || {}));
    default:
      return { ok: false, error: `unknown_message_type:${message.type}` };
  }
}

async function checkBlackboardSession(payload = {}) {
  const requestedUrl = normalizeUrlFrom(
    payload.url || payload.seed_url || payload.seedUrl || DEFAULT_CRAWL_SEED_URL,
    DEFAULT_CRAWL_SEED_URL
  );
  try {
    const response = await fetchWithTimeout(requestedUrl, {
      credentials: "include",
      redirect: "follow",
      cache: "no-store"
    }, BLACKBOARD_SESSION_TIMEOUT_MS);
    const contentType = response.headers.get("content-type") || "";
    const body = /text\/html|application\/xhtml\+xml/i.test(contentType) ? await response.text() : "";
    const accessFailureReason = blackboardCrawlAccessFailureReason(body);
    if (accessFailureReason) {
      return {
        ok: true,
        authenticated: false,
        reason: accessFailureReason,
        final_url: response.url || requestedUrl
      };
    }
    return {
      ok: true,
      ...BlackboardSession.assessBlackboardSession({
        requested_url: requestedUrl,
        final_url: response.url || requestedUrl,
        status: response.status,
        content_type: contentType,
        body
      })
    };
  } catch (_error) {
    return {
      ok: false,
      authenticated: false,
      reason: "request_failed",
      error: "Could not verify the Blackboard session."
    };
  }
}

async function dismissMediaCandidate(payload) {
  return runMediaMutation(async () => {
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
  });
}

async function restoreDismissedMedia() {
  return runMediaMutation(async () => {
    const data = await chrome.storage.local.get(IGNORED_MEDIA_KEY);
    const ignored = Array.isArray(data[IGNORED_MEDIA_KEY]) ? data[IGNORED_MEDIA_KEY] : [];
    await chrome.storage.local.set({ [IGNORED_MEDIA_KEY]: [] });
    return { ok: true, restored_ignored: ignored.length };
  });
}
async function getIndex() {
  const data = await chrome.storage.local.get([RESOURCE_KEY, TRANSCRIPT_KEY, CONTENT_KEY, META_KEY, RESOURCE_PACK_KEY, DETECTED_MEDIA_KEY, IGNORED_MEDIA_KEY]);
  let resources = data[RESOURCE_KEY] || [];
  let transcripts = data[TRANSCRIPT_KEY] || [];
  let contentStore = data[CONTENT_KEY] || {};
  const detectedMedia = data[DETECTED_MEDIA_KEY] || [];
  const ignoredRecords = Array.isArray(data[IGNORED_MEDIA_KEY]) ? data[IGNORED_MEDIA_KEY] : [];
  const ignoredKeys = ignoredMediaKeys(ignoredRecords);
  const prunedDetectedMedia = pruneDetectedMediaToTsinghua(detectedMedia).filter((item) => !mediaCandidateIsIgnored(item, ignoredKeys));
  const deduped = dedupeTranscriptIndex(resources, transcripts);
  resources = deduped.resources;
  transcripts = deduped.transcripts;
  const attachmentMigration = migrateLegacyAttachmentHydration(resources, contentStore, data[META_KEY] || {});
  resources = attachmentMigration.resources;
  contentStore = attachmentMigration.contentStore;
  const transcriptMigration = classifyLegacyTranscriptSources(transcripts, resources);
  transcripts = transcriptMigration.transcripts;
  let meta = data[META_KEY] || {
    resource_count: resources.length,
    transcript_count: transcripts.length,
    content_schema_version: CONTENT_SCHEMA_VERSION,
    content_body_limit: MAX_INDEXED_BODY_CHARS,
    legacy_content_truncation_risk: false,
    legacy_truncated_resource_ids: []
  };
  if (deduped.changed || attachmentMigration.changed || transcriptMigration.changed) {
    matchTranscriptsToResources(resources, transcripts);
    await saveIndex(resources, transcripts, contentStore);
    meta = (await chrome.storage.local.get(META_KEY))[META_KEY] || meta;
  }
  return {
    ok: true,
    resources,
    transcripts,
    detected_media: prunedDetectedMedia,
    ignored_media_keys: Array.from(ignoredKeys),
    ignored_media_count: ignoredRecords.length,
    resource_packs: Array.isArray(data[RESOURCE_PACK_KEY]) ? data[RESOURCE_PACK_KEY] : [],
    content_store: contentStore,
    meta
  };
}

async function clearIndex(payload = {}) {
  const preserveResourcePacks = Boolean(payload.preserve_resource_packs || payload.preserveResourcePacks);
  let resources = [];
  let contentStore = {};
  let resourcePacks = [];

  if (preserveResourcePacks) {
    const data = await chrome.storage.local.get([RESOURCE_KEY, CONTENT_KEY, RESOURCE_PACK_KEY]);
    resources = (data[RESOURCE_KEY] || []).filter((resource) => Boolean(
      resource?.source_pack_id ||
      resource?.collection_kind === "user_import" ||
      resource?.content_origin === "user_import"
    ));
    const preservedIds = new Set(resources.map((resource) => resource.id).filter(Boolean));
    contentStore = Object.fromEntries(
      Object.entries(data[CONTENT_KEY] || {}).filter(([resourceId]) => preservedIds.has(resourceId))
    );
    resourcePacks = Array.isArray(data[RESOURCE_PACK_KEY]) ? data[RESOURCE_PACK_KEY] : [];
  }

  await saveIndex(resources, [], contentStore, {
    index_generation: `generation_${Date.now().toString(36)}_clear`,
    index_build_status: "complete",
    legacy_content_truncation_risk: false,
    legacy_truncated_resource_ids: []
  }, {
    [RESOURCE_PACK_KEY]: resourcePacks,
    [DETECTED_MEDIA_KEY]: [],
    [IGNORED_MEDIA_KEY]: []
  });
  return {
    ok: true,
    preserved_resource_pack_count: resourcePacks.length,
    preserved_resource_count: resources.length
  };
}

async function installResourcePack(payload) {
  const session = await checkBlackboardSession();
  if (!session.ok) return { ok: false, error: session.error || "Could not verify the Blackboard session." };
  if (!session.authenticated) return { ok: false, error: "Please log into Blackboard in this browser before installing resources." };

  const pack = normalizeResourcePack(payload.pack || {});
  if (!pack.id || !pack.title) return { ok: false, error: "invalid_resource_pack" };
  const incomingResources = Array.isArray(payload.resources) ? payload.resources : [];
  if (!incomingResources.length) return { ok: false, error: "resource_pack_empty" };
  const submittedIds = new Set();
  for (let index = 0; index < incomingResources.length; index += 1) {
    const raw = incomingResources[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "resource_pack_invalid_resource" };
    const resourceId = derivedResourcePackItemId(pack.id, raw, index);
    const content = cleanIndexedBodyText(raw.content || raw.searchable_content || raw.searchableContent || raw.text || "", "optional resource pack body");
    if (!resourceId || submittedIds.has(resourceId)) {
      return { ok: false, error: "resource_pack_duplicate_resource_id" };
    }
    if (!content || normalizeText(content).length <= 40) {
      return { ok: false, error: "resource_pack_body_missing", resource_id: resourceId };
    }
    submittedIds.add(resourceId);
  }
  const commitSession = await checkBlackboardSession();
  if (!commitSession.ok) return { ok: false, error: commitSession.error || "Could not reverify the Blackboard session." };
  if (!commitSession.authenticated) return { ok: false, error: "Please log into Blackboard in this browser before installing resources." };
  const sessionVerifiedAt = Date.now();
  return runIndexMutation("install_resource_pack", () => commitResourcePack(pack, incomingResources, sessionVerifiedAt));
}

async function commitResourcePack(pack, incomingResources, sessionVerifiedAt) {
  if (Date.now() - sessionVerifiedAt > BLACKBOARD_SESSION_TIMEOUT_MS * 2) {
    return { ok: false, error: "resource_pack_session_verification_expired" };
  }
  const data = await chrome.storage.local.get([RESOURCE_KEY, TRANSCRIPT_KEY, CONTENT_KEY, RESOURCE_PACK_KEY]);
  const allResources = data[RESOURCE_KEY] || [];
  for (let index = 0; index < incomingResources.length; index += 1) {
    const resourceId = derivedResourcePackItemId(pack.id, incomingResources[index], index);
    const collision = allResources.find((resource) => resource.id === resourceId && resource.source_pack_id !== pack.id);
    if (collision) return { ok: false, error: "resource_pack_resource_id_collision", resource_id: resourceId };
  }
  const packResourcePrefix = `resource_pack:${pack.id}:`;
  const previousPackResources = allResources.filter((resource) => resource.source_pack_id === pack.id);
  const currentResources = allResources.filter((resource) => resource.source_pack_id !== pack.id);
  const byId = new Map(currentResources.map((resource) => [resource.id, resource]));
  const contentStore = { ...(data[CONTENT_KEY] || {}) };
  for (const resource of data[RESOURCE_KEY] || []) {
    if (resource.source_pack_id === pack.id) delete contentStore[resource.id];
  }
  const now = new Date().toISOString();
  let installedResources = 0;
  let searchableResources = 0;
  const installedDocuments = new Set();

  for (let index = 0; index < incomingResources.length; index += 1) {
    const raw = incomingResources[index];
    const rawId = resourcePackItemSourceKey(raw, index);
    const resourceId = derivedResourcePackItemId(pack.id, raw, index);
    const normalized = normalizeResource({
      ...raw,
      id: resourceId,
      canonical_key: cleanText(raw.canonical_key || `${packResourcePrefix}${rawId}`, 240),
      type: cleanText(raw.type || inferType(raw.url || "", raw.title || ""), 80),
      title: raw.title || raw.name || raw.url || pack.title,
      url: raw.url || "",
      preserve_url: true,
      page_url: raw.page_url || raw.source_url || raw.url || "",
      page_title: raw.page_title || pack.title,
      section: raw.section || `Optional resources - ${pack.title}`,
      context: raw.context || raw.description || pack.description || "",
      discovered_at: raw.discovered_at || now
    });
    if (!normalized.title) continue;

    const resource = {
      ...resourceMetadataFrom(normalized),
      source_pack_id: pack.id,
      source_pack_original_id: cleanText(raw.id || raw.pack_resource_id || raw.packResourceId || "", 160),
      source_pack_title: pack.title,
      source_pack_version: pack.version,
      source_pack_document_id: cleanText(raw.document_id || raw.documentId || raw.pack_document_id || raw.packDocumentId || raw.pack_resource_id || raw.id || resourceId, 120),
      source_pack_document_title: cleanText(raw.document_title || raw.documentTitle || raw.pack_document_title || raw.packDocumentTitle || raw.title || normalized.title, 240),
      source_pack_page_range: cleanText(raw.page_range || raw.pageRange || "", 80),
      source_pack_provenance: cleanText(raw.source_pack_provenance || raw.provenance || "", 120)
    };
    installedDocuments.add(resource.source_pack_document_id || resource.id);
    const content = cleanIndexedBodyText(raw.content || raw.searchable_content || raw.searchableContent || raw.text || "", "optional resource pack body");
    if (content) {
      contentStore[resource.id] = content;
      if (!isFileLikeResource(resource) || isReadableStoredFileBodyText(resource, content)) searchableResources += 1;
    }

    const existing = byId.get(resource.id);
    byId.set(resource.id, {
      ...(existing || {}),
      ...withoutEmpty(resource),
      transcript_ids: uniqueStrings([...(existing?.transcript_ids || []), ...(resource.transcript_ids || [])]),
      first_seen_at: existing?.first_seen_at || resource.discovered_at || now,
      last_seen_at: now
    });
    installedResources += 1;
  }

  const resources = Array.from(byId.values());
  const resourceIds = new Set(resources.map((resource) => resource.id));
  const removedPackIds = new Set(previousPackResources.map((resource) => resource.id).filter((resourceId) => !resourceIds.has(resourceId)));
  const transcripts = reconcileTranscriptResourceReferences(data[TRANSCRIPT_KEY] || [], new Map(), removedPackIds, resourceIds);
  matchTranscriptsToResources(resources, transcripts);
  const existingPacks = Array.isArray(data[RESOURCE_PACK_KEY]) ? data[RESOURCE_PACK_KEY] : [];
  const previousPack = existingPacks.find((item) => item.id === pack.id);
  const nextPack = {
    ...pack,
    resource_count: installedResources,
    document_count: installedDocuments.size || installedResources,
    content_count: searchableResources,
    installed_at: previousPack?.installed_at || now,
    updated_at: now
  };
  const resourcePacks = [
    ...existingPacks.filter((item) => item.id !== pack.id),
    nextPack
  ].sort((a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id)));
  await saveIndex(resources, transcripts, contentStore, {}, { [RESOURCE_PACK_KEY]: resourcePacks });

  return {
    ok: true,
    pack: nextPack,
    added_or_updated: installedResources,
    document_count: installedDocuments.size || installedResources,
    content_count: searchableResources,
    resource_count: resources.length
  };
}

function normalizeResourcePack(raw) {
  const id = cleanResourcePackId(raw.id || raw.slug || raw.title || "");
  return {
    id,
    title: cleanText(raw.title || raw.name || id, 160),
    version: cleanText(raw.version || "", 80),
    description: cleanText(raw.description || "", 500),
    source_url: cleanText(raw.source_url || raw.sourceUrl || raw.manifest_url || raw.manifestUrl || "", 600)
  };
}

function cleanResourcePackId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function resourcePackItemSourceKey(raw, index = 0) {
  return cleanText(
    raw?.pack_resource_id || raw?.packResourceId || raw?.document_id || raw?.documentId || raw?.id || raw?.canonical_key || raw?.canonicalKey || [raw?.url, raw?.title, index].filter(Boolean).join("|"),
    240
  );
}

function derivedResourcePackItemId(packId, raw, index = 0) {
  const sourceKey = resourcePackItemSourceKey(raw, index);
  if (!packId || !sourceKey) return "";
  return cleanText(`resource_pack:${packId}:${hashString(sourceKey)}`, 120);
}
async function mergeScrape(payload, mutationToken = null) {
  const scrapedResources = Array.isArray(payload.resources) ? payload.resources : [];
  const scrapedTranscripts = normalizeTranscriptBundle(payload.transcripts || []).map((transcript) => ({
    ...transcript,
    collection_kind: transcript.collection_kind || "blackboard_scrape",
    content_origin: transcript.content_origin || "blackboard_scrape",
    source_class: transcript.source_class || "official_blackboard"
  }));
  const data = await chrome.storage.local.get([RESOURCE_KEY, TRANSCRIPT_KEY, CONTENT_KEY, IGNORED_MEDIA_KEY]);
  const ignoredKeys = ignoredMediaKeys(data[IGNORED_MEDIA_KEY]);
  const currentResources = data[RESOURCE_KEY] || [];
  let transcripts = data[TRANSCRIPT_KEY] || [];
  const contentStore = { ...(data[CONTENT_KEY] || {}) };
  const byId = new Map(currentResources.map((resource) => [resource.id, resource]));
  const byIdentity = new Map(currentResources.map((resource) => [stableResourceIdentityKey(resource), resource]).filter(([identity]) => identity));
  const migratedResourceIds = new Map();

  for (const raw of scrapedResources) {
    const normalized = normalizeResource(raw);
    if (!normalized.url && !normalized.title) continue;
    if (mediaCandidateIsIgnored(normalized, ignoredKeys)) continue;
    const resource = resourceMetadataFrom(normalized);
    const content = searchableContentFrom(normalized);
    const identity = stableResourceIdentityKey(resource);
    const existing = byId.get(resource.id) || (identity ? byIdentity.get(identity) : null);
    if (existing && existing.id !== resource.id) {
      byId.delete(existing.id);
      migratedResourceIds.set(existing.id, resource.id);
      if (!content && contentStore[existing.id] && !contentStore[resource.id]) contentStore[resource.id] = contentStore[existing.id];
      delete contentStore[existing.id];
    }
    if (content) contentStore[resource.id] = content;
    let next;
    if (existing) {
      next = {
        ...existing,
        ...withoutEmpty(resource),
        id: resource.id,
        transcript_ids: uniqueStrings([...(existing.transcript_ids || []), ...(resource.transcript_ids || [])]),
        first_seen_at: existing.first_seen_at || resource.discovered_at,
        last_seen_at: new Date().toISOString()
      };
    } else {
      next = {
        ...resource,
        transcript_ids: uniqueStrings(resource.transcript_ids || []),
        first_seen_at: resource.discovered_at || new Date().toISOString(),
        last_seen_at: new Date().toISOString()
      };
    }
    next = reconcileIncrementalAttachmentBody(existing, resource, next, contentStore);
    byId.set(resource.id, next);
    if (identity) byIdentity.set(identity, next);
  }

  if (scrapedTranscripts.length) {
    const transcriptById = new Map(transcripts.map((transcript) => [transcript.id, transcript]));
    for (const transcript of scrapedTranscripts) {
      transcriptById.set(transcript.id, mergeTranscriptRecords(transcriptById.get(transcript.id), transcript));
    }
    transcripts = Array.from(transcriptById.values());
  }
  if (migratedResourceIds.size) {
    transcripts = reconcileTranscriptResourceReferences(transcripts, migratedResourceIds, new Set(), new Set(byId.keys()));
  }

  let resources = Array.from(byId.values());
  const deduped = dedupeTranscriptIndex(resources, transcripts);
  resources = deduped.resources;
  transcripts = deduped.transcripts;
  matchTranscriptsToResources(resources, transcripts);
  await saveIndex(resources, transcripts, contentStore, {}, {}, mutationToken);
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
  let incoming = normalizeTranscriptBundle(payload);
  if (!incoming.length) return { ok: false, error: "no_transcripts_found" };

  const data = await chrome.storage.local.get([RESOURCE_KEY, TRANSCRIPT_KEY]);
  const resources = data[RESOURCE_KEY] || [];
  const officialResourceIds = new Set(resources
    .filter((resource) => !resourcePersistsAcrossBlackboardReindex(resource))
    .map((resource) => resource.id));
  incoming = incoming.map((transcript) => {
    if (transcriptHasDeclaredCorpusSource(transcript)) return transcript;
    const linkedToOfficial = (transcript.matched_resource_ids || []).some((resourceId) => officialResourceIds.has(resourceId));
    return {
      ...transcript,
      collection_kind: linkedToOfficial ? "blackboard_import" : "user_import",
      content_origin: linkedToOfficial ? "blackboard_transcript" : "user_import",
      source_class: linkedToOfficial ? "official_blackboard" : "user_import"
    };
  });
  const existing = data[TRANSCRIPT_KEY] || [];
  const byId = new Map(existing.map((transcript) => [transcript.id, transcript]));

  for (const transcript of incoming) {
    byId.set(transcript.id, mergeTranscriptRecords(byId.get(transcript.id), transcript));
  }

  let transcripts = Array.from(byId.values());
  const deduped = dedupeTranscriptIndex(resources, transcripts);
  transcripts = deduped.transcripts;
  const matchSummary = matchTranscriptsToResources(resources, transcripts);
  const graph = reconcileIndexTranscriptGraph(resources, transcripts);
  transcripts = graph.transcripts;
  await saveIndex(graph.resources, transcripts);
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

  const importResult = await runIndexMutation("import_video_search_transcripts", () => importTranscripts({ transcripts }));
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
  const result = await storeContentBatch({ entries: [payload] });
  if (!result.ok) return result;
  const stored = result.stored[0];
  return { ok: true, ...stored };
}

async function storeContentBatch(payload) {
  const entries = Array.isArray(payload.entries) ? payload.entries : Array.isArray(payload.resources) ? payload.resources : [];
  if (!entries.length || entries.length > 50) return { ok: false, error: "invalid_content_batch" };
  const prepared = [];
  const seenIds = new Set();
  for (const entry of entries) {
    const resourceId = cleanText(entry?.resource_id || entry?.resourceId || "", 120);
    const rawContent = typeof entry?.content === "string" ? entry.content : typeof entry?.text === "string" ? entry.text : "";
    const content = cleanIndexedBodyText(rawContent, "extracted resource body");
    if (!resourceId || !content) return { ok: false, error: "missing_resource_or_content" };
    if (seenIds.has(resourceId)) return { ok: false, error: "duplicate_resource_in_content_batch" };
    const suppliedContentFingerprint = String(entry?.content_fingerprint || entry?.contentFingerprint || entry?.content_hash_sha256 || "").trim().toLowerCase();
    const suppliedTextHash = String(entry?.extracted_text_sha256 || entry?.extractedTextSha256 || "").trim().toLowerCase();
    if (suppliedContentFingerprint && !/^[a-f0-9]{64}$/.test(suppliedContentFingerprint)) return { ok: false, error: "invalid_content_fingerprint", resource_id: resourceId };
    if (suppliedTextHash && !/^[a-f0-9]{64}$/.test(suppliedTextHash)) return { ok: false, error: "invalid_extracted_text_hash", resource_id: resourceId };
    const extractedTextHash = await sha256Hex(rawContent);
    if (suppliedTextHash && suppliedTextHash !== extractedTextHash) return { ok: false, error: "extracted_text_hash_mismatch", resource_id: resourceId };
    seenIds.add(resourceId);
    prepared.push({
      resourceId,
      content,
      contentFingerprint: suppliedContentFingerprint,
      extractedTextHash,
      expectedHydrationToken: cleanText(entry?.expected_hydration_token || entry?.expectedHydrationToken || "", 160)
    });
  }
  const data = await chrome.storage.local.get([RESOURCE_KEY, TRANSCRIPT_KEY, CONTENT_KEY]);
  const resources = data[RESOURCE_KEY] || [];
  const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));
  for (const entry of prepared) {
    const resource = resourcesById.get(entry.resourceId);
    if (!resource) return { ok: false, error: "resource_not_found", resource_id: entry.resourceId };
    if (!isManagedBlackboardAttachmentHydrationTarget(resource)) {
      return { ok: false, error: "invalid_content_target", resource_id: entry.resourceId,
        detail: "Content hydration is limited to managed Blackboard file attachments." };
    }
    const hydrationToken = cleanText(resource.hydration_token || "", 160);
    if (!hydrationToken || !entry.expectedHydrationToken) {
      return { ok: false, error: "hydration_token_required", resource_id: entry.resourceId };
    }
    if (hydrationToken !== entry.expectedHydrationToken) {
      return { ok: false, error: "stale_hydration_token", resource_id: entry.resourceId };
    }
    if (!entry.contentFingerprint) {
      return { ok: false, error: "content_fingerprint_required", resource_id: entry.resourceId };
    }
    entry.consumedHydrationToken = hydrationToken;
  }
  const preparedById = new Map(prepared.map((entry) => [entry.resourceId, entry]));
  const nextResources = resources.map((resource) => {
    const entry = preparedById.get(resource.id);
    if (!entry || !isFileLikeResource(resource)) return resource;
    const next = {
      ...resource,
      body_verified: true,
      indexed_body_source: "extracted",
      content_origin: "extracted_attachment",
      extracted_text_sha256: entry.extractedTextHash,
      last_body_verified_at: new Date().toISOString()
    };
    if (entry.contentFingerprint) {
      next.content_fingerprint = entry.contentFingerprint;
      next.last_verified_content_fingerprint = entry.contentFingerprint;
    }
    delete next.needs_body_hydration;
    delete next.body_revalidation_required;
    delete next.hydration_token;
    return next;
  });
  const contentStore = { ...(data[CONTENT_KEY] || {}) };
  for (const entry of prepared) contentStore[entry.resourceId] = entry.content;
  await saveIndex(nextResources, data[TRANSCRIPT_KEY] || [], contentStore);
  return {
    ok: true,
    stored: prepared.map((entry) => ({
      resource_id: entry.resourceId,
      status: "stored",
      content_length: entry.content.length,
      content_fingerprint: entry.contentFingerprint,
      extracted_text_sha256: entry.extractedTextHash,
      expected_hydration_token: entry.expectedHydrationToken,
      consumed_hydration_token: entry.consumedHydrationToken
    }))
  };
}

async function upsertLocalResources(payload) {
  const collectionKind = String(payload.collection_kind || payload.collectionKind || "user_import").trim().toLowerCase();
  if (collectionKind !== "user_import") {
    return { ok: false, added: 0, replaced: 0, unchanged: 0, error: "invalid_collection_kind", errors: ["Only the user_import collection can be changed through this route."], results: [], list: [] };
  }
  const entries = Array.isArray(payload.entries) ? payload.entries : Array.isArray(payload.resources) ? payload.resources : [];
  const errors = [];
  if (!entries.length || entries.length > 50) {
    const error = "Submit between 1 and 50 extracted resources.";
    return { ok: false, added: 0, replaced: 0, unchanged: 0, error, errors: [error], results: [], list: [] };
  }
  const prepared = [];
  const seenIds = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const raw = entries[index];
    const label = `Entry ${index + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${label} is not an object.`);
      continue;
    }
    if (["blob", "file", "path", "url", "bytes", "array_buffer", "arrayBuffer", "data"].some((key) => raw[key] !== undefined && raw[key] !== null && raw[key] !== "")) {
      errors.push(`${label} contains raw file/blob/path data; submit extracted text only.`);
      continue;
    }
    const clientId = cleanText(raw.client_id || raw.clientId || `entry-${index + 1}`, 120);
    const name = cleanText(raw.file_name || raw.fileName || raw.name || raw.title || "", 240);
    const type = cleanLocalResourceType(raw.kind || raw.type, name);
    const rawContent = typeof raw.content === "string" ? raw.content : typeof raw.text === "string" ? raw.text : "";
    const suppliedHash = String(raw.content_hash_sha256 || raw.contentHashSha256 || raw.hash || raw.sha256 || "").trim().toLowerCase();
    const rawRequestedId = String(raw.id || "").trim();
    const requestedLocalId = cleanLocalResourceId(rawRequestedId.replace(/^user_import:/i, ""));
    const resourceId = requestedLocalId ? `user_import:${requestedLocalId}` : /^[a-f0-9]{64}$/.test(suppliedHash) ? `user_import:${suppliedHash}` : "";
    const operation = String(raw.operation || (raw.replace_resource_id || raw.replaceResourceId ? "replace" : "add")).trim().toLowerCase();
    const collisionAction = String(raw.collision_action || raw.collisionAction || (operation === "replace" ? "replace" : "add")).trim().toLowerCase();
    const replaceResourceId = cleanText(raw.replace_resource_id || raw.replaceResourceId || "", 120);
    const expectedPreviousHash = String(raw.expected_previous_hash_sha256 || raw.expectedPreviousHashSha256 || "").trim().toLowerCase();
    const expectedPreviousExtractedTextHash = String(raw.expected_previous_extracted_text_sha256 || raw.expectedPreviousExtractedTextSha256 || "").trim().toLowerCase();
    const expectedIndexRevision = Number(raw.expected_index_revision ?? raw.expectedIndexRevision);
    const suppliedTextHash = String(raw.extracted_text_sha256 || raw.extractedTextSha256 || "").trim().toLowerCase();
    if (!resourceId || !name || !type) errors.push(`${label} is missing a valid id, name, or supported type.`);
    if (!rawContent.trim() || rawContent.length > MAX_INDEXED_BODY_CHARS) errors.push(`${label} has missing or oversized extracted text.`);
    if (!/^[a-f0-9]{64}$/.test(suppliedHash)) errors.push(`${label} has an invalid raw-file SHA-256 hash.`);
    if (suppliedTextHash && !/^[a-f0-9]{64}$/.test(suppliedTextHash)) errors.push(`${label} has an invalid extracted-text SHA-256 hash.`);
    if (!["add", "replace"].includes(operation) || !["add", "replace", "keep_both"].includes(collisionAction)) {
      errors.push(`${label} has an unsupported import operation.`);
    }
    if (!Number.isInteger(expectedIndexRevision) || expectedIndexRevision < 0) {
      errors.push(`${label} is missing a valid expected index revision.`);
    }
    if (operation === "replace" && (!replaceResourceId || collisionAction !== "replace" || !/^[a-f0-9]{64}$/.test(expectedPreviousHash) || !/^[a-f0-9]{64}$/.test(expectedPreviousExtractedTextHash))) {
      errors.push(`${label} replacement is missing its target, expected raw hash, or expected extracted-text hash.`);
    }
    if (operation === "add" && (replaceResourceId || collisionAction === "replace")) {
      errors.push(`${label} has inconsistent add/replace fields.`);
    }
    if (resourceId && seenIds.has(resourceId)) errors.push(`${label} collides with another submitted id.`);
    if (resourceId) seenIds.add(resourceId);
    if (
      !resourceId || !name || !type || !rawContent.trim() || rawContent.length > MAX_INDEXED_BODY_CHARS ||
      !/^[a-f0-9]{64}$/.test(suppliedHash) || (suppliedTextHash && !/^[a-f0-9]{64}$/.test(suppliedTextHash)) ||
      !["add", "replace"].includes(operation) || !["add", "replace", "keep_both"].includes(collisionAction)
    ) continue;
    const extractedTextHash = await sha256Hex(rawContent);
    if (suppliedTextHash && extractedTextHash !== suppliedTextHash) {
      errors.push(`${label} extracted-text hash does not match its content.`);
      continue;
    }
    const content = cleanIndexedBodyText(rawContent, "user-imported resource body");
    if (normalizeText(content).length <= 40) {
      errors.push(`${label} does not contain enough readable extracted text.`);
      continue;
    }
    prepared.push({
      clientId, resourceId, name, type, content, hash: suppliedHash, extractedTextHash,
      operation, collisionAction, replaceResourceId, expectedPreviousHash, expectedPreviousExtractedTextHash, expectedIndexRevision,
      byteSize: Math.max(0, Number(raw.byte_size || raw.byteSize || 0)),
      contentType: cleanText(raw.content_type || raw.contentType || "", 160)
    });
  }
  if (errors.length || prepared.length !== entries.length) {
    return { ok: false, added: 0, replaced: 0, unchanged: 0, error: errors[0] || "Local resource validation failed.", errors, results: [], list: [] };
  }
  return runIndexMutation(
    "upsert_local_resources",
    (mutationToken) => upsertPreparedLocalResources(prepared, mutationToken),
    { captureRevision: true }
  );
}

async function upsertPreparedLocalResources(prepared, mutationToken) {
  const data = await chrome.storage.local.get([RESOURCE_KEY, TRANSCRIPT_KEY, CONTENT_KEY]);
  const resources = data[RESOURCE_KEY] || [];
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const contentStore = { ...(data[CONTENT_KEY] || {}) };
  const errors = [];
  const activeIndexRevision = Math.max(0, Number(mutationToken?.expectedRevision || 0));
  const submittedRevisions = new Set(prepared.map((entry) => entry.expectedIndexRevision));
  if (submittedRevisions.size !== 1 || !submittedRevisions.has(activeIndexRevision)) {
    const error = "The index changed after preflight; refresh My resources and try again.";
    return {
      ok: false, added: 0, replaced: 0, unchanged: 0, error: "stale_index_revision", errors: [error],
      results: prepared.map((entry) => ({ client_id: entry.clientId, ok: false, error: "stale_index_revision", detail: error })),
      list: localResourceList(resources, data[CONTENT_KEY] || {})
    };
  }
  const replacementIds = new Set();
  for (const entry of prepared) {
    const existingAtId = byId.get(entry.resourceId);
    const sameRaw = Array.from(byId.values()).find((resource) => resource.collection_kind === "user_import" && localResourceFileHash(resource) === entry.hash);
    const exact = sameRaw && localResourceExtractedTextHash(sameRaw) === entry.extractedTextHash ? sameRaw : null;
    if (existingAtId && existingAtId.collection_kind !== "user_import") {
      errors.push(`Resource id ${entry.resourceId} collides with a managed resource.`);
    }
    if (entry.operation === "replace") {
      const target = byId.get(entry.replaceResourceId);
      if (!target || target.collection_kind !== "user_import") {
        errors.push(`Replacement target ${entry.replaceResourceId} is not a user-imported resource.`);
      } else if (localResourceFileHash(target) !== entry.expectedPreviousHash) {
        errors.push(`Replacement target ${entry.replaceResourceId} changed after preflight; refresh and try again.`);
      } else if (localResourceExtractedTextHash(target) !== entry.expectedPreviousExtractedTextHash) {
        errors.push(`Replacement target ${entry.replaceResourceId} has different extracted text than the preflight copy; refresh and try again.`);
      }
      if (replacementIds.has(entry.replaceResourceId)) errors.push(`Replacement target ${entry.replaceResourceId} was submitted more than once.`);
      replacementIds.add(entry.replaceResourceId);
    } else {
      if (exact) continue;
      if (sameRaw) {
        errors.push(`Raw file ${entry.name} matched an indexed SHA-256 but its extracted text differed; choose an explicit replacement.`);
        continue;
      }
      if (entry.collisionAction !== "keep_both") {
        const sameName = Array.from(byId.values()).find((resource) => (
          resource.collection_kind === "user_import" && localResourceNameKey(resource.original_file_name || resource.file_name || resource.original_name || resource.title) === localResourceNameKey(entry.name)
        ));
        if (sameName) errors.push(`A different file named ${entry.name} already exists; choose replace or keep both.`);
      }
    }
    if (exact) continue;
    if (
      existingAtId && existingAtId.id !== entry.replaceResourceId &&
      (localResourceFileHash(existingAtId) !== entry.hash || localResourceExtractedTextHash(existingAtId) !== entry.extractedTextHash)
    ) {
      errors.push(`Resource id ${entry.resourceId} already exists with different raw or extracted content.`);
    }
  }
  if (errors.length) {
    return {
      ok: false, added: 0, replaced: 0, unchanged: 0,
      error: errors[0], errors,
      results: prepared.map((entry) => ({ client_id: entry.clientId, ok: false, error: errors[0] })),
      list: localResourceList(resources, data[CONTENT_KEY] || {})
    };
  }

  let added = 0;
  let replaced = 0;
  let unchanged = 0;
  const results = [];
  const resourceIdRemaps = new Map();
  const now = new Date().toISOString();
  for (const entry of prepared) {
    const exact = Array.from(byId.values()).find((resource) => resource.collection_kind === "user_import" && localResourceFileHash(resource) === entry.hash && localResourceExtractedTextHash(resource) === entry.extractedTextHash);
    let didReplace = false;
    if (entry.operation === "replace" && exact?.id !== entry.replaceResourceId) {
      byId.delete(entry.replaceResourceId);
      delete contentStore[entry.replaceResourceId];
      if (exact) resourceIdRemaps.set(entry.replaceResourceId, exact.id);
      else resourceIdRemaps.set(entry.replaceResourceId, entry.resourceId);
      didReplace = true;
      replaced += 1;
      if (exact) {
        results.push(localResourceSuccessAck(entry, "replaced", exact.id, { deduplicated: true }));
        continue;
      }
    }
    if (exact) {
      unchanged += 1;
      results.push(localResourceSuccessAck(entry, "unchanged", exact.id));
      continue;
    }
    if (entry.operation === "replace" && !didReplace) {
      byId.delete(entry.replaceResourceId);
      delete contentStore[entry.replaceResourceId];
      resourceIdRemaps.set(entry.replaceResourceId, entry.resourceId);
      didReplace = true;
      replaced += 1;
    }
    const previous = byId.get(entry.resourceId);
    byId.set(entry.resourceId, {
      id: entry.resourceId,
      canonical_key: `user_import:sha256:${entry.hash}`,
      type: entry.type,
      title: entry.name,
      original_name: entry.name,
      original_file_name: entry.name,
      file_name: entry.name,
      url: "",
      page_url: "",
      page_title: "My resources",
      section: "User-imported resources",
      context: "Imported locally from an extracted file.",
      discovered_at: previous?.discovered_at || now,
      first_seen_at: previous?.first_seen_at || now,
      last_seen_at: now,
      collection_kind: "user_import",
      content_origin: "user_import",
      body_verified: true,
      indexed_body_source: "extracted",
      content_sha256: entry.hash,
      content_hash_sha256: entry.hash,
      extracted_text_sha256: entry.extractedTextHash,
      content_type: entry.contentType,
      byte_size: entry.byteSize,
      transcript_ids: []
    });
    contentStore[entry.resourceId] = entry.content;
    if (!previous && !didReplace) added += 1;
    results.push(localResourceSuccessAck(entry, didReplace ? "replaced" : "added", entry.resourceId));
  }
  const nextResources = Array.from(byId.values());
  const localResources = nextResources.filter((resource) => resource.collection_kind === "user_import");
  const localExtractedChars = localResources.reduce((sum, resource) => sum + String(contentStore[resource.id] || "").length, 0);
  if ((added || replaced) && (localResources.length > LOCAL_RESOURCE_MAX_FILES || localExtractedChars > LOCAL_RESOURCE_MAX_EXTRACTED_CHARS)) {
    const detail = `My resources would exceed the persistent corpus limit (${LOCAL_RESOURCE_MAX_FILES} files or ${LOCAL_RESOURCE_MAX_EXTRACTED_CHARS.toLocaleString()} extracted characters). Remove an indexed local file and try again.`;
    return {
      ok: false,
      added: 0,
      replaced: 0,
      unchanged: 0,
      error: "local_resource_budget_exceeded",
      detail,
      errors: [detail],
      usage: {
        files: importedLocalResourceCount(resources),
        extracted_chars: importedLocalResourceChars(resources, data[CONTENT_KEY] || {}),
        max_files: LOCAL_RESOURCE_MAX_FILES,
        max_extracted_chars: LOCAL_RESOURCE_MAX_EXTRACTED_CHARS
      },
      results: prepared.map((entry) => ({ client_id: entry.clientId, ok: false, error: "local_resource_budget_exceeded", detail })),
      list: localResourceList(resources, data[CONTENT_KEY] || {})
    };
  }
  if (!added && !replaced) {
    return { ok: true, added, replaced, unchanged, errors: [], expected_index_revision: activeIndexRevision, committed_index_revision: activeIndexRevision, results: results.map((result) => ({ ...result, committed_index_revision: activeIndexRevision })), list: localResourceList(nextResources, contentStore) };
  }
  const validIds = new Set(nextResources.map((resource) => resource.id));
  const transcripts = reconcileTranscriptResourceReferences(data[TRANSCRIPT_KEY] || [], resourceIdRemaps, new Set(), validIds);
  matchTranscriptsToResources(nextResources, transcripts);
  await saveIndex(nextResources, transcripts, contentStore, {}, {}, mutationToken);
  const committedIndexRevision = activeIndexRevision + 1;
  return { ok: true, added, replaced, unchanged, errors: [], expected_index_revision: activeIndexRevision, committed_index_revision: committedIndexRevision, results: results.map((result) => ({ ...result, committed_index_revision: committedIndexRevision })), list: localResourceList(nextResources, contentStore) };
}

async function removeLocalResource(payload) {
  return runIndexMutation(
    "remove_local_resource",
    (mutationToken) => removePreparedLocalResource(payload, mutationToken),
    { captureRevision: true }
  );
}

async function removePreparedLocalResource(payload, mutationToken) {
  const resourceId = cleanText(payload.resource_id || payload.resourceId || payload.id || "", 120);
  if (!resourceId) return { ok: false, removed: 0, error: "missing_resource_id", list: [] };
  const data = await chrome.storage.local.get([RESOURCE_KEY, TRANSCRIPT_KEY, CONTENT_KEY]);
  const resources = data[RESOURCE_KEY] || [];
  const target = resources.find((resource) => resource.id === resourceId);
  if (!target || target.collection_kind !== "user_import") {
    return { ok: false, removed: 0, error: "not_user_import_resource", list: localResourceList(resources, data[CONTENT_KEY] || {}) };
  }
  const expectedHash = String(payload.expected_previous_hash_sha256 || payload.expectedPreviousHashSha256 || "").trim().toLowerCase();
  const expectedExtractedTextHash = String(payload.expected_previous_extracted_text_sha256 || payload.expectedPreviousExtractedTextSha256 || "").trim().toLowerCase();
  const expectedIndexRevision = Number(payload.expected_index_revision ?? payload.expectedIndexRevision);
  const actualHash = localResourceFileHash(target);
  const actualExtractedTextHash = localResourceExtractedTextHash(target);
  const activeIndexRevision = Math.max(0, Number(mutationToken?.expectedRevision || 0));
  if (!Number.isInteger(expectedIndexRevision) || expectedIndexRevision < 0 || expectedIndexRevision !== activeIndexRevision) {
    return {
      ok: false,
      removed: 0,
      error: "stale_index_revision",
      detail: "The index changed after this file was displayed. Refresh My resources and try again.",
      resource_id: resourceId,
      list: localResourceList(resources, data[CONTENT_KEY] || {})
    };
  }
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || !/^[a-f0-9]{64}$/.test(expectedExtractedTextHash) || expectedHash !== actualHash || expectedExtractedTextHash !== actualExtractedTextHash) {
    return {
      ok: false,
      removed: 0,
      error: "stale_resource",
      detail: "The indexed file or its extracted text changed after it was displayed. Refresh My resources and try again.",
      resource_id: resourceId,
      list: localResourceList(resources, data[CONTENT_KEY] || {})
    };
  }
  const nextResources = resources.filter((resource) => resource.id !== resourceId);
  const contentStore = { ...(data[CONTENT_KEY] || {}) };
  delete contentStore[resourceId];
  const validIds = new Set(nextResources.map((resource) => resource.id));
  const transcripts = reconcileTranscriptResourceReferences(data[TRANSCRIPT_KEY] || [], new Map(), new Set([resourceId]), validIds);
  matchTranscriptsToResources(nextResources, transcripts);
  await saveIndex(nextResources, transcripts, contentStore, {}, {}, mutationToken);
  return {
    ok: true,
    status: "removed",
    removed: 1,
    resource_id: resourceId,
    removed_hash_sha256: actualHash,
    removed_extracted_text_sha256: actualExtractedTextHash,
    expected_index_revision: expectedIndexRevision,
    removed_at_index_revision: activeIndexRevision,
    committed_index_revision: activeIndexRevision + 1,
    list: localResourceList(nextResources, contentStore)
  };
}

function localResourceSuccessAck(entry, status, resourceId, extra = {}) {
  return {
    client_id: entry.clientId,
    ok: true,
    operation: entry.operation,
    status,
    resource_id: resourceId,
    content_hash_sha256: entry.hash,
    extracted_text_sha256: entry.extractedTextHash,
    previous_resource_id: entry.operation === "replace" ? entry.replaceResourceId : "",
    expected_index_revision: entry.expectedIndexRevision,
    ...extra
  };
}

function importedLocalResourceCount(resources) {
  return (resources || []).filter((resource) => resource.collection_kind === "user_import").length;
}

function importedLocalResourceChars(resources, contentStore = {}) {
  return (resources || []).filter((resource) => resource.collection_kind === "user_import")
    .reduce((sum, resource) => sum + String(contentStore[resource.id] || "").length, 0);
}

function localResourceList(resources, contentStore = {}) {
  return (resources || []).filter((resource) => resource.collection_kind === "user_import").map((resource) => ({
    id: resource.id,
    name: resource.original_file_name || resource.file_name || resource.original_name || resource.title,
    file_name: resource.original_file_name || resource.file_name || resource.original_name || resource.title,
    type: resource.type,
    hash: localResourceFileHash(resource),
    content_hash_sha256: localResourceFileHash(resource),
    extracted_text_sha256: localResourceExtractedTextHash(resource),
    content_length: String(contentStore[resource.id] || "").length,
    updated_at: resource.last_seen_at || resource.discovered_at || ""
  })).sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
}

function localResourceFileHash(resource) {
  return String(resource?.content_hash_sha256 || resource?.content_sha256 || resource?.sha256 || "").trim().toLowerCase();
}

function localResourceExtractedTextHash(resource) {
  return String(resource?.extracted_text_sha256 || "").trim().toLowerCase();
}

function reconcileTranscriptResourceReferences(transcripts, remaps = new Map(), removedIds = new Set(), validIds = null) {
  return (transcripts || []).map((transcript) => ({
    ...transcript,
    matched_resource_ids: uniqueStrings((transcript.matched_resource_ids || [])
      .map((resourceId) => resolveResourceIdRemap(resourceId, remaps))
      .filter((resourceId) => resourceId && !removedIds.has(resourceId) && (!validIds || validIds.has(resourceId))))
  }));
}

function reconcileIndexTranscriptGraph(resources, transcripts) {
  const nextResources = (Array.isArray(resources) ? resources : []).map((resource) => ({
    ...resource,
    transcript_ids: uniqueStrings(resource?.transcript_ids || [])
  }));
  const nextTranscripts = (Array.isArray(transcripts) ? transcripts : []).map((transcript) => ({
    ...transcript,
    matched_resource_ids: uniqueStrings(transcript?.matched_resource_ids || [])
  }));
  const resourceById = new Map(nextResources
    .filter((resource) => resource?.id)
    .map((resource) => [String(resource.id), resource]));
  const transcriptById = new Map(nextTranscripts
    .filter((transcript) => transcript?.id)
    .map((transcript) => [String(transcript.id), transcript]));

  for (const resource of nextResources) {
    resource.transcript_ids = uniqueStrings(resource.transcript_ids)
      .filter((transcriptId) => transcriptById.has(String(transcriptId)))
      .sort();
  }
  for (const transcript of nextTranscripts) {
    transcript.matched_resource_ids = uniqueStrings(transcript.matched_resource_ids)
      .filter((resourceId) => resourceById.has(String(resourceId)))
      .sort();
  }
  for (const resource of nextResources) {
    for (const transcriptId of resource.transcript_ids) {
      const transcript = transcriptById.get(String(transcriptId));
      transcript.matched_resource_ids = uniqueStrings([...transcript.matched_resource_ids, resource.id]).sort();
    }
  }
  for (const transcript of nextTranscripts) {
    for (const resourceId of transcript.matched_resource_ids) {
      const resource = resourceById.get(String(resourceId));
      resource.transcript_ids = uniqueStrings([...resource.transcript_ids, transcript.id]).sort();
    }
  }
  return { resources: nextResources, transcripts: nextTranscripts };
}

function resolveResourceIdRemap(resourceId, remaps) {
  let current = String(resourceId || "");
  const visited = new Set();
  while (current && remaps?.has(current) && !visited.has(current)) {
    visited.add(current);
    current = String(remaps.get(current) || "");
  }
  return current;
}

function localResourceNameKey(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase();
}

function cleanLocalResourceId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
}

function cleanLocalResourceType(value, name = "") {
  const explicit = String(value || "").trim().toLowerCase();
  if (["pdf", "document", "slides", "spreadsheet", "text", "markdown"].includes(explicit)) return explicit;
  const lower = String(name || "").toLowerCase();
  if (/\.pdf$/.test(lower)) return "pdf";
  if (/\.docx?$/.test(lower)) return "document";
  if (/\.pptx?$/.test(lower)) return "slides";
  if (/\.(?:xlsx?|csv)$/.test(lower)) return "spreadsheet";
  if (/\.md$/.test(lower)) return "markdown";
  if (/\.txt$/.test(lower)) return "text";
  return "";
}

async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 is unavailable in this browser context.");
  const bytes = new TextEncoder().encode(String(value || ""));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function startCrawlSite(payload) {
  if (activeCrawlPromise || crawlStartInProgress) return { ok: false, error: "index_already_running" };
  crawlStartInProgress = true;
  try {
    const session = await checkBlackboardSession(payload || {});
    if (!session.ok) return { ok: false, error: session.error || "Could not verify the Blackboard session." };
    if (!session.authenticated) {
      return { ok: false, error: "Please log into Blackboard in this browser before indexing." };
    }
  } finally {
    crawlStartInProgress = false;
  }

  activeCrawlMode = "incremental_crawl";
  activeCrawlPromise = crawlSite(payload)
    .catch((error) => {
      emitCrawlProgress({
        status: "error",
        error: String(error && error.message ? error.message : error)
      });
    })
    .finally(() => {
      activeCrawlPromise = null;
      activeCrawlMode = "";
    });
  return { ok: true, started: true };
}
async function startReindexSite(payload) {
  if (activeCrawlPromise || crawlStartInProgress) return { ok: false, error: "index_already_running" };
  crawlStartInProgress = true;
  try {
    const session = await checkBlackboardSession(payload || {});
    if (!session.ok) return { ok: false, error: session.error || "Could not verify the Blackboard session." };
    if (!session.authenticated) return { ok: false, error: "Please log into Blackboard in this browser before indexing." };
  } finally {
    crawlStartInProgress = false;
  }

  activeCrawlMode = "atomic_reindex";
  activeCrawlPromise = reindexSite(payload)
    .then((result) => {
      if (!result.ok) emitCrawlProgress({ status: "error", error: result.error || "Fresh index validation failed." });
      return result;
    })
    .catch((error) => {
      emitCrawlProgress({ status: "error", error: String(error && error.message ? error.message : error) });
      return { ok: false, error: String(error && error.message ? error.message : error) };
    })
    .finally(() => {
      activeCrawlPromise = null;
      activeCrawlMode = "";
    });
  return { ok: true, started: true, mode: "atomic_reindex" };
}

async function reindexSite(payload) {
  const seedUrl = normalizeUrlFrom(payload.seed_url || payload.seedUrl || DEFAULT_CRAWL_SEED_URL, DEFAULT_CRAWL_SEED_URL);
  if (!seedUrl || !/^https?:\/\//i.test(seedUrl)) return { ok: false, error: "missing_or_invalid_seed_url" };
  const allowedPrefix = normalizeUrlFrom(payload.allowed_prefix || payload.allowedPrefix || defaultAllowedPrefix(seedUrl), seedUrl);
  const maxPages = clampInteger(payload.max_pages || payload.maxPages, 1, 2000, 1500);
  const delayMs = clampInteger(payload.delay_ms || payload.delayMs, 0, 3000, 120);
  const pageTimeoutMs = clampInteger(payload.page_timeout_ms || payload.pageTimeoutMs, 5000, 60000, DEFAULT_CRAWL_PAGE_TIMEOUT_MS);
  const allowPartial = payload.allow_partial_reindex === true || payload.allowPartialReindex === true;
  const seedOrigin = new URL(seedUrl).origin;
  const baselineData = await chrome.storage.local.get([RESOURCE_KEY, CONTENT_KEY, META_KEY]);
  const baselineResources = Array.isArray(baselineData[RESOURCE_KEY]) ? baselineData[RESOURCE_KEY] : [];
  const baselineOfficialResources = baselineResources.filter((resource) => !resourcePersistsAcrossBlackboardReindex(resource));
  const baselineResourceIdentities = officialResourceIdentitySet(baselineOfficialResources);
  const baselinePageIdentities = officialPageIdentitySet(baselineOfficialResources);
  const baselineOfficialPages = baselinePageIdentities.size;
  const baselineBodyMetrics = officialBodyCoverageMetrics(baselineOfficialResources, baselineData[CONTENT_KEY] || {});
  const baselineRevision = Math.max(0, Number(baselineData[META_KEY]?.index_revision || 0));
  const queue = [seedUrl];
  const queued = new Set(queue);
  const visited = new Set();
  const failures = [];
  const stagedResources = new Map();
  const stagedContent = {};
  let rawCandidatesSeen = 0;
  let successfulPages = 0;
  let rootCompleted = false;
  let fatalAuthenticationFailure = null;

  emitCrawlProgress({ status: "started", mode: "atomic_reindex", pages: 0, queued: 1, resource_count: 0 });
  while (queue.length && visited.size < maxPages) {
    const currentUrl = queue.shift();
    if (!currentUrl || visited.has(currentUrl)) continue;
    visited.add(currentUrl);
    emitCrawlProgress({ status: "fetching", mode: "atomic_reindex", pages: visited.size, queued: queue.length, current_url: currentUrl, resource_count: stagedResources.size });
    try {
      const page = await fetchCrawlPage(currentUrl, pageTimeoutMs);
      validateFetchedCrawlPage(page, currentUrl);
      successfulPages += 1;
      if (currentUrl === seedUrl) rootCompleted = true;
      const pageResources = Array.isArray(page.resources) ? page.resources : [];
      rawCandidatesSeen += pageResources.length;
      for (const raw of pageResources) mergeResourceIntoStaging(stagedResources, stagedContent, raw);
      const candidateUrls = page.portal_entry_urls?.length && isDefaultPortalUrl(currentUrl) ? page.portal_entry_urls : page.child_urls;
      for (const candidate of candidateUrls || []) {
        const childUrl = normalizeUrlFrom(candidate, page.final_url || currentUrl);
        if (!canQueuePage(childUrl, { allowedPrefix, seedOrigin, visited, queued })) continue;
        queued.add(childUrl);
        queue.push(childUrl);
      }
    } catch (error) {
      if (error?.code === "authentication_lost" || error?.code === "access_denied" || error?.code === "invalid_crawl_page") {
        fatalAuthenticationFailure = { url: currentUrl, error: String(error && error.message ? error.message : error) };
      }
      failures.push({ url: currentUrl, error: String(error && error.message ? error.message : error) });
      emitCrawlProgress({ status: "page_failed", mode: "atomic_reindex", pages: visited.size, queued: queue.length, failed_pages: failures.length, error: failures.at(-1).error });
    }
    if (fatalAuthenticationFailure) break;
    if (delayMs) await sleep(delayMs);
  }

  const truncatedByPageLimit = queue.length > 0 && visited.size >= maxPages;
  if (fatalAuthenticationFailure) {
    return { ok: false, error: "Blackboard authentication was lost during the fresh crawl; the previous index was retained.", pages_crawled: visited.size, staged_resource_count: stagedResources.size, failures: failures.slice(0, 20) };
  }
  if (!rootCompleted || successfulPages < 1) {
    return { ok: false, error: "The fresh crawl did not complete its expected root page; the previous index was retained.", pages_crawled: visited.size, staged_resource_count: stagedResources.size, failures: failures.slice(0, 20) };
  }
  if (truncatedByPageLimit && !allowPartial) {
    return { ok: false, error: "Fresh index reached its page limit with URLs still queued; the previous index was retained.", pages_crawled: visited.size, queued_remaining: queue.length, staged_resource_count: stagedResources.size, failures: failures.slice(0, 20) };
  }
  if (!stagedResources.size) {
    return { ok: false, error: "Fresh index contained no searchable resources; the previous index was retained.", pages_crawled: visited.size, failures: failures.slice(0, 20) };
  }
  if (failures.length && !allowPartial) {
    return { ok: false, error: "Fresh index had page failures; the previous index was retained.", pages_crawled: visited.size, staged_resource_count: stagedResources.size, failures: failures.slice(0, 20) };
  }
  const stagedOfficialResources = Array.from(stagedResources.values());
  const stagedResourceIdentities = officialResourceIdentitySet(stagedOfficialResources);
  const stagedPageIdentities = officialPageIdentitySet(stagedOfficialResources);
  const stagedOfficialPages = stagedPageIdentities.size;
  const hasComparableBaseline = baselineOfficialResources.length > 0;
  const resourceRetention = hasComparableBaseline ? stagedResources.size / baselineOfficialResources.length : 1;
  const pageRetention = baselineOfficialPages > 0 ? stagedOfficialPages / baselineOfficialPages : 1;
  const resourceIdentityOverlap = identitySetOverlapRatio(baselineResourceIdentities, stagedResourceIdentities);
  const pageIdentityOverlap = identitySetOverlapRatio(baselinePageIdentities, stagedPageIdentities);
  const prospectiveBodyMetrics = prospectiveOfficialBodyCoverageMetrics(stagedOfficialResources, stagedContent, baselineOfficialResources, baselineData[CONTENT_KEY] || {});
  const semanticRetention = officialBodySemanticRetention(
    baselineOfficialResources,
    baselineData[CONTENT_KEY] || {},
    stagedOfficialResources,
    prospectiveBodyMetrics.content_store
  );
  const hasComparableBodyBaseline = baselineBodyMetrics.body_count > 0;
  if (
    hasComparableBaseline &&
    (
      resourceRetention < REINDEX_MIN_RESOURCE_RETENTION_RATIO ||
      pageRetention < REINDEX_MIN_PAGE_RETENTION_RATIO ||
      resourceIdentityOverlap < REINDEX_MIN_RESOURCE_IDENTITY_OVERLAP_RATIO ||
      pageIdentityOverlap < REINDEX_MIN_PAGE_IDENTITY_OVERLAP_RATIO ||
      (hasComparableBodyBaseline && (
        prospectiveBodyMetrics.body_count / baselineBodyMetrics.body_count < REINDEX_MIN_BODY_COUNT_RETENTION_RATIO ||
        identitySetOverlapRatio(baselineBodyMetrics.body_identities, prospectiveBodyMetrics.body_identities) < REINDEX_MIN_BODY_IDENTITY_OVERLAP_RATIO ||
        prospectiveBodyMetrics.normalized_char_count / Math.max(1, baselineBodyMetrics.normalized_char_count) < REINDEX_MIN_BODY_CHAR_RETENTION_RATIO ||
        semanticRetention.retention_ratio < REINDEX_MIN_BODY_SEMANTIC_RETENTION_RATIO ||
        semanticRetention.identity_pass_ratio < REINDEX_MIN_BODY_SEMANTIC_IDENTITY_PASS_RATIO
      ))
    )
  ) {
    return {
      ok: false,
      error: "Fresh index coverage collapsed relative to the active official corpus; the previous index was retained.",
      pages_crawled: visited.size,
      staged_resource_count: stagedResources.size,
      baseline_resource_count: baselineOfficialResources.length,
      resource_retention_ratio: resourceRetention,
      shared_resource_identity_count: Array.from(baselineResourceIdentities).filter((identity) => stagedResourceIdentities.has(identity)).length,
      resource_identity_overlap_ratio: resourceIdentityOverlap,
      baseline_page_count: baselineOfficialPages,
      page_retention_ratio: pageRetention,
      shared_page_identity_count: Array.from(baselinePageIdentities).filter((identity) => stagedPageIdentities.has(identity)).length,
      page_identity_overlap_ratio: pageIdentityOverlap,
      baseline_body_count: baselineBodyMetrics.body_count,
      prospective_body_count: prospectiveBodyMetrics.body_count,
      body_count_retention_ratio: hasComparableBodyBaseline ? prospectiveBodyMetrics.body_count / baselineBodyMetrics.body_count : 1,
      body_identity_overlap_ratio: hasComparableBodyBaseline ? identitySetOverlapRatio(baselineBodyMetrics.body_identities, prospectiveBodyMetrics.body_identities) : 1,
      baseline_body_char_count: baselineBodyMetrics.normalized_char_count,
      prospective_body_char_count: prospectiveBodyMetrics.normalized_char_count,
      body_char_retention_ratio: baselineBodyMetrics.normalized_char_count ? prospectiveBodyMetrics.normalized_char_count / baselineBodyMetrics.normalized_char_count : 1,
      semantic_retention_ratio: semanticRetention.retention_ratio,
      semantic_identity_pass_ratio: semanticRetention.identity_pass_ratio,
      semantic_median_identity_retention: semanticRetention.median_identity_retention,
      semantic_eligible_identity_count: semanticRetention.eligible_identity_count,
      failures: failures.slice(0, 20)
    };
  }

  let promotion;
  try {
    promotion = await runIndexMutation(
      "promote_reindex_generation",
      (token) => promoteReindexGeneration(stagedResources, stagedContent, baselineRevision, token)
    );
  } catch (error) {
    if (error?.code === "index_changed_during_reindex" || error?.code === "reindex_resource_id_collision") {
      return { ok: false, error: "The active index changed during the fresh crawl; the previous generation was retained.", pages_crawled: visited.size, staged_resource_count: stagedResources.size };
    }
    throw error;
  }
  const response = {
    ok: true,
    mode: "atomic_reindex",
    pages_crawled: visited.size,
    raw_candidates_seen: rawCandidatesSeen,
    unique_candidates_seen: stagedResources.size,
    resource_count: promotion.resource_count,
    preserved_collection_count: promotion.preserved_collection_count,
    queued_remaining: queue.length,
    truncated: truncatedByPageLimit,
    failures: failures.slice(0, 20)
  };
  emitCrawlProgress({ status: "complete", ...response, pages: visited.size, queued: queue.length });
  return response;
}

function officialResourceIdentitySet(resources) {
  const identities = new Set();
  for (const resource of resources || []) {
    if (resourcePersistsAcrossBlackboardReindex(resource)) continue;
    const canonicalIdentity = stableResourceIdentityKey(resource);
    const resourceId = cleanText(resource?.id || "", 120);
    if (canonicalIdentity) identities.add(canonicalIdentity);
    else if (resourceId) identities.add(`id:${resourceId}`);
  }
  return identities;
}

function officialPageIdentitySet(resources) {
  const identities = new Set();
  for (const resource of resources || []) {
    if (resourcePersistsAcrossBlackboardReindex(resource)) continue;
    const identity = normalizeUrl(resource?.page_url || "") || (String(resource?.type || "").toLowerCase() === "page" ? normalizeUrl(resource?.url || "") : "");
    if (identity) identities.add(identity);
  }
  return identities;
}

function identitySetOverlapRatio(baseline, candidate) {
  if (!baseline?.size) return 1;
  let shared = 0;
  for (const identity of baseline) {
    if (candidate?.has(identity)) shared += 1;
  }
  return shared / baseline.size;
}

function normalizedBodyCoverageLength(body) {
  return String(body || "").replace(/\s+/g, " ").trim().length;
}

function officialBodyCoverageMetrics(resources, contentStore) {
  const bodyIdentities = new Set();
  let bodyCount = 0;
  let normalizedCharCount = 0;
  for (const resource of resources || []) {
    if (resourcePersistsAcrossBlackboardReindex(resource)) continue;
    const body = contentStore?.[resource.id];
    if (!officialBodyCountsAsSearchable(resource, body)) continue;
    bodyCount += 1;
    normalizedCharCount += normalizedBodyCoverageLength(body);
    const identity = officialResourceCoverageIdentity(resource);
    if (identity) bodyIdentities.add(identity);
  }
  return { body_count: bodyCount, normalized_char_count: normalizedCharCount, body_identities: bodyIdentities };
}

function prospectiveOfficialBodyCoverageMetrics(stagedResources, stagedContent, baselineResources, baselineContent) {
  const baselineById = new Map((baselineResources || []).map((resource) => [resource.id, resource]));
  const baselineByIdentity = new Map((baselineResources || []).map((resource) => [stableResourceIdentityKey(resource), resource]).filter(([identity]) => identity));
  const prospectiveContent = {};
  for (const staged of stagedResources || []) {
    if (stagedContent?.[staged.id]) {
      prospectiveContent[staged.id] = stagedContent[staged.id];
      continue;
    }
    if (!isFileLikeResource(staged)) continue;
    const identity = stableResourceIdentityKey(staged);
    const previous = baselineById.get(staged.id) || (identity ? baselineByIdentity.get(identity) : null);
    const previousBody = baselineContent?.[previous?.id || staged.id];
    if (!attachmentBodyTextAvailable(previousBody)) continue;
    const previousFingerprint = stableResourceContentFingerprint(previous);
    const stagedFingerprint = stableResourceContentFingerprint(staged);
    if (previousFingerprint && stagedFingerprint && previousFingerprint !== stagedFingerprint) continue;
    prospectiveContent[staged.id] = previousBody;
  }
  return { ...officialBodyCoverageMetrics(stagedResources, prospectiveContent), content_store: prospectiveContent };
}

function officialBodySemanticRetention(baselineResources, baselineContent, candidateResources, candidateContent) {
  const generic = new Set([
    "about", "after", "again", "also", "announcements", "blackboard", "click", "content", "course",
    "courses", "dashboard", "details", "documents", "files", "footer", "help", "home", "information",
    "items", "links", "login", "main", "menu", "more", "navigation", "official", "open", "page", "policy",
    "resources", "section", "student", "students", "tools", "university", "view", "with", "your"
  ]);
  const tokensFor = (body) => {
    const values = normalizeText(body).split(/\s+/).filter((token) => token.length >= 4 && !generic.has(token) && !/^\d+$/.test(token));
    return new Set(values);
  };
  const candidateByIdentity = new Map((candidateResources || [])
    .map((resource) => [officialResourceCoverageIdentity(resource), resource])
    .filter(([identity]) => identity));
  let eligibleIdentities = 0;
  let passingIdentities = 0;
  let baselineTokenWeight = 0;
  let retainedTokenWeight = 0;
  const identityScores = [];
  for (const baseline of baselineResources || []) {
    const baselineBody = baselineContent?.[baseline.id];
    if (!officialBodyCountsAsSearchable(baseline, baselineBody)) continue;
    const identity = officialResourceCoverageIdentity(baseline);
    const baselineTokens = tokensFor(baselineBody);
    if (!identity || baselineTokens.size < 4) continue;
    const candidate = candidateByIdentity.get(identity);
    const candidateBody = candidate ? candidateContent?.[candidate.id] : "";
    const candidateTokens = tokensFor(candidateBody);
    let shared = 0;
    for (const token of baselineTokens) if (candidateTokens.has(token)) shared += 1;
    const score = shared / baselineTokens.size;
    const weight = Math.min(80, baselineTokens.size);
    eligibleIdentities += 1;
    if (score >= 0.25) passingIdentities += 1;
    baselineTokenWeight += weight;
    retainedTokenWeight += score * weight;
    identityScores.push(score);
  }
  identityScores.sort((left, right) => left - right);
  const midpoint = Math.floor(identityScores.length / 2);
  const median = !identityScores.length ? 1 : identityScores.length % 2
    ? identityScores[midpoint]
    : (identityScores[midpoint - 1] + identityScores[midpoint]) / 2;
  return {
    eligible_identity_count: eligibleIdentities,
    retention_ratio: baselineTokenWeight ? retainedTokenWeight / baselineTokenWeight : 1,
    identity_pass_ratio: eligibleIdentities ? passingIdentities / eligibleIdentities : 1,
    median_identity_retention: median
  };
}

function officialBodyCountsAsSearchable(resource, body) {
  if (normalizedBodyCoverageLength(body) <= 40) return false;
  return !isFileLikeResource(resource) || isReadableStoredFileBodyText(resource, body) || attachmentBodyTextAvailable(body);
}

function officialResourceCoverageIdentity(resource) {
  const canonicalIdentity = stableResourceIdentityKey(resource);
  if (canonicalIdentity) return canonicalIdentity;
  const resourceId = cleanText(resource?.id || "", 120);
  return resourceId ? `id:${resourceId}` : "";
}

function validateFetchedCrawlPage(page, requestedUrl) {
  if (!page || typeof page !== "object" || !page.final_url) {
    const error = new Error(`Blackboard returned an invalid crawl page for ${requestedUrl}.`);
    error.code = "invalid_crawl_page";
    throw error;
  }
  if (page.session_authenticated === false) {
    const error = new Error(`Blackboard authentication was not valid for ${requestedUrl}.`);
    error.code = "authentication_lost";
    throw error;
  }
  if (!Array.isArray(page.resources) || !Array.isArray(page.child_urls)) {
    const error = new Error(`Blackboard returned an incomplete crawl page for ${requestedUrl}.`);
    error.code = "invalid_crawl_page";
    throw error;
  }
}

function mergeResourceIntoStaging(stagedResources, stagedContent, raw) {
  const normalized = normalizeResource(raw);
  if (!normalized.url && !normalized.title) return;
  const resource = resourceMetadataFrom(normalized);
  const content = searchableContentFrom(normalized);
  const existing = stagedResources.get(resource.id);
  const now = new Date().toISOString();
  stagedResources.set(resource.id, existing
    ? {
        ...existing,
        ...withoutEmpty(resource),
        transcript_ids: uniqueStrings([...(existing.transcript_ids || []), ...(resource.transcript_ids || [])]),
        first_seen_at: existing.first_seen_at || resource.discovered_at,
        last_seen_at: now
      }
    : {
        ...resource,
        transcript_ids: uniqueStrings(resource.transcript_ids || []),
        first_seen_at: resource.discovered_at || now,
        last_seen_at: now
      });
  if (content) stagedContent[resource.id] = content;
}

async function promoteReindexGeneration(stagedResources, stagedContent, expectedRevision, mutationToken = null) {
  const data = await chrome.storage.local.get([RESOURCE_KEY, TRANSCRIPT_KEY, CONTENT_KEY, META_KEY]);
  const activeRevision = Math.max(0, Number(data[META_KEY]?.index_revision || 0));
  if (activeRevision !== expectedRevision) {
    const error = new Error("The active index changed during the fresh crawl.");
    error.code = "index_changed_during_reindex";
    throw error;
  }
  assertIndexMutationActive(mutationToken);
  mutationToken.expectedRevision = expectedRevision;
  const existingResources = Array.isArray(data[RESOURCE_KEY]) ? data[RESOURCE_KEY] : [];
  const existingById = new Map(existingResources.map((resource) => [resource.id, resource]));
  const existingByIdentity = new Map(existingResources.map((resource) => [stableResourceIdentityKey(resource), resource]).filter(([identity]) => identity));
  const existingContent = data[CONTENT_KEY] || {};
  const preserved = existingResources.filter(resourcePersistsAcrossBlackboardReindex);
  const nextById = new Map(preserved.map((resource) => [resource.id, resource]));
  const nextContent = {};
  const resourceIdRemaps = new Map();
  const generation = `generation_${Date.now().toString(36)}_${hashString(Array.from(stagedResources.keys()).sort().join("|"))}`;
  for (const resource of preserved) {
    if (existingContent[resource.id]) nextContent[resource.id] = existingContent[resource.id];
  }

  for (const staged of stagedResources.values()) {
    const preservedOwner = nextById.get(staged.id);
    if (preservedOwner && resourcePersistsAcrossBlackboardReindex(preservedOwner)) {
      const error = new Error(`Fresh Blackboard resource ${staged.id} collided with a preserved collection resource.`);
      error.code = "reindex_resource_id_collision";
      throw error;
    }
    const identity = stableResourceIdentityKey(staged);
    const previous = existingById.get(staged.id) || (identity ? existingByIdentity.get(identity) : null);
    const next = previous && !resourcePersistsAcrossBlackboardReindex(previous)
      ? {
          ...previous,
          ...withoutEmpty(staged),
          id: staged.id,
          first_seen_at: previous.first_seen_at || staged.first_seen_at,
          last_seen_at: staged.last_seen_at || new Date().toISOString()
        }
      : { ...staged };
    if (previous?.id && previous.id !== next.id) resourceIdRemaps.set(previous.id, next.id);
    nextById.set(next.id, next);
    if (stagedContent[next.id]) nextContent[next.id] = stagedContent[next.id];
    else if (isFileLikeResource(next)) {
      reconcileFullReindexAttachmentBody(previous, staged, next, existingContent[previous?.id || next.id], nextContent, generation);
    }
  }
  const nextResources = Array.from(nextById.values());
  const nextResourceIds = new Set(nextResources.map((resource) => resource.id));
  const removedIds = new Set(existingResources.map((resource) => resource.id).filter((resourceId) => !nextResourceIds.has(resourceId) && !resourceIdRemaps.has(resourceId)));
  const classifiedTranscripts = classifyLegacyTranscriptSources(data[TRANSCRIPT_KEY] || [], existingResources).transcripts;
  const transcripts = reconcileTranscriptResourceReferences(classifiedTranscripts, resourceIdRemaps, removedIds, nextResourceIds)
    .filter((transcript) => (transcript.matched_resource_ids || []).length || transcriptPersistsAcrossBlackboardReindex(transcript));
  matchTranscriptsToResources(nextResources, transcripts);
  await saveIndex(nextResources, transcripts, nextContent, {
    index_generation: generation,
    index_build_status: "complete"
  }, {}, mutationToken);
  return { resource_count: nextResources.length, preserved_collection_count: preserved.length };
}

function stableResourceContentFingerprint(resource) {
  if (!resource) return "";
  const explicit = cleanText(resource.content_fingerprint || resource.contentFingerprint || "", 160);
  if (explicit) return `content:${explicit}`;
  const etag = cleanText(resource.etag || "", 160);
  if (etag) return `etag:${etag}`;
  const lastModified = cleanText(resource.last_modified || resource.lastModified || "", 120);
  const contentLength = Number(resource.content_length || resource.contentLength || 0);
  return lastModified && Number.isFinite(contentLength) && contentLength > 0 ? `modified:${lastModified}|length:${contentLength}` : "";
}

function resourcePersistsAcrossBlackboardReindex(resource) {
  return Boolean(
    resource?.source_pack_id ||
    resource?.collection_kind === "user_import" ||
    resource?.content_origin === "user_import"
  );
}

function migrateLegacyAttachmentHydration(resources, contentStore, meta = {}) {
  let changed = false;
  const nextContentStore = { ...(contentStore || {}) };
  const generation = `legacy_${Math.max(0, Number(meta.index_revision || 0))}`;
  const nextResources = (resources || []).map((resource) => {
    if (!isManagedBlackboardAttachmentHydrationTarget(resource)) return resource;
    const body = nextContentStore[resource.id];
    const readableBody = Boolean(body) && isReadableStoredFileBodyText(resource, body);
    const verifiedBody = readableBody && resource.body_verified === true && resource.indexed_body_source === "extracted";
    const pendingState = !readableBody && resource.body_verified === false && resource.indexed_body_source === "pending_extraction" &&
      resource.needs_body_hydration === true && resource.body_revalidation_required === true && Boolean(resource.hydration_token);
    const lastKnownState = readableBody && resource.body_verified === false && resource.indexed_body_source === "last_known_extracted" &&
      resource.needs_body_hydration === true && resource.body_revalidation_required === true && Boolean(resource.hydration_token);
    if (verifiedBody || pendingState || lastKnownState) return resource;
    const next = { ...resource };
    if (readableBody) {
      markAttachmentLastKnown(next, resource, resource, generation);
    } else {
      delete nextContentStore[resource.id];
      markAttachmentPending(next, generation);
    }
    changed = true;
    return next;
  });
  return { resources: nextResources, contentStore: nextContentStore, changed };
}

function classifyLegacyTranscriptSources(transcripts, resources) {
  let changed = false;
  const resourceById = new Map((resources || []).map((resource) => [resource.id, resource]));
  const next = (transcripts || []).map((transcript) => {
    if (transcriptHasDeclaredCorpusSource(transcript)) return transcript;
    const matched = (transcript.matched_resource_ids || []).map((resourceId) => resourceById.get(resourceId)).filter(Boolean);
    const localOwner = matched.find((resource) => resource.collection_kind === "user_import" || resource.content_origin === "user_import");
    const packOwner = matched.find((resource) => resource.source_pack_id);
    changed = true;
    if (localOwner || (!packOwner && !matched.length)) {
      return { ...transcript, collection_kind: "user_import", content_origin: "user_import", source_class: "user_import" };
    }
    if (packOwner) {
      return {
        ...transcript,
        source_pack_id: packOwner.source_pack_id,
        collection_kind: "resource_pack",
        content_origin: "resource_pack",
        source_class: "curated_pack"
      };
    }
    return {
      ...transcript,
      collection_kind: "blackboard_legacy",
      content_origin: "blackboard_transcript",
      source_class: "official_blackboard"
    };
  });
  return { transcripts: next, changed };
}

function transcriptHasDeclaredCorpusSource(transcript) {
  return Boolean(
    transcript?.source_pack_id ||
    transcript?.collection_kind ||
    transcript?.content_origin ||
    transcript?.source_class ||
    transcript?.search_source_class
  );
}

function transcriptPersistsAcrossBlackboardReindex(transcript) {
  const sourceClass = String(transcript?.source_class || transcript?.search_source_class || "").toLowerCase();
  return Boolean(
    transcript?.source_pack_id ||
    transcript?.collection_kind === "user_import" ||
    transcript?.content_origin === "user_import" ||
    sourceClass === "user_import" ||
    sourceClass === "curated_pack"
  );
}

function attachmentBodyTextAvailable(text) {
  return normalizeText(String(text || "")).length > 40;
}

function clearAttachmentHydrationState(resource) {
  resource.body_verified = true;
  resource.indexed_body_source = "extracted";
  resource.content_origin = resource.content_origin || "blackboard_attachment";
  delete resource.needs_body_hydration;
  delete resource.body_revalidation_required;
  delete resource.hydration_token;
}

function markAttachmentPending(resource, generation) {
  resource.body_verified = false;
  resource.indexed_body_source = "pending_extraction";
  resource.content_origin = "blackboard_attachment";
  resource.needs_body_hydration = true;
  resource.body_revalidation_required = true;
  resource.hydration_token = `hydrate_${hashString([resource.id, generation, stableResourceContentFingerprint(resource)].join("|"))}`;
}

function markAttachmentLastKnown(resource, previous, staged, generation) {
  const previousFingerprint = stableResourceContentFingerprint(previous);
  const currentFingerprint = stableResourceContentFingerprint(staged);
  resource.body_verified = false;
  resource.indexed_body_source = "last_known_extracted";
  resource.content_origin = "blackboard_attachment";
  resource.needs_body_hydration = true;
  resource.body_revalidation_required = true;
  resource.hydration_token = `hydrate_${hashString([resource.id, generation, previousFingerprint, currentFingerprint].join("|"))}`;
  if (previousFingerprint) resource.last_verified_content_fingerprint = previousFingerprint;
  if (!currentFingerprint) {
    delete resource.content_fingerprint;
    delete resource.etag;
    delete resource.last_modified;
    delete resource.content_length;
  }
}

function reconcileFullReindexAttachmentBody(previous, staged, next, previousBody, nextContent, generation) {
  const bodyAvailable = attachmentBodyTextAvailable(previousBody);
  const previousFingerprint = stableResourceContentFingerprint(previous);
  const stagedFingerprint = stableResourceContentFingerprint(staged);
  if (bodyAvailable && previousFingerprint && stagedFingerprint && previousFingerprint === stagedFingerprint) {
    nextContent[next.id] = previousBody;
    clearAttachmentHydrationState(next);
    return;
  }
  if (bodyAvailable && previousFingerprint && stagedFingerprint && previousFingerprint !== stagedFingerprint) {
    markAttachmentPending(next, generation);
    return;
  }
  if (bodyAvailable) {
    nextContent[next.id] = previousBody;
    markAttachmentLastKnown(next, previous, staged, generation);
    return;
  }
  markAttachmentPending(next, generation);
}

function reconcileIncrementalAttachmentBody(existing, incoming, next, contentStore) {
  if (!isFileLikeResource(next)) return next;
  const incrementalGeneration = `incremental_${Date.now().toString(36)}`;
  if (!existing) {
    markAttachmentPending(next, incrementalGeneration);
    return next;
  }
  const existingFingerprint = stableResourceContentFingerprint(existing);
  const incomingFingerprint = stableResourceContentFingerprint(incoming);
  const body = contentStore[next.id] || contentStore[existing.id];
  if (!existingFingerprint || !incomingFingerprint) {
    if (attachmentBodyTextAvailable(body)) {
      markAttachmentLastKnown(next, existing, incoming, incrementalGeneration);
    } else if (
      existingFingerprint !== incomingFingerprint ||
      !existing.hydration_token ||
      existing?.body_verified === true ||
      existing?.indexed_body_source === "extracted"
    ) {
      markAttachmentPending(next, incrementalGeneration);
    }
    return next;
  }
  if (existingFingerprint !== incomingFingerprint) {
    delete contentStore[next.id];
    if (existing.id !== next.id) delete contentStore[existing.id];
    markAttachmentPending(next, incrementalGeneration);
    return next;
  }
  if (attachmentBodyTextAvailable(body)) {
    clearAttachmentHydrationState(next);
  } else if (!existing.hydration_token || existing.body_verified !== false || existing.indexed_body_source !== "pending_extraction") {
    markAttachmentPending(next, incrementalGeneration);
  }
  return next;
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
  const pageTimeoutMs = clampInteger(
    payload.page_timeout_ms || payload.pageTimeoutMs,
    5000,
    60000,
    DEFAULT_CRAWL_PAGE_TIMEOUT_MS
  );
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
  let checkpointFailed = false;

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
      failed_pages: failures.length,
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

    const batch = resources.slice();
    const progressStatus = force ? "finalizing" : "checkpointing";
    const checkpointStartedAt = Date.now();
    const reportCheckpointProgress = () => {
      emitCrawlProgress({
        status: progressStatus,
        ...crawlProgress({
          pages: visited.size,
          queued: queue.length,
          unsaved_resources: batch.length,
          waiting_seconds: Math.max(0, Math.floor((Date.now() - checkpointStartedAt) / 1000))
        })
      });
    };
    reportCheckpointProgress();
    const checkpointHeartbeat = setInterval(reportCheckpointProgress, CRAWL_HEARTBEAT_MS);
    try {
      const mergeResult = typeof runIndexMutation === "function"
        ? await runIndexMutation("crawl_checkpoint", (token) => mergeScrape({ resources: batch }, token), { timeoutMs: CRAWL_CHECKPOINT_TIMEOUT_MS, captureRevision: true })
        : await mergeScrape({ resources: batch });
      resources.splice(0, batch.length);
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
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      emitCrawlProgress({
        status: "checkpoint_error",
        error: message,
        ...crawlProgress({
          pages: visited.size,
          queued: queue.length,
          unsaved_resources: resources.length,
          resource_count: lastSavedResourceCount
        })
      });
      throw error;
    } finally {
      clearInterval(checkpointHeartbeat);
    }
  }

  while (queue.length && visited.size < maxPages) {
    const currentUrl = queue.shift();
    if (!currentUrl || visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    emitCrawlProgress({
      status: "fetching",
      ...crawlProgress({ current_url: currentUrl })
    });

    const pageStartedAt = Date.now();
    const heartbeatTimer = setInterval(() => {
      emitCrawlProgress({
        status: "fetching",
        ...crawlProgress({
          current_url: currentUrl,
          waiting_seconds: Math.max(1, Math.floor((Date.now() - pageStartedAt) / 1000))
        })
      });
    }, Math.min(CRAWL_HEARTBEAT_MS, Math.max(1000, Math.floor(pageTimeoutMs / 2))));

    try {
      const page = await fetchCrawlPage(currentUrl, pageTimeoutMs);
      const pageResources = Array.isArray(page.resources) ? page.resources : [];
      resources.push(...pageResources);
      recordCandidateResources(pageResources);

      const candidateUrls = page.portal_entry_urls?.length && isDefaultPortalUrl(currentUrl) ? page.portal_entry_urls : page.child_urls;
      for (const candidate of candidateUrls) {
        const childUrl = normalizeUrlFrom(candidate, page.final_url || currentUrl);
        if (!canQueuePage(childUrl, { allowedPrefix, seedOrigin, visited, queued })) continue;
        queued.add(childUrl);
        queue.push(childUrl);
      }
    } catch (error) {
      const failure = {
        url: currentUrl,
        error: String(error && error.message ? error.message : error)
      };
      failures.push(failure);
      emitCrawlProgress({
        status: "page_failed",
        error: failure.error,
        ...crawlProgress({ current_url: currentUrl })
      });
    } finally {
      clearInterval(heartbeatTimer);
    }

    try {
      await checkpointResources(false);
    } catch (error) {
      checkpointFailed = true;
      failures.push({
        url: "index checkpoint",
        error: String(error && error.message ? error.message : error)
      });
      break;
    }

    if (delayMs) await sleep(delayMs);
  }

  let mergeResult = { resource_count: lastSavedResourceCount };
  if (!checkpointFailed) {
    try {
      mergeResult = await checkpointResources(true);
    } catch (error) {
      checkpointFailed = true;
      failures.push({
        url: "final index save",
        error: String(error && error.message ? error.message : error)
      });
    }
  }
  if (checkpointFailed) {
    return {
      ok: false,
      error: "The local index checkpoint did not finish. Previously saved resources were retained.",
      pages_crawled: visited.size,
      resource_count: lastSavedResourceCount,
      queued_remaining: queue.length,
      failures: failures.slice(0, 20)
    };
  }
  const response = {
    ok: true,
    pages_crawled: visited.size,
    candidates_seen: uniqueCandidateIds.size,
    unique_candidates_seen: uniqueCandidateIds.size,
    raw_candidates_seen: rawCandidatesSeen,
    resources_seen: rawCandidatesSeen,
    resource_count: mergeResult.resource_count || lastSavedResourceCount,
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

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_CRAWL_PAGE_TIMEOUT_MS) {
  const durationMs = Math.max(1, Number(timeoutMs) || DEFAULT_CRAWL_PAGE_TIMEOUT_MS);
  const controller = new AbortController();
  let timeoutId = 0;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`Blackboard did not respond within ${Math.ceil(durationMs / 1000)} seconds.`);
      error.name = "TimeoutError";
      error.code = "request_timeout";
      reject(error);
      controller.abort();
    }, durationMs);
  });

  try {
    const request = Promise.resolve().then(() => fetch(url, { ...options, signal: controller.signal }));
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchCrawlPage(url, timeoutMs = DEFAULT_CRAWL_PAGE_TIMEOUT_MS) {
  const response = await fetchWithTimeout(url, {
    credentials: "include",
    redirect: "follow",
    cache: "no-store"
  }, timeoutMs);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const finalUrl = normalizeUrlFrom(response.url || url, url);
  const contentType = response.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    return {
      final_url: finalUrl,
      session_authenticated: true,
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
  const accessFailureReason = blackboardCrawlAccessFailureReason(html);
  if (accessFailureReason) {
    const error = new Error(`Blackboard returned an access or session error page while fetching ${url}.`);
    error.code = "access_denied";
    error.session_reason = accessFailureReason;
    throw error;
  }
  const session = BlackboardSession.assessBlackboardSession({
    requested_url: url,
    final_url: finalUrl,
    status: response.status,
    content_type: contentType,
    body: html
  });
  if (!session.authenticated) {
    const error = new Error(`Blackboard authentication was lost while fetching ${url}.`);
    error.code = "authentication_lost";
    error.session_reason = session.reason || "unauthenticated";
    throw error;
  }
  return {
    ...extractResourcesFromHtml(html, finalUrl),
    session_authenticated: true,
    session_reason: session.reason || "authenticated"
  };
}

function blackboardCrawlAccessFailureReason(html) {
  const source = String(html || "");
  if (!source) return "";
  const title = source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase() || "";
  const text = source
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/&(?:apos|#39);/gi, "'")
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (/\b(session (?:has )?expired|your session is no longer valid|login session (?:has )?expired)\b/i.test(text)) return "session_expired";
  if (/\b(access denied|unauthorized|not authorized|permission denied|forbidden)\b/i.test(title)) return "access_denied";
  if (/\b(you (?:are|do) not (?:authorized|have permission)|not authorized to (?:access|view)|access (?:has been )?denied|authorization (?:has )?failed)\b/i.test(text)) return "access_denied";
  if (
    /^(?:error|blackboard learn error|application error|request error)$/i.test(title) &&
    /\b(?:an error (?:has )?occurred|unable to process|request could not be completed|contact (?:the )?(?:system )?administrator)\b/i.test(text)
  ) {
    return "blackboard_error_page";
  }
  return "";
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

  const pageText = extractMainTextFromDocument(document, MAX_SCRAPED_PAGE_CHARS);
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

async function saveIndex(resources, transcripts, contentStore = null, metaPatch = {}, storagePatch = {}, mutationToken = null) {
  const reconciledGraph = reconcileIndexTranscriptGraph(resources, transcripts);
  resources = reconciledGraph.resources;
  transcripts = reconciledGraph.transcripts;
  const stored = await chrome.storage.local.get([CONTENT_KEY, META_KEY]);
  if (mutationToken) assertIndexMutationActive(mutationToken);
  const storedRevision = Math.max(0, Number(stored[META_KEY]?.index_revision || 0));
  if (mutationToken?.expectedRevision !== null && mutationToken?.expectedRevision !== undefined && storedRevision !== mutationToken.expectedRevision) {
    const error = new Error("The active index revision changed before the mutation could commit.");
    error.code = mutationToken.label === "promote_reindex_generation" ? "index_changed_during_reindex" : "index_revision_conflict";
    throw error;
  }
  let nextContentStore = contentStore || stored[CONTENT_KEY] || {};
  nextContentStore = pruneContentStore(nextContentStore, resources);

  const existingMeta = stored[META_KEY] && typeof stored[META_KEY] === "object" ? stored[META_KEY] : {};
  const resourcesById = new Map(resources.map((resource) => [String(resource?.id || ""), resource]));
  const hadExistingMeta = Object.keys(existingMeta).length > 0;
  const legacyRiskIds = new Set(
    Array.isArray(existingMeta.legacy_truncated_resource_ids)
      ? existingMeta.legacy_truncated_resource_ids.map(String)
      : []
  );
  if (hadExistingMeta && Number(existingMeta.content_schema_version || 0) < CONTENT_SCHEMA_VERSION) {
    for (const [resourceId, text] of Object.entries(nextContentStore)) {
      const length = String(text || "").length;
      if (
        !resourcesById.get(String(resourceId))?.source_pack_id &&
        length >= LEGACY_INDEXED_BODY_CHARS - 50 &&
        length <= LEGACY_INDEXED_BODY_CHARS
      ) {
        legacyRiskIds.add(resourceId);
      }
    }
  }
  for (const resourceId of Array.from(legacyRiskIds)) {
    if (
      !Object.prototype.hasOwnProperty.call(nextContentStore, resourceId) ||
      resourcesById.get(String(resourceId))?.source_pack_id
    ) {
      legacyRiskIds.delete(resourceId);
    }
  }
  const legacyTruncatedResourceIds = Array.from(legacyRiskIds).sort();
  const boundedTruncationIds = boundedContentTruncationIds(nextContentStore);
  const sourceResourceCounts = { official_blackboard: 0, curated_pack: 0, user_import: 0 };
  const sourceContentCounts = { official_blackboard: 0, curated_pack: 0, user_import: 0 };
  for (const resource of resources) sourceResourceCounts[resourceCorpusSource(resource)] += 1;
  for (const resourceId of Object.keys(nextContentStore)) {
    const resource = resourcesById.get(String(resourceId));
    if (resource) sourceContentCounts[resourceCorpusSource(resource)] += 1;
  }
  const previousContentStore = stored[CONTENT_KEY] || {};
  const previousContentHashes = existingMeta.content_entry_sha256 && typeof existingMeta.content_entry_sha256 === "object"
    ? existingMeta.content_entry_sha256
    : {};
  const contentEntrySha256 = {};
  const bodyRecords = await Promise.all(Object.entries(nextContentStore)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(async ([resourceId, text]) => {
      const normalizedBody = String(text || "");
      const cachedHash = String(previousContentHashes[resourceId] || "");
      const bodyHash = Object.prototype.hasOwnProperty.call(previousContentStore, resourceId) &&
        String(previousContentStore[resourceId] || "") === normalizedBody && /^[a-f0-9]{64}$/.test(cachedHash)
        ? cachedHash
        : await sha256Hex(normalizedBody);
      return [resourceId, normalizedBody.length, bodyHash];
    }));
  for (const [resourceId, _length, bodyHash] of bodyRecords) contentEntrySha256[resourceId] = bodyHash;
  const contentBodyDigest = await sha256Hex(JSON.stringify(bodyRecords));
  const resourceRecords = resources
    .map((resource) => [
      resource.id,
      resource.type,
      resource.title,
      resource.url,
      resource.document_url,
      resource.page_url,
      resource.page_title,
      resource.section,
      resource.context,
      resource.canonical_key,
      resourceCorpusSource(resource),
      resource.source_pack_id,
      resource.source_pack_title,
      resource.source_pack_version,
      resource.source_pack_original_id,
      resource.source_pack_document_id,
      resource.source_pack_document_title,
      resource.source_pack_page_range,
      resource.source_pack_provenance,
      resource.collection_kind,
      resource.content_origin,
      resource.original_name,
      resource.original_file_name,
      resource.file_name,
      resource.content_type,
      resource.byte_size,
      resource.content_hash_sha256,
      resource.content_sha256,
      resource.sha256,
      resource.extracted_text_sha256,
      stableResourceContentFingerprint(resource),
      resource.last_verified_content_fingerprint,
      resource.source_class,
      resource.search_source_class,
      resource.corpus_source_class,
      resource.source_trust,
      resource.sourceTrust,
      resource.trust_tier,
      resource.trustTier,
      resource.authority_tier,
      resource.authorityTier,
      resource.trust,
      resource.authority,
      resource.authority_verified,
      resource.source_authority_verified,
      resource.source_provenance,
      resource.sourceProvenance,
      resource.provenance,
      resource.canonical_parent_id,
      resource.parent_document_id,
      resource.document_id,
      JSON.stringify(resource.search_identity || {}),
      uniqueStrings(resource.transcript_ids || []).sort(),
      resource.indexed_body_source,
      resource.body_verified,
      resource.needs_body_hydration,
      resource.body_revalidation_required
    ])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const transcriptRecords = transcripts
    .slice()
    .sort((left, right) => String(left?.id || "").localeCompare(String(right?.id || "")));
  for (let index = 0; index < transcriptRecords.length; index += 1) {
    const transcript = transcriptRecords[index];
    transcriptRecords[index] = [
      transcript.id,
      transcript.title,
      transcript.video_title,
      transcript.source_hint,
      transcript.video_url,
      transcript.url,
      transcript.document_url,
      transcript.page_url,
      transcript.source_pack_id,
      transcript.source_pack_document_id,
      transcript.source_pack_document_title,
      transcript.source_pack_page_range,
      transcript.source_pack_provenance,
      transcript.collection_kind,
      transcript.content_origin,
      transcript.source_class,
      transcript.search_source_class,
      transcript.source_trust,
      transcript.trust_tier,
      transcript.authority_tier,
      transcript.trust,
      transcript.authority,
      transcript.source_provenance,
      transcript.provenance,
      transcript.canonical_parent_id,
      transcript.parent_document_id,
      transcript.document_id,
      JSON.stringify(transcript.search_identity || {}),
      uniqueStrings(transcript.matched_resource_ids || []).sort(),
      await sha256Hex(JSON.stringify(transcript.segments || []))
    ];
  }
  const corpusDigest = await sha256Hex(JSON.stringify({ resources: resourceRecords, transcripts: transcriptRecords, content_body_digest: contentBodyDigest }));

  if (mutationToken) mutationToken.beginCommit();
  await chrome.storage.local.set({
    ...storagePatch,
    [RESOURCE_KEY]: resources,
    [TRANSCRIPT_KEY]: transcripts,
    [CONTENT_KEY]: nextContentStore,
    [META_KEY]: {
      ...existingMeta,
      resource_count: resources.length,
      transcript_count: transcripts.length,
      transcript_segment_count: transcripts.reduce((sum, transcript) => sum + transcript.segments.length, 0),
      content_count: Object.keys(nextContentStore).length,
      content_char_count: Object.values(nextContentStore).reduce((sum, text) => sum + String(text || "").length, 0),
      video_count: resources.filter(isVideoResource).length,
      content_schema_version: CONTENT_SCHEMA_VERSION,
      content_body_limit: MAX_INDEXED_BODY_CHARS,
      legacy_content_truncation_risk: legacyTruncatedResourceIds.length > 0,
      legacy_truncated_resource_ids: legacyTruncatedResourceIds,
      bounded_content_truncation_count: boundedTruncationIds.length,
      bounded_truncated_resource_ids: boundedTruncationIds,
      source_resource_counts: sourceResourceCounts,
      source_content_counts: sourceContentCounts,
      content_entry_sha256: contentEntrySha256,
      content_body_digest: contentBodyDigest,
      corpus_digest: corpusDigest,
      ...metaPatch,
      index_revision: storedRevision + 1,
      last_updated: new Date().toISOString()
    }
  });
}

function resourceCorpusSource(resource) {
  if (resource?.source_pack_id) return "curated_pack";
  if (resource?.collection_kind === "user_import" || resource?.content_origin === "user_import") return "user_import";
  return "official_blackboard";
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
      .map(([id, text]) => [id, cleanIndexedBodyText(text, "stored resource body")])
  );
}

function isReadableStoredFileBodyText(resource, storedContent) {
  const text = String(storedContent || "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (resource?.body_verified === true && resource?.indexed_body_source === "extracted") {
    return normalizeText(text).length > 40;
  }
  if (resource?.body_revalidation_required === true && resource?.indexed_body_source === "last_known_extracted") {
    return normalizeText(text).length > 40;
  }
  // Resource-pack bodies are prepared for indexing. Crawler-shell detection
  // below applies only to discovered file resources.
  if (resource?.source_pack_id) return normalizeText(text).length > 40;
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
    return cleanBoundedIndexedText(readableTextFromNode(root), limit, "Blackboard page extraction");
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
  const canonicalKey = mediaKey || cleanText(raw.canonical_key || raw.canonicalKey || "", 240);
  const generatedIdentity = mediaKey || url || canonicalKey;
  const resource = {
    id: cleanText(raw.id || stableId(["resource", generatedIdentity ? "canonical" : type, generatedIdentity || title]), 120),
    canonical_key: canonicalKey,
    type,
    title,
    url,
    page_url: normalizeUrl(raw.page_url || ""),
    page_title: cleanText(raw.page_title || "", 240),
    section: cleanText(raw.section || "", 240),
    context:
      type === "page"
        ? cleanBoundedIndexedText(raw.context || raw.description || "", MAX_SCRAPED_PAGE_CHARS, "Blackboard page body")
        : cleanText(raw.context || raw.description || "", 1800),
    discovered_at: cleanText(raw.discovered_at || new Date().toISOString(), 80),
    transcript_ids: uniqueStrings(raw.transcript_ids || raw.transcriptIds || [])
  };
  if (raw.body_verified === true) resource.body_verified = true;
  const indexedBodySource = cleanText(raw.indexed_body_source || raw.indexedBodySource || "", 40);
  const contentOrigin = cleanText(raw.content_origin || raw.contentOrigin || "", 80);
  if (indexedBodySource) resource.indexed_body_source = indexedBodySource;
  if (contentOrigin) resource.content_origin = contentOrigin;
  const contentFingerprint = cleanText(raw.content_fingerprint || raw.contentFingerprint || "", 160);
  const etag = cleanText(raw.etag || "", 160);
  const lastModified = cleanText(raw.last_modified || raw.lastModified || "", 120);
  const contentLength = Number(raw.content_length || raw.contentLength || 0);
  if (contentFingerprint) resource.content_fingerprint = contentFingerprint;
  if (etag) resource.etag = etag;
  if (lastModified) resource.last_modified = lastModified;
  if (Number.isFinite(contentLength) && contentLength > 0) resource.content_length = contentLength;
  return resource;
}

function searchableContentFrom(resource) {
  if (isFileLikeResource(resource)) return "";
  const content = resource.type === "page"
    ? cleanBoundedIndexedText(resource.context || "", MAX_SCRAPED_PAGE_CHARS, "Blackboard page body")
    : cleanBodyText(resource.context || "", 5000);
  if (!content) return "";
  return [resource.title, resource.section, resource.page_title, content].filter(Boolean).join("\n\n");
}

function isFileLikeResource(resource) {
  const type = String(resource?.type || "").toLowerCase();
  const hint = [resource?.title, resource?.url, resource?.document_url].filter(Boolean).join(" ");
  return ["pdf", "document", "slides", "spreadsheet"].includes(type) || /\.(pdf|docx|pptx|xlsx)(?:[?#]|$|\s)/i.test(hint);
}

function isManagedBlackboardAttachmentHydrationTarget(resource) {
  if (!resource || !isFileLikeResource(resource)) return false;
  if (resource.source_pack_id || resource.collection_kind === "user_import" || resource.content_origin === "user_import") return false;
  const url = String(resource.url || resource.document_url || "").trim();
  const pageUrl = String(resource.page_url || "").trim();
  const managedContext = pageUrl || resource.page_title || resource.section;
  return Boolean(resource.id && url && managedContext && stableResourceIdentityKey(resource));
}

function stableResourceIdentityKey(resource) {
  if (!resource || resource.source_pack_id || resource.collection_kind === "user_import" || resource.content_origin === "user_import") return "";
  const canonicalKey = cleanText(resource.canonical_key || resource.canonicalKey || "", 240);
  const type = String(resource.type || "").toLowerCase();
  if (/^(audio|video|video_embed)$/.test(type) && canonicalKey) return `canonical:${canonicalKey}`;
  const url = normalizeUrl(resource.url || "");
  if (url) return `url:${url}`;
  if (canonicalKey) return `canonical:${canonicalKey}`;
  return "";
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
    url: normalizeUrl(raw.url || raw.video_url || raw.videoUrl || ""),
    document_url: normalizeUrl(raw.document_url || raw.documentUrl || ""),
    page_url: normalizeUrl(raw.page_url || raw.pageUrl || ""),
    source_pack_id: cleanText(raw.source_pack_id || raw.sourcePackId || "", 120),
    source_pack_document_id: cleanText(raw.source_pack_document_id || raw.sourcePackDocumentId || "", 160),
    source_pack_document_title: cleanText(raw.source_pack_document_title || raw.sourcePackDocumentTitle || "", 240),
    source_pack_page_range: cleanText(raw.source_pack_page_range || raw.sourcePackPageRange || "", 120),
    source_pack_provenance: cleanText(raw.source_pack_provenance || raw.sourcePackProvenance || "", 500),
    collection_kind: cleanText(raw.collection_kind || raw.collectionKind || "", 120),
    content_origin: cleanText(raw.content_origin || raw.contentOrigin || "", 120),
    source_class: cleanText(raw.source_class || raw.sourceClass || "", 120),
    search_source_class: cleanText(raw.search_source_class || raw.searchSourceClass || "", 120),
    source_trust: cleanText(raw.source_trust || raw.sourceTrust || "", 120),
    trust_tier: cleanText(raw.trust_tier || raw.trustTier || "", 120),
    authority_tier: cleanText(raw.authority_tier || raw.authorityTier || "", 120),
    trust: cleanText(raw.trust || "", 120),
    authority: cleanText(raw.authority || "", 120),
    source_provenance: cleanText(raw.source_provenance || raw.sourceProvenance || "", 500),
    provenance: cleanText(raw.provenance || "", 500),
    canonical_parent_id: cleanText(raw.canonical_parent_id || raw.canonicalParentId || "", 160),
    parent_document_id: cleanText(raw.parent_document_id || raw.parentDocumentId || "", 160),
    document_id: cleanText(raw.document_id || raw.documentId || "", 160),
    search_identity: raw.search_identity && typeof raw.search_identity === "object" ? { ...raw.search_identity } : undefined,
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

function cleanIndexedBodyText(value, label = "resource body") {
  return cleanBoundedIndexedText(value, MAX_INDEXED_BODY_CHARS, label);
}

function cleanBoundedIndexedText(value, limit, label = "resource body") {
  const normalized = String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const safeLimit = Math.max(1, Number(limit) || MAX_INDEXED_BODY_CHARS);
  if (normalized.length <= safeLimit) return normalized;
  const marker =
    "\n\n" + INDEXED_TEXT_TRUNCATION_PREFIX + " at " + safeLimit +
    " characters; remainder omitted from " + cleanText(label, 80) + ".]";
  const bodyLimit = Math.max(0, safeLimit - marker.length);
  return normalized.slice(0, bodyLimit).trimEnd() + marker;
}

function boundedContentTruncationIds(contentStore) {
  return Object.entries(contentStore || {})
    .filter(([_resourceId, text]) => String(text || "").includes(INDEXED_TEXT_TRUNCATION_PREFIX))
    .map(([resourceId]) => resourceId)
    .sort();
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
