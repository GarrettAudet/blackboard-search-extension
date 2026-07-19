import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
const valueAfter = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const seed = valueAfter("--seed", "release-default");
const repeats = Math.max(1, Math.min(12, Number.parseInt(valueAfter("--repeats", "3"), 10) || 3));
const jsonOnly = args.includes("--json");
const noGate = args.includes("--no-gate");
const runtimePatchName = valueAfter("--runtime-patch", "");
if (runtimePatchName && (!/^[a-z0-9._-]+$/i.test(runtimePatchName) || runtimePatchName.includes(".."))) {
  throw new Error("--runtime-patch must name a file directly inside scripts/fixtures.");
}
const runtimePatchUrl = runtimePatchName ? new URL(`./fixtures/${runtimePatchName}`, import.meta.url) : null;
const runtimePatchSource = runtimePatchUrl ? fs.readFileSync(runtimePatchUrl, "utf8") : "";

const fixtureUrl = new URL("./fixtures/rag-holdout-suite-v1.json", import.meta.url);
const packRoot = new URL("../resource-packs/schwarzman-c11/", import.meta.url);
const fixture = JSON.parse(fs.readFileSync(fixtureUrl, "utf8"));
const manifest = JSON.parse(fs.readFileSync(new URL("pack.json", packRoot), "utf8"));

function corpusDigest() {
  const textRoot = new URL("texts/", packRoot);
  const textFiles = fs.readdirSync(textRoot).filter((name) => name.endsWith(".txt")).sort();
  const files = ["pack.json", ...textFiles.map((name) => `texts/${name}`)];
  const hash = crypto.createHash("sha256");
  for (const relative of files) {
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(new URL(relative, packRoot)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

const actualCorpusDigest = corpusDigest();
if (manifest.id !== fixture.pack_id || manifest.version !== fixture.pack_version || actualCorpusDigest !== fixture.corpus_digest) {
  throw new Error(
    `STALE_HOLDOUT expected ${fixture.pack_id}@${fixture.pack_version} ${fixture.corpus_digest}, ` +
    `received ${manifest.id}@${manifest.version} ${actualCorpusDigest}`
  );
}
if (!Array.isArray(fixture.cases) || fixture.cases.length < 16) throw new Error("Holdout suite must contain at least 16 logical cases.");
if (fixture.cases.some((item) => !Array.isArray(item.variants) || item.variants.length < 3)) {
  throw new Error("Every holdout case must have at least three independently authored variants.");
}
if (fixture.cases.filter((item) => item.kind !== "answerable").length < 3) {
  throw new Error("Holdout suite must contain at least three conflict, polarity, or unanswerable cases.");
}
const caseIds = fixture.cases.map((item) => String(item.id || "").trim());
if (caseIds.some((id) => !id) || new Set(caseIds).size !== caseIds.length) {
  throw new Error("Every holdout case must have a unique non-empty id.");
}
const allowedKinds = new Set(["answerable", "negative_polarity", "conflict", "unanswerable"]);
for (const item of fixture.cases) {
  if (!allowedKinds.has(item.kind)) throw new Error(`Unknown holdout kind for ${item.id}: ${item.kind}`);
  if (new Set(item.variants.map((variant) => String(variant).trim().toLowerCase())).size !== item.variants.length) {
    throw new Error(`Holdout case ${item.id} contains duplicate variants.`);
  }
  if (!Array.isArray(item.expected_documents) || !item.expected_documents.length) {
    throw new Error(`Holdout case ${item.id} must name at least one expected document.`);
  }
  if (!Array.isArray(item.evidence_groups) || !item.evidence_groups.length) {
    throw new Error(`Holdout case ${item.id} must define at least one evidence group.`);
  }
  if (!item.answer_key || typeof item.answer_key !== "object") {
    throw new Error(`Holdout case ${item.id} must define an answer key.`);
  }
  for (const pattern of item.answer_key.forbidden_patterns || []) {
    try {
      new RegExp(pattern, "i");
    } catch (error) {
      throw new Error(`Invalid forbidden-answer regex for ${item.id}: ${pattern} (${error.message})`);
    }
  }
}

const resources = [];
const contentStore = {};
const corpusTextByDocument = new Map();
for (const raw of manifest.resources || []) {
  const id = ("pack_" + manifest.id + "_" + raw.id).slice(0, 120);
  resources.push({
    id,
    type: raw.type || "document",
    title: raw.document_title || raw.title,
    url: new URL(raw.url || raw.text_url || "", "chrome-extension://holdout/resource-packs/schwarzman-c11/pack.json").href,
    page_url: "chrome-extension://holdout/resource-packs/schwarzman-c11/pack.json",
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
  const resourceText = fs.readFileSync(new URL(raw.text_url, packRoot), "utf8");
  contentStore[id] = resourceText;
  const documentId = raw.document_id || raw.id;
  corpusTextByDocument.set(documentId, `${corpusTextByDocument.get(documentId) || ""}\n${resourceText}`);
}

for (const item of fixture.cases) {
  for (const expectedDocument of item.expected_documents) {
    if (!corpusTextByDocument.has(expectedDocument)) {
      throw new Error(`Unknown expected document for ${item.id}: ${expectedDocument}`);
    }
  }
  for (const group of item.evidence_groups) {
    if (!item.expected_documents.includes(group.document_id)) {
      throw new Error(`Evidence document ${group.document_id} is not expected by ${item.id}.`);
    }
    const corpusText = normalized(corpusTextByDocument.get(group.document_id));
    if (!Array.isArray(group.patterns_all) || !group.patterns_all.length) {
      throw new Error(`Evidence group ${item.id}/${group.document_id} has no required patterns.`);
    }
    for (const pattern of group.patterns_all) {
      if (!corpusText.includes(normalized(pattern))) {
        throw new Error(`Missing corpus evidence for ${item.id}/${group.document_id}: ${pattern}`);
      }
    }
  }
}

const productionUrls = [
  new URL("../lib/answer-formatting.js", import.meta.url),
  new URL("../lib/llm-client.js", import.meta.url),
  new URL("../lib/search-index.js", import.meta.url)
];
const moduleSource = productionUrls.map((file) => fs.readFileSync(file, "utf8")).join("\n\n");
const sidepanelUrl = new URL("../sidepanel/sidepanel.js", import.meta.url);
const sidepanelSource = fs.readFileSync(sidepanelUrl, "utf8");
const runtimeStart = sidepanelSource.indexOf("chrome.runtime.onMessage.addListener");
if (runtimeStart < 0) throw new Error("Could not isolate the side-panel RAG runtime.");

function mockElement() {
  const element = {
    textContent: "", value: "", disabled: false, className: "", dataset: {}, style: {}, content: null,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, append() {}, remove() {}, setAttribute() {},
    querySelector() { return mockElement(); }, cloneNode() { return mockElement(); }, scrollIntoView() {}
  };
  element.content = { firstElementChild: element };
  return element;
}

const context = {
  console: { ...console, warn() {} }, URL, performance, setTimeout, clearTimeout, AbortController,
  fetch: async () => { throw new Error("Network access is forbidden in holdout-eval."); },
  document: { getElementById() { return mockElement(); }, createElement() { return mockElement(); } },
  chrome: {
    runtime: {
      sendMessage() {}, getManifest() { return { version: "holdout" }; },
      getURL(path) { return "chrome-extension://holdout/" + path; }, onMessage: { addListener() {} }
    },
    tabs: { async create() {} }, storage: { local: { async get() { return {}; }, async set() {} } }
  },
  holdoutResources: resources,
  holdoutContentStore: contentStore
};
vm.createContext(context);
vm.runInContext(moduleSource + "\n\n" + sidepanelSource.slice(0, runtimeStart), context);
if (runtimePatchSource) vm.runInContext(runtimePatchSource, context, { filename: runtimePatchName });
vm.runInContext(`
  state.resources = holdoutResources;
  state.contentStore = holdoutContentStore;
  state.transcripts = [];
  state.settings = { hasApiKey: false };
  invalidateSearchIndexCache();

  globalThis.__runHoldoutQuery = (query, lane) => {
    const baseQuery = String(query || "");
    const plan = defaultRagPlan(baseQuery, baseQuery);
    const plannedQuery = plannedRetrievalQuery(plan, baseQuery, baseQuery);
    const primaryQuery = enhanceRetrievalQueryForIntent(baseQuery, plannedQuery, plan);
    const raw = lane === "r0"
      ? searchIndex(primaryQuery, 20)
      : searchAcrossRetrievalQueries(retrievalQueriesForPlan(baseQuery, baseQuery, primaryQuery, plan));
    return prepareAnswerSources(raw, primaryQuery).slice(0, 8).map((source) => ({
      documentId: source.source_pack_document_id || sourceDedupeKey(source),
      title: cleanSourceTitle(source),
      text: String(source.text || ""),
      score: Number(source.score) || 0,
      matchedChunkCount: Number(source.matched_chunk_count) || 1
    }));
  };
`, context);

function seedNumber(value) {
  return crypto.createHash("sha256").update(String(value)).digest().readUInt32LE(0);
}
function mulberry32(initial) {
  let state = initial >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}
function normalized(value) {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function evidenceGroupPass(group, sources) {
  const source = sources.slice(0, 5).find((item) => item.documentId === group.document_id);
  if (!source) return false;
  const haystack = normalized(source.text);
  return (group.patterns_all || []).every((pattern) => haystack.includes(normalized(pattern)));
}

const executionRows = [];
const started = performance.now();
for (let repeat = 0; repeat < repeats; repeat += 1) {
  const repeatRandom = mulberry32(seedNumber(`${seed}|repeat|${repeat}`));
  context.holdoutResources = shuffled(resources, repeatRandom);
  vm.runInContext("state.resources = holdoutResources; invalidateSearchIndexCache();", context);
  const orderedCases = shuffled(fixture.cases, repeatRandom);

  for (const testCase of orderedCases) {
    const variantOffset = seedNumber(`${seed}|variant|${testCase.id}`) % testCase.variants.length;
    const variantIndex = (variantOffset + repeat) % testCase.variants.length;
    const query = testCase.variants[variantIndex];
    for (const lane of ["r0", "r1"]) {
      context.__holdoutQuery = query;
      context.__holdoutLane = lane;
      const sources = vm.runInContext("__runHoldoutQuery(__holdoutQuery, __holdoutLane)", context);
      const expected = testCase.expected_documents || [];
      const top3 = sources.slice(0, 3).map((item) => item.documentId);
      const top5 = sources.slice(0, 5).map((item) => item.documentId);
      const documentHitsAt3 = expected.filter((id) => top3.includes(id)).length;
      const documentHitsAt5 = expected.filter((id) => top5.includes(id)).length;
      const groupResults = (testCase.evidence_groups || []).map((group) => evidenceGroupPass(group, sources));
      executionRows.push({
        id: testCase.id,
        kind: testCase.kind,
        repeat,
        variantIndex,
        lane,
        expectedCount: expected.length,
        documentHitsAt3,
        documentHitsAt5,
        evidenceGroupCount: groupResults.length,
        evidenceGroupHits: groupResults.filter(Boolean).length,
        top1Hit: expected.includes(sources[0]?.documentId),
        passed: documentHitsAt5 === expected.length && groupResults.every(Boolean)
      });
    }
  }
}

function laneReport(lane) {
  const rows = executionRows.filter((item) => item.lane === lane);
  const totalDocuments = rows.reduce((sum, item) => sum + item.expectedCount, 0);
  const totalGroups = rows.reduce((sum, item) => sum + item.evidenceGroupCount, 0);
  const caseSummaries = fixture.cases.map((testCase) => {
    const caseRows = rows.filter((item) => item.id === testCase.id);
    const passes = caseRows.filter((item) => item.passed).length;
    return { id: testCase.id, kind: testCase.kind, passes, attempts: caseRows.length };
  });
  return {
    executions: rows.length,
    parent_recall_at_3: rows.reduce((sum, item) => sum + item.documentHitsAt3, 0) / Math.max(1, totalDocuments),
    parent_recall_at_5: rows.reduce((sum, item) => sum + item.documentHitsAt5, 0) / Math.max(1, totalDocuments),
    evidence_group_recall_at_5: rows.reduce((sum, item) => sum + item.evidenceGroupHits, 0) / Math.max(1, totalGroups),
    top_1_hit_rate: rows.filter((item) => item.top1Hit).length / Math.max(1, rows.length),
    execution_pass_rate: rows.filter((item) => item.passed).length / Math.max(1, rows.length),
    consistent_case_rate: caseSummaries.filter((item) => item.passes === item.attempts).length / fixture.cases.length,
    zero_pass_case_ids: caseSummaries.filter((item) => item.passes === 0).map((item) => item.id),
    inconsistent_case_ids: caseSummaries.filter((item) => item.passes > 0 && item.passes < item.attempts).map((item) => item.id),
    failure_categories: {
      missing_parent: rows.filter((item) => item.documentHitsAt5 < item.expectedCount).length,
      missing_evidence_span: rows.filter((item) => item.documentHitsAt5 === item.expectedCount && item.evidenceGroupHits < item.evidenceGroupCount).length
    }
  };
}

const sourceHash = crypto.createHash("sha256");
sourceHash.update(fs.readFileSync(new URL(import.meta.url)));
for (const file of [...productionUrls, sidepanelUrl]) sourceHash.update(fs.readFileSync(file));
sourceHash.update(fs.readFileSync(fixtureUrl));
if (runtimePatchSource) sourceHash.update(runtimePatchSource);
sourceHash.update(actualCorpusDigest);
const report = {
  suite_id: fixture.suite_id,
  suite_cases: fixture.cases.length,
  variants_per_case: Math.min(...fixture.cases.map((item) => item.variants.length)),
  negative_or_conflict_cases: fixture.cases.filter((item) => item.kind !== "answerable").length,
  seed,
  repeats,
  corpus: { pack_id: manifest.id, pack_version: manifest.version, digest: actualCorpusDigest },
  runtime_digest: sourceHash.digest("hex"),
  runtime_patch: runtimePatchName || null,
  elapsed_ms: performance.now() - started,
  lanes: { r0_default_retrieval: laneReport("r0"), r1_fused_retrieval: laneReport("r1") },
  synthesis: { status: "not_run", reason: "No provider key is read by the offline holdout runner; answer keys are retained for a live synthesis lane." }
};

const r0 = report.lanes.r0_default_retrieval;
const r1 = report.lanes.r1_fused_retrieval;
const gateFailures = [];
if (r0.parent_recall_at_5 < 0.95) gateFailures.push("R0 parent recall@5 below 95%");
if (r0.evidence_group_recall_at_5 < 0.90) gateFailures.push("R0 evidence recall@5 below 90%");
if (r1.parent_recall_at_3 < 0.90) gateFailures.push("R1 parent recall@3 below 90%");
if (r1.parent_recall_at_5 < 0.98) gateFailures.push("R1 parent recall@5 below 98%");
if (r1.evidence_group_recall_at_5 < 0.95) gateFailures.push("R1 evidence recall@5 below 95%");
if (r1.execution_pass_rate < 0.90) gateFailures.push("R1 execution pass rate below 90%");
if (r1.consistent_case_rate < 0.95) gateFailures.push("R1 consistent-case rate below 95%");
if (r1.zero_pass_case_ids.length) gateFailures.push("R1 contains a 0-pass logical case");
report.gate = { passed: gateFailures.length === 0, failures: gateFailures };

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  console.log(`holdout-eval ${report.gate.passed ? "passed" : "failed"} (${report.suite_cases} cases x ${repeats} seeded variants; seed ${seed})`);
  console.log(`R0 parent@3 ${percent(r0.parent_recall_at_3)}, parent@5 ${percent(r0.parent_recall_at_5)}, evidence@5 ${percent(r0.evidence_group_recall_at_5)}, pass ${percent(r0.execution_pass_rate)}`);
  console.log(`R1 parent@3 ${percent(r1.parent_recall_at_3)}, parent@5 ${percent(r1.parent_recall_at_5)}, evidence@5 ${percent(r1.evidence_group_recall_at_5)}, pass ${percent(r1.execution_pass_rate)}, consistent ${percent(r1.consistent_case_rate)}`);
  if (gateFailures.length) console.log(`Gate failures: ${gateFailures.join("; ")}`);
  if (r1.zero_pass_case_ids.length) console.log(`Opaque 0-pass IDs: ${r1.zero_pass_case_ids.join(", ")}`);
  if (r1.inconsistent_case_ids.length) console.log(`Opaque inconsistent IDs: ${r1.inconsistent_case_ids.join(", ")}`);
  console.log(`Runtime digest: ${report.runtime_digest}`);
}

if (!noGate && gateFailures.length) process.exitCode = 1;
