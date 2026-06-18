const state = {
  resources: [],
  transcripts: [],
  meta: {}
};

const els = {
  statusText: document.getElementById("statusText"),
  refreshBtn: document.getElementById("refreshBtn"),
  scanBtn: document.getElementById("scanBtn"),
  importBtn: document.getElementById("importBtn"),
  clearBtn: document.getElementById("clearBtn"),
  transcriptFile: document.getElementById("transcriptFile"),
  resourceCount: document.getElementById("resourceCount"),
  videoCount: document.getElementById("videoCount"),
  transcriptCount: document.getElementById("transcriptCount"),
  queryInput: document.getElementById("queryInput"),
  searchBtn: document.getElementById("searchBtn"),
  resultCount: document.getElementById("resultCount"),
  results: document.getElementById("results"),
  videoStatus: document.getElementById("videoStatus"),
  videoList: document.getElementById("videoList"),
  resultTemplate: document.getElementById("resultTemplate")
};

function sendMessage(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, payload });
}

function setStatus(message) {
  els.statusText.textContent = message;
}

async function refreshIndex() {
  const response = await sendMessage("GET_INDEX");
  if (!response.ok) throw new Error(response.error || "Unable to load index");
  state.resources = response.resources || [];
  state.transcripts = response.transcripts || [];
  state.meta = response.meta || {};
  render();
}

async function scanActiveTab() {
  setStatus("Scanning active Blackboard tab...");
  const response = await sendMessage("SCAN_ACTIVE_TAB");
  if (!response.ok) throw new Error(response.error || "Scan failed");
  await refreshIndex();
  setStatus(`Scanned active tab. Found ${response.resource_count || 0} resources on this page.`);
}

async function importTranscriptFile(file) {
  const text = await file.text();
  const json = JSON.parse(text);
  setStatus("Importing transcripts...");
  const response = await sendMessage("IMPORT_TRANSCRIPTS", json);
  if (!response.ok) throw new Error(response.error || "Transcript import failed");
  await refreshIndex();
  setStatus(`Imported ${response.imported} transcript(s); auto-attached ${response.auto_attached}.`);
}

async function clearIndex() {
  if (!confirm("Clear all indexed Blackboard resources and transcripts from this browser?")) return;
  const response = await sendMessage("CLEAR_INDEX");
  if (!response.ok) throw new Error(response.error || "Clear failed");
  await refreshIndex();
  setStatus("Local index cleared.");
}

function render() {
  const videos = state.resources.filter(isVideoResource);
  els.resourceCount.textContent = String(state.resources.length);
  els.videoCount.textContent = String(videos.length);
  els.transcriptCount.textContent = String(state.transcripts.length);
  const updated = state.meta.last_updated ? new Date(state.meta.last_updated).toLocaleString() : "not built yet";
  setStatus(`Local index updated: ${updated}`);
  renderVideos(videos);
  runSearch();
}

function renderVideos(videos) {
  els.videoList.textContent = "";
  const ready = videos.filter((video) => (video.transcript_ids || []).length).length;
  els.videoStatus.textContent = videos.length ? `${ready}/${videos.length} searchable` : "none found";
  if (!videos.length) {
    els.videoList.append(emptyNode("No video resources found yet. Open Blackboard and scan a course page."));
    return;
  }

  for (const video of videos.slice(0, 30)) {
    const card = document.createElement("article");
    card.className = "video-card";

    const top = document.createElement("div");
    top.className = "video-topline";
    const title = document.createElement("h3");
    title.textContent = video.title || "Untitled video";
    const badge = document.createElement("span");
    const attached = video.transcript_ids || [];
    badge.className = `video-state ${attached.length ? "ready" : "missing"}`;
    badge.textContent = attached.length ? "Transcript ready" : "Transcript missing";
    top.append(title, badge);

    const meta = document.createElement("p");
    meta.className = "video-meta";
    meta.textContent = [video.type, video.section, video.page_title].filter(Boolean).join(" - ");

    card.append(top, meta);
    if (video.url) {
      const link = document.createElement("a");
      link.className = "open-link";
      link.href = video.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "Open video source";
      card.append(link);
    }

    if (!attached.length && state.transcripts.length) {
      const row = document.createElement("div");
      row.className = "attach-row";
      const select = document.createElement("select");
      for (const transcript of state.transcripts) {
        const option = document.createElement("option");
        option.value = transcript.id;
        option.textContent = transcript.title || transcript.id;
        select.append(option);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Attach";
      button.addEventListener("click", async () => {
        const response = await sendMessage("MANUAL_ATTACH_TRANSCRIPT", {
          resource_id: video.id,
          transcript_id: select.value
        });
        if (!response.ok) throw new Error(response.error || "Attach failed");
        await refreshIndex();
      });
      row.append(select, button);
      card.append(row);
    }

    els.videoList.append(card);
  }
}

function runSearch() {
  const query = els.queryInput.value.trim();
  els.results.textContent = "";
  if (!query) {
    els.resultCount.textContent = "";
    els.results.append(emptyNode("Enter a question or keyword to search local resources."));
    return;
  }

  const docs = buildSearchDocs();
  const results = docs
    .map((doc) => ({ ...doc, score: scoreDoc(query, doc) }))
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  els.resultCount.textContent = `${results.length} shown`;
  if (!results.length) {
    els.results.append(emptyNode("No local matches. Try broader terms or import transcripts for video-only resources."));
    return;
  }

  for (const result of results) {
    els.results.append(renderResult(result, query));
  }
}

function buildSearchDocs() {
  const docs = [];
  const resourceById = new Map(state.resources.map((resource) => [resource.id, resource]));

  for (const resource of state.resources) {
    docs.push({
      kind: resource.type || "resource",
      title: resource.title || "Untitled resource",
      text: [resource.context, resource.section, resource.page_title, resource.url].filter(Boolean).join(" "),
      source: [resource.section, resource.page_title].filter(Boolean).join(" - "),
      url: resource.url || resource.page_url || "",
      timestamp: ""
    });
  }

  for (const transcript of state.transcripts) {
    const matchedResource = (transcript.matched_resource_ids || [])
      .map((id) => resourceById.get(id))
      .find(Boolean);
    for (const segment of transcript.segments || []) {
      docs.push({
        kind: "video_transcript",
        title: transcript.title || "Video transcript",
        text: segment.text || "",
        source: matchedResource?.title || transcript.source_hint || transcript.video_url || "Imported transcript",
        url: matchedResource?.url || transcript.video_url || "",
        timestamp: [segment.start, segment.end].filter(Boolean).join("-")
      });
    }
  }
  return docs;
}

function renderResult(result, query) {
  const node = els.resultTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".type-pill").textContent = labelForKind(result.kind);
  node.querySelector(".score").textContent = `score ${Math.round(result.score)}`;
  node.querySelector("h3").textContent = result.timestamp ? `${result.title} (${result.timestamp})` : result.title;
  node.querySelector(".snippet").textContent = snippetFor(result.text, query);
  node.querySelector(".source").textContent = result.source || result.url || "";
  const link = node.querySelector(".open-link");
  if (result.url) {
    link.href = result.url;
  } else {
    link.remove();
  }
  return node;
}

function scoreDoc(query, doc) {
  const queryTokens = expandedTokens(query);
  const title = normalizeText(doc.title);
  const text = normalizeText(doc.text);
  const source = normalizeText(doc.source);
  let score = 0;
  for (const token of queryTokens) {
    if (!token) continue;
    if (title.includes(token)) score += 12;
    if (source.includes(token)) score += 6;
    if (text.includes(token)) score += doc.kind === "video_transcript" ? 10 : 4;
  }
  const phrase = normalizeText(query);
  if (phrase && text.includes(phrase)) score += 25;
  if (phrase && title.includes(phrase)) score += 35;
  return score;
}

function expandedTokens(query) {
  const tokens = normalizeText(query).split(" ").filter((token) => token.length > 2);
  const extras = [];
  const synonymMap = {
    visa: ["x1", "jw202", "permit"],
    money: ["cash", "rmb", "bank", "banking"],
    payment: ["alipay", "wechatpay", "cash", "card"],
    taxi: ["didi", "arrival"],
    video: ["webinar", "recording", "transcript"],
    transcript: ["video", "webinar", "recording"]
  };
  for (const token of tokens) {
    extras.push(...(synonymMap[token] || []));
  }
  return Array.from(new Set([...tokens, ...extras]));
}

function snippetFor(text, query) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const tokens = expandedTokens(query);
  const lower = clean.toLowerCase();
  const hit = tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0).sort((a, b) => a - b)[0] || 0;
  const start = Math.max(0, hit - 90);
  const snippet = clean.slice(start, start + 260);
  return `${start > 0 ? "... " : ""}${snippet}${start + 260 < clean.length ? " ..." : ""}`;
}

function isVideoResource(resource) {
  return /video|audio|recording|media|webinar/i.test(`${resource.type || ""} ${resource.title || ""} ${resource.url || ""}`);
}

function labelForKind(kind) {
  if (kind === "video_transcript") return "Transcript";
  if (kind === "video_embed") return "Video";
  return String(kind || "Resource").replace(/_/g, " ");
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function emptyNode(text) {
  const node = document.createElement("p");
  node.className = "empty";
  node.textContent = text;
  return node;
}

function reportError(error) {
  console.error(error);
  setStatus(`Error: ${error && error.message ? error.message : String(error)}`);
}

els.refreshBtn.addEventListener("click", () => refreshIndex().catch(reportError));
els.scanBtn.addEventListener("click", () => scanActiveTab().catch(reportError));
els.importBtn.addEventListener("click", () => els.transcriptFile.click());
els.clearBtn.addEventListener("click", () => clearIndex().catch(reportError));
els.searchBtn.addEventListener("click", runSearch);
els.queryInput.addEventListener("input", runSearch);
els.transcriptFile.addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  importTranscriptFile(file).catch(reportError).finally(() => {
    els.transcriptFile.value = "";
  });
});

refreshIndex().catch(reportError);
