const RESOURCE_KEY = "resource_index";
const TRANSCRIPT_KEY = "transcript_store";
const CONTENT_KEY = "content_store";
const META_KEY = "index_meta";
const DEFAULT_CRAWL_SEED_URL =
  "https://lms.sc.tsinghua.edu.cn/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1";

try {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
} catch (_error) {
  // Older Chromium builds may not expose sidePanel behavior controls.
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
      return crawlSite(message.payload || {});
    case "IMPORT_TRANSCRIPTS":
      return importTranscripts(message.payload || {});
    case "MANUAL_ATTACH_TRANSCRIPT":
      return manualAttachTranscript(message.payload || {});
    default:
      return { ok: false, error: `unknown_message_type:${message.type}` };
  }
}

async function getIndex() {
  const data = await chrome.storage.local.get([RESOURCE_KEY, TRANSCRIPT_KEY, CONTENT_KEY, META_KEY]);
  const resources = data[RESOURCE_KEY] || [];
  const transcripts = data[TRANSCRIPT_KEY] || [];
  const contentStore = data[CONTENT_KEY] || {};
  const meta = data[META_KEY] || { resource_count: resources.length, transcript_count: transcripts.length };
  return { ok: true, resources, transcripts, content_store: contentStore, meta };
}

async function clearIndex() {
  await chrome.storage.local.set({
    [RESOURCE_KEY]: [],
    [TRANSCRIPT_KEY]: [],
    [CONTENT_KEY]: {},
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
  const data = await chrome.storage.local.get([RESOURCE_KEY, TRANSCRIPT_KEY, CONTENT_KEY]);
  const currentResources = data[RESOURCE_KEY] || [];
  const transcripts = data[TRANSCRIPT_KEY] || [];
  const contentStore = data[CONTENT_KEY] || {};
  const byId = new Map(currentResources.map((resource) => [resource.id, resource]));

  for (const raw of scrapedResources) {
    const normalized = normalizeResource(raw);
    if (!normalized.url && !normalized.title) continue;
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

  const resources = Array.from(byId.values());
  matchTranscriptsToResources(resources, transcripts);
  await saveIndex(resources, transcripts, contentStore);
  return {
    ok: true,
    added_or_updated: scrapedResources.length,
    resource_count: resources.length,
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
    const previous = byId.get(transcript.id);
    byId.set(transcript.id, {
      ...previous,
      ...transcript,
      matched_resource_ids: uniqueStrings([
        ...((previous && previous.matched_resource_ids) || []),
        ...(transcript.matched_resource_ids || [])
      ]),
      imported_at: previous?.imported_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  }

  const transcripts = Array.from(byId.values());
  const matchSummary = matchTranscriptsToResources(resources, transcripts);
  await saveIndex(resources, transcripts);
  return {
    ok: true,
    imported: incoming.length,
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

  emitCrawlProgress({ status: "started", pages: 0, queued: queue.length, resources: 0, current_url: seedUrl });

  while (queue.length && visited.size < maxPages) {
    const currentUrl = queue.shift();
    if (!currentUrl || visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    emitCrawlProgress({
      status: "fetching",
      pages: visited.size,
      queued: queue.length,
      resources: resources.length,
      current_url: currentUrl
    });

    try {
      const page = await fetchCrawlPage(currentUrl);
      resources.push(...page.resources);

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

  const mergeResult = await mergeScrape({ resources });
  const response = {
    ok: true,
    pages_crawled: visited.size,
    resources_seen: resources.length,
    resource_count: mergeResult.resource_count,
    queued_remaining: queue.length,
    failures: failures.slice(0, 20)
  };
  emitCrawlProgress({ status: "complete", pages: visited.size, queued: queue.length, resources: resources.length });
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
    childUrls.push(url);
    add({
      type: inferType(url, title),
      title,
      url,
      page_url: pageUrl,
      page_title: pageTitle,
      section,
      context: nearestContextFromDocument(anchor),
      discovered_at: new Date().toISOString()
    });
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
      urls.push(url);
      resources.push(
        normalizeResource({
          type: inferType(url, fileNameFromUrl(url)),
          title: fileNameFromUrl(url) || url,
          url,
          page_url: pageUrl,
          page_title: title,
          context: title,
          discovered_at: new Date().toISOString()
        })
      );
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
  const resourceIds = new Set(resources.map((resource) => resource.id));
  return Object.fromEntries(
    Object.entries(contentStore || {})
      .filter(([id, text]) => resourceIds.has(id) && String(text || "").trim())
      .map(([id, text]) => [id, cleanBodyText(text, 20000)])
  );
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
  const url = normalizeUrl(raw.url || raw.href || raw.src || "");
  const title = cleanText(raw.title || raw.name || raw.label || url || "Untitled resource", 240);
  const type = cleanText(raw.type || inferType(url, title), 80);
  const resource = {
    id: cleanText(raw.id || stableId(["resource", type, url, title]), 120),
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
  const content = cleanBodyText(resource.context || "", resource.type === "page" ? 20000 : 5000);
  if (!content) return "";
  return [resource.title, resource.section, resource.page_title, content].filter(Boolean).join("\n\n");
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
  if (/(kaltura|panopto|echo360|yuja|mediasite|bbcollab|youtube|vimeo)/.test(text)) return "video_embed";
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
