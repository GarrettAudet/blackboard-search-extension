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

  function pageTextExcerpt() {
    const main =
      document.querySelector("main") ||
      document.querySelector("#content") ||
      document.querySelector("[role='main']") ||
      document.body;
    return cleanText(main && main.innerText, 10000);
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
      resources: collectResources()
    };
  }

  let scrapeTimer = null;
  let lastPayloadKey = "";

  function sendScrape() {
    const payload = scrapePage();
    const payloadKey = `${payload.page.url}|${payload.resources.length}|${payload.resources.map((item) => item.context || item.title).join("|").length}`;
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
