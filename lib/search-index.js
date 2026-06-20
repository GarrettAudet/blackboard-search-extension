// Local search index construction, scoring, source filtering, and result formatting helpers.
// Loaded before sidepanel.js.

function searchIndex(query) {
  const scored = buildSearchDocs(query)
    .map((doc) => ({ ...doc, score: scoreDoc(query, doc) }))
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score);
  return diversifySearchResults(scored, query).slice(0, 10);
}

function diversifySearchResults(scored, query) {
  const wantsVideo = wantsVideoHeavySearch(query);
  const videoLimit = wantsVideo ? 6 : 1;
  const selected = [];
  const deferredVideos = [];
  let videoCount = 0;

  for (const doc of scored) {
    if (isVideoResultKind(doc.kind) && videoCount >= videoLimit) {
      deferredVideos.push(doc);
      continue;
    }
    selected.push(doc);
    if (isVideoResultKind(doc.kind)) videoCount += 1;
    if (selected.length >= 10) break;
  }

  for (const doc of deferredVideos) {
    if (selected.length >= 10) break;
    selected.push(doc);
  }
  return selected;
}

function prepareAnswerSources(results, query = "") {
  const wantsVideo = wantsVideoHeavySearch(query);
  const wantsChineseLanguage = isChineseLanguageQuery(query);
  const wantsEnglishLanguage = isEnglishLanguageQuery(query) && !wantsChineseLanguage;
  const searchResults = rankSourceCandidates(
    isCourseListQuery(query) ? prioritizeCourseListResults(results || []) : results || [],
    query
  );
  const selected = [];
  const seen = new Set();
  for (const result of searchResults) {
    if (!result || result.score <= 0) continue;
    if (isLowValueSearchResult(result)) continue;
    if (wantsChineseLanguage && !wantsEnglishLanguage && isEnglishLanguageResource(result)) continue;
    if (!wantsVideo && isVideoResultKind(result.kind)) continue;
    const key = sourceDedupeKey(result);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(result);
    if (selected.length >= 8) break;
  }
  return selected;
}

function rankSourceCandidates(results, query = "") {
  return [...(results || [])].sort((a, b) => {
    const scoreA = (a?.score || 0) + sourceQualityScore(a, query);
    const scoreB = (b?.score || 0) + sourceQualityScore(b, query);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return (b?.score || 0) - (a?.score || 0);
  });
}

function isCourseListQuery(query) {
  const normalized = normalizeText(query);
  return /\b(course list|list of courses|courses list|released courses?|course release|courses released|course offerings?|course catalog|course calendar|class schedule|course schedule|academic calendar|timetable|curriculum)\b/.test(
    normalized
  );
}

function prioritizeCourseListResults(results) {
  const courseListResults = (results || []).filter(isCourseListResult);
  return courseListResults.length ? courseListResults : results || [];
}

function isCourseListResult(result) {
  const haystack = normalizeText(
    [cleanSourceTitle(result), compactSourceTrail(result), result.text, result.url].filter(Boolean).join(" ")
  );
  const hasScheduleSignal = /\b(calendar|schedule|timetable|course list|list of courses|course offerings?|course catalog|curriculum|class schedule|course schedule|academic calendar)\b/.test(
    haystack
  );
  const hasCourseSignal = /\b(courses?|classes?|academic|module|modules)\b/.test(haystack);
  return hasScheduleSignal && hasCourseSignal;
}
function isChineseLanguageQuery(query) {
  const normalized = normalizeText(query);
  return /\b(mandarin|chinese|chinese language|chinese resources?|learn chinese|study chinese|chinese vocab|chinese vocabulary|chinese grammar|survival chinese)\b/.test(
    normalized
  );
}

function isEnglishLanguageQuery(query) {
  return /\benglish\b/i.test(String(query || ""));
}

function isEnglishLanguageResource(result) {
  const haystack = normalizeText(
    [cleanSourceTitle(result), compactSourceTrail(result), result.text, result.url].filter(Boolean).join(" ")
  );
  return /\benglish language resources?\b/.test(haystack) || (/\benglish\b/.test(haystack) && /\blanguage\b/.test(haystack));
}

function isLowValueSearchResult(result) {
  const title = normalizeText(cleanSourceTitle(result));
  const source = normalizeText(compactSourceTrail(result));
  if (/^(quick links?|open quick links?|tabs|notifications dashboard)$/.test(title)) return true;
  if (title === "quick links" || /open quick links|notifications dashboard|my institution/.test(source)) return true;
  if (isUrlOnlyBlackboardShell(result)) return true;
  if (isThinLinkShell(result)) return true;
  return false;
}

function sourceQualityScore(result, query = "") {
  if (!result) return -999;
  let score = 0;
  const kind = String(result.kind || "").toLowerCase();
  const text = normalizeText(result.text || "");
  if (result.has_body || text.length > 220) score += 80;
  if (/^(pdf|document|page|announcement|video_transcript)$/.test(kind)) score += 40;
  if (kind === "link") score -= 20;
  if (isUrlLikeTitle(result.title || result.base_title)) score -= 90;
  if (isUrlOnlyBlackboardShell(result)) score -= 160;
  if (isThinLinkShell(result)) score -= 120;
  if (isVideoResultKind(kind) && !wantsVideoHeavySearch(query)) score -= 90;
  return score;
}

function isUrlOnlyBlackboardShell(result) {
  const kind = String(result?.kind || "").toLowerCase();
  const title = String(result?.base_title || result?.title || "");
  const url = String(result?.url || "");
  if (!/^(link|resource)$/.test(kind)) return false;
  if (!isUrlLikeTitle(title)) return false;
  return /\/webapps\/blackboard\/execute\/courseMain|\/webapps\/portal\/execute\/tabs\/tabAction/i.test(`${title} ${url}`);
}

function isThinLinkShell(result) {
  const kind = String(result?.kind || "").toLowerCase();
  if (kind !== "link") return false;
  if (result?.has_body) return false;
  const title = normalizeText(result?.base_title || result?.title || "");
  const text = normalizeText(result?.text || "");
  const source = normalizeText(compactSourceTrail(result || {}));
  if (isUrlLikeTitle(result?.base_title || result?.title)) return true;
  if (text.length < 80 && source.length < 80) return true;
  const words = text.split(" ").filter(Boolean);
  const unique = new Set(words);
  if (words.length > 12 && unique.size / words.length < 0.35) return true;
  return title && text && text.replace(title, "").trim().length < 40;
}

function isUrlLikeTitle(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text) || /\b[a-z0-9.-]+\.(?:edu|com|cn|org)\/\S+/i.test(text);
}

function sourceDedupeKey(result) {
  const url = normalizeSourceUrl(result.url || "");
  const title = normalizeText(cleanSourceTitle(result));
  const source = normalizeText(compactSourceTrail(result));
  const text = normalizeText(result.text || "").slice(0, 180);
  if (title && source) return `source:${title}|${source}`;
  if (title && text) return `title:${title}|${text}`;
  if (url) return `url:${url}|${title}`;
  return `text:${title}|${source}|${text}`;
}

function normalizeSourceUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    ["session", "cache", "nonce", "token", "auth", "one_hash", "x-bb-session", "download", "mode"].forEach((key) =>
      parsed.searchParams.delete(key)
    );
    parsed.hash = "";
    return parsed.href.toLowerCase();
  } catch (_error) {
    return String(value || "").split(/[?#]/)[0].replace(/\/+$/g, "").toLowerCase();
  }
}

function wantsVideoHeavySearch(query) {
  return /\b(video|videos|transcript|transcripts|webinar|meeting|recording|lecture|talk|speaker|covered|discussed|said)\b/i.test(query);
}

function isVideoResultKind(kind) {
  return /^(video|audio|video_embed|video_transcript)$/.test(String(kind || ""));
}


function buildSearchDocs(query = "") {
  const docs = [];
  const resourceById = new Map(state.resources.map((resource) => [resource.id, resource]));
  const wantsVideo = wantsVideoHeavySearch(query);

  for (const resource of state.resources) {
    const storedContent = state.contentStore?.[resource.id] || "";
    if (shouldSkipResourceSearchDoc(resource, storedContent, wantsVideo)) continue;
    const baseDoc = {
      resource_id: resource.id,
      kind: resource.type || "resource",
      title: resource.title || "Untitled resource",
      base_title: resource.title || "Untitled resource",
      source: [resource.section, resource.page_title].filter(Boolean).join(" - "),
      url: resource.url || resource.page_url || "",
      timestamp: "",
      has_body: Boolean(normalizeText(storedContent).length > 40)
    };
    const fullText = [resource.title, storedContent || resource.context, resource.section, resource.page_title]
      .filter(Boolean)
      .join(" ");
    if (!normalizeText(fullText)) continue;
    if (fullText.length > 1200) {
      const chunks = chunkTextForSearch(fullText, 1400);
      for (let index = 0; index < chunks.length; index += 1) {
        docs.push({
          ...baseDoc,
          kind: resource.type || "resource",
          title: chunks.length > 1 ? `${baseDoc.title} (part ${index + 1})` : baseDoc.title,
          text: chunks[index]
        });
      }
    } else {
      docs.push({
        ...baseDoc,
        text: fullText
      });
    }
  }

  for (const transcript of state.transcripts) {
    const matchedResource = (transcript.matched_resource_ids || [])
      .map((id) => resourceById.get(id))
      .find(Boolean);
    for (const segment of transcript.segments || []) {
      const text = normalizeTranscriptText(segment.text || "");
      if (!isSearchableTranscriptSegment(text)) continue;
      docs.push({
        kind: "video_transcript",
        title: transcript.title || "Video transcript",
        base_title: transcript.title || "Video transcript",
        resource_id: matchedResource?.id || "",
        text,
        source: matchedResource?.page_title || matchedResource?.title || transcript.source_hint || transcript.video_url || "Imported transcript",
        url: matchedResource?.url || transcript.video_url || "",
        timestamp: [segment.start, segment.end].filter(Boolean).join("-"),
        has_body: true
      });
    }
  }
  return docs;
}

function shouldSkipResourceSearchDoc(resource, storedContent, wantsVideo = false) {
  const type = String(resource?.type || "").toLowerCase();
  const context = clampText(resource?.context || "", 200);
  if (isLowValueNavigationResource(resource, storedContent)) return true;
  const isVideoMetadata = /^(audio|video|video_embed)$/.test(type);
  const hasTranscript = resourceTranscriptSegmentCount(resource) > 0 || (resource?.transcript_ids || []).length > 0;
  if (isVideoMetadata && !wantsVideo && !storedContent) return true;
  if (/^(audio|video)$/.test(type) && !storedContent && !context) return true;
  if (type === "video_embed" && !storedContent && !context && !hasTranscript) return true;
  return false;
}

function isLowValueNavigationResource(resource, storedContent = "") {
  const title = normalizeText(resource?.title || "");
  const source = normalizeText([resource?.section, resource?.page_title, resource?.context].filter(Boolean).join(" "));
  if (!storedContent && /^(quick links?|open quick links?|tabs|notifications dashboard)$/.test(title)) return true;
  if (!storedContent && title === "quick links" && /open quick links|notifications dashboard|my institution/.test(source)) return true;
  return false;
}

function isSearchableTranscriptSegment(text) {
  const clean = normalizeText(text);
  if (clean.length < 12) return false;
  const words = clean.split(" ").filter(Boolean);
  if (words.length < 4) return false;
  const unique = new Set(words);
  return unique.size / Math.max(1, words.length) >= 0.35;
}


function compactSourceTrail(result) {
  const raw = String(result.source || result.url || "");
  const parts = raw
    .split(/\s+-\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const deduped = [];
  for (const part of parts) {
    if (!deduped.some((existing) => normalizeText(existing) === normalizeText(part))) deduped.push(part);
  }
  const text = (deduped.length ? deduped.join(" - ") : raw).replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}


function scoreDoc(query, doc) {
  const queryTokens = expandedTokens(query);
  const queryPhrases = expandedPhrases(query);
  const title = normalizeText(doc.title);
  const text = normalizeText(doc.text);
  const source = normalizeText(doc.source);
  const haystack = `${title} ${source} ${text}`;
  const isTranscript = doc.kind === "video_transcript";
  let score = 0;
  for (const token of queryTokens) {
    if (!token) continue;
    const titleHits = countOccurrences(title, token);
    const sourceHits = countOccurrences(source, token);
    const textHits = countOccurrences(text, token);
    score += Math.min(36, titleHits * 16);
    score += Math.min(18, sourceHits * 8);
    score += Math.min(isTranscript ? 18 : 24, textHits * (isTranscript ? 4 : 6));
  }
  for (const phrase of queryPhrases) {
    if (!phrase) continue;
    if (title.includes(phrase)) score += 48;
    if (source.includes(phrase)) score += 22;
    if (text.includes(phrase)) score += isTranscript ? 18 : 28;
  }
  const phrase = normalizeText(query);
  if (phrase && text.includes(phrase)) score += isTranscript ? 12 : 25;
  if (phrase && title.includes(phrase)) score += 35;
  if (doc.kind === "page") score += pageIntentBoost(query, title, source, haystack);
  if (isTranscript && !wantsVideoHeavySearch(query)) score = Math.max(0, score - 24);
  return score;
}

function expandedTokens(query) {
  const tokens = normalizeText(query)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  const extras = [];
  const synonymMap = {
    visa: ["x1", "jw202", "permit", "residence"],
    permit: ["visa", "residence", "x1"],
    money: ["cash", "rmb", "bank", "banking"],
    banking: ["bank", "rmb", "payment", "cash"],
    payment: ["alipay", "wechatpay", "cash", "card", "bank"],
    pack: ["packing", "bring", "luggage", "clothing", "medicine", "arrival"],
    packing: ["pack", "bring", "luggage", "clothing", "medicine", "arrival"],
    bring: ["pack", "packing", "luggage", "clothing", "medicine"],
    taxi: ["didi", "arrival"],
    video: ["webinar", "recording", "transcript"],
    transcript: ["video", "webinar", "recording"],
    job: ["career", "internship", "resume", "interview"],
    career: ["job", "internship", "resume", "interview"],
    mandarin: ["chinese", "language", "language study", "course", "study"],
    chinese: ["mandarin", "language", "language study", "course"],
    language: ["mandarin", "chinese", "language study", "course"],
    todo: ["to do", "task", "tasks", "action", "item", "deadline", "due", "mandatory", "survey"],
    task: ["to do", "todo", "action", "item", "deadline", "due", "mandatory", "survey"],
    tasks: ["to do", "todo", "task", "action", "item", "deadline", "due", "mandatory", "survey"],
    deadline: ["due", "submit", "submission", "action", "item", "mandatory"],
    due: ["deadline", "submit", "submission", "action", "item"],
    survey: ["form", "questionnaire", "deadline", "mandatory", "submit"]
  };
  if (/\bto\s*[- ]?\s*do\b/i.test(query)) {
    extras.push("todo", "task", "tasks", "action", "item", "deadline", "due", "mandatory", "survey");
  }
  if (isCourseListQuery(query)) {
    extras.push(
      "course",
      "courses",
      "course list",
      "list of courses",
      "course calendar",
      "course schedule",
      "class schedule",
      "academic calendar",
      "calendar",
      "schedule",
      "timetable",
      "course offerings",
      "curriculum",
      "posted",
      "published",
      "available",
      "announced"
    );
  }
  for (const token of tokens) {
    extras.push(...(synonymMap[token] || []));
  }
  return Array.from(new Set([...tokens, ...extras].map((token) => normalizeText(token)).filter(Boolean)));
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "for",
  "from",
  "give",
  "how",
  "i",
  "in",
  "is",
  "link",
  "links",
  "list",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "resource",
  "resources",
  "some",
  "specific",
  "the",
  "there",
  "this",
  "u",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with"
]);

function expandedPhrases(query) {
  const phrases = [];
  const normalized = normalizeText(query);
  if (normalized) phrases.push(normalized);
  if (/\bto\s*[- ]?\s*do\b/i.test(query) || /\btasks?\b/i.test(query)) {
    phrases.push("to do", "action item", "action items", "current tasks", "to do tasks");
  }
  if (isCourseListQuery(query)) {
    phrases.push(
      "course list",
      "list of courses",
      "course calendar",
      "course schedule",
      "class schedule",
      "academic calendar",
      "course offerings",
      "courses released"
    );
  }
  return Array.from(new Set(phrases.map((phrase) => normalizeText(phrase)).filter(Boolean)));
}

function pageIntentBoost(query, title, source, haystack) {
  let boost = 0;
  const isTaskQuery = /\b(to\s*[- ]?\s*do|todo|tasks?|action items?|deadline|due)\b/i.test(query);
  if (isTaskQuery) {
    if (/\bto do\b/.test(title) || /\bto do\b/.test(source)) boost += 120;
    if (/\b(action item|deadline|mandatory|survey|submit|due)\b/.test(haystack)) boost += 40;
  }
  const asksCurrent = /\b(current|latest|new|now|upcoming)\b/i.test(query);
  if (asksCurrent && /\b(deadline|due|upcoming|current|mandatory|submit)\b/.test(haystack)) boost += 20;

  if (isCourseListQuery(query)) {
    if (/\b(calendar|schedule|timetable|course list|list of courses|course calendar|course schedule|class schedule|academic calendar|course offerings?|course catalog|curriculum)\b/.test(title)) boost += 140;
    if (/\b(calendar|schedule|timetable|course list|list of courses|course calendar|course schedule|class schedule|academic calendar|course offerings?|course catalog|curriculum)\b/.test(source)) boost += 80;
    if (/\b(calendar|schedule|timetable|course list|list of courses|course calendar|course schedule|class schedule|academic calendar|course offerings?|course catalog|curriculum)\b/.test(haystack)) boost += 80;
    if (/\b(posted|published|released|available|announced)\b/.test(haystack)) boost += 30;
  }
  return boost;
}

function countOccurrences(text, term) {
  if (!text || !term) return 0;
  let count = 0;
  let index = text.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(term, index + term.length);
  }
  return count;
}

function chunkTextForSearch(text, maxChars = 1400) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean ? [clean] : [];
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
  const chunks = [];
  let buffer = "";
  for (const sentence of sentences.map((item) => item.trim()).filter(Boolean)) {
    if ((buffer + " " + sentence).trim().length > maxChars && buffer) {
      chunks.push(buffer);
      buffer = sentence;
    } else {
      buffer = [buffer, sentence].filter(Boolean).join(" ");
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

function snippetFor(text, query, limit = 260) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const tokens = expandedTokens(query);
  const lower = clean.toLowerCase();
  const hit = tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0).sort((a, b) => a - b)[0] || 0;
  const start = Math.max(0, hit - 60);
  const snippet = clean.slice(start, start + limit);
  return `${start > 0 ? "... " : ""}${snippet}${start + limit < clean.length ? " ..." : ""}`;
}

function isVideoResource(resource) {
  return /video|audio|recording|media|webinar/i.test(`${resource.type || ""} ${resource.title || ""} ${resource.url || ""}`);
}

function isTranscriptCandidateResource(resource) {
  return isActualVideoResource(resource) && isAllowedTranscriptSource(resource) && !resourceIsDismissedMedia(resource);
}

function isActualVideoResource(resource) {
  const type = String(resource?.type || "").toLowerCase();
  const url = String(resource?.url || "");
  if (/^(audio|video|video_embed)$/.test(type)) return true;
  if (isEmbeddedVideoViewerUrl(url) || isLikelyTranscribableMediaUrl(url)) return true;
  return /(panopto|kaltura|echo360|yuja|mediasite|bbcollab)/i.test(url);
}

function resourceIsDismissedMedia(resource) {
  if (!state.ignoredMediaKeys || !state.ignoredMediaKeys.size) return false;
  return mediaCandidateKeysForRecord(resource).some((key) => state.ignoredMediaKeys.has(key));
}

function mediaCandidateKeysForRecord(record) {
  const keys = [];
  const canonical = canonicalVideoKey(record);
  if (/^(panopto|media):/i.test(canonical)) keys.push(canonical.toLowerCase());
  const media = mediaCandidateKey(record?.canonical_key || record?.url || record?.video_url || record?.videoUrl || "");
  if (media) keys.push(media);
  return Array.from(new Set(keys.filter(Boolean)));
}
function isAllowedTranscriptSource(resource) {
  const text = transcriptSourceText(resource);
  if (!text) return false;
  if (/(youtube\.com|youtu\.be|googlevideo\.com|vimeo\.com)/i.test(text)) return false;
  return /(lms\.sc\.tsinghua\.edu\.cn|panopto\.sc\.tsinghua\.edu\.cn|\.tsinghua\.edu\.cn|blackboard\.com|bbcollab\.com|kaltura\.com|panopto\.com|echo360\.(?:org|com)|yuja\.com|mediasite\.com)/i.test(text);
}

function transcriptSourceText(resource) {
  return [
    resource?.url,
    resource?.page_url,
    resource?.document_url,
    resource?.initiator,
    resource?.context,
    resource?.section,
    resource?.page_title,
    resource?.title
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
function labelForKind(kind) {
  if (kind === "video_transcript") return "transcript";
  if (kind === "video_embed") return "video";
  return String(kind || "resource").replace(/_/g, " ");
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

