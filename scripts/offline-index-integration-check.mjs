import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, ...relativePath.split("/")), "utf8");
const clone = (value) => value === undefined ? undefined : structuredClone(value);

function mockElement() {
  const element = {
    textContent: "",
    value: "",
    disabled: false,
    className: "",
    dataset: {},
    style: {},
    content: null,
    title: "",
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

function createStorage(initial = {}) {
  const data = clone(initial);
  return {
    data,
    api: {
      async get(keys) {
        if (keys === null || keys === undefined) return clone(data);
        if (typeof keys === "string") return { [keys]: clone(data[keys]) };
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.map((key) => [key, clone(data[key])]));
        }
        const selected = {};
        for (const [key, fallback] of Object.entries(keys || {})) {
          selected[key] = clone(Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback);
        }
        return selected;
      },
      async set(values) {
        Object.assign(data, clone(values));
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
      }
    }
  };
}

const storage = createStorage({
  resource_index: [],
  transcript_store: [],
  content_store: {},
  resource_pack_store: [],
  detected_media_store: [],
  ignored_media_store: [],
  assistant_settings: {}
});
let mockedSessionFetches = 0;
let forbiddenNetworkAttempts = 0;
let registeredWorkerListener = null;

const workerContext = {
  console: { ...console, warn() {} },
  URL,
  URLSearchParams,
  Date,
  Set,
  Map,
  Promise,
  AbortController,
  TextEncoder,
  Uint8Array,
  crypto: crypto.webcrypto,
  setTimeout,
  clearTimeout,
  structuredClone,
  importScripts() {},
  async fetch(url) {
    const parsed = new URL(String(url));
    if (parsed.origin !== "https://lms.sc.tsinghua.edu.cn") {
      forbiddenNetworkAttempts += 1;
      throw new Error(`Unexpected worker fetch in offline integration check: ${url}`);
    }
    mockedSessionFetches += 1;
    return {
      ok: true,
      status: 200,
      url: parsed.href,
      headers: { get(name) { return /^content-type$/i.test(name) ? "text/html; charset=utf-8" : ""; } },
      async text() { return "<html><body><main>Authenticated Blackboard course portal</main></body></html>"; }
    };
  },
  chrome: {
    runtime: {
      lastError: null,
      onMessage: { addListener(listener) { registeredWorkerListener = listener; } },
      sendMessage(_message, callback) {
        if (callback) callback();
        return Promise.resolve();
      }
    },
    storage: { local: storage.api }
  }
};
vm.createContext(workerContext);
vm.runInContext(read("lib/blackboard-session.js"), workerContext);
vm.runInContext(read("background/service-worker.js"), workerContext);
assert.equal(typeof registeredWorkerListener, "function", "The production service worker did not register its message listener.");

async function invokeWorker(type, payload = {}) {
  workerContext.__offlineMessage = clone({ type, payload });
  const result = await vm.runInContext("handleMessage(globalThis.__offlineMessage)", workerContext);
  return clone(result);
}

const extensionFetches = [];
async function fetchLocalExtensionFile(url) {
  const parsed = new URL(String(url));
  if (parsed.protocol !== "chrome-extension:" || parsed.hostname !== "offline-index-integration") {
    forbiddenNetworkAttempts += 1;
    throw new Error(`Network access is forbidden in offline-index-integration-check: ${url}`);
  }
  const relativePath = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
  const resolved = path.resolve(repoRoot, ...relativePath.split("/"));
  const relative = path.relative(repoRoot, resolved);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `Extension fetch escaped the repository: ${url}`);
  assert.ok(fs.existsSync(resolved), `Extension fetch targeted a missing local file: ${relativePath}`);
  extensionFetches.push(relativePath.replace(/\\/g, "/"));
  const bytes = fs.readFileSync(resolved);
  return {
    ok: true,
    status: 200,
    headers: { get() { return ""; } },
    async text() { return bytes.toString("utf8"); },
    async json() { return JSON.parse(bytes.toString("utf8")); },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  };
}

const moduleSource = [
  "lib/answer-formatting.js",
  "lib/llm-client.js",
  "lib/search-index.js"
].map(read).join("\n\n");
const sidepanelSource = read("sidepanel/sidepanel.js");
const runtimeStart = sidepanelSource.indexOf("chrome.runtime.onMessage.addListener");
assert.ok(runtimeStart > 0, "Could not isolate the production side-panel runtime.");

const sidepanelContext = {
  console: { ...console, warn() {} },
  URL,
  URLSearchParams,
  Date,
  Set,
  Map,
  ArrayBuffer,
  Uint8Array,
  TextDecoder,
  TextEncoder,
  Blob,
  performance,
  structuredClone,
  setTimeout,
  clearTimeout,
  AbortController,
  fetch: fetchLocalExtensionFile,
  window: { setTimeout, clearTimeout, open() {} },
  navigator: {},
  document: {
    getElementById() { return mockElement(); },
    createElement() { return mockElement(); }
  },
  chrome: {
    runtime: {
      getManifest() { return { version: "offline-index-integration" }; },
      getURL(value) {
        return new URL(String(value || "").replace(/^\/+/, ""), "chrome-extension://offline-index-integration/").href;
      },
      sendMessage(message) { return invokeWorker(message.type, message.payload || {}); },
      onMessage: { addListener() {} }
    },
    storage: { local: storage.api },
    tabs: { async create() {} }
  }
};
vm.createContext(sidepanelContext);
vm.runInContext(`${moduleSource}\n\n${sidepanelSource.slice(0, runtimeStart)}`, sidepanelContext);

const packManifest = JSON.parse(read("resource-packs/schwarzman-c11/pack.json"));
const commandContract = vm.runInContext(`(() => {
  const exact = matchingResourcePackCommand("/SchwarzmanC11");
  const alias = matchingResourcePackCommand("/schwarzmanc11");
  return { exactId: exact?.id || "", aliasId: alias?.id || "", manifestPath: exact?.manifestPath || "" };
})()`, sidepanelContext);
assert.deepEqual(
  clone(commandContract),
  {
    exactId: "schwarzman-c11",
    aliasId: "schwarzman-c11",
    manifestPath: "resource-packs/schwarzman-c11/pack.json"
  },
  "The /SchwarzmanC11 command no longer maps to the bundled production pack."
);

sidepanelContext.__packConfig = vm.runInContext("matchingResourcePackCommand('/SchwarzmanC11')", sidepanelContext);
const installResult = clone(await vm.runInContext("installOptionalResourcePack(globalThis.__packConfig)", sidepanelContext));
assert.equal(installResult.ok, true, "Production resource-pack installation failed.");
assert.equal(installResult.prepared_count, packManifest.resources.length, "Not every manifest resource was prepared.");
assert.equal(installResult.added_or_updated, packManifest.resources.length, "Not every prepared resource reached storage.");
assert.equal(installResult.extracted_count, packManifest.resources.length, "Prepared searchable text was missing.");
assert.equal(mockedSessionFetches, 2, "Resource-pack installation did not revalidate the Blackboard session immediately before commit.");
assert.ok(extensionFetches.includes("resource-packs/schwarzman-c11/pack.json"), "The production pack manifest was not fetched.");
assert.ok(
  extensionFetches.some((item) => item.startsWith("resource-packs/schwarzman-c11/texts/")),
  "Production preparation did not read bundled searchable text."
);

let snapshot = await invokeWorker("GET_INDEX");
const storedPackResources = snapshot.resources.filter((resource) => resource.source_pack_id === "schwarzman-c11");
assert.equal(storedPackResources.length, packManifest.resources.length, "Installed pack resource count drifted in storage.");
assert.equal(snapshot.resource_packs.length, 1, "Installed pack metadata was not persisted.");
assert.equal(snapshot.resource_packs[0].id, "schwarzman-c11");
assert.equal(snapshot.resource_packs[0].version, packManifest.version);
assert.ok(storedPackResources.every((resource) => resource.source_pack_document_id), "A stored pack chunk lost its parent document ID.");
assert.ok(storedPackResources.every((resource) => resource.source_pack_provenance), "A stored pack chunk lost provenance.");
assert.equal(
  Object.keys(snapshot.content_store).filter((id) => storedPackResources.some((resource) => resource.id === id)).length,
  packManifest.resources.length,
  "Prepared pack bodies were not retained in the content store."
);

const officialResourceId = "bb-official-x1-residence-policy";
const officialUrl = "https://lms.sc.tsinghua.edu.cn/webapps/blackboard/content/listContent.jsp?course_id=_offline_1&content_id=_policy_1";
const officialBody = [
  "Official Blackboard X1 Student Visa and Residence Permit Policy.",
  "Students must bring the JW202 form and Tsinghua University admission notice. After entering China, X1 visa holders must apply for a residence permit within 30 days. Follow the current official notice if community guidance differs.",
  Array.from({ length: 900 }, (_, index) =>
    `Indexed official policy background segment ${index} preserves representative long Blackboard page content for production chunking.`
  ).join(" "),
  "OFFICIAL_TAIL_SENTINEL cobalt filing window evidence appears only at the far end of the indexed Blackboard body."
].join("\n\n");
assert.ok(officialBody.length > 20000 && officialBody.length < 200000, "Official integration fixture is outside the production page bounds.");

const scrapeResult = await invokeWorker("SCRAPE_PAGE", {
  page: {
    url: officialUrl,
    title: "Official X1 Visa Policy",
    section: "Official Student Policies",
    scraped_at: "2026-07-17T00:00:00.000Z"
  },
  resources: [{
    id: officialResourceId,
    type: "page",
    title: "Official Blackboard X1 Visa and Residence Permit Policy",
    url: officialUrl,
    page_url: officialUrl,
    page_title: "Official Student Policies",
    section: "Visa and residence permit",
    context: officialBody,
    discovered_at: "2026-07-17T00:00:00.000Z"
  }],
  transcripts: []
});
assert.equal(scrapeResult.ok, true, "Representative Blackboard scrape did not merge.");

snapshot = await invokeWorker("GET_INDEX");
const storedOfficial = snapshot.resources.find((resource) => resource.id === officialResourceId);
assert.ok(storedOfficial, "The Blackboard resource was absent after merge.");
assert.equal(Boolean(storedOfficial.source_pack_id), false, "A Blackboard resource was mislabeled as optional-pack content.");
assert.ok(storedOfficial.context.length <= 900, "Blackboard metadata context exceeded its production bound.");
assert.match(snapshot.content_store[officialResourceId], /OFFICIAL_TAIL_SENTINEL/, "The long Blackboard body was truncated before its tail.");
assert.ok(snapshot.content_store[officialResourceId].length > 20000, "The stored Blackboard body regressed to a short snippet.");
assert.equal(snapshot.resources.length, packManifest.resources.length + 1, "The combined index lost pack or Blackboard resources.");
assert.equal(snapshot.meta.content_schema_version, 2, "Combined index metadata lost the current content schema.");

sidepanelContext.__snapshot = clone(snapshot);
vm.runInContext(`
  state.resources = globalThis.__snapshot.resources.filter(isLaunchSearchResource);
  state.resourcePacks = globalThis.__snapshot.resource_packs;
  state.transcripts = globalThis.__snapshot.transcripts;
  state.contentStore = sanitizeLoadedContentStore(globalThis.__snapshot.content_store);
  state.meta = globalThis.__snapshot.meta;
  invalidateSearchIndexCache();
`, sidepanelContext);

sidepanelContext.__tailResults = vm.runInContext(
  "searchIndex('OFFICIAL_TAIL_SENTINEL cobalt filing window', 12)",
  sidepanelContext
);
const tailHit = Array.from(sidepanelContext.__tailResults).find((result) => result.resource_id === officialResourceId);
assert.ok(tailHit, "Combined production search could not retrieve the Blackboard tail chunk.");
assert.match(tailHit.text, /OFFICIAL_TAIL_SENTINEL/, "The retrieved Blackboard result omitted its matching tail evidence.");
assert.ok(tailHit.search_part_count > 1 && tailHit.search_part_index > 0, "The long Blackboard body did not traverse production chunking.");

sidepanelContext.__packResults = vm.runInContext(
  "searchIndex('BKCHCNBJ110 19-digit card number living expenses', 16)",
  sidepanelContext
);
const packHit = Array.from(sidepanelContext.__packResults).find((result) =>
  result.source_pack_id === "schwarzman-c11" && /BKCHCNBJ110/i.test(result.text)
);
assert.ok(packHit, "Combined production search could not retrieve prepared /SchwarzmanC11 evidence.");
assert.equal(packHit.source_pack_document_id, "survival-guide", "Pack parent-document provenance was lost during search.");
assert.ok(packHit.source_pack_provenance, "Pack search result lost its source provenance.");

const webinarContextContract = clone(vm.runInContext(`(() => {
  const query = "What did the Student Life Webinar overview?";
  const results = searchIndex(query, 24);
  const hit = results.find((result) =>
    result.source_pack_id === "schwarzman-c11" &&
    result.source_pack_document_id === "student-life-webinar"
  );
  if (!hit) return { found: false };
  const resources = state.resources.filter((resource) =>
    resource.source_pack_id === "schwarzman-c11" &&
    resource.source_pack_document_id === "student-life-webinar"
  );
  const bodies = resources.map((resource) => cleanIndexedText(state.contentStore[resource.id] || ""));
  const broad = expandAnswerSourcesForSynthesis(query, [hit], [], defaultRagPlan(query, query));
  const broadPrompt = answerPromptSources(broad, 5, MAX_ANSWER_SOURCE_TEXT_CHARS)[0];
  const memory = [{
    user: query,
    assistant: "It covered travel, student life, and visa and registration support."
  }];
  const followQuery = "What visa and registration support did it cover?";
  const followRetrieval = buildRetrievalQuery(followQuery, memory);
  const followHit = searchIndex(followRetrieval, 24).find((result) =>
    result.source_pack_id === "schwarzman-c11" &&
    result.source_pack_document_id === "student-life-webinar"
  );
  const follow = expandAnswerSourcesForSynthesis(
    followQuery,
    [followHit || hit],
    memory,
    defaultRagPlan(followQuery, followRetrieval)
  );
  const followPrompt = answerPromptSources(follow, 5, MAX_ANSWER_SOURCE_TEXT_CHARS)[0];
  const targeted = expandAnswerSourcesForSynthesis(
    "According to the official X1 policy, when is the residence permit deadline?",
    [hit],
    memory,
    defaultRagPlan("According to the official X1 policy, when is the residence permit deadline?", "official X1 residence permit deadline")
  );
  return {
    found: true,
    resourceCount: resources.length,
    bodyChars: bodies.reduce((sum, body) => sum + body.length, 0),
    broadPromptChars: broadPrompt.text.length,
    broadCoverage: broadPrompt.document_coverage,
    broadComplete: broadPrompt.document_coverage_complete,
    broadHasEveryBody: bodies.every((body) => body && broadPrompt.text.includes(body)),
    broadPageRange: broad[0].source_pack_page_range,
    followRetrievedParent: Boolean(followHit),
    followCoverage: followPrompt.document_coverage,
    followComplete: followPrompt.document_coverage_complete,
    followHasEveryBody: bodies.every((body) => body && followPrompt.text.includes(body)),
    targetedExpanded: Boolean(targeted[0].document_context_requested),
    coverageLabel: sourceDocumentCoverageLabel(broad[0])
  };
})()`, sidepanelContext));
assert.equal(webinarContextContract.found, true, "The Student Life webinar parent was not retrievable from the installed pack.");
assert.equal(webinarContextContract.resourceCount, 2, "The Student Life webinar parent did not retain both packaged transcript sections.");
assert.ok(webinarContextContract.bodyChars > 24000, "The real webinar fixture no longer exercises the former 24k prompt truncation.");
assert.ok(webinarContextContract.broadPromptChars > 24000, "Document-wide synthesis still truncated the real webinar at 24k.");
assert.equal(webinarContextContract.broadCoverage, "full_indexed_document", "The broad webinar query did not receive full parent-document context.");
assert.equal(webinarContextContract.broadComplete, true, "The broad webinar context was not marked complete.");
assert.equal(webinarContextContract.broadHasEveryBody, true, "The broad webinar prompt omitted at least one indexed transcript section.");
assert.match(webinarContextContract.broadPageRange, /00:00-15:12/, "The broad webinar source lost its first indexed time range.");
assert.match(webinarContextContract.broadPageRange, /17:42-29:35/, "The broad webinar source lost its second indexed time range.");
assert.equal(webinarContextContract.followRetrievedParent, true, "The elliptical webinar follow-up did not retrieve its conversation parent.");
assert.equal(webinarContextContract.followCoverage, "full_indexed_document", "The elliptical webinar follow-up did not receive full parent-document context.");
assert.equal(webinarContextContract.followComplete, true, "The elliptical webinar follow-up context was not marked complete.");
assert.equal(webinarContextContract.followHasEveryBody, true, "The elliptical webinar follow-up omitted at least one indexed transcript section.");
assert.equal(webinarContextContract.targetedExpanded, false, "A standalone targeted question unnecessarily expanded an unrelated full document.");
assert.match(webinarContextContract.coverageLabel, /Full indexed document supplied/, "The source UI no longer exposes full-document prompt coverage.");

const authorityQuery = "official X1 visa JW202 admission notice residence permit within 30 days";
sidepanelContext.__authorityQuery = authorityQuery;
sidepanelContext.__authorityResults = vm.runInContext(
  "searchIndex(globalThis.__authorityQuery, 24)",
  sidepanelContext
);
sidepanelContext.__packAuthorityResults = vm.runInContext(
  "searchIndex('X1 visa JW202 admission notice residence permit within 30 days', 24)",
  sidepanelContext
);
const authorityResults = Array.from(sidepanelContext.__authorityResults);
const officialAuthorityHit = authorityResults.find((result) => result.resource_id === officialResourceId);
const packAuthorityHit = Array.from(sidepanelContext.__packAuthorityResults).find((result) =>
  result.source_pack_id === "schwarzman-c11" && /(?:jw202|residence permit)/i.test(result.text)
);
assert.ok(officialAuthorityHit && packAuthorityHit, "Authority fixture did not retrieve both Blackboard and pack evidence.");
assert.equal(authorityResults[0].resource_id, officialResourceId, "Explicitly official policy search did not rank Blackboard first.");

sidepanelContext.__officialAuthorityHit = officialAuthorityHit;
sidepanelContext.__packAuthorityHit = packAuthorityHit;
const authorityContract = clone(vm.runInContext(`(() => {
  const facet = { facet_id: "F01", text: globalThis.__authorityQuery };
  const officialCandidate = {
    id: "E_OFFICIAL",
    parentId: "P_OFFICIAL",
    text: globalThis.__officialAuthorityHit.text,
    result: globalThis.__officialAuthorityHit
  };
  const packCandidate = {
    id: "E_PACK",
    parentId: "P_PACK",
    text: globalThis.__packAuthorityHit.text,
    result: globalThis.__packAuthorityHit
  };
  const candidates = [officialCandidate, packCandidate];
  const officialSelection = {
    selectedIds: [officialCandidate.id],
    facetSelections: [{ facet_id: facet.facet_id, candidate_ids: [officialCandidate.id] }]
  };
  const packOnlySelection = {
    selectedIds: [packCandidate.id],
    facetSelections: [{ facet_id: facet.facet_id, candidate_ids: [packCandidate.id] }]
  };
  return {
    officialQuality: sourceQualityScore(globalThis.__officialAuthorityHit, globalThis.__authorityQuery),
    packQuality: sourceQualityScore(globalThis.__packAuthorityHit, globalThis.__authorityQuery),
    officialEvidence: sourceEvidenceScore(facet.text, globalThis.__officialAuthorityHit, facet.text),
    packEvidence: sourceEvidenceScore(facet.text, globalThis.__packAuthorityHit, facet.text),
    officialComparable: semanticCandidateComparableAnswerScore(facet, officialCandidate),
    packComparable: semanticCandidateComparableAnswerScore(facet, packCandidate),
    officialAccepted: semanticSelectionPassesDeterministicSanity(officialSelection, [facet], candidates, true),
    packOnlyAccepted: semanticSelectionPassesDeterministicSanity(packOnlySelection, [facet], candidates, true),
    officialProvenance: promptSourceProvenance(globalThis.__officialAuthorityHit),
    packProvenance: promptSourceProvenance(globalThis.__packAuthorityHit)
  };
})()`, sidepanelContext));

assert.ok(authorityContract.officialQuality > authorityContract.packQuality, "Official Blackboard evidence did not receive the production authority advantage.");
assert.ok(authorityContract.officialEvidence >= 11 && authorityContract.packEvidence >= 11, "Authority comparison used irrelevant evidence.");
assert.ok(authorityContract.officialComparable >= Math.max(24, authorityContract.packComparable - 3), "Official evidence was not comparable to the pack answer.");
assert.equal(authorityContract.officialAccepted, true, "Production selector sanity rejected the relevant official source.");
assert.equal(authorityContract.packOnlyAccepted, false, "Production selector sanity allowed pack-only selection over comparable official evidence.");
assert.equal(authorityContract.officialProvenance, "Blackboard-indexed resource; authority unknown", "Unverified Blackboard prompt provenance was mislabeled.");
assert.equal(authorityContract.packProvenance, `community-collated optional resource; stated provenance: ${packAuthorityHit.source_pack_provenance}`, "Pack prompt provenance was not preserved inside the explicit non-authority label.");
assert.equal(forbiddenNetworkAttempts, 0, "The offline integration check attempted external network access.");

console.log(
  "offline-index-integration-check passed " +
  `(${packManifest.resources.length} prepared pack chunks, 1 Blackboard body, ${extensionFetches.length} local extension fetches, ` +
  "combined search/chunking/provenance/authority verified; network calls: 0)"
);
