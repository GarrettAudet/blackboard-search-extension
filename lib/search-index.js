// Local search index construction, scoring, source filtering, and result formatting helpers.
// Loaded before sidepanel.js.

let searchIndexCacheRevision = 0;
const searchDocCache = new Map();
let searchVideoSensitivityRevision = -1;
let searchHasVideoSensitiveResources = false;

function invalidateSearchIndexCache() {
  searchIndexCacheRevision += 1;
  searchDocCache.clear();
}

function searchResultTieKey(result) {
  if (result?.search_tie_key) return String(result.search_tie_key);
  return [
    searchEvidenceScopeKey(result),
    result?.source_pack_id,
    result?.source_pack_document_id,
    result?.resource_id,
    result?.kind,
    result?.base_title || result?.title,
    result?.source,
    String(Number.isInteger(Number(result?.search_part_index)) ? Number(result.search_part_index) : -1).padStart(6, "0"),
    normalizeText(result?.text || "").slice(0, 360)
  ].map((value) => String(value || "")).join("\u001f");
}

function compareSearchResultIdentity(a, b) {
  const keyA = searchResultTieKey(a);
  const keyB = searchResultTieKey(b);
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

function compareSearchResultsByScore(a, b) {
  const scoreDifference = (Number(b?.score) || 0) - (Number(a?.score) || 0);
  return scoreDifference || compareSearchResultIdentity(a, b);
}

const SEARCH_SOURCE_CLASS_VALUES = new Set(["official_blackboard", "curated_pack", "user_import"]);

function validSearchSourceClass(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return SEARCH_SOURCE_CLASS_VALUES.has(normalized) ? normalized : "";
}

function isStructuralUserImport(resource) {
  const collectionKind = String(resource?.collection_kind || resource?.collectionKind || "").trim().toLowerCase();
  const contentOrigin = String(resource?.content_origin || resource?.contentOrigin || "").trim().toLowerCase();
  return collectionKind === "user_import" || contentOrigin === "user_import";
}

function searchResourceSourceClass(resource, managedBlackboardDefault = false) {
  // Structural ownership wins over cached or caller-supplied labels.
  if (resource?.source_pack_id) return "curated_pack";
  if (isStructuralUserImport(resource)) return "user_import";

  const isManagedBlackboard = managedBlackboardDefault || resource?.search_managed_blackboard_record === true;
  const candidates = [
    resource?.search_identity?.source_class,
    resource?.search_source_class,
    resource?.source_class,
    resource?.sourceClass,
    resource?.corpus_source_class,
    resource?.corpusSourceClass
  ];
  for (const candidate of candidates) {
    const sourceClass = validSearchSourceClass(candidate);
    if (!sourceClass) continue;
    if (sourceClass === "official_blackboard" && !isManagedBlackboard) continue;
    return sourceClass;
  }

  // Only records built from the managed Blackboard resource collection default official.
  return isManagedBlackboard ? "official_blackboard" : "user_import";
}

function searchResourceTrustIdentity(resource) {
  if (resource?.search_identity?.trust_identity !== undefined) return String(resource.search_identity.trust_identity || "");
  if (resource?.search_trust_identity !== undefined) return String(resource.search_trust_identity || "");
  return normalizeText(
    resource?.source_trust ||
    resource?.sourceTrust ||
    resource?.trust_tier ||
    resource?.trustTier ||
    resource?.authority_tier ||
    resource?.authorityTier ||
    resource?.trust ||
    resource?.authority ||
    ""
  ).slice(0, 100);
}

function searchResourceProvenanceIdentity(resource) {
  if (resource?.search_identity?.provenance_identity !== undefined) return String(resource.search_identity.provenance_identity || "");
  if (resource?.search_provenance_identity !== undefined) return String(resource.search_provenance_identity || "");
  return normalizeText(
    resource?.source_provenance ||
    resource?.sourceProvenance ||
    resource?.source_pack_provenance ||
    resource?.content_origin ||
    resource?.indexed_body_source ||
    resource?.provenance ||
    ""
  ).slice(0, 160);
}

const VALIDATED_AUTHORITY_TRUST_VALUES = new Set([
  "authoritative",
  "verified_authoritative",
  "official_policy",
  "primary_official"
]);

function searchResourceHasAllowlistedAuthorityTrust(resource) {
  const trust = searchResourceTrustIdentity(resource).replace(/[\s-]+/g, "_");
  return VALIDATED_AUTHORITY_TRUST_VALUES.has(trust);
}

function searchResourceHasValidatedAuthority(resource) {
  if (resource?.search_identity?.authority_validated !== undefined) {
    return resource.search_identity.authority_validated === true;
  }
  if (searchResourceSourceClass(resource) !== "official_blackboard") return false;
  if (
    resource?.authority_verified === true ||
    resource?.source_authority_verified === true
  ) {
    return true;
  }
  return searchResourceHasAllowlistedAuthorityTrust(resource);
}

function searchBodyEvidenceState(resource) {
  if (resource?.search_identity?.body_evidence_state) return String(resource.search_identity.body_evidence_state);
  if (resource?.search_body_evidence_state) return String(resource.search_body_evidence_state);
  const indexedBodySource = String(resource?.indexed_body_source || "").toLowerCase();
  if (resource?.body_verified === true && indexedBodySource === "extracted") return "verified_extracted";
  if (
    resource?.body_verified !== true &&
    indexedBodySource === "last_known_extracted" &&
    resource?.body_revalidation_required === true
  ) {
    return "stale_last_known_extracted";
  }
  if (indexedBodySource === "pending_extraction") return "pending_extraction";
  if (resource?.body_verified === true) return "verified_other";
  return "unverified";
}

function isStaleLastKnownExtractedBody(resource) {
  return searchBodyEvidenceState(resource) === "stale_last_known_extracted";
}

function searchCanonicalParentIdentity(resource) {
  if (resource?.search_identity?.canonical_parent_identity) return String(resource.search_identity.canonical_parent_identity);
  if (resource?.search_canonical_parent_identity) return String(resource.search_canonical_parent_identity);
  if (resource?.source_pack_id) {
    const packParent = resource?.source_pack_document_id || resource?.pack_document_id || resource?.document_id || resource?.resource_id || resource?.id;
    return `pack:${String(resource.source_pack_id)}:${String(packParent || "unknown")}`;
  }
  const explicit =
    resource?.canonical_parent_id ||
    resource?.canonicalParentId ||
    resource?.parent_document_id ||
    resource?.parentDocumentId ||
    resource?.document_id ||
    resource?.documentId ||
    resource?.parent_id ||
    resource?.parentId;
  if (explicit) return `parent:${String(explicit)}`;
  return "";
}

function searchEvidenceScopeKey(resource) {
  if (resource?.search_identity?.evidence_scope_key) return String(resource.search_identity.evidence_scope_key);
  if (resource?.search_evidence_scope_key) return String(resource.search_evidence_scope_key);
  if (resource?.search_evidence_scope) return String(resource.search_evidence_scope);
  return [
    searchResourceSourceClass(resource),
    searchResourceTrustIdentity(resource) || "unspecified-trust",
    searchResourceProvenanceIdentity(resource) || "unspecified-provenance",
    searchBodyEvidenceState(resource),
    searchCanonicalParentIdentity(resource) || "implicit-parent"
  ].join("|");
}

function searchPostingGroupKey(doc) {
  return [
    doc?.kind,
    doc?.search_title,
    doc?.search_source,
    doc?.search_text
  ].map((value) => String(value || "")).join("\u001f");
}

function searchLogicalParentIdentity(resource) {
  if (resource?.source_pack_id) {
    const documentId = resource?.source_pack_document_id || resource?.resource_id || resource?.id || "unknown";
    return `pack-document:${String(resource.source_pack_id)}:${String(documentId)}`;
  }
  const explicit =
    resource?.canonical_parent_id ||
    resource?.canonicalParentId ||
    resource?.parent_document_id ||
    resource?.parentDocumentId ||
    resource?.document_id ||
    resource?.documentId ||
    resource?.parent_id ||
    resource?.parentId;
  return explicit ? `parent:${String(explicit)}` : "";
}

function selectSearchPostingRepresentatives(docs, group, limit = 3) {
  const cap = Math.max(1, Math.floor(Number(limit) || 3));
  const evidencePriority = new Map([
    ["verified_extracted", 0],
    ["verified_other", 1],
    ["stale_last_known_extracted", 2],
    ["unverified", 3],
    ["pending_extraction", 4]
  ]);
  const ranked = [...(group || [])].sort((a, b) => {
    const priorityA = evidencePriority.get(searchBodyEvidenceState(docs[a])) ?? 5;
    const priorityB = evidencePriority.get(searchBodyEvidenceState(docs[b])) ?? 5;
    return priorityA - priorityB || compareSearchResultIdentity(docs[a], docs[b]);
  });
  const selected = [];
  const selectedIndices = new Set();
  const add = (index) => {
    if (selected.length >= cap || selectedIndices.has(index)) return;
    selectedIndices.add(index);
    selected.push(index);
  };

  // Reserve at most one representative per structural class first.
  for (const sourceClass of ["official_blackboard", "curated_pack", "user_import"]) {
    const representative = ranked.find((index) => searchResourceSourceClass(docs[index]) === sourceClass);
    if (representative !== undefined) add(representative);
  }
  const logicalParents = new Set(
    selected.map((index) => searchLogicalParentIdentity(docs[index])).filter(Boolean)
  );
  const parentSelectionLimit = selected.length === 1 ? Math.min(cap, 2) : cap;
  // Then spend only the remaining bounded slots on distinct logical parents.
  for (const index of ranked) {
    if (selected.length >= parentSelectionLimit) break;
    const logicalParent = searchLogicalParentIdentity(docs[index]);
    if (!logicalParent || logicalParents.has(logicalParent)) continue;
    logicalParents.add(logicalParent);
    add(index);
  }
  return selected;
}
function searchIndex(query, limit = 10) {
  const queryProfile = searchQueryProfile(query);
  const corpus = cachedSearchCorpus(query);
  const scoredGroups = [];
  for (const lead of candidateSearchDocs(query, queryProfile)) {
    const groupId = Number.isInteger(lead?.search_posting_group_id) ? lead.search_posting_group_id : -1;
    const score = scoreDoc(query, lead, queryProfile);
    if (score > 0) scoredGroups.push({ lead, groupId, score });
  }
  scoredGroups.sort((a, b) => b.score - a.score || compareSearchResultIdentity(a.lead, b.lead));

  // Only groups capable of reaching a bounded result need materialized parent/
  // class representatives. Preserve the best group containing each class so
  // source coverage remains available without scoring duplicate text twice.
  const expansionCount = Math.min(scoredGroups.length, Math.max(64, Math.max(1, Number(limit) || 10) * 6));
  const groupsToExpand = new Set(scoredGroups.slice(0, expansionCount).map((item) => item.groupId));
  const coveredClasses = new Set();
  for (const item of scoredGroups) {
    const memberIndices = item.groupId >= 0 ? corpus.posting_groups[item.groupId] : null;
    for (const index of memberIndices || []) {
      const sourceClass = searchResourceSourceClass(corpus.docs[index]);
      if (coveredClasses.has(sourceClass)) continue;
      coveredClasses.add(sourceClass);
      groupsToExpand.add(item.groupId);
    }
    if (coveredClasses.size >= SEARCH_SOURCE_CLASS_VALUES.size) break;
  }

  const scoreByGroupState = new Map();
  const scored = [];
  for (const item of scoredGroups) {
    if (!groupsToExpand.has(item.groupId)) continue;
    const memberIndices = item.groupId >= 0 ? corpus.posting_groups[item.groupId] : null;
    const members = Array.isArray(memberIndices) && memberIndices.length
      ? memberIndices.map((index) => corpus.docs[index]).filter(Boolean)
      : [item.lead];
    for (const doc of members) {
      const scoreGroupKey = `${item.groupId}|${searchBodyEvidenceState(doc)}`;
      let score = scoreByGroupState.get(scoreGroupKey);
      if (score === undefined) {
        score = doc === item.lead ? item.score : scoreDoc(query, doc, queryProfile);
        scoreByGroupState.set(scoreGroupKey, score);
      }
      if (score > 0) scored.push({ ...doc, score });
    }
  }
  scored.sort(compareSearchResultsByScore);
  return diversifySearchResults(scored, query, limit).slice(0, limit);
}

function candidateSearchDocs(query, queryProfile) {
  const corpus = cachedSearchCorpus(query);
  const postingLists = Array.from(queryProfile.singleTokenSet || [])
    .map((token) => searchPostingList(corpus, token))
    .filter((items) => Array.isArray(items) && items.length)
    .sort((a, b) => a.length - b.length);
  if (!postingLists.length) return (corpus.posting_group_lead_indices || []).map((index) => corpus.docs[index]).filter(Boolean);

  const selected = new Set();
  const maximumUsefulPosting = Math.max(60, Math.floor(corpus.docs.length * 0.55));
  for (const posting of postingLists) {
    if (posting.length > maximumUsefulPosting && selected.size >= 10) continue;
    for (const index of posting) selected.add(index);
  }
  if (!selected.size) return (corpus.posting_group_lead_indices || []).map((index) => corpus.docs[index]).filter(Boolean);
  return Array.from(selected, (index) => corpus.docs[index]).filter(Boolean);
}

function searchPostingList(corpus, token) {
  if (corpus.postings.has(token)) return corpus.postings.get(token);
  const posting = [];
  const groups = corpus.posting_groups || corpus.docs.map((_doc, index) => [index]);
  for (const indices of groups) {
    const doc = corpus.docs[indices[0]];
    if (
      containsNormalizedToken(doc.search_title, token) ||
      containsNormalizedToken(doc.search_source, token) ||
      containsNormalizedToken(doc.search_text, token)
    ) {
      posting.push(indices[0]);
    }
  }
  corpus.postings.set(token, posting);
  return posting;
}

function containsNormalizedToken(text, token) {
  if (!text || !token) return false;
  let index = text.indexOf(token);
  while (index >= 0) {
    const end = index + token.length;
    const startsAtBoundary = index === 0 || text.charCodeAt(index - 1) === 32;
    const endsAtBoundary = end === text.length || text.charCodeAt(end) === 32;
    if (startsAtBoundary && endsAtBoundary) return true;
    index = text.indexOf(token, index + 1);
  }
  return false;
}

function cachedSearchCorpus(query) {
  const mode = searchCorpusCacheMode(query);
  const cached = searchDocCache.get(mode);
  if (cached?.revision === searchIndexCacheRevision) return cached;

  const normalizedCache = new Map();
  const normalizeCached = (value) => {
    const key = String(value || "");
    if (!normalizedCache.has(key)) normalizedCache.set(key, normalizeText(key));
    return normalizedCache.get(key);
  };
  const docs = buildSearchDocs(query).map((doc) => {
    const indexed = {
      ...doc,
      search_title: normalizeCached(doc.title),
      search_text: normalizeCached(doc.text),
      search_source: normalizeCached(doc.source)
    };
    const sourceClass = searchResourceSourceClass(indexed);
    const trustIdentity = searchResourceTrustIdentity(indexed);
    const provenanceIdentity = searchResourceProvenanceIdentity(indexed);
    const canonicalParentIdentity = searchCanonicalParentIdentity(indexed);
    const bodyEvidenceState = searchBodyEvidenceState(indexed);
    const authorityValidated = searchResourceHasValidatedAuthority(indexed);
    indexed.search_identity = { source_class: sourceClass, trust_identity: trustIdentity, provenance_identity: provenanceIdentity, authority_validated: authorityValidated, body_evidence_state: bodyEvidenceState, canonical_parent_identity: canonicalParentIdentity };
    indexed.search_identity.evidence_scope_key = searchEvidenceScopeKey(indexed);
    indexed.search_identity.canonical_document_key = canonicalDocumentKey(indexed);
    indexed.search_identity.source_dedupe_key = sourceDedupeKey(indexed);
    indexed.search_tie_key = searchResultTieKey(indexed);
    return indexed;
  });
  const groupsBySignature = new Map();
  docs.forEach((doc, index) => {
    const signature = searchPostingGroupKey(doc);
    if (!groupsBySignature.has(signature)) groupsBySignature.set(signature, []);
    groupsBySignature.get(signature).push(index);
  });
  const postingGroups = Array.from(groupsBySignature.values()).map((group) =>
    selectSearchPostingRepresentatives(docs, group)
  );
  postingGroups.forEach((group, groupId) => {
    for (const index of group) docs[index].search_posting_group_id = groupId;
  });
  const corpus = {
    revision: searchIndexCacheRevision,
    docs,
    postings: new Map(),
    posting_groups: postingGroups,
    posting_group_lead_indices: postingGroups.map((group) => group[0]).filter((index) => Number.isInteger(index))
  };
  searchDocCache.set(mode, corpus);
  return corpus;
}
function searchCorpusCacheMode(query) {
  if (!wantsVideoHeavySearch(query)) return "standard";
  if (searchVideoSensitivityRevision !== searchIndexCacheRevision) {
    searchHasVideoSensitiveResources = (state.resources || []).some((resource) =>
      /^(?:audio|video|video_embed)$/.test(String(resource?.type || "").toLowerCase())
    );
    searchVideoSensitivityRevision = searchIndexCacheRevision;
  }
  return searchHasVideoSensitiveResources ? "video" : "standard";
}


function searchQueryProfile(query) {
  const normalized = normalizeText(query);
  const genericTerms = new Set([
    "also", "besides", "book", "can", "choose", "describe", "detail", "details", "explain", "including", "many",
    "own", "process", "procedure", "should", "state", "student", "summarize", "summary", "use", "used", "using"
  ]);
  const baseTokens = Array.from(
    new Set(
      normalized
        .split(" ")
        .filter((token) => token.length > 1 && !STOP_WORDS.has(token) && !genericTerms.has(token))
    )
  );
  const tokens = expandedTokens(query);
  return {
    tokens,
    singleTokenSet: new Set(tokens.filter((token) => !token.includes(" "))),
    baseTokens,
    phrases: expandedPhrases(query),
    quotedPhrases: extractSignificantQuotedPhrases(query),
    normalized
  };
}

function queryCoverageBoost(profile, title, text, source) {
  const terms = profile?.baseTokens || [];
  if (!terms.length) return 0;
  const titleAndText = title + " " + text;
  const fullText = titleAndText + " " + source;
  const presentTerms = terms.filter((term) => searchTermPosition(fullText, term) >= 0);
  const coverage = presentTerms.length / terms.length;
  let boost = Math.round(coverage * 90);
  if (coverage === 1) boost += 35;

  const numericTerms = terms.filter((term) => /^\d+$/.test(term));
  if (numericTerms.length && numericTerms.every((term) => searchTermPosition(titleAndText, term) >= 0)) boost += 30;

  const positions = terms.map((term) => searchTermPosition(text, term));
  if (positions.every((position) => position >= 0)) {
    const span = Math.max(...positions) - Math.min(...positions);
    if (span <= 220) boost += 70;
    else if (span <= 600) boost += 40;
  }

  const orderedTerms = profile.normalized
    .split(" ")
    .filter((term) => terms.includes(term));
  let bigramBoost = 0;
  for (let index = 0; index < orderedTerms.length - 1; index += 1) {
    const phrase = orderedTerms[index] + " " + orderedTerms[index + 1];
    if (titleAndText.includes(phrase)) bigramBoost += 18;
  }
  return boost + Math.min(72, bigramBoost);
}

function searchTermPosition(haystack, term) {
  const text = String(haystack || "");
  const value = String(term || "");
  const direct = text.indexOf(value);
  if (direct >= 0) return direct;
  const stem = value.length > 4 ? value.replace(/(?:ing|ed|es|s)$/, "") : value;
  return stem.length >= 4 ? text.indexOf(stem) : -1;
}

function diversifySearchResults(scored, query, limit = 10) {
  const wantsVideo = wantsVideoHeavySearch(query);
  const videoLimit = wantsVideo ? 6 : 1;
  const perDocumentLimit = 3;
  const selected = [];
  const deferred = [];
  const documentCounts = new Map();
  const resourceCounts = new Map();
  let videoCount = 0;

  for (const doc of scored) {
    const documentKey = canonicalDocumentKey(doc) || sourceDedupeKey(doc);
    const documentCount = documentCounts.get(documentKey) || 0;
    const resourceKey = doc.resource_id || documentKey;
    const resourceCount = resourceCounts.get(resourceKey) || 0;
    const perResourceLimit = perDocumentLimit;
    const exceedsVideoLimit = isVideoResultKind(doc.kind) && videoCount >= videoLimit;
    const exceedsDocumentLimit = documentCount >= perDocumentLimit;
    const exceedsResourceLimit = resourceCount >= perResourceLimit;
    if (exceedsVideoLimit || exceedsDocumentLimit || exceedsResourceLimit) {
      deferred.push(doc);
      continue;
    }

    selected.push(doc);
    documentCounts.set(documentKey, documentCount + 1);
    resourceCounts.set(resourceKey, resourceCount + 1);
    if (isVideoResultKind(doc.kind)) videoCount += 1;
    if (selected.length >= limit) break;
  }

  for (const doc of deferred) {
    if (selected.length >= limit) break;
    selected.push(doc);
  }
  return ensureSearchSourceClassCoverage(selected, scored, query, limit);
}

function searchSourceIntent(query) {
  const normalized = normalizeText(query);
  const requested = new Set();
  if (/\b(?:official|blackboard(?:\s+(?:source|record|resource|document|guidance))?|university\s+(?:source|record|resource|document|guidance))s?\b/.test(normalized)) {
    requested.add("official_blackboard");
  }
  if (/\b(?:c11|schwarzman\s+c11|curated\s+(?:pack|resource)|resource\s+pack|student\s+survival\s+guide)\b/.test(normalized)) {
    requested.add("curated_pack");
  }
  if (/\b(?:my|local|uploaded|imported|user[ -]?imported?)\s+(?:file|files|document|documents|resource|resources|source|sources)\b/.test(normalized)) {
    requested.add("user_import");
  }
  return { explicit: requested.size > 0, requested, crossSource: requested.size > 1 };
}

function coverageReplacementIsSafe(candidate, replaced, selected, replacementIndex, explicitIntent = false) {
  if (!candidate || !replaced) return false;
  const replacedParent = searchLogicalParentIdentity(replaced) || canonicalDocumentKey(replaced);
  const duplicateParentRemains = selected.some((item, index) =>
    index !== replacementIndex &&
    (searchLogicalParentIdentity(item) || canonicalDocumentKey(item)) === replacedParent
  );
  if (duplicateParentRemains) return true;
  const candidateScore = Number(candidate.score) || 0;
  const replacedScore = Number(replaced.score) || 0;
  return candidateScore >= replacedScore * (explicitIntent ? 0.72 : 0.9);
}

function ensureSearchSourceClassCoverage(selectedResults, scoredResults, query, limit = 10) {
  const targetLimit = Math.max(0, Number(limit) || 0);
  const selected = [...(selectedResults || [])].slice(0, targetLimit);
  if (targetLimit < 2 || !selected.length) return selected;

  const topScore = Number(scoredResults?.[0]?.score) || 0;
  const bestByClass = new Map();
  const coverageProfile = searchQueryProfile(query);
  const sourceIntent = searchSourceIntent(query);
  for (const candidate of scoredResults || []) {
    const sourceClass = searchResourceSourceClass(candidate);
    if (
      sourceClass === "official_blackboard" &&
      sourceIntent.explicit && sourceIntent.requested.has("official_blackboard") &&
      !searchResourceHasValidatedAuthority(candidate)
    ) continue;
    if (bestByClass.has(sourceClass)) continue;
    bestByClass.set(sourceClass, candidate);
  }

  const priorityClasses = ["official_blackboard", "curated_pack", "user_import"].filter((sourceClass) =>
    !sourceIntent.explicit || sourceIntent.requested.has(sourceClass)
  );
  for (const sourceClass of priorityClasses) {
    const candidate = bestByClass.get(sourceClass);
    if (!isSourceClassCoverageCandidate(candidate, coverageProfile, topScore, sourceIntent.explicit ? 0.5 : 0.72)) continue;
    if (!candidate || selected.some((item) => searchResultTieKey(item) === searchResultTieKey(candidate))) continue;
    if (selected.some((item) => searchResourceSourceClass(item) === sourceClass)) continue;

    if (selected.length < targetLimit) {
      selected.push(candidate);
      continue;
    }

    const classCounts = new Map();
    for (const item of selected) {
      const itemClass = searchResourceSourceClass(item);
      classCounts.set(itemClass, (classCounts.get(itemClass) || 0) + 1);
    }
    let replacementIndex = -1;
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      const itemClass = searchResourceSourceClass(selected[index]);
      const isUnrequested = sourceIntent.explicit && !sourceIntent.requested.has(itemClass);
      const isDuplicateClass = (classCounts.get(itemClass) || 0) > 1;
      if (!isUnrequested && !isDuplicateClass) continue;
      if (!coverageReplacementIsSafe(candidate, selected[index], selected, index, sourceIntent.explicit)) continue;
      replacementIndex = index;
      break;
    }
    if (replacementIndex >= 0) selected[replacementIndex] = candidate;
  }

  return selected.sort(compareSearchResultsByScore).slice(0, targetLimit);
}

function isSourceClassCoverageCandidate(candidate, profile, topScore = 0, competitiveRatio = 0.72) {
  if (!candidate || (Number(candidate.score) || 0) <= 0 || isLowValueSearchResult(candidate)) return false;
  const terms = profile.baseTokens || [];
  const haystack = [candidate.search_title, candidate.search_source, candidate.search_text]
    .filter(Boolean)
    .join(" ");
  const hitCount = terms.filter((term) => searchTermPosition(haystack, term) >= 0).length;
  const minimumHits = terms.length <= 2 ? 1 : Math.max(2, Math.ceil(terms.length * 0.4));
  if (terms.length && hitCount < minimumHits) return false;
  const minimumScore = Math.max(18, (Number(topScore) || 0) * competitiveRatio);
  return (Number(candidate.score) || 0) >= minimumScore;
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
    const rawDifference = (b?.score || 0) - (a?.score || 0);
    return rawDifference || compareSearchResultIdentity(a, b);
  });
}
function enhanceRetrievalQueryForIntent(query, retrievalQuery = query, plan = null) {
  const pieces = [retrievalQuery, query];
  const intent = normalizeText(plan?.intent || "").replace(/\s+/g, "_");
  if (isVisaQuery(query)) {
    pieces.push("X1 student visa visa FAQ passport JW202 JW201 admission notice embassy consulate visa application physical exam residence permit within 30 days after entering China immigration documents");
  }
  if (isPackingQuery(query)) {
    pieces.push("Packing List for Students 2026 pack bring China luggage medication prescription doctor letter adapters chargers clothing toiletries passport documents cash bank cards");
    if (/\b(bag|bags|baggage|checked|check\s+in|allowance|inbound\s+flight)\b/.test(normalizeText(query))) {
      pieces.push("inbound flight one checked bag 23 kilograms baggage allowance carry-on");
    }
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
  if (isBroadBeijingLifeQuery(query)) {
    pieces.push(
      "Beijing daily life practical tips WeChat payments restaurant ordering Alipay Didi Amap subway rush hour transportation food delivery weather dry summer winter heating layers English communication translation toilet paper VPN emergency hospital"
    );
  }
  if (isBroadBeijingTransportationQuery(query)) {
    pieces.push(
      "Beijing Transportation Workshop ways to get around subway metro ride hailing Didi taxi Amap Alipay transportation QR code transit card shared bike last mile bus"
    );
  }
  if (isProgramTravelQuery(query) && !isBroadBeijingTransportationQuery(query)) {
    pieces.push(
      "Schwarzman program travel arrival inbound flight Chase Travel travel policy baggage 23 kilograms August 21 Beijing transportation subway metro Didi ride hailing shared bike bus intercity high speed train 12306 Ctrip Trip.com"
    );
  }
  return Array.from(new Set(pieces.map((value) => String(value || "").trim()).filter(Boolean))).join(" ").slice(0, 1400);
}

function isBroadBeijingLifeQuery(query) {
  const normalized = normalizeText(query);
  return (
    /\bbeijing\b/.test(normalized) &&
    /\b(?:tips?|advice|living|life|daily|everyday|settling|survival|prepare)\b/.test(normalized) &&
    !isVisaQuery(query) &&
    !isTaskDeadlineQuery(query)
  );
}

function isBroadBeijingTransportationQuery(query) {
  const normalized = normalizeText(query);
  return (
    /\bbeijing\b/.test(normalized) &&
    (
      /\b(?:travel|transport|transportation|transit|commute|commuting)\b/.test(normalized) ||
      /\b(?:get|getting|move|moving)\s+around\b/.test(normalized) ||
      /\bnavigat(?:e|ing|ion)\b/.test(normalized)
    )
  );
}

function isProgramTravelQuery(query) {
  const normalized = normalizeText(query);
  if (!normalized || isVisaQuery(query) || isPackingQuery(query)) return false;
  const hasTravelTopic =
    /\b(?:travel|transport|transportation|transit|commute|commuting)\b/.test(normalized) ||
    /\b(?:get|getting|move|moving)\s+around\b/.test(normalized) ||
    /\bnavigat(?:e|ing|ion)\b.{0,32}\b(?:travel|transport|program|beijing|china|campus)\b/.test(normalized);
  const hasProgramContext =
    /\b(?:program|schwarzman|beijing|china|campus|college|arrival|arrive|deep dive)\b/.test(normalized);
  const asksForGuidance =
    /\b(?:advice|recommendations?|tips?|how|should|navigate|what to know|ways?)\b/.test(normalized);
  return hasTravelTopic && hasProgramContext && asksForGuidance;
}

function isTaskDeadlineQuery(query) {
  const normalized = normalizeText(query);
  if (!normalized) return false;
  const isDomainGuidance = isVisaQuery(query) || isPackingQuery(query);
  const genericNeedToDo = /\bwhat\s+(?:do\s+(?:i|we)\s+(?:need\s+)?to\s+do|should\s+(?:i|we)\s+do|must\s+(?:i|we)\s+do)\b/.test(normalized);
  const todoPhraseSignal = !genericNeedToDo && /\bto\s+do(?:\s+s)?\b|\bto\s+dos?\b|\btodos?\b/.test(normalized);
  const dueSignal = /\b(?:due|due\s+dates?|deadlines?|cutoffs?|overdue)\b/.test(normalized);
  const dueStatusSignal = /\b(?:anything|nothing|none|zero)\s+(?:is\s+)?due\b|\bdue\s+status\b/.test(normalized);
  const taskItemSignal = /\b(?:tasks?|action\s+items?|assignments?|surveys?|forms?|submissions?|applications?|quizzes?|exams?|requirements?|obligations?|items?)\b/.test(normalized);
  const statusSignal = /\b(?:current|today|today s|tomorrow|upcoming|future|remaining|pending|overdue|complete|completed|incomplete|mandatory|required|optional)\b/.test(normalized);
  const obligationSignal = /\b(?:must|need\s+to|have\s+to|required|mandatory|optional|complete|submit|finish|review|fill\s+out)\b/.test(normalized);
  const obligationStateSignal = /\b(?:required|mandatory|optional|complete|submit|finish|review|fill\s+out)\b/.test(normalized);
  const temporalSignal = /\b(?:today|today s|tomorrow|this\s+week|next\s+week|before|after|by|when|current|upcoming|future|remaining|pending|due|deadline|cutoff)\b/.test(normalized);
  const blackboardTaskContext = /\b(?:blackboard|course|class|module|announcement|assignments?|surveys?|submissions?|quizzes?|exams?|tasks?)\b/.test(normalized);

  if (isDomainGuidance && !todoPhraseSignal && !blackboardTaskContext) return false;
  if (todoPhraseSignal || dueStatusSignal) return true;
  if (dueSignal && (taskItemSignal || obligationSignal || blackboardTaskContext)) return true;
  if (taskItemSignal && statusSignal) return true;
  if (taskItemSignal && obligationSignal && (temporalSignal || obligationStateSignal)) return true;
  return genericNeedToDo && (taskItemSignal || blackboardTaskContext);
}
function isVisaQuery(query) {
  const normalized = normalizeText(query);
  return /\b(x1|visa|jw202|jw201|residence\s+permit|permit|passport|embassy|consulate|admission\s+notice|immigration)\b/.test(normalized);
}

function isPackingQuery(query) {
  const normalized = normalizeText(query);
  if (!normalized) return false;
  if (/\b(pack|packing|luggage|baggage|suitcase|checked\s+bags?|carry\s+on|toiletries|adapters?|clothing|departure\s+checklist|arrival\s+items?)\b/.test(normalized)) {
    return true;
  }
  const hasMedication = /\b(medicine|medication|prescription)\b/.test(normalized);
  const hasPackingContext = /\b(bring|carry|travel|flight|depart|departure|suitcase|china)\b/.test(normalized);
  return hasMedication && hasPackingContext;
}

function prioritizeDomainResults(results, predicate) {
  const domainResults = (results || []).filter(predicate);
  if (!domainResults.length) return results || [];
  const prioritized = new Set(domainResults);
  return [...domainResults, ...(results || []).filter((result) => !prioritized.has(result))];
}

function isVisaResult(result) {
  const title = normalizeText(cleanSourceTitle(result));
  if (/\bpacking\s+list\b/.test(title) && !/\bvisa\b/.test(title)) return false;
  const haystack = normalizeText(
    [title, compactSourceTrail(result), result?.text, result?.url].filter(Boolean).join(" ")
  );
  return /\b(x1\s+student\s+visa|obtaining\s+your\s+x1|visa\s+faq|jw202|jw201|admission\s+notice|embassy|consulate|visa\s+application|residence\s+permit|passport)\b/.test(haystack);
}

function isPackingResult(result) {
  const haystack = normalizeText(
    [cleanSourceTitle(result), compactSourceTrail(result), result?.text, result?.url].filter(Boolean).join(" ")
  );
  return /\b(packing\s+list|pack\s+for|what\s+to\s+pack|luggage|baggage|checked\s+bags?|carry[ -]?on|prescription\s+medication|doctor\s+letter|toiletries|adapters?|bring\s+passport|clothing\s+layers)\b/.test(haystack);
}

function prioritizeTaskDeadlineResults(results) {
  const taskResults = (results || []).filter(isTaskDeadlineResult);
  if (!taskResults.length) return results || [];
  const prioritized = new Set(taskResults);
  return [...taskResults, ...(results || []).filter((result) => !prioritized.has(result))];
}

function isTaskDeadlineResult(result) {
  if (isBlackboardConfigurationResult(result)) return false;
  if (isExplicitEmptyToDoResult(result)) return true;
  const metadata = normalizeText(
    [cleanSourceTitle(result), compactSourceTrail(result), result?.url].filter(Boolean).join(" ")
  );
  const haystack = normalizeText([metadata, result?.text].filter(Boolean).join(" "));
  if (!haystack) return false;
  if (/\b(actions all items|nothing due today|select date go today|last updated)\b/.test(haystack)) return false;
  const isToDoPage = /\b(?:to do|todo)\b/.test(metadata);
  const hasConcreteAction = /\b(review|read|fill out|complete|submit|register|upload|apply|mandatory|required|students who|survey|application|deadline)\b/.test(
    haystack
  );
  const hasTaskTiming = hasTaskTemporalSignal(haystack);
  return (isToDoPage && hasConcreteAction) || (hasTaskTiming && hasConcreteAction);
}

function hasTaskTemporalSignal(value) {
  const text = normalizeText(value);
  return (
    /\bdeadline\b/.test(text) ||
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}(?:\s+\d{4})?\b/.test(text) ||
    /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/.test(text) ||
    /\b\d{1,2}:\d{2}\b/.test(text)
  );
}

function isExplicitEmptyToDoResult(result, textOverride = "") {
  const metadata = normalizeText(
    [result?.title, result?.base_title, result?.page_title, result?.source, result?.section].filter(Boolean).join(" ")
  );
  const text = normalizeText(textOverride || result?.text || result?.context || "");
  const identityText = `${metadata} ${text.slice(0, 1000)}`;
  const hasToDoIdentity =
    /\b(?:to do|todo)\b/.test(metadata) ||
    /^(?:to do|todo)\b/.test(text) ||
    /\bcurrent location\b.{0,240}\b(?:to do|todo)\b/.test(identityText) ||
    /\bcourse menu\b.{0,300}\b(?:to do|todo)\b/.test(identityText);
  return hasToDoIdentity && /\b(?:there is no content to display|nothing due(?: today)?)\b/.test(text);
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
function hasLanguageLearningIntent(query, languageTokens = []) {
  const normalized = normalizeText(query);
  if (!normalized || !languageTokens.length) return false;
  const tokens = normalized.split(" ").filter(Boolean);
  const languagePositions = [];
  const actionPositions = [];
  const topicPositions = [];
  const genericResourcePositions = [];
  const languageSet = new Set(languageTokens);
  const actionToken = /^(?:learn|learning|study|studying|practice|practicing|improve|improving|teach|teaching)$/;
  const topicToken = /^(?:grammar|vocab|vocabulary|pronunciation|fluency|placement|tutor|tutoring|hsk)$/;
  const genericResourceToken = /^(?:course|courses|class|classes|lesson|lessons|level|levels|materials|resources|program|programs|skills)$/;
  tokens.forEach((token, index) => {
    if (languageSet.has(token)) languagePositions.push(index);
    if (actionToken.test(token)) actionPositions.push(index);
    if (topicToken.test(token)) topicPositions.push(index);
    if (genericResourceToken.test(token)) genericResourcePositions.push(index);
  });
  if (!languagePositions.length) return false;

  const demographicReference = languagePositions.some((index) =>
    /^(?:student|students|citizen|citizens|national|nationals|applicant|applicants)$/.test(tokens[index + 1] || "")
  );
  const directLearningRelation = languagePositions.some((languageIndex) =>
    actionPositions.some((actionIndex) =>
      (actionIndex < languageIndex && languageIndex - actionIndex <= 2) ||
      (actionIndex > languageIndex && actionIndex - languageIndex === 1)
    )
  );
  const nearbySpecificTopic = languagePositions.some((languageIndex) =>
    topicPositions.some((topicIndex) => Math.abs(languageIndex - topicIndex) <= 6)
  );
  const directlyQualifiedResource = languagePositions.some((languageIndex) =>
    genericResourcePositions.some((resourceIndex) => Math.abs(languageIndex - resourceIndex) <= 2)
  );
  if (demographicReference && !directLearningRelation && !nearbySpecificTopic) return false;
  return directLearningRelation || nearbySpecificTopic || directlyQualifiedResource;
}

function isChineseLanguageQuery(query) {
  const normalized = normalizeText(query);
  if (/\bsurvival\s+chinese\b|\bhsk\b/.test(normalized)) return true;
  return hasLanguageLearningIntent(normalized, ["chinese", "mandarin"]);
}

function isEnglishLanguageQuery(query) {
  return hasLanguageLearningIntent(query, ["english"]);
}

function isEnglishLanguageResource(result) {
  const metadata = normalizeText(
    [cleanSourceTitle(result), compactSourceTrail(result), result?.section, result?.page_title, result?.url]
      .filter(Boolean)
      .join(" ")
  );
  return /\benglish\s+language\b/.test(metadata) || hasLanguageLearningIntent(metadata, ["english"]);
}

function isLowValueSearchResult(result) {
  if (isExplicitEmptyToDoResult(result)) return false;
  const title = normalizeText(cleanSourceTitle(result));
  const source = normalizeText(compactSourceTrail(result));
  if (/^(quick links?|open quick links?|tabs|notifications dashboard)$/.test(title)) return true;
  if (title === "quick links" || /open quick links|notifications dashboard|my institution/.test(source)) return true;
  if (isBlackboardConfigurationResult(result)) return true;
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
  const provenance = normalizeText(result.source_pack_provenance || "");
  const sourceClass = searchResourceSourceClass(result);
  const isOfficialBlackboard = sourceClass === "official_blackboard";
  const hasValidatedAuthority = searchResourceHasValidatedAuthority(result);
  // Last-known extracted text remains usable while revalidation is pending, but it is never equivalent to fresh evidence.
  if (isStaleLastKnownExtractedBody(result)) score -= 60;
  if (isOfficialBlackboard && hasValidatedAuthority) {
    score += 30;
    const policyDomainMatch =
      (isVisaQuery(query) && isVisaResult(result)) ||
      (isPackingQuery(query) && isPackingResult(result));
    if (policyDomainMatch) score += 90;
    if (policyDomainMatch && /\bofficial\b/.test(normalizeText(query))) score += 260;
    if (!policyDomainMatch && /\b(?:official|blackboard)\b/.test(normalizeText(query))) score += 180;
  } else if (sourceClass === "curated_pack" && provenance === "program webinar transcript") {
    const authorityTerms = searchQueryProfile(query).baseTokens || [];
    const authorityText = normalizeText(
      [cleanSourceTitle(result), compactSourceTrail(result), result.text].filter(Boolean).join(" ")
    );
    const authorityHits = authorityTerms.filter((term) => searchTermPosition(authorityText, term) >= 0).length;
    const authorityCoverage = authorityTerms.length ? authorityHits / authorityTerms.length : 0;
    score += Math.round(60 * authorityCoverage);
  } else if (sourceClass === "curated_pack" && searchResourceHasAllowlistedAuthorityTrust(result)) {
    score += 45;
  }

  const queryText = normalizeText(query);
  const genericTitleTerms = new Set(["document", "documents", "official", "page", "pages", "pdf", "resource", "resources", "transcript"]);
  const titleTerms = Array.from(
    new Set(
      normalizeText(cleanSourceTitle(result))
        .split(" ")
        .filter((term) => term.length >= 3 && !genericTitleTerms.has(term))
    )
  );
  const titleTermHits = titleTerms.filter((term) => searchTermPosition(queryText, term) >= 0).length;
  if (titleTermHits >= 2) score += Math.min(180, titleTermHits * 55);
  const titleTermCoverage = titleTerms.length ? titleTermHits / titleTerms.length : 0;
  if (titleTerms.length >= 2 && titleTermCoverage >= 0.75) score += 280;

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

function isBlackboardConfigurationResult(result) {
  const title = normalizeText([result?.title, result?.base_title, result?.page_title].filter(Boolean).join(" "));
  const text = normalizeText([result?.source, result?.section, result?.text, result?.context].filter(Boolean).join(" "));
  const url = String(result?.url || result?.page_url || "").toLowerCase();
  if (/\b(?:current|change|edit) notification settings?\b|\bnotification destinations\b/.test(`${title} ${text}`)) return true;
  if (/^(?:change|edit) settings(?: blackboard learn)?\b/.test(title)) return true;
  if (/notification(?:settings?|_settings?)|editnotifications?/.test(url)) return true;
  if (/\bselect organization\b.*\bnotification destinations\b/.test(text)) return true;
  if (/\bsettings on off\b.*\bassignment (?:available|due|needs grading)\b/.test(text)) return true;
  return /\bsc gra updated\b.*\bjournal comment\b.*\bunread blog posts?\b/.test(text);
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
  const groups = new Map();
  for (const result of results || []) {
    if (!result) continue;
    const key = sourceDedupeKey(result);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }

  return Array.from(groups.values())
    .map((group) => mergeSourceCandidateGroup(group, query))
    .sort((a, b) => {
      const scoreA = sourceCandidatePreferenceScore(a, query);
      const scoreB = sourceCandidatePreferenceScore(b, query);
      if (scoreA !== scoreB) return scoreB - scoreA;
      const rawDifference = (b?.score || 0) - (a?.score || 0);
      return rawDifference || compareSearchResultIdentity(a, b);
    });
}

function mergeSourceCandidateGroup(group, query = "") {
  const ranked = [...(group || [])].sort((a, b) => {
    const preferenceDifference = sourceCandidatePreferenceScore(b, query) - sourceCandidatePreferenceScore(a, query);
    return preferenceDifference || compareSearchResultIdentity(a, b);
  });
  const primary = ranked[0] || {};
  const corePassages = selectDiverseSourcePassages(ranked, query, 4, 6000);
  const passageCandidates = appendSourceCandidateNeighbors(corePassages, query, 6, 9000);
  const excerpts = [];
  const fingerprints = new Set();
  const resourceIds = [];
  const pageRanges = [];
  let totalChars = 0;

  for (const candidate of passageCandidates) {
    const rawText = String(candidate?.text || "").trim();
    const fingerprint = normalizeText(rawText).slice(0, 500);
    if (!rawText || !fingerprint || fingerprints.has(fingerprint)) continue;
    if (excerpts.length >= 6 || (totalChars && totalChars + rawText.length > 9000)) continue;

    fingerprints.add(fingerprint);
    const range = String(candidate.source_pack_page_range || "").trim();
    const rangeLabel = range && !/^chunk\s+\d+$/i.test(range)
      ? (/^\d{1,2}:\d{2}/.test(range) ? "Timestamp " : "Pages ") + range
      : "";
    excerpts.push(rangeLabel ? rangeLabel + "\n" + rawText : rawText);
    totalChars += rawText.length;
    if (candidate.resource_id && !resourceIds.includes(candidate.resource_id)) resourceIds.push(candidate.resource_id);
    if (range && !pageRanges.includes(range)) pageRanges.push(range);
  }

  return {
    ...primary,
    text: excerpts.length ? excerpts.join("\n\n") : primary.text,
    has_body: ranked.some((candidate) => candidate?.has_body),
    matched_chunk_count: Math.max(1, excerpts.length),
    matched_resource_ids: resourceIds,
    source_pack_page_range: pageRanges.join(", ") || primary.source_pack_page_range || ""
  };
}

function appendSourceCandidateNeighbors(selected, query = "", limit = 6, totalCharLimit = 9000) {
  const seeds = [...(selected || [])];
  if (!seeds.length || seeds.length >= limit) return seeds;
  if (!seeds.some((candidate) => Number.isInteger(Number(candidate?.search_part_index)))) return seeds;

  const byPart = new Map();
  for (const candidate of cachedSearchCorpus(query).docs || []) {
    const partIndex = Number(candidate?.search_part_index);
    if (!candidate?.resource_id || !Number.isInteger(partIndex)) continue;
    byPart.set(`${candidate.resource_id}|${partIndex}`, candidate);
  }

  const keyFor = (candidate) => `${candidate?.resource_id || ""}|${candidate?.search_part_index ?? ""}`;
  const seen = new Set(seeds.map(keyFor));
  const neighbors = new Map();
  for (const seed of seeds) {
    const partIndex = Number(seed?.search_part_index);
    const partCount = Number(seed?.search_part_count);
    if (!seed?.resource_id || !Number.isInteger(partIndex)) continue;
    for (const neighborIndex of [partIndex - 1, partIndex + 1]) {
      if (neighborIndex < 0 || (Number.isInteger(partCount) && neighborIndex >= partCount)) continue;
      const neighbor = byPart.get(`${seed.resource_id}|${neighborIndex}`);
      const key = keyFor(neighbor);
      if (!neighbor || seen.has(key)) continue;
      const candidate = {
        ...neighbor,
        score: Math.max(1, (Number(seed.score) || 1) * 0.45),
        passage_neighbor_priority:
          sourceCandidatePreferenceScore(neighbor, query) + (Number(seed.score) || 0) * 0.08 + (neighborIndex > partIndex ? 2 : 0)
      };
      if (!neighbors.has(key) || candidate.passage_neighbor_priority > neighbors.get(key).passage_neighbor_priority) {
        neighbors.set(key, candidate);
      }
    }
  }

  const result = [...seeds];
  const attachedNeighborResources = new Set();
  let totalChars = result.reduce((sum, candidate) => sum + String(candidate?.text || "").trim().length, 0);
  for (const candidate of Array.from(neighbors.values()).sort((a, b) => (b.passage_neighbor_priority - a.passage_neighbor_priority) || compareSearchResultIdentity(a, b))) {
    const chars = String(candidate?.text || "").trim().length;
    const neighborResourceKey = String(candidate?.resource_id || searchResultTieKey(candidate));
    if (result.length >= limit) break;
    if (attachedNeighborResources.has(neighborResourceKey)) continue;
    if (totalChars && totalChars + chars > totalCharLimit) continue;
    result.push(candidate);
    attachedNeighborResources.add(neighborResourceKey);
    totalChars += chars;
  }
  return result;
}

function selectDiverseSourcePassages(ranked, query = "", limit = 3, totalCharLimit = 5600) {
  if (!Array.isArray(ranked) || ranked.length <= 1) return ranked || [];

  const routeQueries = ranked.flatMap((candidate) =>
    (Array.isArray(candidate?.retrieval_route_queries) ? candidate.retrieval_route_queries : [])
      .map((item) => String(item?.query || ""))
  );
  const queryTerms = Array.from(new Set(
    [query, ...routeQueries].flatMap((value) => searchQueryProfile(value).tokens || [])
  ))
    .filter((term) => term.length > 1);
  const primaryQueryTerms = Array.from(new Set(
    searchQueryProfile(query).baseTokens || []
  ))
    .filter((term) => term.length > 1);
  const profiles = ranked.map((candidate, rankIndex) => {
    const text = normalizeText(candidate?.text || "");
    const termSet = new Set(queryTerms.filter((term) => containsNormalizedToken(text, term)));
    const primaryTermSet = new Set(primaryQueryTerms.filter((term) => containsNormalizedToken(text, term)));
    const routeRanks = Array.isArray(candidate?.retrieval_route_ranks)
      ? candidate.retrieval_route_ranks
          .map((item) => ({ routeIndex: Number(item?.routeIndex), rankIndex: Number(item?.rankIndex) }))
          .filter((item) => Number.isInteger(item.routeIndex) && Number.isInteger(item.rankIndex))
      : [];
    const contentTokens = new Set(
      text.split(" ").filter((term) => term.length >= 4 && !STOP_WORDS.has(term)).slice(0, 320)
    );
    return { candidate, rankIndex, text, termSet, primaryTermSet, routeRanks, contentTokens };
  });

  const termFrequency = new Map();
  for (const profile of profiles) {
    for (const term of profile.termSet) termFrequency.set(term, (termFrequency.get(term) || 0) + 1);
  }

  const selected = [];
  const remaining = new Set(profiles.map((_profile, index) => index));
  const coveredTerms = new Set();
  const coveredRoutes = new Set();
  let totalChars = 0;

  const select = (index) => {
    const profile = profiles[index];
    selected.push(profile);
    remaining.delete(index);
    totalChars += String(profile.candidate?.text || "").trim().length;
    for (const term of profile.termSet) coveredTerms.add(term);
    for (const route of profile.routeRanks) coveredRoutes.add(route.routeIndex);
  };

  select(0);

  // Fusion can rank several partial passages from one logical document above a
  // compact passage that independently covers the user's main question. Keep
  // one strong standalone passage before spending the remaining slots on route
  // diversity. This preserves answer-bearing redundancy without coupling the
  // selector to a corpus, query, or evaluation answer key. Do not reserve a
  // merely redundant passage: it must add a primary facet or express comparable
  // coverage materially more densely than the leader.
  if (primaryQueryTerms.length >= 4 && selected.length < limit) {
    const leadingHitCount = profiles[0]?.primaryTermSet?.size || 0;
    const leadingScore = Math.max(1, Number(profiles[0]?.candidate?.score) || 0);
    const leadingChars = String(profiles[0]?.candidate?.text || "").trim().length;
    const leadingDensity = leadingChars / Math.max(1, leadingHitCount);
    const minimumHitCount = Math.max(3, Math.ceil(primaryQueryTerms.length * 0.6));
    const strongStandalone = Array.from(remaining)
      .map((index) => profiles[index])
      .filter((profile) => {
        const candidateChars = String(profile.candidate?.text || "").trim().length;
        const candidateDensity = candidateChars / Math.max(1, profile.primaryTermSet.size);
        const addsPrimaryFacet = Array.from(profile.primaryTermSet).some((term) => !profiles[0].primaryTermSet.has(term));
        const materiallyDenser = candidateDensity <= leadingDensity * 0.7;
        return (
          profile.primaryTermSet.size >= minimumHitCount &&
          profile.primaryTermSet.size >= Math.max(3, leadingHitCount - 1) &&
          (Number(profile.candidate?.score) || 0) >= leadingScore * 0.55 &&
          totalChars + candidateChars <= totalCharLimit &&
          (addsPrimaryFacet || materiallyDenser)
        );
      })
      .sort((a, b) => {
        const hitDifference = b.primaryTermSet.size - a.primaryTermSet.size;
        if (hitDifference) return hitDifference;
        const densityA = String(a.candidate?.text || "").trim().length / Math.max(1, a.primaryTermSet.size);
        const densityB = String(b.candidate?.text || "").trim().length / Math.max(1, b.primaryTermSet.size);
        if (densityA !== densityB) return densityA - densityB;
        return a.rankIndex - b.rankIndex;
      })[0];
    if (strongStandalone) select(strongStandalone.rankIndex);
  }

  while (selected.length < limit && remaining.size) {
    let bestIndex = -1;
    let bestScore = -Infinity;

    for (const index of remaining) {
      const profile = profiles[index];
      const candidateChars = String(profile.candidate?.text || "").trim().length;
      if (totalChars && totalChars + candidateChars > totalCharLimit) continue;

      let newTermScore = 0;
      let newTermCount = 0;
      let newNumericTermCount = 0;
      for (const term of profile.termSet) {
        if (coveredTerms.has(term)) continue;
        const frequency = termFrequency.get(term) || 1;
        const rarity = Math.log2((profiles.length + 1) / frequency);
        const isNumericTerm = /^\d/.test(term);
        const factWeight = isNumericTerm ? 4.5 : term.length >= 8 ? 1.6 : 1;
        newTermScore += rarity * factWeight;
        newTermCount += 1;
        if (isNumericTerm) newNumericTermCount += 1;
      }

      let newRouteScore = 0;
      for (const route of profile.routeRanks) {
        if (!coveredRoutes.has(route.routeIndex)) newRouteScore += 1 + 4 / (route.rankIndex + 1);
      }

      let maximumRedundancy = 0;
      for (const chosen of selected) {
        let shared = 0;
        for (const term of profile.contentTokens) {
          if (chosen.contentTokens.has(term)) shared += 1;
        }
        const union = profile.contentTokens.size + chosen.contentTokens.size - shared;
        if (union) maximumRedundancy = Math.max(maximumRedundancy, shared / union);
      }

      const rankBonus = 14 / (1 + profile.rankIndex * 0.55);
      const neighborBonus = profile.candidate?.passage_neighbor_distance ? 2.5 : 0;
      const noNewEvidencePenalty = !newNumericTermCount && !newTermCount && !newRouteScore ? 4 : 0;
      const score = newTermScore * 2.5 + newRouteScore * 3 + rankBonus + neighborBonus - maximumRedundancy * 4 - noNewEvidencePenalty;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    if (bestIndex < 0) break;
    select(bestIndex);
  }

  return selected.map((profile) => profile.candidate);
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
  if (typeof result?.search_source_dedupe_key === "string") return result.search_source_dedupe_key;
  if (typeof result?.search_identity?.source_dedupe_key === "string") return result.search_identity.source_dedupe_key;
  const documentKey = canonicalDocumentKey(result);
  if (documentKey) return documentKey;
  const scope = searchEvidenceScopeKey(result);
  const url = normalizeSourceUrl(result.url || "");
  const title = normalizeText(cleanSourceTitle(result));
  const source = normalizeText(compactSourceTrail(result));
  const text = normalizeText(result.text || "").slice(0, 180);
  if (title && source) return `source:${scope}|${title}|${source}`;
  if (title && text) return `title:${scope}|${title}|${text}`;
  if (url) return `url:${scope}|${url}|${title}`;
  return `text:${scope}|${title}|${source}|${text}`;
}

function canonicalDocumentKey(result) {
  if (typeof result?.search_canonical_document_key === "string") return result.search_canonical_document_key;
  if (typeof result?.search_identity?.canonical_document_key === "string") return result.search_identity.canonical_document_key;
  const scope = searchEvidenceScopeKey(result);
  if (result?.source_pack_id && result?.source_pack_document_id) return `packdoc:${scope}|${result.source_pack_id}:${result.source_pack_document_id}`;
  if (result?.source_pack_id && result?.resource_id) return `packdoc:${scope}|${result.source_pack_id}:${result.resource_id}`;
  if (String(result?.kind || "").toLowerCase() === "page") {
    const pageTitle = canonicalPageIdentity(cleanSourceTitle(result || {}));
    const pageSource = canonicalPageIdentity(compactSourceTrail(result || {}));
    if (pageTitle && pageSource) return `page:${scope}|${pageTitle}|${pageSource}`;
  }
  const titleName = canonicalDocumentNameFrom(cleanSourceTitle(result || {}));
  const urlName = canonicalDocumentNameFromUrl(result?.url || result?.document_url || "");
  const sourceName = canonicalDocumentNameFrom(compactSourceTrail(result || {}));
  const textName = canonicalDocumentNameFrom(result?.text || "");
  const name = titleName || urlName || sourceName || textName;
  if (name) return `doc:${scope}|${name}`;

  const url = normalizeSourceUrl(result?.url || result?.document_url || "");
  if (url) return `docurl:${scope}|${url}`;

  const fingerprint = canonicalContentFingerprint(result);
  return fingerprint ? `docfp:${scope}|${fingerprint}` : "";
}

function canonicalPageIdentity(value) {
  return normalizeText(value)
    .replace(/\bblackboard learn\b/g, " ")
    .replace(/\bpart\s+\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
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
  if (String(resource?.indexed_body_source || "").toLowerCase() === "pending_extraction") return false;
  if (isFileLikeSearchResource(resource) && isVerifiedExtractedFileBody(resource)) {
    return normalizeText(text).length > 40;
  }
  if (isFileLikeSearchResource(resource) && isStaleLastKnownExtractedBody(resource)) {
    return normalizeText(text).length > 40;
  }
  // Installed resource-pack text is prepared content, not a crawler-derived
  // file listing. Keep concise substantive pack documents searchable.
  if (resource?.source_pack_id) {
    return normalizeText(text).length > 40;
  }
  if (isFileLikeSearchResource(resource)) return isReadableFileBodyText(resource, text);
  return normalizeText(text).length > 40;
}

function isFileLikeSearchResource(resource) {
  const type = String(resource?.type || "").toLowerCase();
  const hint = [resource?.type, resource?.title, resource?.url, resource?.document_url].filter(Boolean).join(" ");
  return ["pdf", "document", "slides", "spreadsheet"].includes(type) || /\.(pdf|docx|pptx|xlsx)(?:[?#]|$|\s)/i.test(hint);
}

function isVerifiedExtractedFileBody(resource) {
  return resource?.body_verified === true && resource?.indexed_body_source === "extracted";
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
  const processedResourceCache = new Map();
  const cleanedContentCache = new Map();
  const normalizedFullTextCache = new Map();
  const chunkedFullTextCache = new Map();

  for (const resource of state.resources) {
    const rawStoredContent = String(state.contentStore?.[resource.id] || "");
    let metadataCache = processedResourceCache.get(rawStoredContent);
    if (!metadataCache) {
      metadataCache = new Map();
      processedResourceCache.set(rawStoredContent, metadataCache);
    }
    const fileLike = isFileLikeSearchResource(resource);
    const metadataKey = [
      resource.type,
      resource.title,
      [resource.url, resource.document_url, resource.page_url]
        .map((value) => String(value || "").split(/[?#]/)[0].replace(/\/+$/g, "").toLowerCase())
        .join("|"),
      resource.canonical_key,
      resource.collection_kind,
      resource.source_pack_id ? "pack-resource" : "non-pack-resource",
      resource.section,
      resource.page_title,
      resource.context,
      fileLike ? "file" : "non-file",
      searchResourceSourceClass(resource, true),
      searchResourceTrustIdentity(resource),
      searchResourceProvenanceIdentity(resource),
      resource.body_verified === true ? "verified-body" : "unverified-body",
      resource.indexed_body_source,
      resource.body_revalidation_required === true ? "revalidation-required" : "revalidation-not-required",
      resource.needs_body_hydration === true ? "hydration-required" : "hydration-not-required",
      resource.content_origin,
      (resource.transcript_ids || []).join(",")
    ].map((value) => String(value || "")).join("\u001f");
    let processed = metadataCache.get(metadataKey);

    if (!processed) {
      let storedContent = cleanedContentCache.get(rawStoredContent);
      if (storedContent === undefined) {
        storedContent = cleanIndexedText(rawStoredContent);
        cleanedContentCache.set(rawStoredContent, storedContent);
      }
      if (shouldSkipResourceSearchDoc(resource, storedContent, wantsVideo)) {
        processed = { skip: true };
      } else {
        const resourceTitle = cleanIndexedText(resource.title || "Untitled resource");
        const sourceTrail = [resource.section, resource.page_title].map(cleanIndexedText).filter(Boolean).join(" - ");
        const hasBody = resourceHasReadableBody(resource, storedContent);
        const contentForSearch = hasBody ? storedContent : "";
        const fallbackContext = fileLike ? "" : cleanIndexedText(resource.context);
        const fullText = [resourceTitle, contentForSearch || fallbackContext, sourceTrail].filter(Boolean).join(" ");
        let normalizedFullText = normalizedFullTextCache.get(fullText);
        if (normalizedFullText === undefined) {
          normalizedFullText = normalizeText(fullText);
          normalizedFullTextCache.set(fullText, normalizedFullText);
        }
        let texts = [fullText];
        if (fullText.length > 1200) {
          texts = chunkedFullTextCache.get(fullText);
          if (!texts) {
            texts = chunkTextForSearch(fullText, 1400, true);
            chunkedFullTextCache.set(fullText, texts);
          }
        }
        processed = normalizedFullText
          ? {
              skip: false,
              resourceTitle,
              sourceTrail,
              hasBody,
              texts
            }
          : { skip: true };
      }
      metadataCache.set(metadataKey, processed);
    }
    if (processed.skip) continue;

    const resourceSourceClass = searchResourceSourceClass(resource, true);
    const baseDoc = {
      resource_id: resource.id,
      kind: resource.type || "resource",
      title: processed.resourceTitle || "Untitled resource",
      base_title: processed.resourceTitle || "Untitled resource",
      source: processed.sourceTrail,
      url: resource.url || resource.document_url || resource.page_url || "",
      timestamp: "",
      source_pack_id: resource.source_pack_id || "",
      source_pack_title: resource.source_pack_title || "",
      source_pack_document_id: resource.source_pack_document_id || "",
      source_pack_document_title: resource.source_pack_document_title || "",
      source_pack_page_range: resource.source_pack_page_range || "",
      source_pack_provenance: resource.source_pack_provenance || "",
      source_class: resourceSourceClass,
      collection_kind: String(resource.collection_kind || resource.collectionKind || ""),
      content_origin: String(resource.content_origin || resource.contentOrigin || ""),
      search_managed_blackboard_record: resourceSourceClass === "official_blackboard",
      authority_verified: resource.authority_verified === true,
      source_authority_verified: resource.source_authority_verified === true,
      source_trust:
        resource.source_trust || resource.sourceTrust || resource.trust_tier || resource.trustTier ||
        resource.authority_tier || resource.authorityTier || resource.trust || resource.authority || "",
      source_provenance: resource.source_provenance || resource.sourceProvenance || resource.provenance || resource.content_origin || resource.indexed_body_source || "",
      canonical_parent_id:
        resource.canonical_parent_id || resource.canonicalParentId || resource.parent_document_id ||
        resource.parentDocumentId || resource.document_id || resource.documentId || resource.parent_id ||
        resource.parentId || "",
      body_verified: resource.body_verified === true,
      indexed_body_source: String(resource.indexed_body_source || ""),
      body_revalidation_required: resource.body_revalidation_required === true,
      needs_body_hydration: resource.needs_body_hydration === true,
      search_body_evidence_state: searchBodyEvidenceState(resource),
      has_body: processed.hasBody
    };
    for (let index = 0; index < processed.texts.length; index += 1) {
      docs.push({
        ...baseDoc,
        title: processed.texts.length > 1 ? `${baseDoc.title} (part ${index + 1})` : baseDoc.title,
        text: processed.texts[index],
        search_part_index: index,
        search_part_count: processed.texts.length
      });
    }
  }

  for (const transcript of state.transcripts) {
    const matchedResource = (transcript.matched_resource_ids || [])
      .map((id) => resourceById.get(id))
      .find(Boolean);
    const transcriptOwner = matchedResource || transcript;
    const transcriptSourceClass = searchResourceSourceClass(transcriptOwner, Boolean(matchedResource));
    const transcriptCollectionKind = String(
      matchedResource?.collection_kind || transcript.collection_kind || (!matchedResource ? "user_import" : "")
    );
    const transcriptContentOrigin = String(
      matchedResource?.content_origin || transcript.content_origin || (!matchedResource ? "user_import" : "")
    );
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
        url: matchedResource?.url || matchedResource?.document_url || transcript.document_url || transcript.video_url || "",
        timestamp: [segment.start, segment.end].filter(Boolean).join("-"),
        source_pack_id: matchedResource?.source_pack_id || transcript.source_pack_id || "",
        source_pack_document_id: matchedResource?.source_pack_document_id || transcript.source_pack_document_id || "",
        source_pack_provenance: matchedResource?.source_pack_provenance || transcript.source_pack_provenance || "",
        source_class: transcriptSourceClass,
        collection_kind: transcriptCollectionKind,
        content_origin: transcriptContentOrigin,
        search_managed_blackboard_record: Boolean(matchedResource) && transcriptSourceClass === "official_blackboard",
        authority_verified:
          matchedResource?.authority_verified === true || transcript.authority_verified === true,
        source_authority_verified:
          matchedResource?.source_authority_verified === true || transcript.source_authority_verified === true,
        source_trust:
          matchedResource?.source_trust || transcript.source_trust || matchedResource?.trust_tier ||
          transcript.trust_tier || "",
        source_provenance: matchedResource?.source_provenance || transcript.source_provenance || transcript.provenance ||
          matchedResource?.content_origin || transcript.content_origin || matchedResource?.indexed_body_source ||
          transcript.indexed_body_source || "",
        canonical_parent_id:
          matchedResource?.canonical_parent_id || transcript.canonical_parent_id || transcript.id || "",
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
  if (isExplicitEmptyToDoResult(resource, storedContent)) return false;
  if (
    isBlackboardConfigurationResult({
      ...resource,
      text: storedContent || resource?.context || "",
      source: [resource?.section, resource?.page_title].filter(Boolean).join(" ")
    })
  ) return true;
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


function scoreDoc(query, doc, queryProfile = null) {
  const profile = queryProfile || searchQueryProfile(query);
  const queryTokens = profile.tokens;
  const queryPhrases = profile.phrases;
  const title = doc.search_title || normalizeText(doc.title);
  const text = doc.search_text || normalizeText(doc.text);
  const source = doc.search_source || normalizeText(doc.source);
  const haystack = `${title} ${source} ${text}`;
  const isTranscript = doc.kind === "video_transcript";
  let score = quotedPhraseMatchScore(profile.quotedPhrases, [doc.title, doc.source, doc.text].filter(Boolean).join(" "));
  if (profile.quotedPhrases.length && score <= 0) score -= 60;
  const titleTokenHits = queryTokenHitCounts(title, profile.singleTokenSet);
  const sourceTokenHits = queryTokenHitCounts(source, profile.singleTokenSet);
  const textTokenHits = queryTokenHitCounts(text, profile.singleTokenSet);
  for (const token of queryTokens) {
    if (!token) continue;
    const isPhraseToken = token.includes(" ");
    const titleHits = isPhraseToken ? countOccurrences(title, token) : titleTokenHits[token] || 0;
    const sourceHits = isPhraseToken ? countOccurrences(source, token) : sourceTokenHits[token] || 0;
    const textHits = isPhraseToken ? countOccurrences(text, token) : textTokenHits[token] || 0;
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
  score += queryCoverageBoost(profile, title, text, source);
  if (isTranscript && !wantsVideoHeavySearch(query)) score = Math.max(0, score - 24);
  // Preserve recall for stale text while deterministically preferring an otherwise identical fresh extraction.
  if (isStaleLastKnownExtractedBody(doc) && score > 0) score *= 0.96;
  return score;
}

function tokenMorphologyVariants(token) {
  const word = normalizeText(token);
  if (!word || word.includes(" ") || word.length < 4) return [];
  const variants = new Set();
  const add = (value) => {
    const clean = normalizeText(value);
    if (clean.length >= 4 && clean !== word) variants.add(clean);
  };

  if (/ies$/.test(word) && word.length > 5) add(word.slice(0, -3) + "y");
  else if (/s$/.test(word) && !/ss$/.test(word) && word.length > 4) add(word.slice(0, -1));
  if (/ing$/.test(word) && word.length > 6) {
    add(word.slice(0, -3));
    add(word.slice(0, -3) + "e");
  }
  if (/ed$/.test(word) && word.length > 5) {
    add(word.slice(0, -2));
    add(word.slice(0, -1));
  }
  if (/ly$/.test(word) && word.length > 5) add(word.slice(0, -2));
  if (/ability$/.test(word)) add(word.replace(/ability$/, "able"));
  if (/ibility$/.test(word)) add(word.replace(/ibility$/, "ible"));
  if (/able$/.test(word)) {
    add(word.replace(/able$/, "ability"));
    add(word.replace(/able$/, "ably"));
  }
  if (/ible$/.test(word)) {
    add(word.replace(/ible$/, "ibility"));
    add(word.replace(/ible$/, "ibly"));
  }
  const negativeAdjective = word.match(/^(?:in|un|non)([a-z]{4,}(?:able|ible))$/);
  if (negativeAdjective) add(negativeAdjective[1]);
  return Array.from(variants);
}

function expandedTokens(query) {
  const tokens = normalizeText(query)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  const extras = [];
  const synonymMap = {
    accommodation: ["accommodations", "accessibility", "support", "request", "feasible", "alternative"],
    accommodations: ["accommodation", "accessibility", "support", "request", "feasible", "alternative"],
    app: ["apps", "didi", "alipay", "wechat"],
    apps: ["app", "didi", "alipay", "wechat"],
    ride: ["didi", "taxi", "ride sharing"],
    hailing: ["didi", "taxi", "ride sharing"],
    often: ["frequency", "every", "minutes", "interval"],
    frequent: ["frequency", "every", "minutes", "interval"],
    frequency: ["frequent", "every", "minutes", "interval"],
    arrive: ["frequency", "every", "minutes", "interval"],
    train: ["subway", "metro", "line"],
    trains: ["subway", "metro", "line"],
    cost: ["price", "fare", "yuan", "rmb"],
    costs: ["price", "fare", "yuan", "rmb"],
    confirm: ["verify", "contact", "support", "helpdesk", "front desk"],
    fare: ["cost", "price", "yuan", "rmb"],
    fee: ["cost", "price", "charge"],
    fees: ["fee", "cost", "price", "charges"],
    guarantee: ["guaranteed", "reliable", "reliability", "definite"],
    guaranteed: ["guarantee", "reliable", "reliability", "definite"],
    hardware: ["equipment", "device", "model", "printer", "printing"],
    payments: ["payment", "pay", "alipay", "wechatpay"],
    visa: ["x1", "jw202", "permit", "residence"],
    vpn: ["reliability", "redundancy", "backup", "fallback", "obfuscated", "esim", "moving target", "current cohort"],
    permit: ["visa", "residence", "x1"],
    approval: ["approve", "approved", "authorization", "proposal"],
    approvals: ["approval", "approve", "approved", "authorization", "proposal"],
    documentation: ["documents", "paperwork", "records", "form", "forms", "receipt", "invoice", "fapiao"],
    paperwork: ["documentation", "documents", "records", "form", "forms", "receipt", "invoice", "fapiao", "prescription", "diagnosis", "treatment notes"],
    printer: ["printing", "print", "hardware", "model", "per page", "it support"],
    printing: ["printer", "print", "hardware", "per page", "it support"],
    registration: ["register", "enrollment", "course"],
    reliable: ["reliability", "reliably", "stable", "guarantee"],
    reliability: ["reliable", "reliably", "stability", "guarantee"],
    reimbursement: ["reimburse", "claim", "receipt", "invoice", "fapiao"],
    reimbursed: ["reimbursement", "claim", "receipt", "invoice", "fapiao"],
    restroom: ["restrooms", "bathroom", "bathrooms", "toilet", "toilets"],
    restrooms: ["restroom", "bathroom", "bathrooms", "toilet", "toilets"],
    billing: ["bill", "insurance", "claim", "reimbursement"],
    banking: ["bank", "rmb", "payment", "cash"],
    payment: ["alipay", "wechatpay", "cash", "card", "bank"],
    pack: ["packing", "bring", "luggage", "clothing", "medicine", "arrival"],
    packing: ["pack", "bring", "luggage", "clothing", "medicine", "arrival"],
    bring: ["pack", "packing", "luggage", "clothing", "medicine"],
    taxi: ["didi", "arrival"],
    travel: ["transport", "transportation", "transit", "subway", "metro", "didi", "flight", "train", "12306"],
    transport: ["travel", "transportation", "transit", "subway", "metro", "didi", "shared bike", "bus"],
    transportation: ["travel", "transport", "transit", "subway", "metro", "didi", "shared bike", "bus"],
    navigate: ["navigation", "get around", "transportation", "amap", "subway", "metro", "didi"],
    navigation: ["navigate", "get around", "transportation", "amap", "subway", "metro", "didi"],
    visitor: ["visitors", "guest", "guests"],
    visitors: ["visitor", "guest", "guests"],
    guest: ["guests", "visitor", "visitors"],
    guests: ["guest", "visitor", "visitors"],
    club: ["clubs", "activities", "organizations"],
    clubs: ["club", "activities", "organizations"],
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
    support: ["helpdesk", "front desk", "contact", "assistance"],
    survey: ["form", "questionnaire", "deadline", "mandatory", "submit"],
    verify: ["confirm", "contact", "support", "helpdesk", "front desk"]
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
    extras.push(...(synonymMap[token] || []), ...tokenMorphologyVariants(token));
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

function queryTokenHitCounts(text, tokenSet) {
  const hits = Object.create(null);
  if (!text || !tokenSet?.size) return hits;
  for (const word of text.split(" ")) {
    if (!tokenSet.has(word)) continue;
    hits[word] = (hits[word] || 0) + 1;
  }
  return hits;
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

function chunkTextForSearch(text, maxChars = 1400, alreadyClean = false) {
  const clean = alreadyClean ? String(text || "").trim() : cleanIndexedText(text).replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean ? [clean] : [];
  const overlapLimit = Math.min(240, Math.max(100, Math.floor(maxChars * 0.18)));
  const sentences = (clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean])
    .flatMap((item) => splitOversizedSearchUnit(item.trim(), maxChars, overlapLimit))
    .filter(Boolean);
  const chunks = [];
  let buffer = "";

  for (const sentence of sentences) {
    const combined = [buffer, sentence].filter(Boolean).join(" ");
    if (combined.length > maxChars && buffer) {
      chunks.push(buffer);
      const overlapBudget = Math.max(0, maxChars - sentence.length - 1);
      const overlap = overlapBudget
        ? trailingSearchChunkOverlap(buffer, Math.min(overlapLimit, overlapBudget))
        : "";
      buffer = [overlap, sentence].filter(Boolean).join(" ");
    } else {
      buffer = combined;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

function splitOversizedSearchUnit(value, maxChars, overlapLimit) {
  const text = String(value || "").trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const pieces = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const minimumBreak = start + Math.floor(maxChars * 0.55);
      const boundary = text.lastIndexOf(" ", end);
      if (boundary >= minimumBreak) end = boundary;
    }
    if (end <= start) end = Math.min(text.length, start + maxChars);
    const piece = text.slice(start, end).trim();
    if (piece) pieces.push(piece);
    if (end >= text.length) break;

    let nextStart = Math.max(start + 1, end - overlapLimit);
    const overlapBoundary = text.indexOf(" ", nextStart);
    if (overlapBoundary >= 0 && overlapBoundary < end) nextStart = overlapBoundary + 1;
    if (nextStart <= start) nextStart = end;
    start = nextStart;
  }
  return pieces;
}

function trailingSearchChunkOverlap(value, limit = 220) {
  const sentences = String(value || "").match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  let overlap = "";
  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    const candidate = [sentences[index].trim(), overlap].filter(Boolean).join(" ");
    if (candidate.length > limit && overlap) break;
    overlap = candidate;
    if (overlap.length >= limit * 0.65) break;
  }
  if (overlap.length > limit) {
    const clipped = overlap.slice(-limit);
    const firstSpace = clipped.indexOf(" ");
    overlap = firstSpace >= 0 ? clipped.slice(firstSpace + 1) : clipped;
  }
  return overlap.trim();
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
