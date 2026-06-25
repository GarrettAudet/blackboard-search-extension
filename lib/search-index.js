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
  const routedResults = isVisaQuery(query)
    ? prioritizeDomainResults(results || [], isVisaResult)
    : isPackingQuery(query)
      ? prioritizeDomainResults(results || [], isPackingResult)
      : isTaskDeadlineQuery(query)
        ? prioritizeTaskDeadlineResults(results || [])
        : isCourseListQuery(query)
          ? prioritizeCourseListResults(results || [])
          : results || [];
  const searchResults = dedupeSourceCandidates(rankSourceCandidates(routedResults, query), query);
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
function enhanceRetrievalQueryForIntent(query, retrievalQuery = query, plan = null) {
  const pieces = [retrievalQuery, query];
  const intent = normalizeText(plan?.intent || "").replace(/\s+/g, "_");
  if (isVisaQuery(query)) {
    pieces.push("X1 student visa visa FAQ passport JW202 JW201 admission notice embassy consulate visa application physical exam residence permit immigration documents");
  }
  if (isPackingQuery(query)) {
    pieces.push("Packing List for Students 2026 pack bring China luggage medication prescription doctor letter adapters chargers clothing toiletries passport documents cash bank cards");
  }
  if (isTaskDeadlineQuery(query) || intent === "task_deadline") {
    pieces.push(
      "To Do deadline deadlines due action items current tasks mandatory required submit submission survey application prerequisite capstone"
    );
  }
  if (isCourseListQuery(query) || intent === "course_list") {
    pieces.push(
      "course list list of courses course calendar class schedule course schedule academic calendar timetable curriculum course offerings released published"
    );
  }
  if (isChineseLanguageQuery(query)) {
    pieces.push("Chinese Language Learning Resources Mandarin key vocabulary grammar survival Chinese placement tests language study");
  }
  return Array.from(new Set(pieces.map((value) => String(value || "").trim()).filter(Boolean))).join(" ").slice(0, 1400);
}

function isTaskDeadlineQuery(query) {
  const normalized = normalizeText(query);
  if (!normalized) return false;
  const todoPhraseSignal = /\bto\s+do(?:\s+s)?\b|\bto\s+dos?\b|\btodos?\b/i.test(normalized);
  const concreteTaskSignal = /\btasks?\b|\baction\s+items?\b|\bdeadlines?\b|\bdue\b|\bdue\s+dates?\b|\banything\s+due\b|\brequirements?\s+due\b/i.test(
    normalized
  );
  const genericNeedToDo = /\bwhat\s+(?:do|should|must)\s+(?:i|we)\s+(?:need\s+)?to\s+do\b/i.test(normalized);
  const domainSpecificNeedToDo = (isVisaQuery(query) || isPackingQuery(query)) && (genericNeedToDo || todoPhraseSignal);
  if (domainSpecificNeedToDo && !concreteTaskSignal) return false;
  return concreteTaskSignal || todoPhraseSignal || genericNeedToDo;
}
function isVisaQuery(query) {
  const normalized = normalizeText(query);
  return /\b(x1|visa|jw202|jw201|residence\s+permit|permit|passport|embassy|consulate|admission\s+notice|immigration)\b/.test(normalized);
}

function isPackingQuery(query) {
  const normalized = normalizeText(query);
  return /\b(pack|packing|bring|luggage|suitcase|medicine|medication|prescription|toiletries|adapter|adapters|clothing|arrival\s+items?)\b/.test(normalized);
}

function prioritizeDomainResults(results, predicate) {
  const domainResults = (results || []).filter(predicate);
  if (!domainResults.length) return results || [];
  const domainKeys = new Set(domainResults.map(sourceDedupeKey));
  return [...domainResults, ...(results || []).filter((result) => !domainKeys.has(sourceDedupeKey(result)))];
}

function isVisaResult(result) {
  const haystack = normalizeText(
    [cleanSourceTitle(result), compactSourceTrail(result), result?.text, result?.url].filter(Boolean).join(" ")
  );
  return /\b(x1\s+student\s+visa|obtaining\s+your\s+x1|visa\s+faq|jw202|jw201|admission\s+notice|embassy|consulate|visa\s+application|residence\s+permit|passport)\b/.test(haystack);
}

function isPackingResult(result) {
  const haystack = normalizeText(
    [cleanSourceTitle(result), compactSourceTrail(result), result?.text, result?.url].filter(Boolean).join(" ")
  );
  return /\b(packing\s+list|pack\s+for|what\s+to\s+pack|luggage|prescription\s+medication|doctor\s+letter|toiletries|adapters?|bring\s+passport|clothing\s+layers)\b/.test(haystack);
}

function prioritizeTaskDeadlineResults(results) {
  const taskResults = (results || []).filter(isTaskDeadlineResult);
  if (!taskResults.length) return results || [];
  const taskKeys = new Set(taskResults.map(sourceDedupeKey));
  return [...taskResults, ...(results || []).filter((result) => !taskKeys.has(sourceDedupeKey(result)))];
}

function isTaskDeadlineResult(result) {
  const haystack = normalizeText(
    [cleanSourceTitle(result), compactSourceTrail(result), result?.text, result?.url].filter(Boolean).join(" ")
  );
  if (!haystack) return false;
  if (/\b(actions all items|nothing due today|select date go today|last updated)\b/.test(haystack)) return false;
  const hasTaskShell = /\b(to do|todo|task|action item|deadline|due|mandatory|required|submit|submission|survey|application)\b/.test(
    haystack
  );
  const hasConcreteAction = /\b(review|fill out|complete|submit|mandatory|required|students who|survey|application|deadline|due)\b/.test(
    haystack
  );
  return hasTaskShell && hasConcreteAction;
}

function isCourseListQuery(query) {
  const normalized = normalizeText(query);
  if (!normalized) return false;
  if (/\b(course list|list of courses|courses list|released courses?|course release|courses released|course offerings?|course catalog|course calendar|class schedule|course schedule|academic calendar|timetable|curriculum)\b/.test(normalized)) {
    return true;
  }
  return /\b(?:what|which)\s+(?:classes|courses)\s+(?:do|did|can|should|will)\s+(?:i|we)\s+(?:have|take|need|choose|register|attend)\b/.test(normalized) ||
    /\b(?:my|available|released|published|listed)\s+(?:classes|courses)\b/.test(normalized) ||
    /\b(?:classes|courses)\s+(?:available|released|published|listed)\b/.test(normalized);
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
  if (isBlackboardChromeResult(result)) return true;
  if (isUrlOnlyBlackboardShell(result)) return true;
  if (isThinLinkShell(result)) return true;
  if (isGenericCourseShellResult(result)) return true;
  return false;
}

function sourceQualityScore(result, query = "") {
  if (!result) return -999;
  let score = 0;
  const kind = String(result.kind || "").toLowerCase();
  const text = normalizeText(result.text || "");
  const quoteScore = quotedPhraseMatchScore(query, [cleanSourceTitle(result), compactSourceTrail(result), result.text, result.url].filter(Boolean).join(" "));
  if (quoteScore) score += quoteScore;
  else if (extractSignificantQuotedPhrases(query).length) score -= 90;
  if (result.has_body || text.length > 220) score += 80;
  if (isBlackboardChromeResult(result)) score -= 260;
  if (isVisaQuery(query)) {
    if (isVisaResult(result)) score += 220;
    else if (isTaskDeadlineResult(result)) score -= 120;
  }
  if (isPackingQuery(query)) {
    if (isPackingResult(result)) score += 220;
    else if (isTaskDeadlineResult(result)) score -= 120;
  }
  if (/^(pdf|document|page|announcement|video_transcript)$/.test(kind)) score += 40;
  if (kind === "link") score -= 20;
  if (isUrlLikeTitle(result.title || result.base_title)) score -= 90;
  if (isUrlOnlyBlackboardShell(result)) score -= 160;
  if (isThinLinkShell(result)) score -= 120;
  if (isGenericCourseShellResult(result)) score -= 150;
  if (isVideoResultKind(kind) && !wantsVideoHeavySearch(query)) score -= 90;
  if (isTaskDeadlineQuery(query) && !isVisaQuery(query) && !isPackingQuery(query)) {
    if (isTaskDeadlineResult(result)) score += 170;
    if (isVideoResultKind(kind)) score -= 140;
  }
  return score;
}

function isBlackboardChromeResult(result) {
  const haystack = [result?.title, result?.base_title, result?.source, result?.text, result?.url].filter(Boolean).join(" ");
  return isBlackboardChromeText(haystack) && !hasSubstantiveSearchPayload(haystack);
}

function isBlackboardChromeText(value) {
  const text = normalizeText(value);
  if (!text) return false;
  const chromeSignals = [
    "open quick links",
    "page landmarks",
    "content outline",
    "keyboard shortcuts",
    "global menu",
    "my institution",
    "notifications dashboard",
    "activity updates",
    "top frame",
    "it service access",
    "logout"
  ];
  const hits = chromeSignals.filter((signal) => text.includes(signal)).length;
  return hits >= 3 || /\bopen quick links\b.*\bpage landmarks\b.*\bkeyboard shortcuts\b/.test(text);
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

function isGenericCourseShellResult(result) {
  const kind = String(result?.kind || "").toLowerCase();
  if (!/^(link|resource|page)$/.test(kind)) return false;
  if (result?.has_body) return false;
  const title = normalizeText(cleanSourceTitle(result || {}));
  const text = normalizeText(result?.text || "");
  const source = normalizeText(compactSourceTrail(result || {}));
  const haystack = `${title} ${source} ${text}`;
  if (!/\bclass of 20\d{2}\s+20\d{2}\s+pre program\b/.test(haystack) && !/\bblackboard learn\b/.test(haystack)) return false;
  if (hasSubstantiveSearchPayload(text)) return false;

  const courseOnlyTitle = /^class of 20\d{2}\s+20\d{2}\s+pre program$/.test(title);
  const repeatedCourseTrail = countOccurrences(haystack, "class of 20") >= 3;
  const repeatedSectionTrail = /\b(home|to do|resources|career development materials|language study|announcements)\b/.test(haystack) && repeatedCourseTrail;
  const words = text.split(" ").filter(Boolean);
  const uniqueRatio = words.length ? new Set(words).size / words.length : 1;
  return courseOnlyTitle || repeatedSectionTrail || (words.length >= 18 && uniqueRatio < 0.45 && !hasSubstantiveSearchPayload(haystack));
}

function hasSubstantiveSearchPayload(text) {
  return /\b(deadline|submit|review|fill out|mandatory|passport|visa|jw202|packing|pack|luggage|wechat|alipay|bank|health|insurance|key vocabulary|grammar|survival chinese|course calendar|course schedule|list of courses|academic calendar|webinar|presentation|slides|pdf|attached files|recommended|students who|developed|transcript|recording)\b/.test(
    normalizeText(text)
  );
}

function isUrlLikeTitle(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text) || /\b[a-z0-9.-]+\.(?:edu|com|cn|org)\/\S+/i.test(text);
}

function dedupeSourceCandidates(results, query = "") {
  const byKey = new Map();
  for (const result of results || []) {
    if (!result) continue;
    const key = sourceDedupeKey(result);
    const previous = byKey.get(key);
    if (!previous || sourceCandidatePreferenceScore(result, query) > sourceCandidatePreferenceScore(previous, query)) {
      byKey.set(key, result);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => {
    const scoreA = sourceCandidatePreferenceScore(a, query);
    const scoreB = sourceCandidatePreferenceScore(b, query);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return (b?.score || 0) - (a?.score || 0);
  });
}

function sourceCandidatePreferenceScore(result, query = "") {
  if (!result) return -9999;
  let score = (result.score || 0) + sourceQualityScore(result, query);
  const kind = String(result.kind || "").toLowerCase();
  if (result.has_body) score += 120;
  if (/^(pdf|document|slides|spreadsheet)$/.test(kind)) score += 35;
  if (kind === "link" && !result.has_body) score -= 55;
  if (sourceLooksLikeDocumentListing(result)) score -= 90;
  return score;
}

function sourceDedupeKey(result) {
  const documentKey = canonicalDocumentKey(result);
  if (documentKey) return documentKey;
  const url = normalizeSourceUrl(result.url || "");
  const title = normalizeText(cleanSourceTitle(result));
  const source = normalizeText(compactSourceTrail(result));
  const text = normalizeText(result.text || "").slice(0, 180);
  if (title && source) return `source:${title}|${source}`;
  if (title && text) return `title:${title}|${text}`;
  if (url) return `url:${url}|${title}`;
  return `text:${title}|${source}|${text}`;
}

function canonicalDocumentKey(result) {
  const titleName = canonicalDocumentNameFrom(cleanSourceTitle(result || {}));
  const urlName = canonicalDocumentNameFromUrl(result?.url || result?.document_url || "");
  const sourceName = canonicalDocumentNameFrom(compactSourceTrail(result || {}));
  const textName = canonicalDocumentNameFrom(result?.text || "");
  const name = titleName || urlName || sourceName || textName;
  if (name) return `doc:${name}`;

  const url = normalizeSourceUrl(result?.url || result?.document_url || "");
  if (url) return `docurl:${url}`;

  const fingerprint = canonicalContentFingerprint(result);
  return fingerprint ? `docfp:${fingerprint}` : "";
}

function canonicalDocumentNameFrom(value) {
  const decoded = safeDecodeURIComponent(String(value || ""));
  const cleaned = decoded
    .replace(/\s+\(part\s+\d+\)$/i, "")
    .replace(/[\\/]+/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = cleaned.match(/([A-Za-z0-9][^\\/:*?"<>|]{2,180}\.(?:pdf|docx?|pptx?|xlsx?|csv))(?:\b|$)/i);
  const candidate = match ? match[1] : cleaned;
  const normalized = normalizeText(candidate).replace(/\bpart\s+\d+\b/g, " ").replace(/\s+/g, " ").trim();
  return isCanonicalDocumentName(normalized) ? normalized : "";
}

function canonicalDocumentNameFromUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    const name = parsed.pathname.split("/").filter(Boolean).pop() || "";
    return canonicalDocumentNameFrom(name);
  } catch (_error) {
    return canonicalDocumentNameFrom(value);
  }
}

function isCanonicalDocumentName(value) {
  return /\b(?:pdf|docx?|pptx?|xlsx?|csv)$/.test(String(value || ""));
}

function canonicalContentFingerprint(result) {
  if (!result?.has_body) return "";
  const text = normalizeText(result.text || "");
  if (text.length < 120) return "";
  return text.slice(0, 220);
}

function sourceLooksLikeDocumentListing(result) {
  if (!result || result.has_body) return false;
  const haystack = [result.title, result.base_title, result.source, result.text].filter(Boolean).join(" ");
  const fileMentions = haystack.match(/\b[^\s]+\.(?:pdf|docx?|pptx?|xlsx?)\b/gi) || [];
  return fileMentions.length >= 3 && /\b(resources?|content|attached files?|blackboard|open source)\b/i.test(haystack);
}

function extractSignificantQuotedPhrases(value) {
  const text = String(value || "");
  const phrases = [];
  const patterns = [/["\u201c\u201d]([^"\u201c\u201d]{24,700})["\u201c\u201d]/g, /'([^'\n]{60,700})'/g];
  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match) {
      phrases.push(cleanQuotedPhrase(match[1]));
      match = pattern.exec(text);
    }
  }
  if (!phrases.length) {
    const foundMatch = text.match(/\bfound\s+(?:this|that)\s+(.{45,700})$/i);
    if (foundMatch) phrases.push(cleanQuotedPhrase(foundMatch[1]));
  }
  const seen = new Set();
  return phrases.filter((phrase) => {
    const normalized = normalizeText(phrase);
    const tokens = normalized.split(" ").filter((token) => token.length > 2 && !STOP_WORDS.has(token));
    if (tokens.length < 6 && normalized.length < 55) return false;
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function cleanQuotedPhrase(value) {
  return String(value || "")
    .replace(/^[\s>*_`~\-:]+|[\s>*_`~\-:.]+$/g, "")
    .replace(/\*{1,3}/g, " ")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function quotedPhraseMatchScore(queryOrPhrases, haystack) {
  const phrases = Array.isArray(queryOrPhrases) ? queryOrPhrases : extractSignificantQuotedPhrases(queryOrPhrases);
  if (!phrases.length) return 0;
  let score = 0;
  for (const phrase of phrases) {
    const ratio = quotedPhraseMatchRatio(phrase, haystack);
    if (ratio >= 0.92) score += 620;
    else if (ratio >= 0.78) score += 360;
  }
  return score;
}

function sourceContainsQuotedPhrase(source, queryOrPhrases) {
  const phrases = Array.isArray(queryOrPhrases) ? queryOrPhrases : extractSignificantQuotedPhrases(queryOrPhrases);
  return phrases.some((phrase) => quotedPhraseMatchRatio(phrase, [source?.title, source?.base_title, source?.source, source?.text, source?.url].filter(Boolean).join(" ")) >= 0.78);
}

function quotedPhraseMatchRatio(phrase, haystack) {
  const needle = normalizeText(cleanQuotedPhrase(phrase));
  const target = normalizeText(haystack || "");
  if (!needle || !target) return 0;
  if (target.includes(needle)) return 1;
  const tokens = needle.split(" ").filter((token) => token.length > 2 && !STOP_WORDS.has(token));
  if (!tokens.length) return 0;
  const hits = tokens.filter((token) => target.includes(token)).length;
  return hits / tokens.length;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch (_error) {
    return String(value || "");
  }
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

function resourceHasReadableBody(resource, storedContent) {
  const text = String(storedContent || "");
  if (isFileLikeSearchResource(resource)) return isReadableFileBodyText(resource, text);
  return normalizeText(text).length > 40;
}

function isFileLikeSearchResource(resource) {
  const type = String(resource?.type || "").toLowerCase();
  const hint = [resource?.type, resource?.title, resource?.url, resource?.document_url].filter(Boolean).join(" ");
  return ["pdf", "document", "slides", "spreadsheet"].includes(type) || /\.(pdf|docx|pptx|xlsx)(?:[?#]|$|\s)/i.test(hint);
}

function isReadableFileBodyText(resource, storedContent) {
  const text = String(storedContent || "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  const words = text.toLowerCase().match(/[a-z0-9']+/g) || [];
  if (words.length < 45) return false;
  if (isLikelyCrawlerFileContext(resource, text, words)) return false;
  if (/\bPage\s+\d+:/i.test(text) && words.length >= 45) return true;
  return words.length >= 110 || text.length >= 900;
}

function isLikelyCrawlerFileContext(resource, text, words = []) {
  const title = normalizeText(cleanSourceTitle(resource || {}));
  const sourceBits = normalizeText([resource?.section, resource?.page_title].filter(Boolean).join(" "));
  const normalized = normalizeText(text);
  if (!normalized) return false;
  const hasPdfPageMarker = /\bPage\s+\d+:/i.test(text);
  if (hasPdfPageMarker) return false;
  const mentionsTitle = title && normalized.includes(title);
  const mentionsSource = sourceBits && normalized.includes(sourceBits);
  const hasResourceListingSignals = /\b(resources?|content|attached files?|blackboard|class of|pre-program|click|open|pdf)\b/i.test(text);
  const hasDocumentDetailSignals = /\b(passport|jw202|admission notice|visa application|physical exam|medication|prescription|packing|pack|clothing|toiletries|adapter|cash|bank card|residence permit|registration|insurance|vaccination|luggage|documents to bring)\b/i.test(text);
  return Boolean((words.length < 110 && (mentionsTitle || mentionsSource || hasResourceListingSignals) && !hasDocumentDetailSignals) || (mentionsTitle && mentionsSource && words.length < 160));
}


function buildSearchDocs(query = "") {
  const docs = [];
  const resourceById = new Map(state.resources.map((resource) => [resource.id, resource]));
  const wantsVideo = wantsVideoHeavySearch(query);

  for (const resource of state.resources) {
    const storedContent = cleanIndexedText(state.contentStore?.[resource.id] || "");
    if (shouldSkipResourceSearchDoc(resource, storedContent, wantsVideo)) continue;
    const resourceTitle = cleanIndexedText(resource.title || "Untitled resource");
    const sourceTrail = [resource.section, resource.page_title].map(cleanIndexedText).filter(Boolean).join(" - ");
    const baseDoc = {
      resource_id: resource.id,
      kind: resource.type || "resource",
      title: resourceTitle || "Untitled resource",
      base_title: resourceTitle || "Untitled resource",
      source: sourceTrail,
      url: resource.url || resource.page_url || "",
      timestamp: "",
      has_body: resourceHasReadableBody(resource, storedContent)
    };
    const contentForSearch = baseDoc.has_body ? storedContent : "";
    const fallbackContext = isFileLikeSearchResource(resource) ? "" : cleanIndexedText(resource.context);
    const fullText = [resourceTitle, contentForSearch || fallbackContext, sourceTrail]
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
  if (!hasSubstantiveSearchPayload(storedContent || resource?.context || "") && isBlackboardChromeText([resource?.title, resource?.section, resource?.page_title, resource?.context, storedContent].filter(Boolean).join(" "))) return true;
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
  const raw = cleanIndexedText(result.source || result.url || "");
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
  let score = quotedPhraseMatchScore(query, [doc.title, doc.source, doc.text].filter(Boolean).join(" "));
  if (extractSignificantQuotedPhrases(query).length && score <= 0) score -= 60;
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
  if (isTaskDeadlineQuery(query)) {
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
  "do",
  "does",
  "have",
  "has",
  "any",
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
  for (const quote of extractSignificantQuotedPhrases(query)) phrases.push(quote);
  if (isTaskDeadlineQuery(query)) {
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
  const isTaskQuery = isTaskDeadlineQuery(query);
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
  const clean = cleanIndexedText(text).replace(/\s+/g, " ").trim();
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
  return decodeBasicHtmlEntities(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanIndexedText(value) {
  return decodeBasicHtmlEntities(value)
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/\bOpen Quick Links\b/gi, " ")
    .replace(/\bPage Landmarks\b/gi, " ")
    .replace(/\bContent Outline\b/gi, " ")
    .replace(/\bKeyboard Shortcuts\b/gi, " ")
    .replace(/\bGlobal Menu\b/gi, " ")
    .replace(/\bNotifications Dashboard\b/gi, " ")
    .replace(/\bActivity Updates\b/gi, " ")
    .replace(/\bTop Frame\b/gi, " ")
    .replace(/\bTabs My Institution\b/gi, " ")
    .replace(/\bIT Service Access\b/gi, " ")
    .replace(/\bLogout\b/gi, " ")
    .replace(/\bWelcome,?\s+Garrett\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeBasicHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;/gi, "-")
    .replace(/&mdash;/gi, "-")
    .replace(/&hellip;/gi, "...")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : " ";
    })
    .replace(/&#(\d+);/g, (_match, number) => {
      const codePoint = Number.parseInt(number, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : " ";
    });
}