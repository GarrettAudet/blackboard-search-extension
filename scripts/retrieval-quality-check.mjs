import fs from "node:fs";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const packRoot = new URL("../resource-packs/schwarzman-c11/", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("pack.json", packRoot), "utf8"));
const resources = [];
const contentStore = {};

for (const raw of manifest.resources || []) {
  const id = ("pack_" + manifest.id + "_" + raw.id).slice(0, 120);
  const url = new URL(raw.url || raw.text_url || "", "chrome-extension://quality/resource-packs/schwarzman-c11/pack.json").href;
  resources.push({
    id,
    type: raw.type || "document",
    title: raw.document_title || raw.title,
    url,
    page_url: "chrome-extension://quality/resource-packs/schwarzman-c11/pack.json",
    page_title: raw.page_title || manifest.title,
    section: raw.section || manifest.title,
    context: raw.description || manifest.description || "",
    source_pack_id: manifest.id,
    source_pack_title: manifest.title,
    source_pack_version: manifest.version,
    source_pack_document_id: raw.document_id || raw.id,
    source_pack_document_title: raw.document_title || raw.title,
    source_pack_page_range: raw.page_range || "",
    source_pack_provenance: raw.provenance || ""
  });
  contentStore[id] = fs.readFileSync(new URL(raw.text_url, packRoot), "utf8");
}
const officialAcademicCalendarId = "bb-official-academic-calendar";
resources.push({
  id: officialAcademicCalendarId,
  type: "pdf",
  title: "Slides_C11 Academic Webinar.pdf",
  url: "https://lms.sc.tsinghua.edu.cn/courses/C11/Slides_C11_Academic_Webinar.pdf",
  page_url: "https://lms.sc.tsinghua.edu.cn/courses/C11/academics",
  page_title: "C11 Academic Webinar",
  section: "Official Blackboard academic materials",
  context: "Official indexed Blackboard academic-calendar slides.",
  source_class: "official_blackboard",
  collection_kind: "blackboard",
  content_origin: "blackboard",
  canonical_parent_id: "official-academic-calendar",
  authority_verified: true,
  source_authority_verified: true,
  body_verified: true,
  indexed_body_source: "extracted"
});
contentStore[officialAcademicCalendarId] =
  "Page 9: After the orientation and course-registration process, classes begin on September 14th.";


const modulePaths = [
  new URL("../lib/answer-formatting.js", import.meta.url),
  new URL("../lib/llm-client.js", import.meta.url),
  new URL("../lib/search-index.js", import.meta.url)
];
const moduleSource = modulePaths.map((file) => fs.readFileSync(file, "utf8")).join("\n\n");
const sidepanelSource = fs.readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");
const runtimeStart = sidepanelSource.indexOf("chrome.runtime.onMessage.addListener");
const testableSource = moduleSource + "\n\n" + sidepanelSource.slice(0, runtimeStart);

function mockElement() {
  const element = {
    textContent: "",
    value: "",
    disabled: false,
    className: "",
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
    content: null,
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
  fetch: async () => { throw new Error("Network access is forbidden in retrieval-quality-check."); },
  document: {
    getElementById() { return mockElement(); },
    createElement() { return mockElement(); }
  },
  chrome: {
    runtime: {
      sendMessage() {},
      getManifest() { return { version: "quality-test" }; },
      getURL(path) { return "chrome-extension://quality/" + path; },
      onMessage: { addListener() {} }
    },
    tabs: { async create() {} },
    storage: { local: { async get() { return {}; }, async set() {} } }
  },
  qualityResources: resources,
  qualityContentStore: contentStore
};

const cases = [
  { query: "Can I enter China before August 21 if I book my own flight?", expected: ["student-life-webinar"], evidence: ["august 21"] },
  { query: "How many checked bags are allowed on the inbound flight?", expected: ["student-life-webinar"], evidence: ["23 kilograms"] },
  { query: "Can the dining hall accommodate halal, gluten-free, and kosher meals?", expected: ["student-life-webinar"], evidence: ["kosher"] },
  { query: "Can I choose a group capstone or an individual capstone?", expected: ["academic-webinar"], evidence: ["individual capstone"] },
  { query: "How do I pay for the Beijing subway with Alipay?", expected: ["beijing-transportation-workshop"], evidence: ["alipay"] },
  {
    query: "Any tips for living in Beijing?",
    expected: ["life-in-china-webinar", "survival-guide", "beijing-transportation-workshop"],
    evidence: ["wechat"],
    forbiddenTop3: ["international-logistics-webinar", "academic-webinar", "student-life-webinar"]
  },
  { query: "How should I travel in Beijing?", expected: ["beijing-transportation-workshop"], evidence: ["four ways"] },
  {
    query: "Any recommendations for how to navigate travel in the program?",
    expected: ["beijing-transportation-workshop", "student-life-webinar", "life-in-china-webinar", "survival-guide"]
  },
  {
    query: "Any advice for getting around during the program?",
    expected: ["beijing-transportation-workshop", "student-life-webinar", "life-in-china-webinar", "survival-guide"]
  },
  { query: "What should I know about transportation once I arrive?", expected: ["beijing-transportation-workshop"] },
  { query: "What is WeChat used for besides messages, including payments and ordering food?", expected: ["life-in-china-webinar"], evidence: ["restaurants"] },
  { query: "What are the visitor rules during orientation and when must guests leave?", expected: ["student-life-webinar"], evidence: ["1030"] },
  { query: "When must an X1 visa be converted to a residence permit?", expected: ["international-logistics-webinar", "survival-guide"], evidence: ["30 days"] },
  { query: "What do I need for my Residence visa?", expected: ["international-logistics-webinar", "survival-guide"], evidence: ["30 days"] },
  { query: "How is the stipend paid after I open a Bank of China account?", expected: ["international-logistics-webinar"], evidence: ["two payments"] },
  { query: "Which subway stations are closest to Tsinghua and the college?", expected: ["beijing-transportation-workshop"], evidence: ["wudaokou"] },
  { query: "What apps should I use for ride hailing and everyday payments in China?", expected: ["life-in-china-webinar", "beijing-transportation-workshop", "survival-guide"], evidence: ["didi"] },
  { query: "Do guests have to leave the college by 10:30 p.m.?", expected: ["student-life-webinar"], evidence: ["1030"] },
  { query: "Are kosher meals available in the college dining hall?", expected: ["student-life-webinar"], evidence: ["kosher"] },
  { query: "How often do Beijing subway trains arrive and what does a normal trip cost?", expected: ["beijing-transportation-workshop"], evidence: ["2 to 5 minutes"] },
  { query: "When do classes begin after orientation?", expected: ["official-academic-calendar"], evidence: ["september 14"] },
  {
    query: "What approvals and documentation do I need before spending money on a student event?",
    expected: ["survival-guide"],
    evidence: ["proposal for funding", "written approval", "fapiao"]
  },
  {
    query: "Which hospitals bill the insurance provider directly, and what paperwork should I retain after visiting Tsinghua University Hospital?",
    expected: ["survival-guide"],
    evidence: ["beijing united family", "oasis", "fapiao", "doctor"]
  }
];
context.qualityCases = cases;

vm.createContext(context);
vm.runInContext(testableSource, context);
vm.runInContext(`
state.resources = qualityResources;
state.contentStore = qualityContentStore;
state.transcripts = [];
state.settings = { hasApiKey: false };
invalidateSearchIndexCache();

function documentIdForQuality(source) {
  return source?.source_pack_document_id || source?.canonical_parent_id || sourceDedupeKey(source || {});
}

const details = qualityCases.map((testCase) => {
  const retrievalQuery = enhanceRetrievalQueryForIntent(
    testCase.query,
    testCase.query,
    defaultRagPlan(testCase.query, testCase.query)
  );
  const sources = prepareAnswerSources(searchIndex(retrievalQuery), retrievalQuery);
  const documentIds = sources.map(documentIdForQuality);
  const rank = documentIds.findIndex((id) => testCase.expected.includes(id)) + 1;
  const matchedSource = sources.find((source) => testCase.expected.includes(documentIdForQuality(source)));
  const matchedText = normalizeText(matchedSource?.text || "");
  const evidenceMissing = (testCase.evidence || []).filter((phrase) => !matchedText.includes(normalizeText(phrase)));
  const forbiddenTopThree = documentIds.slice(0, 3).filter((id) => (testCase.forbiddenTop3 || []).includes(id));

  const profile = searchQueryProfile(retrievalQuery);
  const exhaustiveScored = cachedSearchCorpus(retrievalQuery).docs
    .map((doc) => ({ ...doc, score: scoreDoc(retrievalQuery, doc, profile) }))
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score);
  const exhaustiveSources = prepareAnswerSources(
    diversifySearchResults(exhaustiveScored, retrievalQuery).slice(0, 10),
    retrievalQuery
  );
  const exhaustiveTopDocumentId = documentIdForQuality(exhaustiveSources[0]);

  return {
    query: testCase.query,
    retrievalQuery,
    documentIds,
    rank,
    evidenceMissing,
    forbiddenTopThree,
    exhaustiveTopDocumentId,
    candidatePreservesExhaustiveTop: !exhaustiveTopDocumentId || documentIds.slice(0, 3).includes(exhaustiveTopDocumentId),
    duplicateKeys: sources.length - new Set(sources.map(sourceDedupeKey)).size,
    titles: sources.map(cleanSourceTitle)
  };
});

const multiQuery = "What are the visitor rules and what student clubs can I join?";
const multiSources = prepareAnswerSources(searchIndex(multiQuery), multiQuery);
const studentLife = multiSources.find((source) => source.source_pack_document_id === "student-life-webinar");
const uncited = enforceCitedAnswer(
  "What are the visitor rules during orientation?",
  { text: "Guests have restrictions during orientation.", sources: multiSources },
  multiSources,
  "visitor rules orientation guests"
);

const adviceQuery = "Any advice for living in Beijing";
const adviceRetrievalQuery = enhanceRetrievalQueryForIntent(adviceQuery, adviceQuery, defaultRagPlan(adviceQuery));
const adviceSources = prepareAnswerSources(searchIndex(adviceRetrievalQuery), adviceRetrievalQuery);
const adviceAnswer = buildDirectAnswer(adviceQuery, adviceSources);
const travelQuery = "How should I travel in Beijing";
const travelRetrievalQuery = enhanceRetrievalQueryForIntent(travelQuery, travelQuery, defaultRagPlan(travelQuery));
const travelSources = prepareAnswerSources(searchIndex(travelRetrievalQuery), travelRetrievalQuery);
const travelAnswer = buildDirectAnswer(travelQuery, travelSources);
const programTravelQuery = "Any recommendations for how to navigate travel in the program?";
const programTravelRetrievalQuery = enhanceRetrievalQueryForIntent(programTravelQuery, programTravelQuery, defaultRagPlan(programTravelQuery));
const programTravelSources = prepareAnswerSources(searchIndex(programTravelRetrievalQuery), programTravelRetrievalQuery);
const programTravelAnswer = buildDirectAnswer(programTravelQuery, programTravelSources);
const directGrounding = {
  advice: isUsableCitedAnswer(adviceQuery, adviceAnswer, adviceSources, adviceRetrievalQuery),
  travel: isUsableCitedAnswer(travelQuery, travelAnswer, travelSources, travelRetrievalQuery),
  programTravel: isUsableCitedAnswer(programTravelQuery, programTravelAnswer, programTravelSources, programTravelRetrievalQuery)
};
const directRouting = {
  advice: hasDeterministicDirectAnswerIntent(adviceQuery),
  travel: hasDeterministicDirectAnswerIntent(travelQuery),
  programTravel: hasDeterministicDirectAnswerIntent(programTravelQuery),
  specificSubwayPayment: hasDeterministicDirectAnswerIntent("How do I pay for the Beijing subway with Alipay?")
};

const originalResources = state.resources;
const originalContentStore = state.contentStore;
const scaledResources = [];
const scaledContentStore = {};
for (let copy = 0; copy < 40; copy += 1) {
  for (const resource of originalResources) {
    const id = resource.id + "_scale_" + copy;
    scaledResources.push({
      ...resource,
      id,
      url: resource.url + "?scale=" + copy,
      source_pack_id: resource.source_pack_id + "-scale-" + copy
    });
    scaledContentStore[id] = originalContentStore[resource.id];
  }
}
state.resources = scaledResources;
state.contentStore = scaledContentStore;
invalidateSearchIndexCache();
const coldStart = performance.now();
searchIndex(enhanceRetrievalQueryForIntent(qualityCases[0].query, qualityCases[0].query, defaultRagPlan(qualityCases[0].query)));
const coldMs = performance.now() - coldStart;
const warmStart = performance.now();
for (const testCase of qualityCases) {
  searchIndex(enhanceRetrievalQueryForIntent(testCase.query, testCase.query, defaultRagPlan(testCase.query)));
}
const warmTotalMs = performance.now() - warmStart;
const warmAverageMs = warmTotalMs / qualityCases.length;

state.resources = originalResources;
state.contentStore = originalContentStore;
invalidateSearchIndexCache();

globalThis.__quality = {
  details,
  multi: {
    sourceCount: multiSources.filter((source) => source.source_pack_document_id === "student-life-webinar").length,
    matchedChunkCount: studentLife?.matched_chunk_count || 0,
    matchedResourceIds: studentLife?.matched_resource_ids || [],
    pageRange: studentLife?.source_pack_page_range || "",
    text: studentLife?.text || ""
  },
  uncited,
  direct: {
    advice: {
      text: adviceAnswer?.text || "",
      documentIds: (adviceAnswer?.sources || []).map(documentIdForQuality)
    },
    travel: {
      text: travelAnswer?.text || "",
      documentIds: (travelAnswer?.sources || []).map(documentIdForQuality)
    },
    programTravel: {
      text: programTravelAnswer?.text || "",
      documentIds: (programTravelAnswer?.sources || []).map(documentIdForQuality)
    },
    routing: directRouting,
    grounding: directGrounding
  },
  performance: {
    resourceCount: scaledResources.length,
    coldMs,
    warmAverageMs
  }
};
`, context);

const quality = context.__quality;
const failedQueries = quality.details.filter((item) => item.rank < 1 || item.rank > 3);
if (failedQueries.length) {
  throw new Error("Expected document missing from top 3:\n" + JSON.stringify(failedQueries, null, 2));
}
const forbiddenSourceFailures = quality.details.filter((item) => item.forbiddenTopThree.length);
if (forbiddenSourceFailures.length) {
  throw new Error("Irrelevant documents entered the top three for a guarded query:\n" + JSON.stringify(forbiddenSourceFailures, null, 2));
}
const top1Rate = quality.details.filter((item) => item.rank === 1).length / quality.details.length;
const mrr = quality.details.reduce((sum, item) => sum + 1 / item.rank, 0) / quality.details.length;
if (top1Rate < 0.75) throw new Error("Top-1 retrieval rate fell below 75%: " + top1Rate.toFixed(3) + "\n" + JSON.stringify(quality.details, null, 2));
if (mrr < 0.85) throw new Error("Mean reciprocal rank fell below 0.85: " + mrr.toFixed(3));
if (quality.details.some((item) => item.duplicateKeys > 0)) {
  throw new Error("Prepared answer sources contain duplicate document keys.");
}
const missingEvidence = quality.details.filter((item) => item.evidenceMissing.length);
if (missingEvidence.length) {
  throw new Error("Expected source ranked without its answer evidence: \n" + JSON.stringify(missingEvidence, null, 2));
}
const candidateRecallFailures = quality.details.filter((item) => !item.candidatePreservesExhaustiveTop);
if (candidateRecallFailures.length) {
  throw new Error("Candidate index dropped the exhaustive top document: \n" + JSON.stringify(candidateRecallFailures, null, 2));
}
if (
  !quality.direct.routing.advice ||
  !quality.direct.routing.travel ||
  !quality.direct.routing.programTravel ||
  !quality.direct.routing.specificSubwayPayment
) {
  throw new Error("Deterministic travel-answer routing is incorrect: " + JSON.stringify(quality.direct.routing));
}
if (
  !/WeChat/i.test(quality.direct.advice.text) ||
  !/subway/i.test(quality.direct.advice.text) ||
  !/dry weather/i.test(quality.direct.advice.text) ||
  !/toilet paper/i.test(quality.direct.advice.text) ||
  !/\[1\]/.test(quality.direct.advice.text) ||
  !quality.direct.advice.documentIds.includes("life-in-china-webinar") ||
  !quality.direct.advice.documentIds.includes("beijing-transportation-workshop")
) {
  throw new Error("The real optional-pack files did not produce a complete direct Beijing-life answer: " + JSON.stringify(quality.direct.advice, null, 2));
}
if (
  !/subway/i.test(quality.direct.travel.text) ||
  !/Didi/i.test(quality.direct.travel.text) ||
  !/shared bikes/i.test(quality.direct.travel.text) ||
  !/buses/i.test(quality.direct.travel.text) ||
  !/Alipay/i.test(quality.direct.travel.text) ||
  !/\[1\]/.test(quality.direct.travel.text) ||
  quality.direct.travel.documentIds.length !== 1 ||
  quality.direct.travel.documentIds[0] !== "beijing-transportation-workshop"
) {
  throw new Error("The dedicated transportation transcript did not produce the expected direct answer: " + JSON.stringify(quality.direct.travel, null, 2));
}
if (
  !/subway|inbound flight|high-speed rail/i.test(quality.direct.programTravel.text) ||
  !/\[1\]/.test(quality.direct.programTravel.text) ||
  !quality.direct.programTravel.documentIds.includes("beijing-transportation-workshop")
) {
  throw new Error("The exact failed program-travel wording did not produce a sourced answer: " + JSON.stringify(quality.direct.programTravel, null, 2));
}
if (quality.details.some((item) => item.titles.some((title) => /\(part\s+\d+\)|\bchunk\s+\d+\b/i.test(title)))) {
  throw new Error("A source title exposed an internal chunk label.");
}
if (quality.multi.sourceCount !== 1 || quality.multi.matchedChunkCount < 2) {
  throw new Error("Multi-part retrieval did not merge evidence into one parent-document source: " + JSON.stringify(quality.multi));
}
if (!/guest|visitor/i.test(quality.multi.text) || !/club/i.test(quality.multi.text)) {
  throw new Error("Merged parent-document evidence did not retain both parts of the multi-part question: " + JSON.stringify({ matchedChunkCount: quality.multi.matchedChunkCount, matchedResourceIds: quality.multi.matchedResourceIds, pageRange: quality.multi.pageRange, hasVisitor: /guest|visitor/i.test(quality.multi.text), hasClub: /club/i.test(quality.multi.text) }));
}
if (!/\[\d+\]/.test(quality.uncited.text) && !/could not (?:find|produce)/i.test(quality.uncited.text)) {
  throw new Error("Uncited model output did not fail closed or fall back to cited evidence.");
}
if (/I found relevant information in the indexed resources|(?:^|\n)\s*-?\s*Page\s+\d+\s*:/i.test(quality.uncited.text)) {
  throw new Error("Uncited model output fell back to a raw retrieval excerpt dump.");
}
if (quality.performance.coldMs > 2500 || quality.performance.warmAverageMs > 250) {
  throw new Error("Search performance budget exceeded: " + JSON.stringify(quality.performance));
}

console.log(
  "retrieval-quality-check passed (" +
    cases.length +
    " queries, top-1 " +
    Math.round(top1Rate * 100) +
    "%, recall@3 100%, MRR " +
    mrr.toFixed(3) +
    "; " +
    quality.performance.resourceCount +
    "-resource cold " +
    quality.performance.coldMs.toFixed(1) +
    " ms, warm " +
    quality.performance.warmAverageMs.toFixed(1) +
    " ms/query)"
);
