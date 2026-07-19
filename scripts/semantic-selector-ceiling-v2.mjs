import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

// Blinded ceiling check for the exact production semantic-selector pool builder.
// The builder receives only the question and production retrieval routes. Expected
// parents and evidence phrases are read only after the prompt-clamped pool exists.

const args = process.argv.slice(2);
const valueAfter = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const numberAfter = (name, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(valueAfter(name, String(fallback)), 10);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(parsed) ? parsed : fallback));
};

const seedList = valueAfter("--seeds", "blind-v2-a,blind-v2-b,blind-v2-c")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const repeats = numberAfter("--repeats", 3, 1, 12);
const outputPath = valueAfter("--out", "");
const jsonOnly = args.includes("--json");
if (!seedList.length) throw new Error("At least one non-empty seed is required.");

const RAW_LIMIT = 50;
const FACET_LIMIT = 5;
const PER_FACET_LIMIT = 20;
const MAX_UNIQUE_CHUNKS = 80;
const MAX_PROMPT_CHARS = 105000;
const commandArg = (value) => /^[A-Za-z0-9_./,:=\\-]+$/.test(value) ? value : JSON.stringify(value);
const exactCommand = ["node", "scripts/semantic-selector-ceiling-v2.mjs", ...args].map(commandArg).join(" ");

const fixtureUrl = new URL("./fixtures/rag-holdout-suite-v2.json", import.meta.url);
const blackboardCorpusUrl = new URL("./fixtures/rag-holdout-v2-blackboard-corpus.json", import.meta.url);
const packRoot = new URL("../resource-packs/schwarzman-c11/", import.meta.url);
const manifestUrl = new URL("pack.json", packRoot);
const manifest = JSON.parse(fs.readFileSync(manifestUrl, "utf8"));
const fixture = JSON.parse(fs.readFileSync(fixtureUrl, "utf8"));
const blackboardCorpus = JSON.parse(fs.readFileSync(blackboardCorpusUrl, "utf8"));

function normalized(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function digestFiles(entries) {
  const hash = crypto.createHash("sha256");
  for (const [name, bytes] of entries) {
    hash.update(name);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function packCorpusDigest() {
  const textRoot = new URL("texts/", packRoot);
  const textFiles = fs.readdirSync(textRoot).filter((name) => name.endsWith(".txt")).sort();
  return digestFiles([
    ["pack.json", fs.readFileSync(manifestUrl)],
    ...textFiles.map((name) => [`texts/${name}`, fs.readFileSync(new URL(name, textRoot))])
  ]);
}

const actualPackDigest = packCorpusDigest();
const actualBlackboardDigest = sha256Bytes(fs.readFileSync(blackboardCorpusUrl));
const suiteDigest = sha256Bytes(fs.readFileSync(fixtureUrl));
if (
  manifest.id !== fixture.pack_id ||
  manifest.version !== fixture.pack_version ||
  actualPackDigest !== fixture.pack_corpus_digest
) {
  throw new Error("STALE_PACK: V2 fixture does not match the indexed pack corpus.");
}
if (
  blackboardCorpus.corpus_id !== fixture.blackboard_corpus_id ||
  blackboardCorpus.corpus_version !== fixture.blackboard_corpus_version ||
  actualBlackboardDigest !== fixture.blackboard_corpus_digest
) {
  throw new Error("STALE_BLACKBOARD_CORPUS: V2 fixture does not match the local Blackboard corpus.");
}

const allowedKinds = new Set(["answerable", "negative_polarity", "conflict", "unanswerable"]);
if (!Array.isArray(fixture.cases) || !fixture.cases.length) throw new Error("V2 fixture has no logical cases.");
for (const item of fixture.cases) {
  if (!allowedKinds.has(item.kind)) throw new Error(`Unknown V2 logical kind for opaque case ${item.id}.`);
  if (!Array.isArray(item.variants) || item.variants.length < 3) {
    throw new Error(`Opaque V2 case ${item.id} must have at least three variants.`);
  }
  if (!Array.isArray(item.expected_documents) || !item.expected_documents.length) {
    throw new Error(`Opaque V2 case ${item.id} has no expected parents.`);
  }
  if (!Array.isArray(item.evidence_groups) || !item.evidence_groups.length) {
    throw new Error(`Opaque V2 case ${item.id} has no audited evidence groups.`);
  }
}

const resources = [];
const contentStore = {};
const corpusTextByDocument = new Map();
for (const raw of manifest.resources || []) {
  const id = ("pack_" + manifest.id + "_" + raw.id).slice(0, 120);
  const resourceText = fs.readFileSync(new URL(raw.text_url, packRoot), "utf8");
  resources.push({
    id,
    type: raw.type || "document",
    title: raw.document_title || raw.title,
    url: new URL(raw.url || raw.text_url || "", "chrome-extension://v2/resource-packs/schwarzman-c11/pack.json").href,
    page_url: "chrome-extension://v2/resource-packs/schwarzman-c11/pack.json",
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
  contentStore[id] = resourceText;
  const documentId = raw.document_id || raw.id;
  corpusTextByDocument.set(documentId, `${corpusTextByDocument.get(documentId) || ""}\n${resourceText}`);
}
for (const raw of blackboardCorpus.resources || []) {
  resources.push({
    id: raw.id,
    type: raw.type || "page",
    title: raw.title,
    url: raw.url,
    page_url: raw.url,
    page_title: raw.page_title || raw.title,
    section: raw.section || "Blackboard",
    context: raw.text,
    source_pack_id: "local-blackboard-v2",
    source_pack_title: "Representative locally indexed Blackboard resources",
    source_pack_version: blackboardCorpus.corpus_version,
    source_pack_document_id: raw.document_id,
    source_pack_document_title: raw.title,
    source_pack_page_range: "",
    source_pack_provenance: raw.provenance || "official Blackboard page"
  });
  contentStore[raw.id] = raw.text;
  corpusTextByDocument.set(raw.document_id, `${corpusTextByDocument.get(raw.document_id) || ""}\n${raw.text}`);
}

// Audit keys before evaluation. The retrieval code below never receives these
// expected documents or phrases; they are consumed only after the pool exists.
for (const item of fixture.cases) {
  for (const documentId of item.expected_documents) {
    if (!corpusTextByDocument.has(documentId)) {
      throw new Error(`Unknown expected parent in opaque V2 case ${item.id}.`);
    }
  }
  for (const group of item.evidence_groups) {
    if (!item.expected_documents.includes(group.document_id)) {
      throw new Error(`Evidence parent mismatch in opaque V2 case ${item.id}.`);
    }
    const sourceText = normalized(corpusTextByDocument.get(group.document_id));
    for (const phrase of group.patterns_all || []) {
      if (!sourceText.includes(normalized(phrase))) {
        throw new Error(`Missing audited corpus phrase in opaque V2 case ${item.id}.`);
      }
    }
  }
}

const productionUrls = [
  new URL("../lib/answer-formatting.js", import.meta.url),
  new URL("../lib/llm-client.js", import.meta.url),
  new URL("../lib/search-index.js", import.meta.url)
];
const sidepanelUrl = new URL("../sidepanel/sidepanel.js", import.meta.url);
const moduleSource = productionUrls.map((file) => fs.readFileSync(file, "utf8")).join("\n\n");
const sidepanelSource = fs.readFileSync(sidepanelUrl, "utf8");
const runtimeStart = sidepanelSource.indexOf("chrome.runtime.onMessage.addListener");
if (runtimeStart < 0) throw new Error("Could not isolate the current side-panel search runtime.");

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
  fetch: async () => { throw new Error("Network access is forbidden in the offline V2 ceiling diagnostic."); },
  document: { getElementById() { return mockElement(); }, createElement() { return mockElement(); } },
  chrome: {
    runtime: {
      sendMessage() {}, getManifest() { return { version: "v2-candidate-ceiling" }; },
      getURL(path) { return "chrome-extension://v2/" + path; }, onMessage: { addListener() {} }
    },
    tabs: { async create() {} }, storage: { local: { async get() { return {}; }, async set() {} } }
  },
  holdoutResources: resources,
  holdoutContentStore: contentStore
};
vm.createContext(context);
vm.runInContext(moduleSource + "\n\n" + sidepanelSource.slice(0, runtimeStart), context);
vm.runInContext(`
  state.resources = holdoutResources;
  state.contentStore = holdoutContentStore;
  state.transcripts = [];
  state.settings = { hasApiKey: false };
  invalidateSearchIndexCache();

  globalThis.__runV2CandidateCeiling = (query) => {
    const baseQuery = String(query || "");
    const plan = defaultRagPlan(baseQuery, baseQuery);
    const primaryQuery = enhanceRetrievalQueryForIntent(baseQuery, baseQuery, plan);
    const retrievalQueries = retrievalQueriesForPlan(baseQuery, baseQuery, primaryQuery, plan);
    // This is the exact production builder. No answer key, expected parent,
    // evidence phrase, or provider-generated answer is present in this context.
    const pool = buildSemanticEvidenceCandidatePool([], baseQuery, retrievalQueries, plan);
    const candidates = pool.map((candidate) => ({
      documentId: String(candidate.result.source_pack_document_id || sourceDedupeKey(candidate.result)),
      chunkKey: candidate.chunkKey,
      text: String(candidate.prompt.text || ""),
      chars: String(candidate.prompt.text || "").length,
      routeTypes: [...(candidate.prompt.route_types || [])]
    }));
    return {
      facetCount: questionFacetRetrievalQueries(baseQuery, 5).length,
      occurrenceCount: candidates.length,
      uniqueCandidates: candidates
    };
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

function evidenceGroupPresent(group, chunksByParent) {
  const chunks = chunksByParent.get(group.document_id) || [];
  return (group.patterns_all || []).every((phrase) => {
    const needle = normalized(phrase);
    return chunks.some((chunk) => normalized(chunk.text).includes(needle));
  });
}

const rows = [];
const started = performance.now();
for (const seed of seedList) {
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const random = mulberry32(seedNumber(`${seed}|resource-order|${repeat}`));
    context.holdoutResources = shuffled(resources, random);
    vm.runInContext("state.resources = holdoutResources; invalidateSearchIndexCache();", context);
    const orderedCases = shuffled(fixture.cases, random);
    for (const testCase of orderedCases) {
      const variantOffset = seedNumber(`${seed}|variant|${testCase.id}`) % testCase.variants.length;
      const variantIndex = (variantOffset + repeat) % testCase.variants.length;
      context.__v2CandidateQuery = testCase.variants[variantIndex];
      const pool = vm.runInContext("__runV2CandidateCeiling(__v2CandidateQuery)", context);
      const chunksByParent = new Map();
      for (const candidate of pool.uniqueCandidates) {
        if (!chunksByParent.has(candidate.documentId)) chunksByParent.set(candidate.documentId, []);
        chunksByParent.get(candidate.documentId).push(candidate);
      }
      const parentHits = testCase.expected_documents.filter((id) => chunksByParent.has(id)).length;
      const evidenceHits = testCase.evidence_groups.filter((group) => evidenceGroupPresent(group, chunksByParent)).length;
      const parentComplete = parentHits === testCase.expected_documents.length;
      const evidenceComplete = evidenceHits === testCase.evidence_groups.length;
      rows.push({
        opaqueId: testCase.id,
        kind: testCase.kind,
        expectedParents: testCase.expected_documents.length,
        parentHits,
        evidenceGroups: testCase.evidence_groups.length,
        evidenceHits,
        parentComplete,
        evidenceComplete,
        jointComplete: parentComplete && evidenceComplete,
        facetCount: pool.facetCount,
        occurrenceCount: pool.occurrenceCount,
        uniqueChunkCount: pool.uniqueCandidates.length,
        parentGroupCount: chunksByParent.size,
        contextChars: pool.uniqueCandidates.reduce((sum, candidate) => sum + candidate.chars, 0)
      });
    }
  }
}

const totalParents = rows.reduce((sum, row) => sum + row.expectedParents, 0);
const totalEvidenceGroups = rows.reduce((sum, row) => sum + row.evidenceGroups, 0);
const average = (selector) => rows.reduce((sum, row) => sum + selector(row), 0) / Math.max(1, rows.length);
const maximum = (selector) => Math.max(0, ...rows.map(selector));
const logicalCases = fixture.cases.map((testCase) => {
  const caseRows = rows.filter((row) => row.opaqueId === testCase.id);
  return {
    kind: testCase.kind,
    parentFailures: caseRows.filter((row) => !row.parentComplete).length,
    evidenceFailures: caseRows.filter((row) => !row.evidenceComplete).length,
    jointPasses: caseRows.filter((row) => row.jointComplete).length,
    attempts: caseRows.length
  };
});

const failureCountsByKind = Object.fromEntries([...allowedKinds].map((kind) => {
  const kindRows = rows.filter((row) => row.kind === kind);
  const kindCases = logicalCases.filter((item) => item.kind === kind);
  return [kind, {
    executions: kindRows.length,
    parent_failure_executions: kindRows.filter((row) => !row.parentComplete).length,
    evidence_failure_executions: kindRows.filter((row) => !row.evidenceComplete).length,
    joint_failure_executions: kindRows.filter((row) => !row.jointComplete).length,
    logical_cases_with_any_parent_failure: kindCases.filter((item) => item.parentFailures > 0).length,
    logical_cases_with_any_evidence_failure: kindCases.filter((item) => item.evidenceFailures > 0).length,
    zero_pass_logical_cases: kindCases.filter((item) => item.jointPasses === 0).length
  }];
}));

const selfUrl = new URL(import.meta.url);
const runtimeEntries = [
  ["scripts/semantic-selector-ceiling-v2.mjs", fs.readFileSync(selfUrl)],
  ...productionUrls.map((url) => [url.pathname.split("/").slice(-2).join("/"), fs.readFileSync(url)]),
  ["sidepanel/sidepanel.js", fs.readFileSync(sidepanelUrl)],
  ["scripts/fixtures/rag-holdout-suite-v2.json", fs.readFileSync(fixtureUrl)],
  ["scripts/fixtures/rag-holdout-v2-blackboard-corpus.json", fs.readFileSync(blackboardCorpusUrl)]
];
const report = {
  diagnostic: "v2_production_semantic_selector_pool_ceiling",
  status: "production_pool_release_gate",
  command: exactCommand,
  suite: {
    id: fixture.suite_id,
    digest: suiteDigest,
    logical_cases: fixture.cases.length,
    variants_per_case: Math.min(...fixture.cases.map((item) => item.variants.length)),
    seeds: seedList,
    repeats_per_seed: repeats,
    resource_order_shuffles: seedList.length * repeats,
    executions: rows.length
  },
  corpus: {
    pack: { id: manifest.id, version: manifest.version, digest: actualPackDigest },
    blackboard: {
      id: blackboardCorpus.corpus_id,
      version: blackboardCorpus.corpus_version,
      digest: actualBlackboardDigest
    }
  },
  runtime_digest: digestFiles(runtimeEntries),
  retrieval_contract: {
    raw_question_limit: RAW_LIMIT,
    generic_facet_limit: FACET_LIMIT,
    per_facet_result_limit: PER_FACET_LIMIT,
    maximum_result_occurrences_per_execution: RAW_LIMIT + FACET_LIMIT * PER_FACET_LIMIT,
    maximum_unique_prompt_chunks: MAX_UNIQUE_CHUNKS,
    maximum_prompt_excerpt_chars: MAX_PROMPT_CHARS,
    builder: "production buildSemanticEvidenceCandidatePool",
    facet_extractor: "production questionFacetRetrievalQueries; question text only",
    grouping: "exact prompt-clamped chunks grouped by source_pack_document_id for scoring",
    expected_data_visible_to_builder: false,
    provider_or_network_calls: 0
  },
  pool_cost: {
    average_facets: average((row) => row.facetCount),
    maximum_facets: maximum((row) => row.facetCount),
    average_result_occurrences: average((row) => row.occurrenceCount),
    maximum_result_occurrences: maximum((row) => row.occurrenceCount),
    average_unique_chunks: average((row) => row.uniqueChunkCount),
    maximum_unique_chunks: maximum((row) => row.uniqueChunkCount),
    average_parent_groups: average((row) => row.parentGroupCount),
    maximum_parent_groups: maximum((row) => row.parentGroupCount),
    average_context_chars: average((row) => row.contextChars),
    maximum_context_chars: maximum((row) => row.contextChars)
  },
  ceiling: {
    expected_parent_recall: rows.reduce((sum, row) => sum + row.parentHits, 0) / Math.max(1, totalParents),
    evidence_group_recall: rows.reduce((sum, row) => sum + row.evidenceHits, 0) / Math.max(1, totalEvidenceGroups),
    parent_complete_execution_rate: rows.filter((row) => row.parentComplete).length / Math.max(1, rows.length),
    evidence_complete_execution_rate: rows.filter((row) => row.evidenceComplete).length / Math.max(1, rows.length),
    joint_complete_execution_rate: rows.filter((row) => row.jointComplete).length / Math.max(1, rows.length),
    fully_consistent_logical_case_rate:
      logicalCases.filter((item) => item.jointPasses === item.attempts).length / Math.max(1, logicalCases.length),
    zero_pass_logical_case_count: logicalCases.filter((item) => item.jointPasses === 0).length,
    failure_counts_by_logical_kind: failureCountsByKind
  },
  audit: {
    source_evidence_keys_verified: true,
    query_or_answer_text_disclosed_in_report: false,
    answer_keys_visible_to_production_builder: false,
    answer_keys_used_for_retrieval: false,
    provider_prompts_created: 0,
    synthesis_run: false
  },
  elapsed_ms: performance.now() - started
};

const serialized = JSON.stringify(report, null, 2) + "\n";
if (outputPath) fs.writeFileSync(outputPath, serialized, "utf8");
if (jsonOnly || !outputPath) {
  process.stdout.write(serialized);
} else {
  const pct = (value) => `${(100 * value).toFixed(1)}%`;
  console.log(
    `V2 production semantic-selector pool ceiling: parent ${pct(report.ceiling.expected_parent_recall)}, ` +
    `evidence ${pct(report.ceiling.evidence_group_recall)}, joint ${pct(report.ceiling.joint_complete_execution_rate)}`
  );
  console.log(
    `Pool avg/max: ${report.pool_cost.average_unique_chunks.toFixed(1)}/${report.pool_cost.maximum_unique_chunks} chunks, ` +
    `${Math.round(report.pool_cost.average_context_chars)}/${report.pool_cost.maximum_context_chars} chars`
  );
  console.log(`Report written to ${outputPath}`);
}

const gateFailures = [];
if (report.ceiling.expected_parent_recall < 1) gateFailures.push("expected-parent recall below 100%");
if (report.ceiling.evidence_group_recall < 0.968) gateFailures.push("evidence-group recall below measured 96.8% ceiling");
if (report.pool_cost.maximum_unique_chunks > MAX_UNIQUE_CHUNKS) gateFailures.push("pool exceeded 80 chunks");
if (report.pool_cost.maximum_context_chars > MAX_PROMPT_CHARS) gateFailures.push("pool exceeded 105,000 prompt excerpt characters");
if (gateFailures.length) {
  console.error(`semantic-selector-ceiling-v2 failed: ${gateFailures.join("; ")}`);
  process.exitCode = 1;
} else if (!jsonOnly) {
  console.log("semantic-selector-ceiling-v2 passed");
}
