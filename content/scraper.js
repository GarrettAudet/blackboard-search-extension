(function () {
  const VIDEO_HOST_HINTS = [
    "kaltura",
    "panopto",
    "echo360",
    "yuja",
    "mediasite",
    "bbcollab",
    "youtube",
    "vimeo"
  ];

  function cleanText(value, limit = 500) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit);
  }

  function cleanBodyText(value, limit = 10000) {
    return String(value || "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, limit);
  }

  function absoluteUrl(rawUrl) {
    try {
      return new URL(rawUrl, window.location.href).href;
    } catch (_error) {
      return "";
    }
  }

  function normalizeUrl(rawUrl) {
    const url = absoluteUrl(rawUrl);
    if (!url) return "";
    try {
      const parsed = new URL(url);
      [
        "session",
        "cache",
        "nonce",
        "token",
        "auth",
        "one_hash",
        "x-bb-session",
        "download"
      ].forEach((key) => parsed.searchParams.delete(key));
      parsed.hash = "";
      return parsed.href;
    } catch (_error) {
      return url;
    }
  }

  function inferResourceType(url, label = "") {
    const lower = `${url} ${label}`.toLowerCase();
    if (/\.(pdf)(\?|$)/.test(lower)) return "pdf";
    if (/\.(doc|docx|rtf|odt)(\?|$)/.test(lower)) return "document";
    if (/\.(ppt|pptx)(\?|$)/.test(lower)) return "slides";
    if (/\.(xls|xlsx|csv)(\?|$)/.test(lower)) return "spreadsheet";
    if (/\.(mp4|mov|m4v|webm|avi|mkv)(\?|$)/.test(lower)) return "video";
    if (/\.(mp3|m4a|wav|aac|ogg)(\?|$)/.test(lower)) return "audio";
    if (VIDEO_HOST_HINTS.some((hint) => lower.includes(hint))) return "video_embed";
    if (lower.includes("announcement")) return "announcement";
    return "link";
  }

  function breadcrumbText() {
    const selectors = [
      "[aria-label*='breadcrumb' i]",
      ".breadcrumb",
      "#breadcrumbs",
      ".path",
      ".locationPane"
    ];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const text = cleanText(node && node.innerText, 300);
      if (text) return text;
    }
    return "";
  }

  function nearestContext(element) {
    const parts = [];
    const heading = element.closest("li, article, section, div");
    if (heading) {
      const titleNode = heading.querySelector("h1,h2,h3,h4,.item,.title,.name");
      const title = cleanText(titleNode && titleNode.innerText, 180);
      if (title) parts.push(title);
      const text = cleanText(heading.innerText, 280);
      if (text && text !== title) parts.push(text);
    }
    return parts.join(" - ");
  }

  function videoTitle() {
    const selectors = [
      "[class*='title' i]",
      "h1",
      "h2",
      "[aria-label*='title' i]"
    ];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const text = cleanText(node && (node.innerText || node.textContent), 240);
      if (text && !/^results?$/i.test(text)) return text;
    }
    return cleanText(document.title || "Video search results", 240);
  }

  function simpleHash(value) {
    let hash = 0;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
    }
    return hash.toString(36);
  }

  function pageTextExcerpt() {
    const main =
      document.querySelector("main") ||
      document.querySelector("#content") ||
      document.querySelector("[role='main']") ||
      document.body;
    return cleanBodyText(main && main.innerText, 10000);
  }

  function resourceFromUrl(rawUrl, label, type, element) {
    const url = normalizeUrl(rawUrl);
    if (!url || url.startsWith("javascript:") || url.startsWith("mailto:")) return null;
    const title = cleanText(label || element?.getAttribute("title") || element?.getAttribute("aria-label") || url, 240);
    const finalType = type || inferResourceType(url, title);
    return {
      id: "",
      type: finalType,
      title,
      url,
      page_url: normalizeUrl(window.location.href),
      page_title: cleanText(document.title, 240),
      section: breadcrumbText(),
      context: nearestContext(element || document.body),
      discovered_at: new Date().toISOString()
    };
  }

  function collectVideoSearchTranscripts() {
    const segments = visibleVideoSearchSegments();
    if (!segments.length) return [];
    const url = normalizeUrl(window.location.href);
    const title = videoTitle();
    return [
      {
        id: `visible_video_results_${simpleHash(url || title)}`,
        title,
        source_hint: `Visible video search results - ${cleanText(document.title || title, 180)}`,
        video_url: url,
        segments
      }
    ];
  }

  function visibleVideoSearchSegments() {
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
    const candidates = [];

    document.querySelectorAll(rowSelectors.join(",")).forEach((node) => {
      const text = cleanText(node.innerText || node.textContent, 700);
      const timestamps = text.match(timestampPattern) || [];
      if (!timestamps.length || !/[a-zA-Z]{4,}/.test(text)) return;
      if (/^(details|discussion|notes|bookmarks|results|hide|search all|sort by relevance)\b/i.test(text)) return;
      const timestamp = timestamps[timestamps.length - 1];
      const snippet = cleanText(
        text
          .replace(timestampPattern, " ")
          .replace(/\b(Search all|Sort by relevance|Results|Hide)\b/gi, " "),
        500
      );
      if (snippet.length < 12) return;
      const key = `${timestamp}|${snippet.toLowerCase().slice(0, 160)}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ id: String(candidates.length), start: normalizeTimestamp(timestamp), end: "", speaker: "", text: snippet });
    });

    return candidates.sort((a, b) => secondsFromTimestamp(a.start) - secondsFromTimestamp(b.start));
  }

  function normalizeTimestamp(value) {
    const parts = String(value || "").split(":").map((part) => Number.parseInt(part, 10));
    if (parts.some((part) => !Number.isFinite(part))) return String(value || "");
    if (parts.length === 2) return `00:${String(parts[0]).padStart(2, "0")}:${String(parts[1]).padStart(2, "0")}`;
    if (parts.length === 3) return parts.map((part) => String(part).padStart(2, "0")).join(":");
    return String(value || "");
  }

  function secondsFromTimestamp(value) {
    const parts = String(value || "").split(":").map((part) => Number.parseInt(part, 10));
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return 0;
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  function collectResources() {
    const resources = [];
    const seen = new Set();

    function add(resource) {
      if (!resource) return;
      const key = `${resource.type}|${resource.url}|${resource.title}`;
      if (seen.has(key)) return;
      seen.add(key);
      resources.push(resource);
    }

    document.querySelectorAll("a[href]").forEach((anchor) => {
      const label = cleanText(anchor.innerText || anchor.textContent || anchor.href, 240);
      add(resourceFromUrl(anchor.href, label, "", anchor));
    });

    document.querySelectorAll("video[src], video source[src], audio[src], audio source[src]").forEach((media) => {
      const host = media.closest("video,audio") || media;
      const label =
        host.getAttribute("title") ||
        host.getAttribute("aria-label") ||
        nearestContext(host) ||
        document.title;
      const type = media.closest("audio") ? "audio" : "video";
      add(resourceFromUrl(media.getAttribute("src"), label, type, host));
    });

    document.querySelectorAll("iframe[src], embed[src], object[data]").forEach((frame) => {
      const rawUrl = frame.getAttribute("src") || frame.getAttribute("data");
      const label =
        frame.getAttribute("title") ||
        frame.getAttribute("aria-label") ||
        nearestContext(frame) ||
        document.title;
      const inferred = inferResourceType(rawUrl, label);
      if (inferred === "video_embed" || inferred === "video") {
        add(resourceFromUrl(rawUrl, label, "video_embed", frame));
      }
    });

    const pageText = pageTextExcerpt();
    if (pageText) {
      add({
        id: "",
        type: "page",
        title: cleanText(document.title || "Blackboard page", 240),
        url: normalizeUrl(window.location.href),
        page_url: normalizeUrl(window.location.href),
        page_title: cleanText(document.title, 240),
        section: breadcrumbText(),
        context: pageText,
        discovered_at: new Date().toISOString()
      });
    }

    return resources;
  }

  function scrapePage() {
    return {
      page: {
        url: normalizeUrl(window.location.href),
        title: cleanText(document.title, 240),
        section: breadcrumbText(),
        scraped_at: new Date().toISOString()
      },
      resources: collectResources(),
      transcripts: collectVideoSearchTranscripts()
    };
  }

  let scrapeTimer = null;
  let lastPayloadKey = "";

  function sendScrape() {
    const payload = scrapePage();
    const transcriptKey = (payload.transcripts || [])
      .flatMap((transcript) => transcript.segments || [])
      .map((segment) => `${segment.start}|${segment.text}`)
      .join("|");
    const payloadKey = `${payload.page.url}|${payload.resources.length}|${payload.resources.map((item) => item.context || item.title).join("|").length}|${transcriptKey.length}`;
    if (payloadKey === lastPayloadKey) return;
    lastPayloadKey = payloadKey;
    chrome.runtime.sendMessage({ type: "SCRAPE_PAGE", payload }, () => {
      void chrome.runtime.lastError;
    });
  }

  function scheduleScrape(delay = 500) {
    if (scrapeTimer) window.clearTimeout(scrapeTimer);
    scrapeTimer = window.setTimeout(sendScrape, delay);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "REQUEST_SCRAPE") {
      const payload = scrapePage();
      chrome.runtime.sendMessage({ type: "SCRAPE_PAGE", payload }, () => {
        void chrome.runtime.lastError;
      });
      sendResponse({ ok: true, ...payload });
      return true;
    }
    return false;
  });

  scheduleScrape(800);
  window.setTimeout(sendScrape, 2500);
  window.setTimeout(sendScrape, 6000);
  try {
    const observer = new MutationObserver(() => scheduleScrape(900));
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
    window.setTimeout(() => observer.disconnect(), 15000);
  } catch (_error) {
    // MutationObserver may be unavailable in unusual frames.
  }
})();
