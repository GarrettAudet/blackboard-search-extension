import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const SEARCH_LIMIT = 8;
const PERFORMANCE_GATES = Object.freeze({
  postingFloodResources: 960,
  frozenCopies: 40,
  frozenReferenceResources: 960,
  frozenWarmMedianMs: 44.4,
  existingResources: 1200,
  mixedBaseResources: 5000,
  irrelevantGrowthResources: 1000,
  hardNegativeGrowthResources: 1000,
  postingRepresentativeCap: 3,
  existingWarmMedianMs: 90,
  largeCandidateCeiling: 550,
  maximumSuiteMs: 45000
});
const suiteStarted = performance.now();
const searchIndexSource = [
  "../lib/answer-formatting.js",
  "../lib/llm-client.js",
  "../lib/search-index.js"
].map((file) => fs.readFileSync(new URL(file, import.meta.url), "utf8")).join("\n\n");
const sidepanelSource = fs.readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");
const runtimeStart = sidepanelSource.indexOf("chrome.runtime.onMessage.addListener");
assert.ok(runtimeStart > 0, "Could not isolate the side-panel runtime.");

function mockElement() {
  const element = {
    textContent: "",
    value: "",
    disabled: false,
    className: "",
    dataset: {},
    style: {},
    content: null,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    append() {},
    remove() {},
    setAttribute() {},
    querySelector() { return mockElement(); },
    cloneNode() { return mockElement(); },
    scrollIntoView() {}
  };
  element.content = { firstElementChild: element };
  return element;
}

const context = {
  console,
  URL,
  performance,
  setTimeout,
  clearTimeout,
  AbortController,
  fetch: async () => { throw new Error("Network access is forbidden in corpus-growth-check."); },
  document: {
    getElementById() { return mockElement(); },
    createElement() { return mockElement(); }
  },
  chrome: {
    runtime: {
      sendMessage() {},
      getManifest() { return { version: "corpus-growth-test" }; },
      getURL(path) { return "chrome-extension://growth/" + path; },
      onMessage: { addListener() {} }
    },
    tabs: { async create() {} },
    storage: { local: { async get() { return {}; }, async set() {} } }
  }
};
vm.createContext(context);
vm.runInContext(searchIndexSource + "\n\n" + sidepanelSource.slice(0, runtimeStart), context);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setCorpus(resources, contentStore, transcripts = []) {
  context.__growthResources = resources;
  context.__growthContentStore = contentStore;
  context.__growthTranscripts = transcripts;
  vm.runInContext(
    "state.resources = globalThis.__growthResources; " +
      "state.contentStore = globalThis.__growthContentStore; " +
      "state.transcripts = globalThis.__growthTranscripts; invalidateSearchIndexCache();",
    context
  );
}

function runSearch(query, { prepared = true, limit = SEARCH_LIMIT } = {}) {
  context.__growthQuery = query;
  context.__growthLimit = limit;
  context.__growthPrepared = prepared;
  vm.runInContext(
    "globalThis.__growthResult = globalThis.__growthPrepared " +
      "? prepareAnswerSources(searchIndex(globalThis.__growthQuery, globalThis.__growthLimit), globalThis.__growthQuery) " +
      ": searchIndex(globalThis.__growthQuery, globalThis.__growthLimit);",
    context
  );
  return clone(context.__growthResult);
}

function runCoverage(selected, scored, query, limit) {
  context.__growthSelected = selected;
  context.__growthScored = scored;
  context.__growthCoverageQuery = query;
  context.__growthCoverageLimit = limit;
  vm.runInContext(
    "globalThis.__growthCoverageResult = ensureSearchSourceClassCoverage(" +
      "globalThis.__growthSelected, globalThis.__growthScored, globalThis.__growthCoverageQuery, globalThis.__growthCoverageLimit);",
    context
  );
  return clone(context.__growthCoverageResult);
}

function sourceQualityFor(result, query) {
  context.__growthQualityResult = result;
  context.__growthQualityQuery = query;
  vm.runInContext(
    "globalThis.__growthQualityScore = sourceQualityScore(globalThis.__growthQualityResult, globalThis.__growthQualityQuery);",
    context
  );
  return Number(context.__growthQualityScore);
}

function validatedAuthorityFor(result) {
  context.__growthAuthorityResult = result;
  vm.runInContext(
    "globalThis.__growthAuthorityValidated = searchResourceHasValidatedAuthority(globalThis.__growthAuthorityResult);",
    context
  );
  return context.__growthAuthorityValidated === true;
}

function rankSources(results, query) {
  context.__growthRankResults = results;
  context.__growthRankQuery = query;
  vm.runInContext(
    "globalThis.__growthRanked = rankSourceCandidates(globalThis.__growthRankResults, globalThis.__growthRankQuery);",
    context
  );
  return clone(context.__growthRanked);
}

function getSearchDiagnostics(query) {
  context.__growthDiagnosticQuery = query;
  vm.runInContext(`(() => {
    const profile = searchQueryProfile(globalThis.__growthDiagnosticQuery);
    const corpus = cachedSearchCorpus(globalThis.__growthDiagnosticQuery);
    globalThis.__growthDiagnostics = {
      docs: corpus.docs.length,
      posting_groups: corpus.posting_groups.length,
      maximum_posting_group_representatives: Math.max(0, ...corpus.posting_groups.map((group) => group.length)),
      candidates: candidateSearchDocs(globalThis.__growthDiagnosticQuery, profile).length
    };
  })()`, context);
  return clone(context.__growthDiagnostics);
}
function productionRetrievalQuery(query) {
  context.__growthBaseQuery = query;
  vm.runInContext(
    "globalThis.__growthEnhancedQuery = enhanceRetrievalQueryForIntent(" +
      "globalThis.__growthBaseQuery, globalThis.__growthBaseQuery, defaultRagPlan(globalThis.__growthBaseQuery));",
    context
  );
  return String(context.__growthEnhancedQuery || query);
}

function resultIdentity(result) {
  return [
    result.source_class || (result.source_pack_id ? "curated_pack" : "official_blackboard"),
    result.source_pack_id || "",
    result.source_pack_document_id || "",
    result.canonical_parent_id || "",
    result.resource_id || ""
  ].join(":");
}

function resultParent(result) {
  return result.source_pack_document_id || result.canonical_parent_id || result.resource_id || "";
}

function resource(id, overrides = {}) {
  return {
    id,
    type: "document",
    title: "Corpus Growth Notice.pdf",
    section: "Corpus Growth",
    page_title: "Corpus Growth",
    url: `https://blackboard.example.edu/content/${encodeURIComponent(id)}.pdf`,
    body_verified: true,
    indexed_body_source: "extracted",
    canonical_parent_id: id,
    ...overrides
  };
}

function corpusStore(resources, bodyFor) {
  return Object.fromEntries(resources.map((item, index) => [item.id, bodyFor(item, index)]));
}

function deterministicPermutation(items, salt) {
  const score = (value) => {
    let hash = 2166136261 ^ salt;
    for (const char of String(value.id || value)) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  };
  return [...items].sort((a, b) => score(a) - score(b) || String(a.id).localeCompare(String(b.id)));
}

// The old processed-body cache reused the first same-text resource's hasBody/skip
// decision. This concise file body is intentionally readable for a pack but not
// for an unverified crawler file shell.
const cacheSentinel = "quartzfalcon731";
const conciseBody =
  `${cacheSentinel} The signed arrival notice closes at 09:10 on August 18. Keep the original receipt for review.`;
const cacheOfficial = resource("cache-official-shell", {
  title: "Shared Notice.pdf",
  section: "Shared",
  page_title: "Shared",
  body_verified: false,
  indexed_body_source: "",
  canonical_parent_id: "cache-official-parent"
});
const cachePack = resource("cache-pack-body", {
  title: "Shared Notice.pdf",
  section: "Shared",
  page_title: "Shared",
  body_verified: false,
  indexed_body_source: "",
  source_pack_id: "cache-pack",
  source_pack_document_id: "cache-pack-parent",
  source_pack_provenance: "Curated student guide",
  canonical_parent_id: ""
});
const cacheStore = { [cacheOfficial.id]: conciseBody, [cachePack.id]: conciseBody };
for (const ordered of [[cacheOfficial, cachePack], [cachePack, cacheOfficial]]) {
  setCorpus(ordered, cacheStore);
  const hits = runSearch(cacheSentinel, { prepared: false });
  assert.deepEqual(
    hits.map((item) => item.resource_id),
    [cachePack.id],
    "Processed-body cache leaked a same-text readability decision across source classes."
  );
  assert.equal(hits[0].has_body, true, "The concise curated-pack body was not searchable.");
}

// URL-dependent filters are part of the processed-body cache identity. A
// Blackboard settings route sharing text with a normal resource must not leak
// its skip decision in either corpus order.
const urlFilterToken = "urlfilter815";
const urlFilterBody = `${urlFilterToken} ordinary guidance contains the current student procedure. `.repeat(6);
const urlFiltered = resource("url-filtered", {
  type: "link",
  title: "Shared Student Guide",
  url: "https://blackboard.example.edu/webapps/notificationsettings",
  canonical_parent_id: "url-filtered-parent"
});
const urlReadable = resource("url-readable", {
  type: "link",
  title: "Shared Student Guide",
  url: "https://blackboard.example.edu/content/student-guide",
  canonical_parent_id: "url-readable-parent"
});
for (const ordered of [[urlFiltered, urlReadable], [urlReadable, urlFiltered]]) {
  setCorpus(ordered, { [urlFiltered.id]: urlFilterBody, [urlReadable.id]: urlFilterBody });
  assert.deepEqual(
    runSearch(urlFilterToken, { prepared: false }).map((item) => item.resource_id),
    [urlReadable.id],
    "Processed-body cache leaked a URL-dependent filter decision."
  );
}

// Kind is part of an exact posting signature so a page and document with the
// same visible text do not erase one another before scoring.
const kindToken = "kindidentity816";
const kindBody = `${kindToken} shared page and document evidence remains independently searchable. `.repeat(6);
const kindResources = [
  resource("kind-document", { type: "document", title: "Shared Kind Evidence", canonical_parent_id: "kind-document-parent" }),
  resource("kind-page", { type: "page", title: "Shared Kind Evidence", canonical_parent_id: "kind-page-parent" })
];
setCorpus(kindResources, corpusStore(kindResources, () => kindBody));
assert.deepEqual(
  new Set(runSearch(kindToken, { prepared: false }).map((item) => item.kind)),
  new Set(["document", "page"]),
  "Posting grouping collapsed different resource kinds."
);

// Implicit URL/resource identity must not defeat semantic page deduplication.
// Explicit canonical parents and pack ownership are tested separately below.
const semanticDuplicatePages = [
  {
    score: 240,
    resource_id: "semantic-page-a",
    kind: "page",
    title: "Orientation Overview - Blackboard Learn",
    source: "Pre-program Orientation - Orientation Overview - Blackboard Learn",
    url: "https://blackboard.example.edu/content/list.jsp?content_id=one",
    text: "Orientation Overview. Review the arrival schedule and required orientation sessions.",
    search_managed_blackboard_record: true,
    source_class: "official_blackboard",
    has_body: true
  },
  {
    score: 230,
    resource_id: "semantic-page-b",
    kind: "page",
    title: "Orientation Overview - Blackboard Learn",
    source: "Pre-program Orientation - Orientation Overview - Blackboard Learn",
    url: "https://blackboard.example.edu/content/list.jsp?content_id=two",
    text: "Orientation Overview. Required sessions and the arrival schedule are listed here.",
    search_managed_blackboard_record: true,
    source_class: "official_blackboard",
    has_body: true
  }
];
context.__growthSemanticPages = semanticDuplicatePages;
context.__growthSemanticQuery = "orientation overview schedule";
vm.runInContext(
  "globalThis.__growthSemanticDeduped = dedupeSourceCandidates(globalThis.__growthSemanticPages, globalThis.__growthSemanticQuery);",
  context
);
const semanticDeduped = clone(context.__growthSemanticDeduped);
assert.equal(semanticDeduped.length, 1, "Implicit Blackboard URLs prevented semantic duplicate collapse.");
assert.equal(semanticDeduped[0].matched_resource_ids?.length, 2, "Collapsed semantic pages lost their resource IDs.");

// Exact title/source/body collisions must retain official, curated, and local
// evidence; preparation must not merge them into one source.
const conflictToken = "zephyrpermit731";
const conflictBody =
  `${conflictToken} boarding policy: retain the signed clearance form and present it at the arrival desk. ` +
  "This sentence is repeated to make a clearly substantive extracted document body. ".repeat(4);
const conflictResources = [
  resource("conflict-official", {
    source_class: "official_blackboard",
    source_trust: "authoritative",
    source_provenance: "university policy",
    canonical_parent_id: "official-conflict-parent"
  }),
  resource("conflict-pack", {
    source_pack_id: "schwarzman-c11-test",
    source_pack_document_id: "pack-conflict-parent",
    source_pack_provenance: "Curated student guide",
    source_trust: "advisory",
    canonical_parent_id: ""
  }),
  resource("conflict-local", {
    source_class: "user_import",
    source_trust: "personal",
    source_provenance: "manual upload",
    content_origin: "user_import",
    canonical_parent_id: "local-conflict-parent"
  })
];
const conflictStore = corpusStore(conflictResources, () => conflictBody);
setCorpus(conflictResources, conflictStore);
const conflictRaw = runSearch(`official ${conflictToken} boarding policy`, { prepared: false });
assert.deepEqual(
  new Set(conflictRaw.map((item) => item.source_class)),
  new Set(["official_blackboard", "curated_pack", "user_import"]),
  "Exact-text posting groups discarded a provenance class."
);
const conflictPrepared = runSearch(`official ${conflictToken} boarding policy`);
assert.equal(conflictPrepared[0].source_class, "official_blackboard", "Explicit official intent did not rank official evidence first.");
assert.deepEqual(
  new Set(conflictPrepared.map((item) => item.source_class)),
  new Set(["official_blackboard", "curated_pack", "user_import"]),
  "Source deduplication collapsed official, curated-pack, or user-import evidence."
);

// Structural ownership cannot be spoofed by explicit or cached source labels.
const structuralCases = [
  resource("structure-collection-local", {
    title: "Collection Local.pdf",
    collection_kind: "user_import",
    source_class: "official_blackboard",
    search_identity: { source_class: "official_blackboard" },
    canonical_parent_id: "structure-collection-parent"
  }),
  resource("structure-pack-spoof", {
    title: "Pack Spoof.pdf",
    source_pack_id: "structural-pack",
    source_pack_document_id: "structural-pack-document",
    source_class: "official_blackboard",
    search_identity: { source_class: "official_blackboard" },
    canonical_parent_id: ""
  }),
  resource("structure-origin-local", {
    title: "Origin Local.pdf",
    content_origin: "user_import",
    source_class: "official_blackboard",
    search_identity: { source_class: "official_blackboard" },
    canonical_parent_id: "structure-origin-parent"
  })
];
const structuralTokens = ["collectionlocal811", "packspoof812", "originlocal813"];
const structuralStore = Object.fromEntries(structuralCases.map((item, index) => [
  item.id,
  `${structuralTokens[index]} structural authority evidence. `.repeat(8)
]));
setCorpus(structuralCases, structuralStore);
const structuralExpectedClasses = ["user_import", "curated_pack", "user_import"];
for (let index = 0; index < structuralCases.length; index += 1) {
  const hit = runSearch(structuralTokens[index], { prepared: false })[0];
  assert.equal(hit?.source_class, structuralExpectedClasses[index], "A structural owner was overridden by a spoofed label.");
  const explicitOfficialDelta =
    sourceQualityFor(hit, `official ${structuralTokens[index]}`) - sourceQualityFor(hit, structuralTokens[index]);
  assert.ok(
    explicitOfficialDelta < 150,
    "A structurally non-official result received the explicit-official authority bonus."
  );
}

const unmatchedTranscriptToken = "unmatchedtranscript814";
setCorpus([], {}, [{
  id: "unmatched-manual-transcript",
  title: "Manual Transcript",
  source_class: "official_blackboard",
  search_identity: { source_class: "official_blackboard" },
  source_hint: "Manually imported notes",
  matched_resource_ids: [],
  segments: [{ start: "00:00", end: "00:20", text: `${unmatchedTranscriptToken} records manual orientation notes about housing insurance transit clubs registration scheduling and visitor procedures.` }]
}]);
const unmatchedTranscriptHit = runSearch(`video transcript ${unmatchedTranscriptToken}`, { prepared: false })[0];
assert.equal(unmatchedTranscriptHit?.source_class, "user_import", "An unmatched transcript defaulted to official.");
assert.equal(unmatchedTranscriptHit?.collection_kind, "user_import", "Unmatched transcript ownership was not propagated.");
assert.equal(unmatchedTranscriptHit?.content_origin, "user_import", "Unmatched transcript origin was not propagated.");

// Blackboard is an ownership class, not an authority guarantee. An unverified
// course upload receives no official-policy bonus and loses an otherwise close
// comparison to validated curated or official evidence.
const unverifiedBlackboard = {
  resource_id: "authority-unverified-blackboard",
  kind: "document",
  title: "Authority Candidate.pdf",
  base_title: "Authority Candidate.pdf",
  source: "Managed Blackboard course",
  text: "nebula handbook procedure is described in this student upload",
  search_managed_blackboard_record: true,
  source_class: "official_blackboard",
  source_trust: "unverified",
  source_provenance: "course upload",
  canonical_parent_id: "authority-unverified-parent",
  has_body: true,
  score: 600
};
const authoritativePack = {
  ...unverifiedBlackboard,
  resource_id: "authority-pack",
  source_pack_id: "authority-pack",
  source_pack_document_id: "authority-pack-document",
  source_class: "official_blackboard",
  source_trust: "authoritative",
  source_provenance: "verified program guidance",
  canonical_parent_id: "",
  score: 590
};
const authoritativeOfficial = {
  ...unverifiedBlackboard,
  resource_id: "authority-official",
  source_trust: "authoritative",
  source_provenance: "university policy",
  canonical_parent_id: "authority-official-parent",
  score: 580
};
const provenanceAuthoritySpoof = {
  ...unverifiedBlackboard,
  resource_id: "authority-provenance-spoof",
  source_trust: "institutional",
  source_provenance: "University policy from the admissions office",
  canonical_parent_id: "authority-provenance-spoof-parent"
};
const partialTrustSpoof = {
  ...unverifiedBlackboard,
  resource_id: "authority-partial-trust-spoof",
  source_trust: "authoritative-ish",
  source_provenance: "verified authoritative official policy",
  provenance_verified: true,
  canonical_parent_id: "authority-partial-spoof-parent"
};
const booleanVerifiedOfficial = {
  ...unverifiedBlackboard,
  resource_id: "authority-boolean-verified",
  authority_verified: true,
  canonical_parent_id: "authority-boolean-parent"
};
assert.equal(validatedAuthorityFor(unverifiedBlackboard), false, "An unverified Blackboard upload was treated as authoritative.");
assert.equal(validatedAuthorityFor(authoritativePack), false, "Curated ownership was mislabeled as validated official authority.");
assert.equal(validatedAuthorityFor(authoritativeOfficial), true, "Validated official evidence lost its authority signal.");
assert.equal(validatedAuthorityFor(provenanceAuthoritySpoof), false,
  "Free-form university/office provenance spoofed validated authority.");
assert.equal(validatedAuthorityFor(partialTrustSpoof), false,
  "A partial trust label or provenance_verified flag spoofed validated authority.");
assert.equal(validatedAuthorityFor(booleanVerifiedOfficial), true,
  "An explicit authority verification boolean was ignored for official evidence.");
const unverifiedOfficialDelta =
  sourceQualityFor(unverifiedBlackboard, "official nebula handbook") - sourceQualityFor(unverifiedBlackboard, "nebula handbook");
const verifiedOfficialDelta =
  sourceQualityFor(authoritativeOfficial, "official nebula handbook") - sourceQualityFor(authoritativeOfficial, "nebula handbook");
assert.ok(
  unverifiedOfficialDelta < 150,
  "Explicit official wording boosted authority-unknown Blackboard evidence."
);
assert.ok(
  verifiedOfficialDelta - unverifiedOfficialDelta >= 180,
  `Validated official evidence did not receive the explicit-official authority bonus (${verifiedOfficialDelta} vs ${unverifiedOfficialDelta}).`
);
assert.equal(rankSources([unverifiedBlackboard, authoritativePack], "nebula handbook")[0].resource_id, authoritativePack.resource_id,
  "Unverified Blackboard evidence outranked close authoritative curated evidence.");
assert.equal(rankSources([unverifiedBlackboard, authoritativeOfficial], "nebula handbook")[0].resource_id, authoritativeOfficial.resource_id,
  "Unverified Blackboard evidence outranked close authoritative official evidence.");

function coverageDoc(id, sourceClass, score, parent, text = "aurora permit code current answer evidence") {
  const structural = sourceClass === "curated_pack"
    ? { source_pack_id: `coverage-${id}`, source_pack_document_id: parent }
    : sourceClass === "user_import"
      ? { collection_kind: "user_import", content_origin: "user_import" }
      : { search_managed_blackboard_record: true };
  return {
    resource_id: id,
    kind: "document",
    title: `${id}.pdf`,
    base_title: `${id}.pdf`,
    source: "Coverage fixtures",
    text,
    search_title: String(id).toLowerCase(),
    search_source: "coverage fixtures",
    search_text: text.toLowerCase(),
    source_class: sourceClass,
    canonical_parent_id: parent,
    has_body: true,
    score,
    ...structural
  };
}

const officialPrimary = coverageDoc("official-primary-633", "official_blackboard", 633, "official-primary-parent");
const officialException = coverageDoc("official-exception-633", "official_blackboard", 633, "official-exception-parent");
const localIncorrect = coverageDoc("local-incorrect-534", "user_import", 534, "local-incorrect-parent", "aurora permit code incorrect guess 534");
assert.deepEqual(
  runCoverage([officialPrimary, officialException], [officialPrimary, officialException, localIncorrect], "What is the aurora permit code?", 2)
    .map((item) => item.resource_id),
  [officialException.resource_id, officialPrimary.resource_id].sort(),
  "Ambiguous balancing displaced a materially better distinct official answer-bearing parent."
);

const packCoverage = coverageDoc("pack-coverage-620", "curated_pack", 620, "pack-coverage-parent", "compare official blackboard c11 resource pack aurora permit evidence");
const localCoverage = coverageDoc("local-coverage-618", "user_import", 618, "local-coverage-parent", "compare uploaded files official blackboard aurora permit evidence");
const officialCoverage = coverageDoc("official-coverage-625", "official_blackboard", 625, "official-coverage-parent", "compare official blackboard c11 resource pack uploaded files aurora permit evidence");
const officialCoverageSecond = coverageDoc("official-coverage-second-624", "official_blackboard", 624, "official-coverage-second-parent", "compare official blackboard c11 resource pack uploaded files aurora permit evidence");
for (const [query, selected, expectedClasses] of [
  ["Use only official Blackboard sources for aurora permit", [officialCoverage, officialCoverageSecond], ["official_blackboard"]],
  ["Use only the C11 resource pack for aurora permit", [packCoverage, { ...packCoverage, resource_id: "pack-second", canonical_parent_id: "pack-second-parent" }], ["curated_pack"]],
  ["Use only my uploaded files for aurora permit", [localCoverage, { ...localCoverage, resource_id: "local-second", canonical_parent_id: "local-second-parent" }], ["user_import"]]
]) {
  const scored = [officialCoverage, officialCoverageSecond, packCoverage, localCoverage].sort((a, b) => b.score - a.score);
  assert.deepEqual(
    new Set(runCoverage(selected, scored, query, 2).map((item) => item.source_class)),
    new Set(expectedClasses),
    `Explicit single-source intent injected another source class: ${query}`
  );
}
assert.deepEqual(
  new Set(runCoverage(
    [officialCoverage, officialCoverageSecond],
    [officialCoverage, officialCoverageSecond, packCoverage, localCoverage],
    "Compare official Blackboard and C11 resource pack evidence for aurora permit",
    2
  ).map((item) => item.source_class)),
  new Set(["official_blackboard", "curated_pack"]),
  "Explicit official/pack comparison was not balanced across the requested sources."
);
assert.deepEqual(
  new Set(runCoverage(
    [officialCoverage, officialCoverageSecond],
    [officialCoverage, officialCoverageSecond, localCoverage, packCoverage],
    "Compare my uploaded files with official Blackboard sources for aurora permit",
    2
  ).map((item) => item.source_class)),
  new Set(["official_blackboard", "user_import"]),
  "Explicit official/local comparison was not balanced across the requested sources."
);

// Reindexing may preserve a last-known extracted body while the attachment is
// unavailable. It remains searchable with explicit stale provenance, loses to
// an otherwise identical fresh extraction, and cannot be confused with a body
// that is merely pending extraction.
const staleToken = "saffronreentry914";
const staleBody =
  `${staleToken} renewal desk: retain the signed receipt and present it during residence registration. ` +
  "The reentry instructions repeat this current evidence for deterministic retrieval. ".repeat(4);
const freshReindexed = resource("reindex-fresh", {
  title: "Reentry Instructions.pdf",
  source_class: "official_blackboard",
  source_trust: "authoritative",
  source_provenance: "university attachment",
  canonical_parent_id: "reindex-shared-parent"
});
const staleReindexed = resource("reindex-stale", {
  title: "Reentry Instructions.pdf",
  source_class: "official_blackboard",
  source_trust: "authoritative",
  source_provenance: "university attachment",
  canonical_parent_id: "reindex-shared-parent",
  body_verified: false,
  indexed_body_source: "last_known_extracted",
  body_revalidation_required: true,
  needs_body_hydration: true,
  hydration_token: "reindex-token"
});
const pendingReindexed = resource("reindex-pending", {
  title: "Pending Extraction.pdf",
  source_class: "official_blackboard",
  source_trust: "authoritative",
  source_provenance: "university attachment",
  canonical_parent_id: "reindex-pending-parent",
  body_verified: false,
  indexed_body_source: "pending_extraction",
  body_revalidation_required: true,
  needs_body_hydration: true,
  hydration_token: "pending-token"
});
setCorpus(
  [staleReindexed, pendingReindexed, freshReindexed],
  {
    [freshReindexed.id]: `${staleBody} freshness marker current.`,
    [staleReindexed.id]: `${staleBody} revalidation marker pending.`,
    [pendingReindexed.id]: `pendingonly773 ${staleBody}`
  }
);
const reindexRaw = runSearch(staleToken, { prepared: false });
assert.deepEqual(
  reindexRaw.slice(0, 2).map((item) => item.resource_id),
  [freshReindexed.id, staleReindexed.id],
  "A stale last-known extraction was collapsed or ranked above equivalent fresh evidence."
);
const staleHit = reindexRaw.find((item) => item.resource_id === staleReindexed.id);
assert.equal(staleHit?.has_body, true, "A preserved last-known extraction was not searchable.");
assert.equal(staleHit?.body_verified, false, "Stale evidence was presented as verified.");
assert.equal(staleHit?.indexed_body_source, "last_known_extracted", "Stale evidence provenance was lost.");
assert.equal(staleHit?.body_revalidation_required, true, "Stale evidence lost its revalidation requirement.");
assert.equal(staleHit?.search_body_evidence_state, "stale_last_known_extracted", "Stale evidence state was not explicit.");
assert.equal(
  runSearch(staleToken).slice(0, 2).map((item) => item.resource_id).join(","),
  `${freshReindexed.id},${staleReindexed.id}`,
  "Prepared sources did not prefer fresh official evidence to stale official evidence."
);
assert.equal(runSearch("pendingonly773", { prepared: false }).length, 0, "Pending-extraction text was searchable.");

// Two same-class documents with identical text but explicit different canonical
// parents remain independently retrievable and independently citable.
const parentResources = [
  resource("parent-a", { canonical_parent_id: "canonical-parent-a", source_trust: "authoritative" }),
  resource("parent-b", { canonical_parent_id: "canonical-parent-b", source_trust: "authoritative" })
];
const parentStore = corpusStore(parentResources, () => conflictBody);
setCorpus(parentResources, parentStore);
const parentHits = runSearch(conflictToken);
assert.deepEqual(
  new Set(parentHits.map(resultParent)),
  new Set(["canonical-parent-a", "canonical-parent-b"]),
  "Canonical-parent distinctions collapsed during posting or source deduplication."
);

// A pack document identity is scoped by pack ID. Two packs may intentionally
// carry the same document ID and both must survive the bounded parent pass.
const packParentToken = "packparent817";
const packParentResources = ["alpha", "beta"].map((packId) => resource(`pack-parent-${packId}`, {
  title: "Shared Pack Parent.pdf",
  source_pack_id: `pack-${packId}`,
  source_pack_document_id: "shared-document-id",
  source_pack_provenance: "Curated shared fixture",
  canonical_parent_id: ""
}));
setCorpus(
  packParentResources,
  corpusStore(packParentResources, () => `${packParentToken} shared pack document evidence. `.repeat(6))
);
assert.deepEqual(
  new Set(runSearch(packParentToken, { prepared: false }).map((item) => item.source_pack_id)),
  new Set(["pack-alpha", "pack-beta"]),
  "Logical parent identity collapsed the same document ID across different packs."
);

// A relevant hard negative can be retained for context, but it must not outrank
// the document containing all terms and the exact answer-bearing phrase.
const hardQuery = "orion gate permit code 731";
const hardRelevant = resource("hard-relevant", {
  title: "Arrival Requirements.pdf",
  source_pack_id: "hard-pack",
  source_pack_document_id: "hard-relevant-parent",
  source_pack_provenance: "Curated student guide",
  canonical_parent_id: ""
});
const hardNegative = resource("hard-negative", {
  title: "Orion Permit Archive.pdf",
  canonical_parent_id: "hard-negative-parent"
});
const hardResources = [hardRelevant, hardNegative];
const hardStore = {
  [hardRelevant.id]:
    "orion gate permit code 731: present the blue confirmation after arrival. " +
    "The checklist repeats the exact requirement for verification. ".repeat(4),
  [hardNegative.id]:
    "The orion permit archive contains historical summaries and unrelated committee minutes. " +
    "It does not state an arrival gate, a current code, or an operative requirement. ".repeat(3)
};
setCorpus(hardResources, hardStore);
assert.equal(runSearch(hardQuery)[0].resource_id, hardRelevant.id, "A hard negative outranked answer-bearing evidence.");

// Official volume must not crowd relevant curated-pack and user-import evidence
// out of a bounded result set.
const balanceQuery = "nebula housing deadline 2042";
const balancePack = resource("balance-pack", {
  title: "Nebula Housing Deadline 2042 Pack Guide.pdf",
  source_pack_id: "balance-pack",
  source_pack_document_id: "balance-pack-parent",
  source_pack_provenance: "Curated student guide",
  canonical_parent_id: ""
});
const balanceLocal = resource("balance-local", {
  title: "Nebula Housing Deadline 2042 Local Addendum.pdf",
  source_class: "user_import",
  source_trust: "personal",
  source_provenance: "manual upload",
  content_origin: "user_import",
  canonical_parent_id: "balance-local-parent"
});
const officialVolume = Array.from({ length: 24 }, (_value, index) =>
  resource(`balance-official-${String(index).padStart(2, "0")}`, {
    title: `Nebula Housing Deadline 2042 Official Form ${String(index).padStart(2, "0")}.pdf`,
    source_class: "official_blackboard",
    canonical_parent_id: `balance-official-parent-${index}`
  })
);
const balanceResources = [...officialVolume, balancePack, balanceLocal];
const balanceStore = corpusStore(balanceResources, (item) =>
  item.id.startsWith("balance-official-")
    ? "nebula housing deadline 2042 official form and processing instructions. ".repeat(4)
    : "nebula housing deadline 2042: submit the signed form before the stated cutoff. ".repeat(4)
);
setCorpus(balanceResources, balanceStore);
const balanced = runSearch(balanceQuery, { prepared: false, limit: 6 });
assert.deepEqual(
  new Set(balanced.map((item) => item.source_class)),
  new Set(["official_blackboard", "curated_pack", "user_import"]),
  "Relevant local or curated-pack evidence was displaced by official-source volume."
);

// Repeated queries, corpus-order permutations, and irrelevant corpus growth must
// leave the answer-bearing ordering stable.
const stabilityCorpus = [...conflictResources, hardRelevant, hardNegative];
const stabilityStore = { ...conflictStore, ...hardStore };
setCorpus(stabilityCorpus, stabilityStore);
const stabilityQuery = `official ${conflictToken} boarding policy`;
const stableBaseline = runSearch(stabilityQuery).map(resultIdentity);
assert.deepEqual(runSearch(stabilityQuery).map(resultIdentity), stableBaseline, "Warm repeated search order changed.");
for (const salt of [7, 19, 41]) {
  setCorpus(deterministicPermutation(stabilityCorpus, salt), stabilityStore);
  assert.deepEqual(
    runSearch(stabilityQuery).map(resultIdentity),
    stableBaseline,
    `Search order changed under deterministic corpus permutation ${salt}.`
  );
}

const irrelevantResources = Array.from({ length: 96 }, (_value, index) =>
  resource(`irrelevant-${String(index).padStart(3, "0")}`, {
    title: `Unrelated Archive ${index}.pdf`,
    canonical_parent_id: `irrelevant-parent-${index}`
  })
);
const irrelevantStore = corpusStore(irrelevantResources, (_item, index) =>
  `archive topic ${index} cafeteria map printer setup and historical newsletter. `.repeat(4)
);
setCorpus([...stabilityCorpus, ...irrelevantResources], { ...stabilityStore, ...irrelevantStore });
const grownRelevantOrder = runSearch(stabilityQuery)
  .filter((item) => conflictResources.some((resourceItem) => resourceItem.id === item.resource_id))
  .map(resultIdentity);
assert.deepEqual(grownRelevantOrder, stableBaseline, "Irrelevant corpus growth changed relevant-source ordering or recall.");

// Public Schwarzman C11 resources provide known parent and answer-evidence gates.
const packRoot = new URL("../resource-packs/schwarzman-c11/", import.meta.url);
const packManifest = JSON.parse(fs.readFileSync(new URL("pack.json", packRoot), "utf8"));
const packResources = [];
const packStore = {};
for (const raw of packManifest.resources || []) {
  const id = `growth_pack_${raw.id}`.slice(0, 120);
  packResources.push({
    id,
    type: raw.type || "document",
    title: raw.document_title || raw.title,
    url: new URL(raw.url || raw.text_url || "", "chrome-extension://growth/resource-packs/schwarzman-c11/pack.json").href,
    page_url: "chrome-extension://growth/resource-packs/schwarzman-c11/pack.json",
    page_title: raw.page_title || packManifest.title,
    section: raw.section || packManifest.title,
    context: raw.description || packManifest.description || "",
    source_pack_id: packManifest.id,
    source_pack_title: packManifest.title,
    source_pack_document_id: raw.document_id || raw.id,
    source_pack_document_title: raw.document_title || raw.title,
    source_pack_page_range: raw.page_range || "",
    source_pack_provenance: raw.provenance || ""
  });
  packStore[id] = fs.readFileSync(new URL(raw.text_url, packRoot), "utf8");
}

const publicAcademicCalendarId = "growth-official-academic-calendar";
const publicIndexedResources = [resource(publicAcademicCalendarId, {
  type: "pdf",
  title: "Slides_C11 Academic Webinar.pdf",
  url: "https://lms.sc.tsinghua.edu.cn/courses/C11/Slides_C11_Academic_Webinar.pdf",
  page_url: "https://lms.sc.tsinghua.edu.cn/courses/C11/academics",
  page_title: "C11 Academic Webinar",
  section: "Official Blackboard academic materials",
  source_class: "official_blackboard",
  collection_kind: "blackboard",
  content_origin: "blackboard",
  canonical_parent_id: "official-academic-calendar",
  authority_verified: true,
  source_authority_verified: true
})];
const publicIndexedStore = {
  [publicAcademicCalendarId]:
    "Page 9: After the orientation and course-registration process, classes begin on September 14th."
};

const publicCases = [
  { query: "Can the dining hall accommodate halal, gluten-free, and kosher meals?", parent: "student-life-webinar", evidence: [["kosher"]] },
  { query: "How do I pay for the Beijing subway with Alipay?", parent: "beijing-transportation-workshop", evidence: [["alipay"]] },
  { query: "When do classes begin after orientation?", parent: "official-academic-calendar", evidence: [["september 14"]] },
  { query: "How many checked bags are allowed on the inbound flight?", parent: "student-life-webinar", evidence: [["23 kilograms"]] },
  { query: "What approvals and documentation do I need before spending money on a student event?", parent: "survival-guide", evidence: [["proposal for funding"], ["written approval"], ["fapiao"]] },
  { query: "Which hospitals bill the insurance provider directly, and what paperwork should I retain after visiting Tsinghua University Hospital?", parent: "survival-guide", evidence: [["beijing united family"], ["oasis"], ["fapiao"], ["doctor"]] },
  { query: "What are the visitor rules, and what student clubs can I join?", parent: "student-life-webinar", evidence: [["guest", "visitor"], ["club"]] }
];

function evaluatePublicCases(resources) {
  setCorpus([...resources, ...publicIndexedResources], { ...packStore, ...publicIndexedStore });
  return publicCases.map((testCase) => {
    const sources = runSearch(testCase.query);
    const parents = sources.map(resultParent);
    const matched = sources.find((source) => resultParent(source) === testCase.parent);
    const text = String(matched?.text || "").toLowerCase();
    return {
      parentRank: parents.indexOf(testCase.parent) + 1,
      evidencePass: testCase.evidence.every((alternatives) => alternatives.some((phrase) => text.includes(phrase))),
      ordering: parents
    };
  });
}

const publicBaseline = evaluatePublicCases(packResources);
const publicParentPasses = publicBaseline.filter((item) => item.parentRank > 0 && item.parentRank <= 3).length;
const publicEvidencePasses = publicBaseline.filter((item) => item.evidencePass).length;
assert.equal(publicParentPasses, publicCases.length, "Public-fixture parent recall@3 fell below 100%.");
assert.equal(publicEvidencePasses, publicCases.length, "Public-fixture answer-evidence recall fell below 100%.");
for (const ordered of [
  [...packResources].reverse(),
  deterministicPermutation(packResources, 73)
]) {
  const variant = evaluatePublicCases(ordered);
  assert.deepEqual(
    variant.map((item) => item.ordering),
    publicBaseline.map((item) => item.ordering),
    "Public-fixture source ordering changed when the corpus input order changed."
  );
}

// A same-content flood with unique provenance must remain strictly bounded.
const postingFloodToken = "postingflood921";
const postingFloodResources = Array.from({ length: PERFORMANCE_GATES.postingFloodResources }, (_value, index) =>
  resource(`posting-flood-${index}`, {
    title: "Posting Flood.pdf",
    source_provenance: `unique-provenance-${index}`,
    canonical_parent_id: `posting-flood-parent-${index}`
  })
);
const postingFloodStore = corpusStore(postingFloodResources, () =>
  `${postingFloodToken} bounded posting representative evidence. `.repeat(6)
);
setCorpus(postingFloodResources, postingFloodStore);
const postingFloodDiagnostics = getSearchDiagnostics(postingFloodToken);
assert.ok(
  postingFloodDiagnostics.maximum_posting_group_representatives <= PERFORMANCE_GATES.postingRepresentativeCap,
  "A same-content posting group exceeded the hard representative cap."
);
assert.ok(
  postingFloodDiagnostics.candidates <= PERFORMANCE_GATES.postingRepresentativeCap,
  "Unique provenance strings expanded the bounded candidate set."
);

// Existing production-shaped pack corpus, increased to 1,200 resources.
const performanceResources = packResources.map((item) => ({ ...item }));
const performanceStore = { ...packStore };
for (let index = performanceResources.length; index < PERFORMANCE_GATES.existingResources; index += 1) {
  const id = `existing-managed-${String(index).padStart(4, "0")}`;
  const isLocal = index % 11 === 0;
  performanceResources.push(resource(id, {
    type: index % 5 === 0 ? "page" : "document",
    title: `Existing Course Archive ${index}.pdf`,
    section: `Course section ${index % 37}`,
    page_title: `Managed Blackboard course ${index % 23}`,
    source_provenance: `existing-index-batch-${index % 71}`,
    canonical_parent_id: `existing-managed-parent-${index}`,
    ...(isLocal ? {
      collection_kind: "user_import",
      content_origin: "user_import",
      source_class: "official_blackboard"
    } : {})
  }));
  performanceStore[id] =
    `existingarchive${index} course catalog record ${index % 211} contains unrelated module navigation and historical notes.`;
}
assert.equal(performanceResources.length, PERFORMANCE_GATES.existingResources);
const performanceBaseQueries = [
  "Can I enter China before August 21 if I book my own flight?",
  "How many checked bags are allowed on the inbound flight?",
  "Can the dining hall accommodate halal, gluten-free, and kosher meals?",
  "Can I choose a group capstone or an individual capstone?",
  "How do I pay for the Beijing subway with Alipay?",
  "Any tips for living in Beijing?",
  "How should I travel in Beijing?",
  "Any recommendations for how to navigate travel in the program?",
  "Any advice for getting around during the program?",
  "What should I know about transportation once I arrive?",
  "What is WeChat used for besides messages, including payments and ordering food?",
  "What are the visitor rules during orientation and when must guests leave?",
  "When must an X1 visa be converted to a residence permit?",
  "What do I need for my Residence visa?",
  "How is the stipend paid after I open a Bank of China account?",
  "Which subway stations are closest to Tsinghua and the college?",
  "What apps should I use for ride hailing and everyday payments in China?",
  "Do guests have to leave the college by 10:30 p.m.?",
  "Are kosher meals available in the college dining hall?",
  "How often do Beijing subway trains arrive and what does a normal trip cost?",
  "When do classes begin after orientation?",
  "What approvals and documentation do I need before spending money on a student event?",
  "Which hospitals bill the insurance provider directly, and what paperwork should I retain after visiting Tsinghua University Hospital?"
];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function benchmarkWarmQueries(queries, rounds = 3) {
  for (const query of queries) runSearch(query, { prepared: false, limit: 8 });
  const roundAverageMs = [];
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now();
    for (const query of queries) runSearch(query, { prepared: false, limit: 8 });
    roundAverageMs.push((performance.now() - started) / Math.max(1, queries.length));
  }
  return { roundAverageMs, medianMs: median(roundAverageMs) };
}

const warmQueries = performanceBaseQueries.map(productionRetrievalQuery);
const frozenResources = [];
const frozenStore = {};
for (let copy = 0; copy < PERFORMANCE_GATES.frozenCopies; copy += 1) {
  for (const item of packResources) {
    const id = `${item.id}_frozen_${copy}`;
    frozenResources.push({
      ...item,
      id,
      url: `${item.url}?frozen_copy=${copy}`,
      source_pack_id: `${item.source_pack_id}-frozen-${copy}`
    });
    frozenStore[id] = packStore[item.id];
  }
}
assert.equal(frozenResources.length, packResources.length * PERFORMANCE_GATES.frozenCopies);
setCorpus(frozenResources, frozenStore);
const frozenBenchmark = benchmarkWarmQueries(warmQueries);
const frozenWarmGateMs = PERFORMANCE_GATES.frozenWarmMedianMs *
  Math.max(1, frozenResources.length / PERFORMANCE_GATES.frozenReferenceResources);
assert.ok(
  frozenBenchmark.medianMs <= frozenWarmGateMs,
  `Frozen ${frozenResources.length}-resource warm median exceeded ${frozenWarmGateMs.toFixed(1)} ms: ${JSON.stringify(frozenBenchmark)}`
);

setCorpus(performanceResources, performanceStore);
const existingBenchmark = benchmarkWarmQueries(warmQueries);
const existingDiagnostics = getSearchDiagnostics(warmQueries[0]);
assert.ok(
  existingBenchmark.medianMs <= PERFORMANCE_GATES.existingWarmMedianMs,
  `Warm median exceeded the generous 1,200-resource ceiling: ${JSON.stringify(existingBenchmark)}`
);
assert.ok(
  existingDiagnostics.maximum_posting_group_representatives <= PERFORMANCE_GATES.postingRepresentativeCap,
  "Production-shaped posting representatives exceeded the hard cap."
);

function largeSourceOverrides(sourceClass, id, parent) {
  if (sourceClass === "curated_pack") {
    return {
      source_pack_id: `large-pack-${Number.parseInt(id.replace(/\D/g, "") || "0", 10) % 31}`,
      source_pack_document_id: parent,
      source_pack_provenance: "Curated corpus growth fixture",
      source_class: "official_blackboard",
      canonical_parent_id: ""
    };
  }
  if (sourceClass === "user_import") {
    return {
      collection_kind: "user_import",
      content_origin: "user_import",
      source_class: "official_blackboard",
      canonical_parent_id: parent
    };
  }
  return { source_class: "official_blackboard", canonical_parent_id: parent };
}

const largeCases = [
  { slug: "quasar", query: "What is the quasar residence permit code?", answer: "633", sourceClass: "official_blackboard" },
  { slug: "lyra", query: "Which lyra dining allergy protocol applies?", answer: "842", sourceClass: "curated_pack" },
  { slug: "nova", query: "What is the nova club reimbursement approval?", answer: "715", sourceClass: "user_import" },
  { slug: "orion", query: "Which orion visitor desk rule applies?", answer: "926", sourceClass: "official_blackboard" },
  { slug: "vega", query: "What is the vega transit payment procedure?", answer: "381", sourceClass: "curated_pack" },
  { slug: "atlas", query: "Which atlas insurance receipt requirement applies?", answer: "407", sourceClass: "user_import" }
].map((item, index) => ({ ...item, id: `large-gold-${item.slug}-${index}`, parent: `large-gold-parent-${item.slug}` }));

const mixedResources = largeCases.map((testCase, index) => resource(testCase.id, {
  title: `${testCase.slug} ${testCase.query.replace(/^(?:what|which|is|the)\s+/i, "")}.pdf`,
  source_provenance: `known-answer-${testCase.slug}`,
  ...largeSourceOverrides(testCase.sourceClass, String(index), testCase.parent)
}));
const mixedStore = Object.fromEntries(largeCases.map((testCase) => [
  testCase.id,
  `${testCase.slug} answer-bearing policy states ${testCase.answer} as the current requirement. ` +
    "Signed primary guidance applies; retain the original evidence for verification. ".repeat(3)
]));
for (let index = mixedResources.length; index < PERFORMANCE_GATES.mixedBaseResources; index += 1) {
  const sourceClass = ["official_blackboard", "curated_pack", "user_import"][index % 3];
  const id = `large-base-${String(index).padStart(5, "0")}`;
  const parent = `large-base-parent-${index}`;
  mixedResources.push(resource(id, {
    title: `Archive Topic ${index % 211} Record ${index}.pdf`,
    source_provenance: `archive-batch-${index % 173}`,
    ...largeSourceOverrides(sourceClass, String(index), parent)
  }));
  mixedStore[id] = `archivecode${index} campus record topic ${index % 211} contains unrelated historical scheduling notes and catalog metadata.`;
}
assert.equal(mixedResources.length, PERFORMANCE_GATES.mixedBaseResources);

function evaluateLargeCases(resources, store) {
  setCorpus(resources, store);
  const rows = largeCases.map((testCase) => {
    const results = runSearch(testCase.query);
    const parents = results.map(resultParent);
    const rank = parents.indexOf(testCase.parent) + 1;
    return {
      rank,
      top1: rank === 1,
      recallAt3: rank > 0 && rank <= 3,
      ordering: parents,
      diagnostics: getSearchDiagnostics(testCase.query)
    };
  });
  return {
    rows,
    top1: rows.filter((row) => row.top1).length / rows.length,
    recallAt3: rows.filter((row) => row.recallAt3).length / rows.length,
    mrr: rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / rows.length,
    maximumCandidates: Math.max(...rows.map((row) => row.diagnostics.candidates)),
    maximumPostingRepresentatives: Math.max(...rows.map((row) => row.diagnostics.maximum_posting_group_representatives))
  };
}

const largeBaseline = evaluateLargeCases(mixedResources, mixedStore);
assert.deepEqual(
  { top1: largeBaseline.top1, recallAt3: largeBaseline.recallAt3, mrr: largeBaseline.mrr },
  { top1: 1, recallAt3: 1, mrr: 1 },
  "The 5,000-resource known-answer baseline was not perfect."
);

const largeIrrelevantResources = Array.from({ length: PERFORMANCE_GATES.irrelevantGrowthResources }, (_value, index) => {
  const id = `large-irrelevant-${String(index).padStart(4, "0")}`;
  return resource(id, {
    title: `Unrelated Facilities Archive ${index}.pdf`,
    source_provenance: `irrelevant-batch-${index % 89}`,
    ...largeSourceOverrides(["official_blackboard", "curated_pack", "user_import"][index % 3], String(index + 6000), `large-irrelevant-parent-${index}`)
  });
});
const largeIrrelevantStore = corpusStore(largeIrrelevantResources, (_item, index) =>
  `facilityarchive${index} printer cafeteria landscaping inventory and unrelated historical minutes.`
);
const afterIrrelevant = evaluateLargeCases(
  [...mixedResources, ...largeIrrelevantResources],
  { ...mixedStore, ...largeIrrelevantStore }
);
assert.ok(afterIrrelevant.top1 >= largeBaseline.top1 && afterIrrelevant.recallAt3 >= largeBaseline.recallAt3 && afterIrrelevant.mrr >= largeBaseline.mrr,
  "Adding 1,000 irrelevant resources regressed top-1, recall@3, or MRR.");

const largeHardNegativeResources = Array.from({ length: PERFORMANCE_GATES.hardNegativeGrowthResources }, (_value, index) => {
  const testCase = largeCases[index % largeCases.length];
  const id = `large-hard-negative-${String(index).padStart(4, "0")}`;
  return resource(id, {
    title: `${testCase.slug} archived draft ${index}.pdf`,
    source_provenance: `hard-negative-batch-${index % 97}`,
    ...largeSourceOverrides(["official_blackboard", "curated_pack", "user_import"][index % 3], String(index + 7000), `large-hard-negative-parent-${index}`)
  });
});
const largeHardNegativeStore = corpusStore(largeHardNegativeResources, (_item, index) => {
  const testCase = largeCases[index % largeCases.length];
  return `${testCase.slug} ${testCase.query.replace(/[?]/g, "")} incorrect superseded guess 534 is not the current answer. ` +
    "This archived draft is retained only as a negative historical example.";
});
const finalLargeResources = [...mixedResources, ...largeIrrelevantResources, ...largeHardNegativeResources];
const finalLargeStore = { ...mixedStore, ...largeIrrelevantStore, ...largeHardNegativeStore };
const afterHardNegatives = evaluateLargeCases(finalLargeResources, finalLargeStore);
assert.ok(afterHardNegatives.top1 >= largeBaseline.top1 && afterHardNegatives.recallAt3 >= largeBaseline.recallAt3 && afterHardNegatives.mrr >= largeBaseline.mrr,
  "Adding 1,000 hard negatives regressed top-1, recall@3, or MRR.");
assert.ok(afterHardNegatives.maximumCandidates <= PERFORMANCE_GATES.largeCandidateCeiling,
  `Large-corpus candidate ceiling exceeded: ${afterHardNegatives.maximumCandidates}.`);
assert.ok(afterHardNegatives.maximumPostingRepresentatives <= PERFORMANCE_GATES.postingRepresentativeCap,
  "Large-corpus posting representative cap was exceeded.");

const permutedLarge = evaluateLargeCases(deterministicPermutation(finalLargeResources, 149), finalLargeStore);
assert.deepEqual(
  permutedLarge.rows.map((row) => row.ordering),
  afterHardNegatives.rows.map((row) => row.ordering),
  "The 7,000-resource result ordering changed under corpus permutation."
);

const largeWarmQueries = largeCases.map((testCase) => testCase.query);
const largeBenchmark = benchmarkWarmQueries(largeWarmQueries);
const environmentNormalizedLargeCeilingMs = Math.max(180, existingBenchmark.medianMs * 6);
assert.ok(
  largeBenchmark.medianMs <= environmentNormalizedLargeCeilingMs,
  `Environment-normalized large-corpus median exceeded ${environmentNormalizedLargeCeilingMs.toFixed(1)} ms: ` +
    JSON.stringify(largeBenchmark)
);
const totalMs = performance.now() - suiteStarted;
assert.ok(totalMs <= PERFORMANCE_GATES.maximumSuiteMs,
  `Corpus-growth check exceeded the generous ${PERFORMANCE_GATES.maximumSuiteMs} ms suite ceiling: ${totalMs.toFixed(1)} ms.`);

console.log(
  "corpus-growth-check passed " +
    JSON.stringify({
      cache_order_variants: 2,
      exact_conflict_source_classes: 3,
      stale_reindex_provenance_cases: 1,
      canonical_parents_retained: 2,
      deterministic_permutations: 3,
      irrelevant_documents_added: irrelevantResources.length,
      official_volume_documents: officialVolume.length,
      public_fixture_cases: publicCases.length,
      public_parent_recall_at_3: publicParentPasses / publicCases.length,
      public_evidence_recall: publicEvidencePasses / publicCases.length,
      public_order_stability: 1,
      posting_flood: {
        resources: postingFloodResources.length,
        diagnostics: postingFloodDiagnostics
      },
      large_growth: {
        base_resources: mixedResources.length,
        irrelevant_added: largeIrrelevantResources.length,
        hard_negatives_added: largeHardNegativeResources.length,
        final_resources: finalLargeResources.length,
        baseline: { top1: largeBaseline.top1, recall_at_3: largeBaseline.recallAt3, mrr: largeBaseline.mrr },
        after_irrelevant: { top1: afterIrrelevant.top1, recall_at_3: afterIrrelevant.recallAt3, mrr: afterIrrelevant.mrr },
        after_hard_negatives: {
          top1: afterHardNegatives.top1,
          recall_at_3: afterHardNegatives.recallAt3,
          mrr: afterHardNegatives.mrr,
          maximum_candidates: afterHardNegatives.maximumCandidates,
          maximum_posting_representatives: afterHardNegatives.maximumPostingRepresentatives
        },
        permutation_stable: true
      },
      performance: {
        frozen_resources: frozenResources.length,
        frozen_warm_round_average_ms: frozenBenchmark.roundAverageMs.map((value) => Number(value.toFixed(1))),
        frozen_warm_median_ms: Number(frozenBenchmark.medianMs.toFixed(1)),
        frozen_warm_median_gate_ms: frozenWarmGateMs,
        existing_resources: performanceResources.length,
        existing_warm_round_average_ms: existingBenchmark.roundAverageMs.map((value) => Number(value.toFixed(1))),
        existing_warm_median_ms: Number(existingBenchmark.medianMs.toFixed(1)),
        historical_frozen_960_warm_average_ms_reference: 37,
        ratio_to_historical_reference: Number((existingBenchmark.medianMs / 37).toFixed(2)),
        large_warm_round_average_ms: largeBenchmark.roundAverageMs.map((value) => Number(value.toFixed(1))),
        large_warm_median_ms: Number(largeBenchmark.medianMs.toFixed(1)),
        environment_normalized_large_ceiling_ms: Number(environmentNormalizedLargeCeilingMs.toFixed(1)),
        total_ms: Number(totalMs.toFixed(1)),
        existing_search_diagnostics: existingDiagnostics,
        gates: PERFORMANCE_GATES
      },
      network_calls: 0
    })
);
