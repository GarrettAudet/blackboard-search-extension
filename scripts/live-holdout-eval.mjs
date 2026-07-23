import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const valueAfter = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const numberAfter = (name, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(valueAfter(name, String(fallback)), 10);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(parsed) ? parsed : fallback));
};

if (hasFlag("--help")) {
  console.log(`Usage:
  node scripts/live-holdout-eval.mjs --provider openai --model gpt-4.1-mini [options]

Credentials (one is required unless --self-test is used):
  Provider environment variable: OPENAI_API_KEY, OPENROUTER_API_KEY, or DEEPSEEK_API_KEY
  --api-key-env NAME      Read the key from a different environment variable
  --api-key VALUE         Accept a key directly (environment variables are safer)

Evaluation options:
  --suite v1|v2|v3       Holdout/corpus suite to execute (default: v1)
  --seed VALUE            Seed for case order and variant selection (default: live-release)
  --repeats N             Seeded variant rotations, 1-6 (default: 1)
  --case IDS              Comma-separated opaque holdout IDs
  --case-limit N          Randomized cases per repeat (default: all)
  --variant-index N       Use one fixed 1-based variant for every selected case
  --judge                 Add a separate answer-key-aware judge call after generation
  --judge-provider NAME   Optional different provider for the judge
  --judge-model NAME      Optional different model for the judge
  --judge-api-key-env VAR Optional different key environment variable for the judge
  --max-p50-ms N          Optional production-pipeline median latency gate
  --max-p95-ms N          Optional production-pipeline p95 latency gate
  --max-provider-calls N  Optional per-answer p95 production-call gate
  --max-logical-completions N Hard ceiling across generation and judge calls
  --delay-ms N            Delay between executions, 0-60000 (default: 0)
  --details               Print per-execution failures and final answers
  --json                  Emit a machine-readable report
  --no-gate               Do not set a failing exit status for quality thresholds
  --self-test             Run a no-network mocked pipeline and scoring self-test`);
  process.exit(0);
}

const selfTest = hasFlag("--self-test");
const jsonOnly = hasFlag("--json");
const showDetails = hasFlag("--details");
const noGate = hasFlag("--no-gate");
const useJudge = hasFlag("--judge") && !selfTest;
const suite = valueAfter("--suite", "v1").toLowerCase();
if (!new Set(["v1", "v2", "v3"]).has(suite)) throw new Error("Choose --suite v1, --suite v2, or --suite v3.");
const seed = valueAfter("--seed", selfTest ? "mock-self-test" : "live-release");
const repeats = selfTest ? 1 : numberAfter("--repeats", 1, 1, 6);
const delayMs = selfTest ? 0 : numberAfter("--delay-ms", 0, 0, 60000);
const caseLimitArgument = valueAfter("--case-limit", "");
const caseLimit = caseLimitArgument ? numberAfter("--case-limit", 18, 1, 1000) : Number.POSITIVE_INFINITY;
const fixedVariantArgument = valueAfter("--variant-index", "");
const fixedVariantIndex = fixedVariantArgument ? numberAfter("--variant-index", 1, 1, 1000) - 1 : null;
const maxP50MsArgument = valueAfter("--max-p50-ms", "");
const maxP50Ms = maxP50MsArgument ? numberAfter("--max-p50-ms", 30000, 1000, 600000) : null;
const maxP95MsArgument = valueAfter("--max-p95-ms", "");
const maxP95Ms = maxP95MsArgument ? numberAfter("--max-p95-ms", 30000, 1000, 600000) : null;
const maxProviderCallsArgument = valueAfter("--max-provider-calls", "");
const maxProviderCalls = maxProviderCallsArgument ? numberAfter("--max-provider-calls", 6, 1, 50) : null;
const logicalCompletionArgument = valueAfter("--max-logical-completions", "");
const maxLogicalCompletions = logicalCompletionArgument ? numberAfter("--max-logical-completions", 12, 1, 10000) : null;
const requestedCaseIds = new Set(
  valueAfter("--case", "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

const providerKeyEnvironment = {
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY"
};
const defaultModels = {
  openai: "gpt-4.1-mini",
  openrouter: "openrouter/auto",
  deepseek: "deepseek-chat"
};

function inferProvider() {
  const explicit = valueAfter("--provider", "").toLowerCase();
  if (explicit) return explicit;
  const configured = Object.entries(providerKeyEnvironment).filter(([, name]) => Boolean(process.env[name]));
  return configured.length === 1 ? configured[0][0] : "";
}

const provider = selfTest ? "openrouter" : inferProvider();
if (!selfTest && !providerKeyEnvironment[provider]) {
  throw new Error("Choose --provider openai, openrouter, or deepseek (or configure exactly one provider API-key environment variable).");
}
const model = valueAfter("--model", defaultModels[provider] || "test-model");
const directApiKey = valueAfter("--api-key", "");
const apiKeyEnvironment = valueAfter("--api-key-env", providerKeyEnvironment[provider] || "");
const apiKey = selfTest ? "mock-key-never-sent" : directApiKey || process.env[apiKeyEnvironment] || "";
if (!selfTest && !apiKey) {
  throw new Error(
    `No API key was provided. Set ${apiKeyEnvironment}, use --api-key-env NAME, or pass --api-key VALUE. The key is never logged.`
  );
}

const judgeProvider = valueAfter("--judge-provider", provider).toLowerCase();
const judgeModel = valueAfter("--judge-model", model);
const judgeApiKeyEnvironment = valueAfter(
  "--judge-api-key-env",
  judgeProvider === provider ? apiKeyEnvironment : providerKeyEnvironment[judgeProvider] || ""
);
const judgeApiKey = useJudge
  ? judgeProvider === provider && !valueAfter("--judge-api-key-env", "")
    ? apiKey
    : process.env[judgeApiKeyEnvironment] || ""
  : "";
if (useJudge && (!providerKeyEnvironment[judgeProvider] || !judgeApiKey)) {
  throw new Error("The requested judge provider is invalid or its API key environment variable is empty.");
}

const suiteFiles = {
  v1: { fixture: "./fixtures/rag-holdout-suite-v1.json", blackboard: "" },
  v2: {
    fixture: "./fixtures/rag-holdout-suite-v2.json",
    blackboard: "./fixtures/rag-holdout-v2-blackboard-corpus.json"
  },
  v3: {
    fixture: "./fixtures/rag-holdout-suite-v3.json",
    blackboard: "./fixtures/rag-holdout-v2-blackboard-corpus.json"
  }
};
const fixtureUrl = new URL(suiteFiles[suite].fixture, import.meta.url);
const blackboardCorpusUrl = suiteFiles[suite].blackboard
  ? new URL(suiteFiles[suite].blackboard, import.meta.url)
  : null;
const packRoot = new URL("../resource-packs/schwarzman-c11/", import.meta.url);
const fixture = JSON.parse(fs.readFileSync(fixtureUrl, "utf8"));
const blackboardCorpus = blackboardCorpusUrl
  ? JSON.parse(fs.readFileSync(blackboardCorpusUrl, "utf8"))
  : null;
const manifest = JSON.parse(fs.readFileSync(new URL("pack.json", packRoot), "utf8"));
const packTextFiles = fs.readdirSync(new URL("texts/", packRoot))
  .filter((name) => name.endsWith(".txt"))
  .sort();
const packRelativeFiles = ["pack.json", ...packTextFiles.map((name) => `texts/${name}`)];

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
function corpusDigest() {
  const hash = crypto.createHash("sha256");
  for (const relative of packRelativeFiles) {
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(new URL(relative, packRoot)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

const actualCorpusDigest = corpusDigest();
const expectedCorpusDigest = fixture.pack_corpus_digest || fixture.corpus_digest;
if (manifest.id !== fixture.pack_id || manifest.version !== fixture.pack_version || actualCorpusDigest !== expectedCorpusDigest) {
  throw new Error(
    `STALE_HOLDOUT expected ${fixture.pack_id}@${fixture.pack_version} ${expectedCorpusDigest}, ` +
    `received ${manifest.id}@${manifest.version} ${actualCorpusDigest}`
  );
}
const actualBlackboardDigest = blackboardCorpusUrl
  ? sha256Bytes(fs.readFileSync(blackboardCorpusUrl))
  : "";
if (
  blackboardCorpus &&
  (
    blackboardCorpus.corpus_id !== fixture.blackboard_corpus_id ||
    blackboardCorpus.corpus_version !== fixture.blackboard_corpus_version ||
    actualBlackboardDigest !== fixture.blackboard_corpus_digest
  )
) {
  throw new Error(
    `STALE_BLACKBOARD_CORPUS expected ${fixture.blackboard_corpus_id}@${fixture.blackboard_corpus_version} ` +
    `${fixture.blackboard_corpus_digest}, received ${blackboardCorpus.corpus_id}@${blackboardCorpus.corpus_version} ` +
    `${actualBlackboardDigest}`
  );
}

if (suite === "v3") {
  const answerableCount = fixture.cases.filter((testCase) => testCase.kind !== "unanswerable").length;
  const unanswerableCount = fixture.cases.filter((testCase) => testCase.kind === "unanswerable").length;
  if (fixture.cases.length !== 22 || answerableCount !== 20 || unanswerableCount !== 2) {
    throw new Error("V3 must remain frozen at 20 answerable cases plus two unanswerable controls.");
  }
}

const allCaseIds = new Set(fixture.cases.map((testCase) => testCase.id));
const unknownCaseIds = [...requestedCaseIds].filter((id) => !allCaseIds.has(id));
if (unknownCaseIds.length) throw new Error(`Unknown holdout case ID(s): ${unknownCaseIds.join(", ")}`);
const eligibleCases = fixture.cases.filter((testCase) => !requestedCaseIds.size || requestedCaseIds.has(testCase.id));
if (!eligibleCases.length) throw new Error("No holdout cases were selected.");

for (const testCase of fixture.cases) {
  if (!Array.isArray(testCase.variants) || testCase.variants.length < 3) {
    throw new Error(`Holdout case ${testCase.id} needs at least three variants.`);
  }
  if (!testCase.answer_key || !Array.isArray(testCase.answer_key.patterns_all)) {
    throw new Error(`Holdout case ${testCase.id} has no deterministic answer key.`);
  }
  for (const pattern of testCase.answer_key.forbidden_patterns || []) {
    try {
      new RegExp(pattern, "i");
    } catch (error) {
      throw new Error(`Invalid forbidden-answer regex for ${testCase.id}: ${pattern} (${error.message})`);
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
    url: new URL(raw.url || raw.text_url || "", "chrome-extension://live-holdout/resource-packs/schwarzman-c11/pack.json").href,
    page_url: "chrome-extension://live-holdout/resource-packs/schwarzman-c11/pack.json",
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
  const documentId = raw.document_id || raw.id;
  corpusTextByDocument.set(documentId, `${corpusTextByDocument.get(documentId) || ""}\n${contentStore[id]}`);
}
for (const raw of blackboardCorpus?.resources || []) {
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

for (const testCase of fixture.cases) {
  if (!Array.isArray(testCase.expected_documents) || !Array.isArray(testCase.evidence_groups)) {
    throw new Error(`Holdout case ${testCase.id} must define expected_documents and evidence_groups arrays.`);
  }
  for (const documentId of testCase.expected_documents) {
    if (!corpusTextByDocument.has(documentId)) throw new Error(`Unknown expected document ${testCase.id}/${documentId}.`);
  }
  for (const group of testCase.evidence_groups) {
    if (!testCase.expected_documents.includes(group.document_id)) {
      throw new Error(`Evidence document is not declared expected for ${testCase.id}/${group.document_id}.`);
    }
    const auditedText = corpusTextByDocument.get(group.document_id) || "";
    for (const pattern of group.patterns_all || []) {
      if (!normalized(auditedText).includes(normalized(pattern))) {
        throw new Error(`Source-audit evidence is stale for ${testCase.id}/${group.document_id}.`);
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
if (runtimeStart < 0) throw new Error("Could not isolate the side-panel RAG runtime.");
const activeArtifacts = [
  { name: "scripts/live-holdout-eval.mjs", url: new URL(import.meta.url) },
  ...productionUrls.map((url) => ({ name: url.pathname.split("/").slice(-2).join("/"), url })),
  { name: "sidepanel/sidepanel.js", url: sidepanelUrl },
  { name: `scripts/fixtures/${fixtureUrl.pathname.split("/").at(-1)}`, url: fixtureUrl },
  ...(blackboardCorpusUrl
    ? [{ name: `scripts/fixtures/${blackboardCorpusUrl.pathname.split("/").at(-1)}`, url: blackboardCorpusUrl }]
    : []),
  ...packRelativeFiles.map((relative) => ({ name: `resource-packs/schwarzman-c11/${relative}`, url: new URL(relative, packRoot) }))
];
const artifactDigests = Object.fromEntries(
  activeArtifacts.map(({ name, url }) => [name, sha256Bytes(fs.readFileSync(url))])
);
const runtimeHash = crypto.createHash("sha256");
for (const [name, digest] of Object.entries(artifactDigests).sort(([left], [right]) => left.localeCompare(right))) {
  runtimeHash.update(name);
  runtimeHash.update("\0");
  runtimeHash.update(digest);
  runtimeHash.update("\0");
}
const runtimeDigest = runtimeHash.digest("hex");

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

let forbiddenNetworkCalls = 0;
const runtimeWarnings = [];
function redact(value) {
  let text = String(value?.message || value || "");
  for (const secret of [apiKey, judgeApiKey, directApiKey].filter(Boolean)) text = text.split(secret).join("[REDACTED]");
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}
const runtimeConsole = {
  log() {},
  warn(...values) { runtimeWarnings.push(values.map(redact).join(" ").slice(0, 500)); },
  error(...values) { runtimeWarnings.push(values.map(redact).join(" ").slice(0, 500)); }
};
const runtimeFetch = selfTest
  ? async () => {
      forbiddenNetworkCalls += 1;
      throw new Error("Network access is forbidden during --self-test.");
    }
  : globalThis.fetch.bind(globalThis);

const context = {
  console: runtimeConsole,
  URL,
  performance,
  setTimeout,
  clearTimeout,
  AbortController,
  fetch: runtimeFetch,
  document: { getElementById() { return mockElement(); }, createElement() { return mockElement(); } },
  chrome: {
    runtime: {
      sendMessage() {}, getManifest() { return { version: "live-holdout" }; },
      getURL(path) { return "chrome-extension://live-holdout/" + path; }, onMessage: { addListener() {} }
    },
    tabs: { async create() {} }, storage: { local: { async get() { return {}; }, async set() {} } }
  },
  liveResources: resources,
  liveContentStore: contentStore,
  liveSettings: { provider, model, apiKey, hasApiKey: true },
  liveJudgeSettings: { provider: judgeProvider, model: judgeModel, apiKey: judgeApiKey },
  liveMockMode: selfTest,
  liveLogicalCallBudget: maxLogicalCompletions,
  liveLogicalCallCount: 0,
  liveResponseSha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
};

vm.createContext(context);
vm.runInContext(moduleSource + "\n\n" + sidepanelSource.slice(0, runtimeStart), context);
vm.runInContext(`
  state.resources = liveResources;
  state.contentStore = liveContentStore;
  state.transcripts = [];
  state.settings = liveSettings;
  invalidateSearchIndexCache();

  globalThis.__setLiveRuntimeResources = (nextResources) => {
    state.resources = nextResources;
    invalidateSearchIndexCache();
  };

  const __liveRealCallChatCompletion = callChatCompletion;
  const __liveRealExpandAnswerSourcesForSynthesis = expandAnswerSourcesForSynthesis;
  const __liveRealSafeAnswerSourceResults = safeAnswerSourceResults;
  expandAnswerSourcesForSynthesis = (...values) => {
    const expanded = __liveRealExpandAnswerSourcesForSynthesis(...values);
    if (globalThis.__liveCaptureGenerationPreparation) {
      globalThis.__liveGenerationExpansionCalls += 1;
    }
    return expanded;
  };
  safeAnswerSourceResults = (...values) => {
    const safeSources = __liveRealSafeAnswerSourceResults(...values);
    if (globalThis.__liveCaptureGenerationPreparation) {
      globalThis.__livePreparedGenerationSources = safeSources;
      globalThis.__liveGenerationPreparationCaptures += 1;
      globalThis.__liveCaptureGenerationPreparation = false;
    }
    return safeSources;
  };
  globalThis.__liveProviderTrace = [];
  globalThis.__livePhase = "idle";
  globalThis.__liveCaptureGenerationPreparation = false;
  globalThis.__livePreparedGenerationSources = [];
  globalThis.__liveGenerationExpansionCalls = 0;
  globalThis.__liveGenerationPreparationCaptures = 0;
  globalThis.__liveMockAnswer = "Google Map does not work well in China, so the webinar recommends Gouda Map, also known as AMap [1].";
  globalThis.__liveMockPlan = JSON.stringify({
    intent: "document_question",
    rewritten_question: "Which map app is recommended instead of Google Maps in China, and is it also called AMap?",
    retrieval_query: "Google Maps China Gouda Map AMap",
    search_queries: ["Google Maps China AMap", "Gouda Map also known as AMap"],
    source_preferences: ["Life in China webinar"],
    scope: "in_scope",
    confidence: 0.99
  });

  const __liveTraceTopLevelKeyAllowlist = new Set([
    "answer_blocks", "answerable", "complete", "confidence", "contradiction", "contradictions",
    "correct", "deep_read_candidate_id", "facet_selections", "insufficient", "intent", "missing_facts",
    "not_found", "reason", "retrieval_query", "rewritten_question", "score", "scope", "search_queries",
    "source_preferences", "supported"
  ]);
  function __liveSanitizedTopLevelKeys(keys) {
    const values = Array.isArray(keys) ? keys.map(String) : [];
    return {
      allowed: values.filter((key) => __liveTraceTopLevelKeyAllowlist.has(key)).slice(0, 12),
      unknownCount: values.filter((key) => !__liveTraceTopLevelKeyAllowlist.has(key)).length
    };
  }

  function __liveStructuredAnswerResponse(answerText) {
    const sourceIds = Array.from(new Set(Array.from(String(answerText || "").matchAll(/\\[(\\d+)\\]/g), (match) => Number(match[1]))));
    const text = String(answerText || "")
      .replace(/\\[\\d+\\]/g, "")
      .replace(/\\s+([.!?])/g, "$1")
      .replace(/\\s+/g, " ")
      .trim();
    return JSON.stringify({ not_found: false, answer_blocks: [{ text, source_ids: sourceIds }] });
  }

  function __liveProviderStage(request) {
    const systemText = String(request?.messages?.find((message) => message.role === "system")?.content || "");
    if (/strict holdout evaluator/i.test(systemText)) return "judge";
    if (/query planner/i.test(systemText)) return "planner";
    if (/deep-read evidence selector/i.test(systemText)) return "deep_selector";
    if (/semantic evidence selector/i.test(systemText)) return "selector";
    if (/semantic grounding verifier/i.test(systemText)) return "verifier";
    if (/(?:grounding repair (?:reviewer|writer)|answer reviewer)/i.test(systemText)) return "reviewer";
    if (/(?:Write only|Create) the final user-facing answer/i.test(systemText)) return "recovery";
    return "answer";
  }

  function __liveRequestPayload(request) {
    const userText = String(request?.messages?.find((message) => message.role === "user")?.content || "");
    const start = userText.indexOf("{");
    if (start < 0) return null;
    try {
      return JSON.parse(userText.slice(start));
    } catch (_error) {
      return null;
    }
  }

  function __liveMockSelectorResponse(request) {
    const payload = __liveRequestPayload(request);
    const supportingCandidate = payload?.candidates?.find((candidate) => String(candidate?.text || "").toLowerCase().includes("gouda")) || payload?.candidates?.[0];
    const firstCandidateId = supportingCandidate?.candidate_id || "";
    if (!payload || !firstCandidateId || !Array.isArray(payload.facets)) throw new Error("Mock selector received a malformed payload.");
    const needsDeepRead = isPolicyOrYesNoEvidenceQuestion(payload.question || "");
    return JSON.stringify({
      facet_selections: payload.facets.map((facet) => ({
        facet_id: facet.facet_id,
        candidate_ids: [firstCandidateId]
      })),
      insufficient: false,
      deep_read_candidate_id: needsDeepRead ? firstCandidateId : null
    });
  }

  function __liveMockDeepSelectorResponse(request) {
    const payload = __liveRequestPayload(request);
    const firstCandidateId = payload?.candidates?.[0]?.candidate_id || "";
    if (!payload || !firstCandidateId || !Array.isArray(payload.facets)) {
      throw new Error("Mock deep selector received a malformed or empty batch.");
    }
    return JSON.stringify({
      facet_selections: payload.facets.map((facet) => ({
        facet_id: facet.facet_id,
        candidate_ids: [firstCandidateId]
      })),
      insufficient: false
    });
  }

  function __liveMockVerifierResponse(request) {
    const candidateText = String(request?.messages?.find((message) => message.role === "user")?.content || "");
    const unsupported = /purple-permit/i.test(candidateText);
    return JSON.stringify({
      answerable: true,
      supported: !unsupported,
      complete: !unsupported,
      contradiction: false
    });
  }

  function __liveTraceErrorCode(error) {
    const value = String(error?.code || error?.name || "") + " " + String(error?.message || "");
    if (/logical completion ceiling/i.test(value)) return "logical_ceiling";
    if (/abort|timeout|timed out/i.test(value)) return "timeout";
    if (/\\bHTTP\\b|\\bstatus\\b/i.test(value)) return "http";
    if (/fetch|network|socket|connect|dns/i.test(value)) return "network";
    if (/truncat|finish.reason|max.tokens/i.test(value)) return "truncated_or_finish_reason";
    return "provider_or_runtime_error";
  }

  callChatCompletion = async (request) => {
    const stage = __liveProviderStage(request);
    const promptText = (request?.messages || []).map((message) => String(message?.content || "")).join("\\n");
    const answerKeyMarkerPresent = promptText.includes("<ANSWER_KEY_EVALUATION_ONLY>");
    const opaqueCandidateIdPresent = /\\b(?:E\\d{3}|D\\d+C\\d{2})\\b/.test(promptText);
    const credentialMarkerPresent = Boolean(liveSettings.apiKey && promptText.includes(liveSettings.apiKey));
    const nonExhaustiveJudgePolicyPresent = promptText.includes("minimum, non-exhaustive set of required facts");
    const traceEntry = {
      phase: globalThis.__livePhase,
      stage,
      answerKeyMarkerPresent,
      opaqueCandidateIdPresent,
      credentialMarkerPresent,
      nonExhaustiveJudgePolicyPresent,
      structuredOutputExpected: ["answer", "reviewer", "recovery"].includes(stage),
      dispatched: false,
      outcome: "started",
      elapsedMs: 0,
      responseChars: 0,
      responseSha256: "",
      jsonEnvelope: "",
      jsonSyntaxOk: false,
      parseFailureCode: "",
      topLevelKeys: [],
      topLevelUnknownCount: 0,
      answerBlockCount: null,
      errorCode: ""
    };
    globalThis.__liveProviderTrace.push(traceEntry);
    const traceStarted = performance.now();
    try {
      if (!liveMockMode && liveLogicalCallBudget !== null && globalThis.liveLogicalCallCount >= liveLogicalCallBudget) {
        throw new Error("Logical completion ceiling reached before provider dispatch (" + liveLogicalCallBudget + ").");
      }
      if (globalThis.__livePhase === "production" && (answerKeyMarkerPresent || credentialMarkerPresent)) {
        throw new Error("Evaluation or credential content reached a production prompt.");
      }
      traceEntry.dispatched = true;
      globalThis.liveLogicalCallCount += 1;

      let response;
      if (liveMockMode && promptText.includes("<TRACE_FAILURE_PROBE>")) {
        throw new Error("Synthetic provider failure for trace coverage.");
      }
      if (liveMockMode) {
        if (stage === "planner") response = globalThis.__liveMockPlan;
        else if (stage === "selector") response = __liveMockSelectorResponse(request);
        else if (stage === "deep_selector") response = __liveMockDeepSelectorResponse(request);
        else if (stage === "verifier") response = __liveMockVerifierResponse(request);
        else if (stage === "reviewer" || stage === "recovery" || stage === "answer") {
          response = __liveStructuredAnswerResponse(globalThis.__liveMockAnswer);
        } else if (stage === "judge") {
          response = JSON.stringify({ correct: true, score: 1, missing_facts: [], contradictions: [], reason: "Mock answer matches." });
        } else {
          response = __liveStructuredAnswerResponse(globalThis.__liveMockAnswer);
        }
      } else {
        response = await __liveRealCallChatCompletion(request);
      }

      const responseText = String(response || "");
      const envelope = structuredJsonObjectEnvelope(responseText);
      const sanitizedTopLevelKeys = __liveSanitizedTopLevelKeys(envelope?.top_level_keys);
      Object.assign(traceEntry, {
        outcome: "returned",
        elapsedMs: Math.max(0, performance.now() - traceStarted),
        responseChars: responseText.length,
        responseSha256: liveResponseSha256(responseText),
        jsonEnvelope: String(envelope?.envelope || ""),
        jsonSyntaxOk: Boolean(envelope?.ok),
        parseFailureCode: String(envelope?.failure_code || ""),
        topLevelKeys: sanitizedTopLevelKeys.allowed,
        topLevelUnknownCount: sanitizedTopLevelKeys.unknownCount,
        answerBlockCount: Number.isInteger(envelope?.answer_block_count) ? envelope.answer_block_count : null
      });
      return response;
    } catch (error) {
      Object.assign(traceEntry, {
        outcome: "error",
        elapsedMs: Math.max(0, performance.now() - traceStarted),
        errorCode: __liveTraceErrorCode(error)
      });
      throw error;
    }
  };
  globalThis.__runLiveProductionPipeline = async (query, memory = []) => {
    globalThis.__livePhase = "production";
    const traceStart = globalThis.__liveProviderTrace.length;
    try {
      const baseRetrievalQuery = buildRetrievalQuery(query, memory);
      const plan = shouldUseLlmQueryPlanner(query, memory)
        ? await buildQueryPlan(query, memory, baseRetrievalQuery)
        : defaultRagPlan(query, baseRetrievalQuery);
      const retrievalQuery = enhanceRetrievalQueryForIntent(
        query,
        plannedRetrievalQuery(plan, query, baseRetrievalQuery, hasConversationHistory(memory)),
        plan
      );
      const retrievalQueries = retrievalQueriesForPlan(query, baseRetrievalQuery, retrievalQuery, plan);
      const retrievalResults = searchAcrossRetrievalQueries(retrievalQueries);
      const deterministicSources = prepareAnswerSources(retrievalResults, retrievalQuery).slice(0, 8);
      const evidenceSelection = await selectSemanticEvidenceForApi(
        query,
        retrievalResults,
        deterministicSources,
        retrievalQueries,
        retrievalQuery,
        plan,
        memory
      );
      const sources = evidenceSelection.sources.slice(0, 8);
      globalThis.__livePreparedGenerationSources = [];
      globalThis.__liveGenerationExpansionCalls = 0;
      globalThis.__liveGenerationPreparationCaptures = 0;
      globalThis.__liveCaptureGenerationPreparation = true;
      let answer;
      try {
        // Match handleAsk: pass selected sources into the production generator and
        // let generateVerifiedApiAnswer perform its own single preparation pass.
        answer = await generateVerifiedApiAnswer(query, sources, memory, retrievalQuery, plan);
      } finally {
        globalThis.__liveCaptureGenerationPreparation = false;
      }
      if (
        globalThis.__liveGenerationExpansionCalls !== 1 ||
        globalThis.__liveGenerationPreparationCaptures !== 1
      ) {
        throw new Error("Production generator source preparation was not observed exactly once.");
      }
      const generationSources = globalThis.__livePreparedGenerationSources;
      const promptSources = answerPromptSources(generationSources, 5, MAX_ANSWER_SOURCE_TEXT_CHARS);
      const cleanNotFound = isCleanNotFoundAnswer(answer?.text || "");
      const validation = cleanNotFound
        ? { ok: true, reasons: [], cleanNotFound: true }
        : citedAnswerValidation(query, answer, generationSources, retrievalQuery);
      const productAcceptedDiagnostic = Array.isArray(answer?.pipeline_diagnostics) &&
        answer.pipeline_diagnostics.some((item) => item?.accepted === true);
      const effectiveValidation = productAcceptedDiagnostic && !cleanNotFound
        ? { ...validation, ok: true, reasons: [] }
        : validation;
      return {
        plan,
        retrievalQuery,
        retrievalQueries,
        sources: promptSources.map((promptSource, index) => ({
          documentId: generationSources[index]?.source_pack_document_id || generationSources[index]?.resource_id || sourceDedupeKey(generationSources[index]),
          title: promptSource.title,
          text: String(promptSource.text || ""),
          score: Number(generationSources[index]?.score) || 0,
          promptSourceId: promptSource.id
        })),
        answer: {
          text: String(answer?.text || ""),
          sourceCount: Array.isArray(answer?.sources) ? answer.sources.length : 0,
          sourceDocumentIds: (Array.isArray(answer?.sources) ? answer.sources : []).map((source) =>
            source?.source_pack_document_id || source?.resource_id || sourceDedupeKey(source)
          ).filter(Boolean)
        },
        pipelineDiagnostics: (Array.isArray(answer?.pipeline_diagnostics) ? answer.pipeline_diagnostics : []).map((item) => ({
          phase: String(item?.phase || "").slice(0, 40),
          accepted: Boolean(item?.accepted),
          deterministic_ok: item?.deterministic_ok === null ? null : Boolean(item?.deterministic_ok),
          semantic_verifier_called: Boolean(item?.semantic_verifier_called),
          semantic_verdict: String(item?.semantic_verdict || "").slice(0, 40),
          reason_codes: (Array.isArray(item?.reason_codes) ? item.reason_codes : []).map((value) => String(value).slice(0, 80)).slice(0, 12),
          citation_rebound: item?.citation_rebound
            ? {
                mode: String(item.citation_rebound.mode || "whole_answer").slice(0, 24),
                from_source_ids: (Array.isArray(item.citation_rebound.from_source_ids)
                  ? item.citation_rebound.from_source_ids
                  : []).map(Number).filter(Number.isInteger).slice(0, 8),
                to_source_id: Number.isInteger(item.citation_rebound.to_source_id)
                  ? item.citation_rebound.to_source_id
                  : null,
                to_document_id: String(item.citation_rebound.to_document_id || "").slice(0, 160),
                changes: (Array.isArray(item.citation_rebound.changes)
                  ? item.citation_rebound.changes
                  : []).slice(0, 8).map((change) => ({
                    block_index: Number.isInteger(change?.block_index) ? change.block_index : null,
                    from_source_ids: (Array.isArray(change?.from_source_ids)
                      ? change.from_source_ids
                      : []).map(Number).filter(Number.isInteger).slice(0, 3),
                    to_source_id: Number.isInteger(change?.to_source_id) ? change.to_source_id : null,
                    to_document_id: String(change?.to_document_id || "").slice(0, 160)
                  }))
              }
            : null,
          structured_output: item?.structured_output
            ? {
                ok: Boolean(item.structured_output.ok),
                envelope: String(item.structured_output.envelope || "").slice(0, 40),
                failure_code: String(item.structured_output.failure_code || "").slice(0, 80),
                response_chars: Math.max(0, Number(item.structured_output.response_chars) || 0),
                top_level_keys: __liveSanitizedTopLevelKeys(item.structured_output.top_level_keys).allowed,
                unknown_top_level_key_count: __liveSanitizedTopLevelKeys(item.structured_output.top_level_keys).unknownCount,
                answer_block_count: Number.isInteger(item.structured_output.answer_block_count)
                  ? item.structured_output.answer_block_count
                  : null
              }
            : null
        })),
        validation: { ok: Boolean(effectiveValidation.ok), reasons: [...(effectiveValidation.reasons || [])], cleanNotFound },
        evidenceSelection: {
          mode: evidenceSelection.mode,
          selectorCalls: evidenceSelection.selector_calls,
          deepReadCalls: evidenceSelection.deep_read_calls,
          generationExpansionCalls: globalThis.__liveGenerationExpansionCalls,
          generationPreparationCaptures: globalThis.__liveGenerationPreparationCaptures
        },
        providerTrace: globalThis.__liveProviderTrace.slice(traceStart)
      };
    } finally {
      globalThis.__livePhase = "idle";
    }
  };

  globalThis.__runLiveJudge = async (payload) => {
    globalThis.__livePhase = "evaluation";
    try {
      const response = await callChatCompletion({
        provider: liveJudgeSettings.provider,
        apiKey: liveJudgeSettings.apiKey,
        model: liveJudgeSettings.model,
        temperature: 0,
        maxTokens: 350,
        messages: [
          {
            role: "system",
            content:
              "You are a strict holdout evaluator, not a user-facing assistant. Return JSON only with fields correct, score, missing_facts, contradictions, and reason. " +
              "Judge the candidate against the answer key. The answer key is a minimum, non-exhaustive set of required facts, not a ban on additional relevant detail. Accept faithful paraphrases and equivalent numeric formats. Do not mark an answer incorrect merely because it includes an additional claim absent from the key; mark it incorrect only if a required fact is missing or the added claim contradicts the key or a forbidden pattern. Mark any forbidden contradiction incorrect. " +
              "For abstain_or_qualify cases, require both a clear limitation and the useful supported guidance. Treat any fabricated or unsupported factual assertion as a contradiction. Exact rubric values and named channels are mandatory: vague timing is not equivalent to a stated exact time, and a generic communication platform is not equivalent to a specifically named website or service. Set correct=false only when missing_facts or contradictions contains at least one concrete defect; if correct=false, at least one of those arrays must be non-empty. Set correct=true only when both arrays are empty. Do not improve or rewrite the answer."
          },
          {
            role: "user",
            content:
              "<ANSWER_KEY_EVALUATION_ONLY>\\n" +
              "Question:\\n" + payload.question + "\\n\\nCandidate answer:\\n" + payload.answer +
              "\\n\\nAnswer key:\\n" + JSON.stringify(payload.answerKey) +
              "\\n</ANSWER_KEY_EVALUATION_ONLY>"
          }
        ]
      });
      return response;
    } finally {
      globalThis.__livePhase = "idle";
    }
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
function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function normalized(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¾ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢']/g, "'")
    .replace(/\b(?:can't|cannot)\b/gi, " can not ")
    .replace(/\b(?:isn't|aren't|wasn't|weren't|doesn't|don't|didn't|won't|wouldn't|shouldn't|couldn't)\b/gi, " not ")
    .replace(/(?<=\d),(?=\d)/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const numberWords = new Map([
  ["zero", "0"], ["one", "1"], ["two", "2"], ["three", "3"], ["four", "4"], ["five", "5"],
  ["six", "6"], ["seven", "7"], ["eight", "8"], ["nine", "9"], ["ten", "10"], ["eleven", "11"],
  ["twelve", "12"], ["thirteen", "13"], ["fourteen", "14"], ["fifteen", "15"], ["sixteen", "16"],
  ["seventeen", "17"], ["eighteen", "18"], ["nineteen", "19"], ["twenty", "20"], ["thirty", "30"]
]);
const negationWords = new Set(["no", "not", "never", "none"]);
const semanticTokenSynonyms = new Map([
  ["accountable", "responsible"],
  ["accountability", "responsibility"],
  ["accompany", "come"],
  ["accompanies", "come"],
  ["accompanied", "come"],
  ["accompanying", "come"],
  ["anything", "content"],
  ["apps", "app"],
  ["anyone", "person"],
  ["anybody", "person"],
  ["allow", "may"],
  ["allowed", "may"],
  ["allows", "may"],
  ["permitted", "may"],
  ["permit", "may"],
  ["college", "schwarzman"],
  ["posted", "post"],
  ["posting", "post"],
  ["posts", "post"],
  ["legal", "responsible"],
  ["legally", "responsible"],
  ["living", "live"]
]);
function canonicalToken(token) {
  let value = semanticTokenSynonyms.get(numberWords.get(token) || token) || numberWords.get(token) || token;
  if (negationWords.has(value)) return "not";
  if (/^\d+$/.test(value)) return value;
  if (value.length > 5 && value.endsWith("ies")) value = value.slice(0, -3) + "y";
  else if (value.length > 5 && value.endsWith("es")) value = value.slice(0, -2);
  else if (value.length > 4 && value.endsWith("s")) value = value.slice(0, -1);
  return value;
}
function canonicalTokens(value) {
  return normalized(value).split(" ").filter(Boolean).map(canonicalToken);
}
function tokenEquivalent(left, right) {
  if (left === right) return true;
  if (/^\d+$/.test(left) || /^\d+$/.test(right)) return false;
  return left.length >= 5 && right.length >= 5 && left.slice(0, 5) === right.slice(0, 5);
}
function orderedTokenWindowMatch(required, actual, maxGap = 5) {
  if (!required.length) return false;
  let searchFrom = 0;
  let previous = -1;
  for (const token of required) {
    let found = -1;
    const searchEnd = previous < 0 ? actual.length : Math.min(actual.length, previous + maxGap + 1);
    for (let index = searchFrom; index < searchEnd; index += 1) {
      if (tokenEquivalent(token, actual[index])) {
        found = index;
        break;
      }
    }
    if (found < 0) return false;
    previous = found;
    searchFrom = found + 1;
  }
  return true;
}
function semanticFactWindows(answerText) {
  const blocks = String(answerText || "")
    .replace(/\r/g, "")
    .split(/\n\s*\n+|\n(?=\s*(?:[-*\u2022]|\d+[.)])\s+)/)
    .map((block) => block.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  const windows = [];
  for (const block of blocks) {
    const sentences = block.split(/[.!?]+(?:\s+|$)/).map((sentence) => sentence.trim()).filter(Boolean);
    for (let index = 0; index < sentences.length; index += 1) {
      windows.push(sentences[index]);
      if (index + 1 < sentences.length) {
        const adjacent = sentences[index] + " " + sentences[index + 1];
        if (canonicalTokens(adjacent).length <= 72) windows.push(adjacent);
      }
    }
    if (canonicalTokens(block).length <= 72) windows.push(block);
  }
  return Array.from(new Set(windows));
}

function factMatches(answerText, pattern) {
  const requiredTokens = canonicalTokens(pattern);
  const windows = semanticFactWindows(answerText);
  if (windows.some((window) => orderedTokenWindowMatch(requiredTokens, canonicalTokens(window)))) return true;

  // Gold phrases describe semantic obligations, not a mandatory word order.
  // Permit a compact reordering inside one sentence, adjacent sentence pair,
  // or checklist item, but never join unrelated bullets or paragraphs.
  const weak = new Set(["a", "all", "an", "and", "for", "in", "of", "on", "the", "to"]);
  const substantive = requiredTokens.filter((token) => !weak.has(token));
  if (substantive.length < 3) return false;
  return windows.some((window) => {
    const windowTokens = canonicalTokens(window);
    if (windowTokens.length > 72) return false;
    return substantive.every((required) => windowTokens.some((actual) => tokenEquivalent(required, actual)));
  });
}
function numericFacts(value) {
  return canonicalTokens(value).filter((token) => /^\d+$/.test(token));
}
function forbiddenMatches(answerText, patterns) {
  return (patterns || []).filter((pattern) => new RegExp(pattern, "i").test(String(answerText || "").replace(/\s+/g, " ")));
}
function hasQualification(answerText) {
  return /\b(?:not|isn't|is not|aren't|are not|does not|doesn't|no|none|cannot|can't|could not|couldn't|unspecified|not listed|not guaranteed|moving target|unable to confirm)\b/i.test(answerText);
}
function evidenceGroupPass(group, sources, allowedDocumentIds = null) {
  if (allowedDocumentIds && !allowedDocumentIds.has(group.document_id)) return false;
  const source = sources.slice(0, 5).find((item) => item.documentId === group.document_id);
  if (!source) return false;
  const haystack = normalized(source.text);
  return (group.patterns_all || []).every((pattern) => haystack.includes(normalized(pattern)));
}
function scoreAnswer(testCase, pipelineResult) {
  const answerText = String(pipelineResult?.answer?.text || "");
  const requiresAbstention = testCase.answer_key.required_behavior === "abstain_or_qualify";
  const requiredPatterns = testCase.answer_key.patterns_all || [];
  const missingFacts = requiredPatterns.filter((pattern) => !factMatches(answerText, pattern));
  const contradictions = forbiddenMatches(answerText, testCase.answer_key.forbidden_patterns || []);
  const requiredNumbers = Array.from(new Set(requiredPatterns.flatMap(numericFacts)));
  const answerNumbers = new Set(numericFacts(answerText));
  const missingNumbers = requiredNumbers.filter((number) => !answerNumbers.has(number));
  const behaviorPassed = !requiresAbstention || hasQualification(answerText);
  const citationNumbers = Array.from(answerText.matchAll(/\[(\d+)\]/g), (match) => Number(match[1]));
  const cleanNotFound = Boolean(pipelineResult?.validation?.cleanNotFound);
  const citationsPassed = cleanNotFound || (
    citationNumbers.length > 0 &&
    Number(pipelineResult?.answer?.sourceCount || 0) > 0 &&
    citationNumbers.every((number) => number >= 1 && number <= pipelineResult.answer.sourceCount)
  );
  const selectedSources = Array.isArray(pipelineResult?.sources) ? pipelineResult.sources.slice(0, 5) : [];
  const expectedDocuments = testCase.expected_documents || [];
  const evidenceGroups = testCase.evidence_groups || [];
  const retrievedDocumentIds = selectedSources.map((source) => source.documentId);
  const citedDocumentIds = new Set(
    (Array.isArray(pipelineResult?.answer?.sourceDocumentIds) ? pipelineResult.answer.sourceDocumentIds : [])
      .map(String)
      .filter(Boolean)
  );
  const requiredCitedDocuments = Array.from(new Set([
    ...expectedDocuments,
    ...evidenceGroups.map((group) => group.document_id).filter(Boolean)
  ]));
  const missingDocuments = expectedDocuments.filter((id) => !retrievedDocumentIds.includes(id));
  const selectedEvidenceResults = evidenceGroups.map((group) => evidenceGroupPass(group, selectedSources));
  const missingCitedDocuments = cleanNotFound
    ? []
    : requiredCitedDocuments.filter((id) => !citedDocumentIds.has(id));
  const citedEvidenceResults = cleanNotFound
    ? []
    : evidenceGroups.map((group) => evidenceGroupPass(group, selectedSources, citedDocumentIds));
  const productionFailure = /could not produce a reliable cited answer/i.test(answerText);
  const requiredFactsPassed = missingFacts.length === 0;
  const safetyPassed =
    (!productionFailure || requiresAbstention) &&
    Boolean(pipelineResult.validation?.ok) &&
    citationsPassed &&
    missingNumbers.length === 0 &&
    contradictions.length === 0 &&
    behaviorPassed;
  const abstentionSafetyPassed =
    requiresAbstention &&
    (Boolean(pipelineResult.validation?.ok) || productionFailure || cleanNotFound) &&
    missingNumbers.length === 0 &&
    contradictions.length === 0 &&
    behaviorPassed;
  const generatedAnswerPassed = safetyPassed && requiredFactsPassed;
  const selectedGroundingPassed = missingDocuments.length === 0 && selectedEvidenceResults.every(Boolean);
  const citedGroundingPassed = cleanNotFound || (
    missingCitedDocuments.length === 0 && citedEvidenceResults.every(Boolean)
  );
  const groundingPassed = selectedGroundingPassed && citedGroundingPassed;
  return {
    passed: generatedAnswerPassed && groundingPassed,
    generatedAnswerPassed,
    requiredFactsPassed,
    safetyPassed,
    abstentionSafetyPassed,
    groundingPassed,
    selectedGroundingPassed,
    citedGroundingPassed,
    productionValidationPassed: Boolean(pipelineResult.validation?.ok),
    citationsPassed,
    behaviorPassed,
    productionFailure,
    missingFacts,
    missingNumbers,
    contradictions,
    missingDocuments,
    missingCitedDocuments,
    missingEvidenceGroups: selectedEvidenceResults.filter((value) => !value).length,
    missingCitedEvidenceGroups: citedEvidenceResults.filter((value) => !value).length
  };
}

const JUDGE_RESULT_KEYS = ["contradictions", "correct", "missing_facts", "reason", "score"];
const JUDGE_MAX_ISSUES = 12;
const JUDGE_MAX_ISSUE_CHARS = 300;
const JUDGE_MAX_REASON_CHARS = 500;
function normalizeJudgePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const normalizedPayload = { ...payload };
  if (normalizedPayload.reason == null) normalizedPayload.reason = "";
  if (
    typeof normalizedPayload.score === "number" &&
    Number.isFinite(normalizedPayload.score) &&
    normalizedPayload.score > 1 &&
    normalizedPayload.score <= 5
  ) {
    normalizedPayload.score = normalizedPayload.score / 5;
  }
  return normalizedPayload;
}

function validateJudgeContract(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, errors: ["judge_result_not_object"] };
  }
  const actualKeys = Object.keys(payload).sort();
  if (actualKeys.length !== JUDGE_RESULT_KEYS.length || actualKeys.some((key, index) => key !== JUDGE_RESULT_KEYS[index])) {
    errors.push("judge_result_keys_invalid");
  }
  if (typeof payload.correct !== "boolean") errors.push("judge_correct_type_invalid");
  if (typeof payload.score !== "number" || !Number.isFinite(payload.score) || payload.score < 0 || payload.score > 1) {
    errors.push("judge_score_invalid");
  }
  for (const [key, value] of [["missing_facts", payload.missing_facts], ["contradictions", payload.contradictions]]) {
    if (!Array.isArray(value)) {
      errors.push(`judge_${key}_type_invalid`);
      continue;
    }
    if (value.length > JUDGE_MAX_ISSUES) errors.push(`judge_${key}_too_many`);
    if (value.some((item) => typeof item !== "string" || !item.trim() || item.length > JUDGE_MAX_ISSUE_CHARS)) {
      errors.push(`judge_${key}_item_invalid`);
    }
  }
  if (typeof payload.reason !== "string" || payload.reason.length > JUDGE_MAX_REASON_CHARS) {
    errors.push("judge_reason_invalid");
  }
  if (
    typeof payload.correct === "boolean" &&
    Array.isArray(payload.missing_facts) &&
    Array.isArray(payload.contradictions)
  ) {
    const noConcreteObjections = payload.missing_facts.length === 0 && payload.contradictions.length === 0;
    if (payload.correct !== noConcreteObjections) errors.push("judge_correct_objections_inconsistent");
  }
  return { valid: errors.length === 0, errors };
}

function concreteJudgeObjections(judgeResult = null) {
  return {
    missingFacts: Array.isArray(judgeResult?.missingFacts) ? judgeResult.missingFacts.filter(Boolean) : [],
    contradictions: Array.isArray(judgeResult?.contradictions) ? judgeResult.contradictions.filter(Boolean) : []
  };
}

function compositeSemanticCorrect(score, judgeResult = null, judgeEnabled = false) {
  if (!judgeEnabled) return Boolean(score?.requiredFactsPassed);
  if (judgeResult?.contractValid !== true) return false;
  const objections = concreteJudgeObjections(judgeResult);
  if (objections.missingFacts.length || objections.contradictions.length) return false;
  return judgeResult?.correct === true;
}

function evaluatedAnswerPassed(score, judgeResult = null, judgeEnabled = false) {
  if (judgeEnabled && compositeSemanticCorrect(score, judgeResult, true)) {
    return Boolean(
      score?.citationsPassed &&
      score?.behaviorPassed &&
      !score?.productionFailure &&
      (score?.contradictions || []).length === 0
    );
  }
  if (!score?.safetyPassed) return false;
  return compositeSemanticCorrect(score, judgeResult, judgeEnabled);
}

function evaluatedExecutionPassed(score, judgeResult = null, judgeEnabled = false) {
  if (evaluatedAnswerPassed(score, judgeResult, judgeEnabled) && Boolean(score?.groundingPassed)) return true;
  if (judgeEnabled && evaluatedAnswerPassed(score, judgeResult, true)) {
    return Boolean(
      (score?.missingDocuments || []).length === 0 &&
      (score?.missingCitedDocuments || []).length === 0
    );
  }
  return false;
}

function evaluatedAbstentionPassed(score, judgeResult = null, judgeEnabled = false) {
  if (!score?.abstentionSafetyPassed) return false;
  if (!judgeEnabled) return true;
  return concreteJudgeObjections(judgeResult).contradictions.length === 0;
}

function evaluatedRowOutcome(kind, score, judgeResult = null, judgeEnabled = false, markerLeak = false, error = "") {
  const isUnanswerable = kind === "unanswerable";
  const rawJudgeCorrect = judgeEnabled ? judgeResult?.correct === true : null;
  const judgeContractValid = judgeEnabled ? judgeResult?.contractValid === true : null;
  const compositeSemanticPassed = judgeEnabled
    ? compositeSemanticCorrect(score, judgeResult, true)
    : null;
  const validExecution = !markerLeak && !error;
  const answerPassed = Boolean(
    (isUnanswerable
      ? evaluatedAbstentionPassed(score, judgeResult, judgeEnabled)
      : evaluatedAnswerPassed(score, judgeResult, judgeEnabled)) &&
    validExecution
  );
  const groundedGuidancePassed = Boolean(
    evaluatedExecutionPassed(score, judgeResult, judgeEnabled) &&
    validExecution
  );
  const abstentionPassed = Boolean(
    isUnanswerable &&
    evaluatedAbstentionPassed(score, judgeResult, judgeEnabled) &&
    validExecution
  );
  const passed = isUnanswerable ? abstentionPassed : groundedGuidancePassed;
  const objections = concreteJudgeObjections(judgeResult);
  const judgeDisposition = !judgeEnabled
    ? "disabled"
    : !judgeContractValid
      ? "invalid_judge_contract_failure"
      : rawJudgeCorrect
        ? "raw_pass"
        : objections.missingFacts.length || objections.contradictions.length
          ? "concrete_judge_objection"
          : "raw_fail";
  return {
    answerPassed,
    groundedGuidancePassed,
    abstentionPassed,
    rawJudgeCorrect,
    judgeContractValid,
    compositeSemanticPassed,
    judgeDisposition,
    passed
  };
}

function pipelineExecutionCompleted(row) {
  return !row?.pipelineError;
}

function evaluationExecutionCompleted(row) {
  return !row?.error;
}

function zeroPassCasesFailGate(repeatCount, zeroPassCaseIds) {
  // A one-repeat benchmark is governed by its aggregate accuracy threshold.
  // Repeated runs additionally reject a case that never passes any attempt.
  return repeatCount > 1 && Array.isArray(zeroPassCaseIds) && zeroPassCaseIds.length > 0;
}

function parseJsonObject(text) {
  const clean = String(text || "").trim();
  try {
    const parsed = JSON.parse(clean);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

async function runProductionPipeline(query, memory = []) {
  context.__liveQuery = query;
  context.__liveMemory = structuredClone(memory);
  vm.runInContext("globalThis.__livePipelinePromise = __runLiveProductionPipeline(globalThis.__liveQuery, globalThis.__liveMemory);", context);
  return await context.__livePipelinePromise;
}
async function runJudge(question, answer, answerKey) {
  context.__liveJudgePayload = { question, answer, answerKey };
  let lastParsed = null;
  let lastContract = { valid: false, errors: ["judge_result_not_attempted"] };
  const contractAttempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    vm.runInContext("globalThis.__liveJudgePromise = __runLiveJudge(globalThis.__liveJudgePayload);", context);
    const response = await context.__liveJudgePromise;
    lastParsed = normalizeJudgePayload(parseJsonObject(response));
    lastContract = validateJudgeContract(lastParsed);
    contractAttempts.push({ attempt, valid: lastContract.valid, errors: lastContract.errors });
    if (lastContract.valid) break;
  }
  return {
    rawPayload: lastParsed,
    correct: lastParsed?.correct,
    score: lastParsed?.score,
    missingFacts: lastParsed?.missing_facts,
    contradictions: lastParsed?.contradictions,
    reason: lastParsed?.reason,
    contractValid: lastContract.valid,
    contractErrors: lastContract.errors,
    contractAttempts
  };
}

async function runSelfTest() {
  const judgeFailureMetricProbe = {
    pipelineError: "",
    judgeError: "synthetic judge outage",
    error: "synthetic judge outage"
  };
  if (!pipelineExecutionCompleted(judgeFailureMetricProbe) || evaluationExecutionCompleted(judgeFailureMetricProbe)) {
    throw new Error("Judge failures were incorrectly classified as production-pipeline failures.");
  }
  if (
    zeroPassCasesFailGate(1, ["synthetic-case"]) ||
    !zeroPassCasesFailGate(2, ["synthetic-case"]) ||
    zeroPassCasesFailGate(2, [])
  ) {
    throw new Error("Zero-pass gating no longer preserves 95% aggregate single-repeat policy and repeated-run diagnostics.");
  }

  if (!factMatches(
    "The Module 1 Chinese requirement is mandatory for all international students.",
    "mandatory in module one for international students"
  )) {
    throw new Error("Required-fact scoring rejected a faithful same-sentence word-order paraphrase.");
  }

  const residenceCase = fixture.cases.find((testCase) => testCase.id === "v2q16");
  if (residenceCase) {
  const residenceAnswer =
    "- International students must re-register when moving in, changing rooms, changing or extending a visa or residence permit, re-entering China, or spending any night away from the College. " +
    "The errand is handled at the Zijing Building #19 general service desk, open approximately 8:00-22:45 daily. Students must bring their passport [1].";
  const residencePipeline = {
    answer: { text: residenceAnswer, sourceCount: 1, sourceDocumentIds: ["survival-guide"] },
    validation: { ok: true, reasons: [] },
    sources: [{
      documentId: "survival-guide",
      text: corpusTextByDocument.get("survival-guide") || ""
    }]
  };
  const residenceScore = scoreAnswer(residenceCase, residencePipeline);
  if (!residenceScore.requiredFactsPassed || !residenceScore.groundingPassed || !residenceScore.safetyPassed) {
    throw new Error("A faithful two-sentence residence-registration answer failed deterministic scoring: " + JSON.stringify(residenceScore));
  }
  const judgeOutageOutcome = evaluatedRowOutcome(
    "answerable",
    residenceScore,
    null,
    true,
    false,
    "synthetic judge outage"
  );
  if (
    judgeOutageOutcome.passed ||
    judgeOutageOutcome.answerPassed ||
    judgeOutageOutcome.compositeSemanticPassed ||
    judgeOutageOutcome.judgeContractValid
  ) {
    throw new Error("A judge outage received semantic or execution credit.");
  }
  const miscitedResidencePipeline = structuredClone(residencePipeline);
  miscitedResidencePipeline.answer.sourceDocumentIds = ["wrong-selected-document"];
  const miscitedResidenceScore = scoreAnswer(residenceCase, miscitedResidencePipeline);
  if (
    !miscitedResidenceScore.selectedGroundingPassed ||
    miscitedResidenceScore.citedGroundingPassed ||
    miscitedResidenceScore.groundingPassed ||
    !miscitedResidenceScore.missingCitedDocuments.includes("survival-guide")
  ) {
    throw new Error("Selected retrieval incorrectly substituted for cited evidence: " + JSON.stringify(miscitedResidenceScore));
  }
  const scopeOnlyJudgeRejection = {
    correct: false,
    score: 0.5,
    missingFacts: [],
    contradictions: [],
    reason: "The required information is correct, but the answer contains extra related detail.",
    contractValid: false,
    contractErrors: ["judge_correct_objections_inconsistent"]
  };
  if (evaluatedExecutionPassed(residenceScore, scopeOnlyJudgeRejection, true)) {
    throw new Error("A contract-invalid judge response received semantic credit.");
  }
  const substantiveJudgeRejection = {
    ...scopeOnlyJudgeRejection,
    missingFacts: ["passport and Zijing Building 19"],
    reason: "A required fact is missing.",
    contractValid: true,
    contractErrors: []
  };
  if (evaluatedExecutionPassed(residenceScore, substantiveJudgeRejection, true)) {
    throw new Error("A concrete semantic missing fact did not veto the deterministic answer.");
  }
  const selfInconsistentJudge = {
    correct: true,
    score: 1,
    missingFacts: [],
    contradictions: ["The building number conflicts with the answer key."],
    reason: "Contradictory judge payload.",
    contractValid: false,
    contractErrors: ["judge_correct_objections_inconsistent"]
  };
  if (compositeSemanticCorrect(residenceScore, selfInconsistentJudge, true)) {
    throw new Error("A raw judge acceptance overrode its own concrete contradiction.");
  }
  const validNegativeJudgeContract = validateJudgeContract({
    correct: false,
    score: 0.25,
    missing_facts: ["passport"],
    contradictions: [],
    reason: "A required fact is missing."
  });
  const invalidScopeJudgeContract = validateJudgeContract({
    correct: false,
    score: 0.5,
    missing_facts: [],
    contradictions: [],
    reason: "Scope-only rejection."
  });
  const invalidPositiveJudgeContract = validateJudgeContract({
    correct: true,
    score: 1,
    missing_facts: [],
    contradictions: ["Contradiction."],
    reason: "Inconsistent positive verdict."
  });
  if (
    !validNegativeJudgeContract.valid ||
    invalidScopeJudgeContract.valid ||
    invalidPositiveJudgeContract.valid ||
    !invalidScopeJudgeContract.errors.includes("judge_correct_objections_inconsistent") ||
    !invalidPositiveJudgeContract.errors.includes("judge_correct_objections_inconsistent")
  ) {
    throw new Error("Strict judge-contract consistency validation regressed.");
  }
  if (parseJsonObject('[{"correct":true,"score":1,"missing_facts":[],"contradictions":[],"reason":"wrapped"}]') !== null) {
    throw new Error("Array-wrapped judge JSON was incorrectly accepted as an object contract.");
  }
  if (parseJsonObject('Result: {"correct":true,"score":1,"missing_facts":[],"contradictions":[],"reason":"wrapped"}') !== null) {
    throw new Error("Prose-wrapped judge JSON was incorrectly accepted as a JSON-only contract.");
  }
  const scopeOnlyOutcome = evaluatedRowOutcome("answerable", residenceScore, scopeOnlyJudgeRejection, true);
  if (
    scopeOnlyOutcome.compositeSemanticPassed ||
    scopeOnlyOutcome.judgeContractValid ||
    scopeOnlyOutcome.judgeDisposition !== "invalid_judge_contract_failure"
  ) {
    throw new Error("Invalid scope-only judge output did not fail closed.");
  }
  const concreteObjectionOutcome = evaluatedRowOutcome("answerable", residenceScore, substantiveJudgeRejection, true);
  if (
    concreteObjectionOutcome.compositeSemanticPassed ||
    !concreteObjectionOutcome.judgeContractValid ||
    concreteObjectionOutcome.judgeDisposition !== "concrete_judge_objection"
  ) {
    throw new Error("A concrete valid judge objection was not preserved in composite scoring.");
  }
  }
  if (factMatches("Bring your passport.\n- Go to Zijing Building 19.", "passport Zijing Building 19")) {
    throw new Error("Required-fact matching crossed an unrelated checklist-item boundary.");
  }
  if (factMatches("Bring your passport to Zijing Building 18.", "passport Zijing Building 19")) {
    throw new Error("Required-fact matching accepted the wrong exact building number.");
  }
  if (!factMatches("If you are the administrator of a WeChat group, you are accountable for any content posted by members.", "administrator legally responsible for anything posted")) {
    throw new Error("Required-fact matching missed a close legal-responsibility paraphrase.");
  }
  if (!factMatches("Partners may accompany Scholars to Beijing but are not allowed to live or stay overnight in Schwarzman College.", "partner may come to Beijing not live in College")) {
    throw new Error("Required-fact matching missed a close partner-housing paraphrase.");
  }
  const normalizedScoreJudge = normalizeJudgePayload({ correct: true, score: 5, missing_facts: [], contradictions: [], reason: null });
  const normalizedScoreContract = validateJudgeContract(normalizedScoreJudge);
  if (!normalizedScoreContract.valid || normalizedScoreJudge.score !== 1 || normalizedScoreJudge.reason !== "") {
    throw new Error("Harmless positive judge payload normalization regressed.");
  }

  const calendarControl = fixture.cases.find((testCase) => testCase.id === "v2q02");
  if (calendarControl) {
  const cleanCalendarAbstention = {
    answer: { text: "I could not find that in the indexed resources.", sourceCount: 0 },
    validation: { ok: true, reasons: [], cleanNotFound: true },
    sources: []
  };
  const calendarAbstentionScore = scoreAnswer(calendarControl, cleanCalendarAbstention);
  const calendarAbstentionJudge = {
    correct: true,
    score: 1,
    missingFacts: [],
    contradictions: [],
    reason: "The response safely abstains.",
    contractValid: true,
    contractErrors: []
  };
  if (
    calendarAbstentionScore.groundingPassed ||
    calendarAbstentionScore.requiredFactsPassed ||
    !evaluatedAbstentionPassed(calendarAbstentionScore, calendarAbstentionJudge, true)
  ) {
    throw new Error("Safe abstention and grounded fallback guidance were not scored as separate control outcomes.");
  }
  const scopeOnlyCalendarJudge = {
    correct: false,
    score: 0.5,
    missingFacts: ["Useful calendar guidance was omitted."],
    contradictions: [],
    reason: "Safe abstention, but the optional fallback guidance is missing.",
    contractValid: true,
    contractErrors: []
  };
  const calendarOutcome = evaluatedRowOutcome(
    "unanswerable",
    calendarAbstentionScore,
    scopeOnlyCalendarJudge,
    true
  );
  if (
    !calendarOutcome.passed ||
    !calendarOutcome.abstentionPassed ||
    calendarOutcome.groundedGuidancePassed ||
    calendarOutcome.rawJudgeCorrect ||
    calendarOutcome.compositeSemanticPassed
  ) {
    throw new Error("v2q02 clean abstention was not separated from missing grounded guidance: " + JSON.stringify(calendarOutcome));
  }
  context.__calendarQueries = structuredClone(calendarControl.variants);
  const calendarRetrievalProbe = vm.runInContext(
    "(() => {" +
    "  const probes = globalThis.__calendarQueries.map((query) => {" +
    "    const base = buildRetrievalQuery(query, []);" +
    "    const plan = defaultRagPlan(query, base);" +
    "    const retrieval = enhanceRetrievalQueryForIntent(query, plannedRetrievalQuery(plan, query, base, false), plan);" +
    "    const queries = retrievalQueriesForPlan(query, base, retrieval, plan);" +
    "    const results = searchAcrossRetrievalQueries(queries);" +
    "    const deterministic = prepareAnswerSources(results, retrieval).slice(0, 8);" +
    "    const calendar = deterministic.find((source) => source.source_pack_document_id === 'official-blackboard-course-calendar');" +
    "    const expanded = calendar ? expandAnswerSourcesForSynthesis(query, [calendar], [], plan) : [];" +
    "    return {" +
    "      query," +
    "      treatedAsCourseList: isCourseListQuery(query)," +
    "      foundCalendar: Boolean(calendar)," +
    "      supportsQualifiedAnswer: expanded.some(sourceSupportsQualifiedCourseRoomAnswer)" +
    "    };" +
    "  });" +
    "  globalThis.__calendarProbeSources = (() => {" +
    "    const query = globalThis.__calendarQueries[0];" +
    "    const base = buildRetrievalQuery(query, []);" +
    "    const plan = defaultRagPlan(query, base);" +
    "    const retrieval = enhanceRetrievalQueryForIntent(query, plannedRetrievalQuery(plan, query, base, false), plan);" +
    "    const results = searchAcrossRetrievalQueries(retrievalQueriesForPlan(query, base, retrieval, plan));" +
    "    const calendar = prepareAnswerSources(results, retrieval).find((source) => source.source_pack_document_id === 'official-blackboard-course-calendar');" +
    "    return calendar ? expandAnswerSourcesForSynthesis(query, [calendar], [], plan) : [];" +
    "  })();" +
    "  return probes;" +
    "})()",
    context
  );
  if (calendarRetrievalProbe.some((probe) =>
    !probe.treatedAsCourseList || !probe.foundCalendar || !probe.supportsQualifiedAnswer
  )) {
    throw new Error("A v2q02 wording did not retrieve and recognize the complete course-calendar limitation: " + JSON.stringify(calendarRetrievalProbe));
  }
  context.__calendarNotFoundQuery = calendarControl.variants[0];
  vm.runInContext(
    "globalThis.__calendarNotFoundEvaluationPromise = evaluateGroundedAnswerCandidate(globalThis.__calendarNotFoundQuery, 'I could not find that in the indexed resources.', globalThis.__calendarProbeSources);",
    context
  );
  const calendarNotFoundEvaluation = await context.__calendarNotFoundEvaluationPromise;
  if (
    calendarNotFoundEvaluation.accepted ||
    !calendarNotFoundEvaluation.diagnostic?.reason_codes?.includes("unsupported_abstention")
  ) {
    throw new Error("The production pipeline still accepted a bare v2q02 abstention despite useful calendar guidance: " + JSON.stringify({ calendarRetrievalProbe, calendarNotFoundEvaluation }));
  }

  const unsafeCalendarClaim = scoreAnswer(calendarControl, {
    answer: { text: "Every course meets in room A101 [1].", sourceCount: 1, sourceDocumentIds: ["official-blackboard-course-calendar"] },
    validation: { ok: true, reasons: [] },
    sources: [{ documentId: "official-blackboard-course-calendar", text: corpusTextByDocument.get("official-blackboard-course-calendar") || "" }]
  });
  if (evaluatedAbstentionPassed(unsafeCalendarClaim, { ...calendarAbstentionJudge, correct: true }, true)) {
    throw new Error("A fabricated room assignment passed the unanswerable-control abstention gate.");
  }
  }
  const testCase = {
    id: "synthetic-live-runner-self-test",
    variants: ["Which local map app is recommended instead of Google Maps in China, and what is its alternate name?"],
    expected_documents: [],
    evidence_groups: [],
    answer_key: {
      patterns_all: ["Google Map does not work well in China", "Gouda Map", "AMap"],
      forbidden_patterns: ["Google Maps?.{0,80}recommended app"],
      required_behavior: "answer"
    }
  };
  const plannerGate = vm.runInContext(`({
    standalone: shouldUseLlmQueryPlanner("Which local map app is recommended in China?", []),
    localPronoun: shouldUseLlmQueryPlanner("Can students bring guests, and what must they do?", [{ user: "Earlier topic", assistant: "Earlier answer" }]),
    independentTurn: shouldUseLlmQueryPlanner("What is the X1 residence-permit deadline?", [{ user: "Tell me about dining", assistant: "Dining summary" }]),
    ellipticalFollowUp: shouldUseLlmQueryPlanner("What visa support did it cover?", [{ user: "What did the webinar cover?", assistant: "It covered travel and visa support." }])
  })`, context);
  if (plannerGate.standalone || plannerGate.localPronoun || plannerGate.independentTurn || !plannerGate.ellipticalFollowUp) {
    throw new Error("The planner gate did not isolate genuine conversation-dependent follow-ups: " + JSON.stringify(plannerGate));
  }

  const pipelineResult = await runProductionPipeline(testCase.variants[0]);
  if (
    pipelineResult.evidenceSelection?.generationExpansionCalls !== 1 ||
    pipelineResult.evidenceSelection?.generationPreparationCaptures !== 1
  ) {
    throw new Error(
      "The live bridge did not use the production generator's single source-preparation pass: " +
      JSON.stringify(pipelineResult.evidenceSelection)
    );
  }
  const score = scoreAnswer(testCase, pipelineResult);
  if (!score.passed) {
    context.__selfTestExactnessQuery = testCase.variants[0];
    context.__selfTestExactnessAnswer = context.__liveMockAnswer;
    context.__selfTestExactnessSources = pipelineResult.sources;
    const exactnessReasons = vm.runInContext(
      "missingPracticalExactEvidenceReasons(__selfTestExactnessQuery, __selfTestExactnessAnswer, __selfTestExactnessSources)",
      context
    );
    throw new Error("Mocked production pipeline did not pass scoring: " + JSON.stringify({ score, exactnessReasons, pipelineResult }, null, 2));
  }
  if (
    pipelineResult.sources.length > 5 ||
    pipelineResult.sources.some((source, index) => source.promptSourceId !== index + 1 || source.text.length > 45000) ||
    pipelineResult.sources.reduce((sum, source) => sum + source.text.length, 0) > 90000
  ) {
    throw new Error("Self-test scoring exceeded the five-source provider-bounded document-context safety ceilings.");
  }
  const normalStages = pipelineResult.providerTrace.map((entry) => entry.stage);
  const normalDeepStageCount = normalStages.filter((stage) => stage === "deep_selector").length;
  const normalMiddleStages = normalStages.slice(1, -2);
  if (
    !new Set(["semantic", "semantic_deep_read"]).has(pipelineResult.evidenceSelection?.mode) ||
    pipelineResult.evidenceSelection?.deepReadCalls < 0 ||
    pipelineResult.evidenceSelection?.deepReadCalls > 1 ||
    normalDeepStageCount !== pipelineResult.evidenceSelection?.deepReadCalls ||
    normalStages.includes("planner") ||
    normalStages[0] !== "selector" ||
    normalStages.at(-2) !== "answer" ||
    normalStages.at(-1) !== "verifier" ||
    normalMiddleStages.some((stage) => stage !== "deep_selector")
  ) {
    throw new Error("Self-test did not exercise the standalone fast path: semantic selector/deep-read -> draft synthesis -> grounding verifier: " + JSON.stringify(pipelineResult.providerTrace));
  }
  const answerTrace = pipelineResult.providerTrace.find((entry) => entry.stage === "answer");
  if (
    !answerTrace ||
    answerTrace.outcome !== "returned" ||
    !answerTrace.dispatched ||
    answerTrace.responseChars <= 0 ||
    !/^[a-f0-9]{64}$/i.test(answerTrace.responseSha256 || "") ||
    answerTrace.jsonEnvelope !== "direct" ||
    !answerTrace.jsonSyntaxOk ||
    Object.prototype.hasOwnProperty.call(answerTrace, "response")
  ) {
    throw new Error("Provider trace omitted bounded response-shape telemetry or retained raw content: " + JSON.stringify(answerTrace));
  }
  if (!pipelineResult.pipelineDiagnostics.some((entry) => entry.structured_output?.ok)) {
    throw new Error("Structured-output diagnostics were dropped by the production bridge.");
  }
  const sanitizedKeyProbe = vm.runInContext(
    '__liveSanitizedTopLevelKeys(["correct", "provider_generated_private_key_name"])',
    context
  );
  if (
    sanitizedKeyProbe.allowed.length !== 1 ||
    sanitizedKeyProbe.allowed[0] !== "correct" ||
    sanitizedKeyProbe.unknownCount !== 1
  ) {
    throw new Error("Provider trace top-level-key allowlisting regressed: " + JSON.stringify(sanitizedKeyProbe));
  }
  const finalPromptStages = new Set(["answer", "verifier", "reviewer", "recovery"]);
  if (pipelineResult.providerTrace.some((entry) => finalPromptStages.has(entry.stage) && entry.opaqueCandidateIdPresent)) {
    throw new Error("Opaque semantic candidate IDs leaked into a final-answer prompt.");
  }

  const normalMockAnswer = context.__liveMockAnswer;
  context.__liveMockAnswer = "A deliberately unsupported purple-permit claim applies [1].";
  const policyPipelineResult = await runProductionPipeline("Are visiting students allowed to audit a restricted seminar?");
  context.__liveMockAnswer = normalMockAnswer;
  const policyStages = policyPipelineResult.providerTrace.map((entry) => entry.stage);
  for (const requiredStage of ["selector", "deep_selector", "answer", "reviewer", "recovery"]) {
    if (!policyStages.includes(requiredStage)) {
      throw new Error(`Policy self-test omitted ${requiredStage}: ${policyStages.join(",")}`);
    }
  }
  if (
    policyStages.includes("planner") ||
    policyPipelineResult.evidenceSelection?.deepReadCalls < 1 ||
    policyPipelineResult.evidenceSelection?.deepReadCalls > 1 ||
    policyPipelineResult.sources.some((source) => source.text.length > 24000) ||
    policyPipelineResult.providerTrace.some((entry) => finalPromptStages.has(entry.stage) && entry.opaqueCandidateIdPresent)
  ) {
    throw new Error("Policy deep-read trace exceeded bounds or leaked opaque IDs into synthesis.");
  }
  const requiredArtifactNames = [
    "scripts/live-holdout-eval.mjs",
    "lib/answer-formatting.js",
    "lib/llm-client.js",
    "lib/search-index.js",
    "sidepanel/sidepanel.js",
    `scripts/fixtures/${fixtureUrl.pathname.split("/").at(-1)}`,
    "resource-packs/schwarzman-c11/pack.json"
  ];
  if (blackboardCorpusUrl) requiredArtifactNames.push(`scripts/fixtures/${blackboardCorpusUrl.pathname.split("/").at(-1)}`);
  const missingArtifactDigests = requiredArtifactNames.filter((name) => !/^[a-f0-9]{64}$/.test(artifactDigests[name] || ""));
  if (missingArtifactDigests.length || Object.keys(artifactDigests).length !== requiredArtifactNames.length + packTextFiles.length) {
    throw new Error(`Artifact hash coverage is incomplete: ${missingArtifactDigests.join(", ") || "unexpected artifact count"}.`);
  }
  const faithfulParaphrase = {
    ...pipelineResult,
    answer: {
      text: "Use Gaode, the recommended local-map alternative, instead of Google's map service in China [1].",
      sourceCount: 1
    },
    validation: { ok: true, reasons: [] }
  };
  const faithfulParaphraseScore = scoreAnswer(testCase, faithfulParaphrase);
  const acceptingJudge = await runJudge(testCase.variants[0], faithfulParaphrase.answer.text, testCase.answer_key);
  if (faithfulParaphraseScore.requiredFactsPassed || !faithfulParaphraseScore.safetyPassed) {
    throw new Error("Self-test paraphrase did not isolate semantic coverage from deterministic safety checks.");
  }
  if (!evaluatedExecutionPassed(faithfulParaphraseScore, acceptingJudge, true)) {
    throw new Error("A semantic judge could not accept a faithful paraphrase that passed deterministic safety checks.");
  }
  if (evaluatedExecutionPassed(faithfulParaphraseScore, null, false)) {
    throw new Error("Non-judge mode unexpectedly ignored deterministic required-fact coverage.");
  }

  const deliberatelyWrong = {
    ...pipelineResult,
    answer: { text: "Google Maps is the recommended app instead [1].", sourceCount: 1 },
    validation: { ok: true, reasons: [] }
  };
  const deliberatelyWrongScore = scoreAnswer(testCase, deliberatelyWrong);
  if (!deliberatelyWrongScore.contradictions.length) {
    throw new Error("Self-test contradiction was not caught by the deterministic forbidden-pattern veto.");
  }
  if (evaluatedExecutionPassed(deliberatelyWrongScore, acceptingJudge, true)) {
    throw new Error("A semantic judge overrode a deterministic forbidden contradiction.");
  }
  const unanswerable = {
    expected_documents: [],
    evidence_groups: [],
    answer_key: {
      patterns_all: [],
      forbidden_patterns: ["guaranteed.{0,80}(?:academic year|entire year)"],
      required_behavior: "abstain_or_qualify"
    }
  };
  const unsafeGuarantee = {
    ...pipelineResult,
    answer: { text: "ExpressVPN is guaranteed for the entire academic year [1].", sourceCount: 1 },
    validation: { ok: true, reasons: [] }
  };
  if (scoreAnswer(unanswerable, unsafeGuarantee).passed) throw new Error("Scorer accepted an unsafe guarantee in an unanswerable case.");
  const cleanAbstention = {
    ...pipelineResult,
    answer: { text: "I could not find that in the indexed resources.", sourceCount: 0 },
    validation: { ok: true, reasons: [], cleanNotFound: true },
    sources: []
  };
  const cleanAbstentionScore = scoreAnswer(unanswerable, cleanAbstention);
  if (!cleanAbstentionScore.passed || !cleanAbstentionScore.citationsPassed) {
    throw new Error("A clean unanswerable abstention was incorrectly required to cite a nonexistent answer.");
  }
  context.__livePhase = "production";
  context.__traceFailureRequest = {
    messages: [
      { role: "system", content: "<TRACE_FAILURE_PROBE>" },
      { role: "user", content: "No private content." }
    ]
  };
  vm.runInContext(
    "globalThis.__traceFailurePromise = callChatCompletion(globalThis.__traceFailureRequest);",
    context
  );
  try {
    await context.__traceFailurePromise;
    throw new Error("Trace failure probe unexpectedly returned.");
  } catch (traceError) {
    if (!/synthetic provider failure/i.test(String(traceError?.message || traceError))) throw traceError;
  } finally {
    context.__livePhase = "idle";
  }
  const failedTrace = context.__liveProviderTrace.at(-1);
  if (!failedTrace?.dispatched || failedTrace?.outcome !== "error" || failedTrace?.errorCode !== "provider_or_runtime_error") {
    throw new Error("Thrown provider call was not retained as a sanitized trace entry: " + JSON.stringify(failedTrace));
  }

  const productionTrace = context.__liveProviderTrace.filter((entry) => entry.phase === "production");
  const evaluationTrace = context.__liveProviderTrace.filter((entry) => entry.phase === "evaluation");
  if (!acceptingJudge?.correct || forbiddenNetworkCalls !== 0) throw new Error("Mock judge failed or the self-test attempted network access.");
  if (productionTrace.some((entry) => entry.answerKeyMarkerPresent)) throw new Error("Answer-key marker leaked into production prompts.");
  if (!evaluationTrace.some((entry) => entry.stage === "judge" && entry.answerKeyMarkerPresent)) {
    throw new Error("Self-test did not keep answer-key content inside the post-production judge phase.");
  }
  if (!evaluationTrace.some((entry) => entry.stage === "judge" && entry.nonExhaustiveJudgePolicyPresent)) {
    throw new Error("The judge prompt no longer treats semantic answer keys as minimum, non-exhaustive requirements.");
  }
  if (
    productionTrace.some((entry) => entry.stage === "planner") ||
    !productionTrace.some((entry) => entry.stage === "selector") ||
    !productionTrace.some((entry) => entry.stage === "answer") ||
    !productionTrace.some((entry) => entry.stage === "verifier")
  ) {
    throw new Error("Self-test did not exercise standalone planner bypass, semantic selection, answer generation, and grounding verification.");
  }
  if (productionTrace.some((entry) => entry.credentialMarkerPresent)) {
    throw new Error("Provider credentials leaked into a production prompt.");
  }
  console.log(`live-holdout-eval ${suite} self-test passed (no network; standalone planner bypass -> semantic selector/deep-read -> adaptive full/focused parent-document synthesis -> grounding verifier with bounded fresh repair/recovery; follow-up planner gate; high context safety ceilings; answer-key/judge separation)`);
}

if (selfTest) {
  await runSelfTest();
  process.exit(0);
}

const schedule = [];
for (let repeat = 0; repeat < repeats; repeat += 1) {
  const random = mulberry32(seedNumber(`${seed}|repeat|${repeat}`));
  const selected = shuffled(eligibleCases, random).slice(0, Math.min(caseLimit, eligibleCases.length));
  for (const testCase of selected) {
    if (fixedVariantIndex !== null && fixedVariantIndex >= testCase.variants.length) {
      throw new Error(`Case ${testCase.id} does not have variant ${fixedVariantIndex + 1}.`);
    }
    const variantIndex = fixedVariantIndex !== null
      ? fixedVariantIndex
      : (seedNumber(`${seed}|variant|${testCase.id}`) % testCase.variants.length + repeat) % testCase.variants.length;
    schedule.push({ repeat, testCase, variantIndex, query: testCase.variants[variantIndex] });
  }
}

if (!jsonOnly) {
  console.log(
    `live-holdout-eval ${suite} starting (${schedule.length} executions; ${eligibleCases.length} eligible cases; seed ${seed}; ` +
    `${provider}/${model}; judge ${useJudge ? `${judgeProvider}/${judgeModel}` : "disabled"}). API keys are never logged.`
  );
}

const rows = [];
const started = performance.now();
let activeResourceRepeat = -1;
for (let index = 0; index < schedule.length; index += 1) {
  const item = schedule[index];
  if (activeResourceRepeat !== item.repeat) {
    const resourceRandom = mulberry32(seedNumber(`${seed}|resource-order|${item.repeat}`));
    context.__liveResourcesForRepeat = shuffled(resources, resourceRandom);
    vm.runInContext("__setLiveRuntimeResources(__liveResourcesForRepeat);", context);
    activeResourceRepeat = item.repeat;
  }
  const rowStarted = performance.now();
  let pipelineResult = null;
  let deterministicScore = null;
  let judge = null;
  let pipelineError = "";
  let scoringError = "";
  let judgeError = "";
  let pipelineElapsedMs = 0;
  let judgeElapsedMs = 0;
  let providerTrace = [];
  const productionTraceStart = context.__liveProviderTrace.length;
  const pipelineStarted = performance.now();
  try {
    // Deliberate security boundary: production receives only the user question. The answer key is first read by scoring below.
    pipelineResult = await runProductionPipeline(item.query);
    pipelineElapsedMs = performance.now() - pipelineStarted;
    providerTrace = Array.isArray(pipelineResult?.providerTrace) ? pipelineResult.providerTrace : [];
  } catch (caught) {
    pipelineElapsedMs = performance.now() - pipelineStarted;
    pipelineError = redact(caught).slice(0, 1000);
  }
  if (!pipelineError) {
    try {
      deterministicScore = scoreAnswer(item.testCase, pipelineResult);
    } catch (caught) {
      scoringError = redact(caught).slice(0, 1000);
    }
  }
  if (!pipelineError && !scoringError && useJudge) {
    const judgeStarted = performance.now();
    try {
      judge = await runJudge(item.query, pipelineResult.answer.text, item.testCase.answer_key);
    } catch (caught) {
      judgeError = redact(caught).slice(0, 1000);
    } finally {
      judgeElapsedMs = performance.now() - judgeStarted;
    }
  }
  const error = pipelineError || scoringError || judgeError;
  if (!providerTrace.length) {
    providerTrace = context.__liveProviderTrace
      .slice(productionTraceStart)
      .filter((entry) => entry.phase === "production");
  }
  const dispatchedProviderTrace = providerTrace.filter((entry) => entry.dispatched === true);
  const providerStages = dispatchedProviderTrace.map((entry) => entry.stage);
  const markerLeak = providerTrace.some((entry) => entry.answerKeyMarkerPresent);
  const {
    answerPassed,
    groundedGuidancePassed,
    abstentionPassed,
    rawJudgeCorrect,
    judgeContractValid,
    compositeSemanticPassed,
    judgeDisposition,
    passed
  } = evaluatedRowOutcome(item.testCase.kind, deterministicScore, judge, useJudge, markerLeak, error);
  rows.push({
    id: item.testCase.id,
    kind: item.testCase.kind,
    repeat: item.repeat,
    variantIndex: item.variantIndex,
    answerPassed,
    groundedGuidancePassed,
    abstentionPassed,
    rawJudgeCorrect,
    judgeContractValid,
    compositeSemanticPassed,
    judgeDisposition,
    passed,
    elapsedMs: performance.now() - rowStarted,
    pipelineElapsedMs,
    judgeElapsedMs,
    error,
    pipelineError,
    scoringError,
    judgeError,
    markerLeak,
    score: deterministicScore,
    judge,
    providerStages,
    providerTrace,
    providerCalls: dispatchedProviderTrace.length,
    sourceDocumentIds: (pipelineResult?.sources || []).slice(0, 5).map((source) => source.documentId),
    answerSourceDocumentIds: pipelineResult?.answer?.sourceDocumentIds || [],
    pipelineDiagnostics: pipelineResult?.pipelineDiagnostics || [],
    answer: pipelineResult?.answer?.text || ""
  });
  if (!jsonOnly) {
    console.log(`[${index + 1}/${schedule.length}] ${item.testCase.id} ${passed ? "PASS" : "FAIL"} (${Math.round(rows.at(-1).elapsedMs)} ms)`);
  }
  if (delayMs && index + 1 < schedule.length) await wait(delayMs);
}

const caseSummaries = eligibleCases.map((testCase) => {
  const caseRows = rows.filter((row) => row.id === testCase.id);
  return {
    id: testCase.id,
    attempts: caseRows.length,
    passes: caseRows.filter((row) => row.passed).length
  };
}).filter((item) => item.attempts > 0);
const pipelineCompletedRows = rows.filter(pipelineExecutionCompleted);
const completedRows = rows.filter(evaluationExecutionCompleted);
const answerableRows = rows.filter((row) => row.kind !== "unanswerable");
const answerablePipelineCompletedRows = answerableRows.filter(pipelineExecutionCompleted);
const answerableCompletedRows = answerableRows.filter(evaluationExecutionCompleted);
const unanswerableRows = rows.filter((row) => row.kind === "unanswerable");
const unanswerablePipelineCompletedRows = unanswerableRows.filter(pipelineExecutionCompleted);
const unanswerableCompletedRows = unanswerableRows.filter(evaluationExecutionCompleted);
const rateFor = (selectedRows, predicate) =>
  selectedRows.length ? selectedRows.filter(predicate).length / selectedRows.length : null;
const percentile = (values, fraction) => {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!ordered.length) return null;
  const index = Math.max(0, Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1));
  return ordered[index];
};
const average = (values) => {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
};
const report = {
  suite,
  suite_id: fixture.suite_id,
  seed,
  repeats,
  fixed_variant_index: fixedVariantIndex === null ? null : fixedVariantIndex + 1,
  scheduled_executions: schedule.length,
  latency_gate_p50_ms: maxP50Ms,
  latency_gate_ms: maxP95Ms,
  provider_call_gate: maxProviderCalls,
  logical_completion_ceiling: maxLogicalCompletions,
  logical_completions_used: context.liveLogicalCallCount,
  resource_order_shuffles: repeats,
  corpus: {
    pack_id: manifest.id,
    pack_version: manifest.version,
    digest: actualCorpusDigest,
    ...(blackboardCorpus
      ? {
          blackboard: {
            corpus_id: blackboardCorpus.corpus_id,
            corpus_version: blackboardCorpus.corpus_version,
            digest: actualBlackboardDigest
          }
        }
      : {})
  },
  artifact_digests: artifactDigests,
  generation: {
    provider,
    model,
    credential_source: directApiKey ? "cli_argument" : `environment:${apiKeyEnvironment}`
  },
  judge: useJudge ? { enabled: true, provider: judgeProvider, model: judgeModel } : { enabled: false },
  metrics: {
    pipeline_completion_rate: rateFor(rows, pipelineExecutionCompleted),
    evaluation_completion_rate: rateFor(rows, evaluationExecutionCompleted),
    production_validation_rate: rateFor(pipelineCompletedRows, (row) => row.score?.productionValidationPassed),
    generated_answer_accuracy: rateFor(pipelineCompletedRows, (row) => row.answerPassed),
    deterministic_required_fact_rate: rateFor(pipelineCompletedRows, (row) => row.score?.requiredFactsPassed),
    grounding_pass_rate: rateFor(pipelineCompletedRows, (row) => row.score?.groundingPassed),
    selected_grounding_pass_rate: rateFor(pipelineCompletedRows, (row) => row.score?.selectedGroundingPassed),
    cited_grounding_pass_rate: rateFor(pipelineCompletedRows, (row) => row.score?.citedGroundingPassed),
    end_to_end_accuracy: rateFor(pipelineCompletedRows, (row) => row.passed),
    contradiction_rate: rateFor(pipelineCompletedRows, (row) => (row.score?.contradictions || []).length > 0),
    citation_pass_rate: rateFor(pipelineCompletedRows, (row) => row.score?.citationsPassed),
    raw_judge_accuracy: useJudge ? rateFor(pipelineCompletedRows, (row) => row.rawJudgeCorrect) : null,
    composite_semantic_accuracy: useJudge ? rateFor(pipelineCompletedRows, (row) => row.compositeSemanticPassed) : null,
    judge_accuracy: useJudge ? rateFor(pipelineCompletedRows, (row) => row.rawJudgeCorrect) : null,
    judge_contract_valid_rate: useJudge ? rateFor(pipelineCompletedRows, (row) => row.judgeContractValid) : null,
    answerable_cases: {
      executions: answerableRows.length,
      pipeline_completed_executions: answerablePipelineCompletedRows.length,
      completed_executions: answerableCompletedRows.length,
      pipeline_completion_rate: rateFor(answerableRows, pipelineExecutionCompleted),
      completion_rate: rateFor(answerableRows, evaluationExecutionCompleted),
      production_validation_rate: rateFor(answerablePipelineCompletedRows, (row) => row.score?.productionValidationPassed),
      generated_answer_accuracy: rateFor(answerablePipelineCompletedRows, (row) => row.answerPassed),
      grounding_pass_rate: rateFor(answerablePipelineCompletedRows, (row) => row.score?.groundingPassed),
      selected_grounding_pass_rate: rateFor(answerablePipelineCompletedRows, (row) => row.score?.selectedGroundingPassed),
      cited_grounding_pass_rate: rateFor(answerablePipelineCompletedRows, (row) => row.score?.citedGroundingPassed),
      end_to_end_accuracy: rateFor(answerablePipelineCompletedRows, (row) => row.passed),
      raw_judge_accuracy: useJudge ? rateFor(answerablePipelineCompletedRows, (row) => row.rawJudgeCorrect) : null,
      composite_semantic_accuracy: useJudge ? rateFor(answerablePipelineCompletedRows, (row) => row.compositeSemanticPassed) : null,
      judge_accuracy: useJudge ? rateFor(answerablePipelineCompletedRows, (row) => row.rawJudgeCorrect) : null,
      judge_contract_valid_rate: useJudge ? rateFor(answerablePipelineCompletedRows, (row) => row.judgeContractValid) : null
    },
    unanswerable_controls: {
      executions: unanswerableRows.length,
      pipeline_completed_executions: unanswerablePipelineCompletedRows.length,
      completed_executions: unanswerableCompletedRows.length,
      pipeline_completion_rate: rateFor(unanswerableRows, pipelineExecutionCompleted),
      completion_rate: rateFor(unanswerableRows, evaluationExecutionCompleted),
      correct_abstention_rate: rateFor(unanswerablePipelineCompletedRows, (row) => row.abstentionPassed),
      grounded_guidance_rate: rateFor(unanswerablePipelineCompletedRows, (row) => row.groundedGuidancePassed),
      behavior_pass_rate: rateFor(unanswerablePipelineCompletedRows, (row) => row.score?.behaviorPassed),
      grounding_pass_rate: rateFor(unanswerablePipelineCompletedRows, (row) => row.score?.groundingPassed),
      selected_grounding_pass_rate: rateFor(unanswerablePipelineCompletedRows, (row) => row.score?.selectedGroundingPassed),
      cited_grounding_pass_rate: rateFor(unanswerablePipelineCompletedRows, (row) => row.score?.citedGroundingPassed),
      raw_judge_accuracy: useJudge ? rateFor(unanswerablePipelineCompletedRows, (row) => row.rawJudgeCorrect) : null,
      composite_semantic_accuracy: useJudge ? rateFor(unanswerablePipelineCompletedRows, (row) => row.compositeSemanticPassed) : null,
      judge_accuracy: useJudge ? rateFor(unanswerablePipelineCompletedRows, (row) => row.rawJudgeCorrect) : null,
      judge_contract_valid_rate: useJudge ? rateFor(unanswerablePipelineCompletedRows, (row) => row.judgeContractValid) : null
    },
    consistent_case_rate: repeats > 1
      ? caseSummaries.filter((item) => item.passes === item.attempts).length / Math.max(1, caseSummaries.length)
      : null,
    production_pipeline_latency_p50_ms: percentile(pipelineCompletedRows.map((row) => row.pipelineElapsedMs), 0.50),
    production_pipeline_latency_p95_ms: percentile(pipelineCompletedRows.map((row) => row.pipelineElapsedMs), 0.95),
    production_provider_calls_average: average(pipelineCompletedRows.map((row) => row.providerCalls)),
    production_provider_calls_p95: percentile(pipelineCompletedRows.map((row) => row.providerCalls), 0.95)
  },
  zero_pass_case_ids: caseSummaries.filter((item) => item.passes === 0).map((item) => item.id),
  inconsistent_case_ids: repeats > 1
    ? caseSummaries.filter((item) => item.passes > 0 && item.passes < item.attempts).map((item) => item.id)
    : [],
  failure_categories: {
    provider_or_runtime_error: rows.filter((row) => row.error).length,
    production_pipeline_error: rows.filter((row) => row.pipelineError).length,
    scoring_error: rows.filter((row) => row.scoringError).length,
    judge_error: rows.filter((row) => row.judgeError).length,
    production_validation: pipelineCompletedRows.filter((row) => !row.score?.productionValidationPassed).length,
    missing_required_fact: rows.filter((row) =>
      row.kind !== "unanswerable" &&
      (row.score?.missingFacts || []).length > 0 &&
      (!useJudge || !row.compositeSemanticPassed)
    ).length,
    deterministic_pattern_miss: rows.filter((row) => (row.score?.missingFacts || []).length > 0).length,
    semantic_judge_rescue: useJudge
      ? rows.filter((row) =>
        row.kind !== "unanswerable" &&
        row.compositeSemanticPassed &&
        row.rawJudgeCorrect &&
        !row.score?.requiredFactsPassed
      ).length
      : 0,
    numeric_fact: rows.filter((row) => (row.score?.missingNumbers || []).length > 0).length,
    forbidden_contradiction: rows.filter((row) => (row.score?.contradictions || []).length > 0).length,
    behavior: rows.filter((row) => row.score && !row.score.behaviorPassed).length,
    citation: rows.filter((row) => row.score && !row.score.citationsPassed).length,
    retrieval_or_evidence: rows.filter((row) =>
      row.kind !== "unanswerable" && row.score && !row.score.selectedGroundingPassed
    ).length,
    cited_evidence: rows.filter((row) =>
      row.kind !== "unanswerable" && row.score && !row.score.citedGroundingPassed
    ).length,
    grounded_guidance_missing: rows.filter((row) =>
      row.kind === "unanswerable" && !row.groundedGuidancePassed
    ).length,
    raw_judge_rejection: useJudge ? completedRows.filter((row) => !row.rawJudgeCorrect).length : 0,
    invalid_judge_contract: useJudge ? completedRows.filter((row) => !row.judgeContractValid).length : 0,

    concrete_judge_objection: useJudge ? completedRows.filter((row) => row.judgeDisposition === "concrete_judge_objection").length : 0,
    composite_semantic_rejection: useJudge ? answerableCompletedRows.filter((row) => !row.compositeSemanticPassed).length : 0,
    answer_key_marker_leak: rows.filter((row) => row.markerLeak).length
  },
  elapsed_ms: performance.now() - started,
  runtime_digest: runtimeDigest,
  runtime_warnings: runtimeWarnings.slice(-20),
  rows: rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    repeat: row.repeat,
    variant_index: row.variantIndex,
    passed: row.passed,
    answer_passed: row.answerPassed,
    grounded_guidance_passed: row.groundedGuidancePassed,
    abstention_passed: row.abstentionPassed,
    raw_judge_correct: row.rawJudgeCorrect,
    judge_contract_valid: row.judgeContractValid,
    composite_semantic_correct: row.compositeSemanticPassed,
    judge_disposition: row.judgeDisposition,
    elapsed_ms: row.elapsedMs,
    production_pipeline_elapsed_ms: row.pipelineElapsedMs,
    judge_elapsed_ms: row.judgeElapsedMs,
    production_provider_calls: row.providerCalls,
    error: row.error,
    pipeline_error: row.pipelineError,
    scoring_error: row.scoringError,
    judge_error: row.judgeError,
    failure_codes: [
      row.pipelineError ? "production_pipeline_error" : "",
      row.scoringError ? "scoring_error" : "",
      row.judgeError ? "judge_error" : "",
      row.score && !row.score.productionValidationPassed ? "production_validation" : "",
      row.kind !== "unanswerable" &&
        (row.score?.missingFacts || []).length &&
        (!useJudge || !row.compositeSemanticPassed) ? "missing_required_fact" : "",
      (row.score?.missingNumbers || []).length ? "numeric_fact" : "",
      (row.score?.contradictions || []).length ? "forbidden_contradiction" : "",
      row.score && !row.score.behaviorPassed ? "behavior" : "",
      row.score && !row.score.citationsPassed ? "citation" : "",
      row.kind !== "unanswerable" && row.score && !row.score.selectedGroundingPassed ? "retrieval_or_evidence" : "",
      row.kind !== "unanswerable" && row.score && !row.score.citedGroundingPassed ? "cited_evidence" : "",
      useJudge && row.kind !== "unanswerable" && !row.compositeSemanticPassed ? "composite_semantic_rejection" : "",
      row.markerLeak ? "answer_key_marker_leak" : ""
    ].filter(Boolean),
    diagnostic_codes: [
      row.kind === "unanswerable" && !row.groundedGuidancePassed ? "grounded_guidance_missing" : "",
      useJudge && !row.rawJudgeCorrect ? "raw_judge_rejection" : "",
      useJudge && !row.judgeContractValid ? "judge_contract_invalid" : "",

      useJudge && row.judgeDisposition === "concrete_judge_objection" ? "concrete_judge_objection" : "",
      useJudge && row.kind === "unanswerable" && !row.compositeSemanticPassed
        ? "grounded_guidance_judge_rejection"
        : ""
    ].filter(Boolean),
    provider_stages: row.providerStages,
    provider_trace: (row.providerTrace || []).map((entry) => ({
      phase: String(entry?.phase || "").slice(0, 24),
      stage: String(entry?.stage || "").slice(0, 40),
      outcome: String(entry?.outcome || "").slice(0, 24),
      elapsed_ms: Math.max(0, Number(entry?.elapsedMs) || 0),
      response_chars: Math.max(0, Number(entry?.responseChars) || 0),
      response_sha256: /^[a-f0-9]{64}$/i.test(String(entry?.responseSha256 || ""))
        ? String(entry.responseSha256)
        : "",
      json_envelope: String(entry?.jsonEnvelope || "").slice(0, 40),
      json_syntax_ok: Boolean(entry?.jsonSyntaxOk),
      parse_failure_code: String(entry?.parseFailureCode || "").slice(0, 80),
      top_level_keys: (Array.isArray(entry?.topLevelKeys) ? entry.topLevelKeys : []).map(String).slice(0, 12),
      unknown_top_level_key_count: Math.max(0, Number(entry?.topLevelUnknownCount) || 0),
      answer_block_count: Number.isInteger(entry?.answerBlockCount) ? entry.answerBlockCount : null,
      error_code: String(entry?.errorCode || "").slice(0, 80),
      structured_output_expected: Boolean(entry?.structuredOutputExpected),
      dispatched: Boolean(entry?.dispatched),
      answer_key_marker_present: Boolean(entry?.answerKeyMarkerPresent),
      opaque_candidate_id_present: Boolean(entry?.opaqueCandidateIdPresent),
      credential_marker_present: Boolean(entry?.credentialMarkerPresent)
    })),
    pipeline_diagnostics: row.pipelineDiagnostics,
    source_document_ids: row.sourceDocumentIds,
    answer_source_document_ids: row.answerSourceDocumentIds,
    ...(showDetails ? { answer: row.answer, deterministic_score: row.score, judge_result: row.judge } : {})
  }))
};

const gateFailures = [];
const minimumAccuracy = 0.95;
if (report.metrics.pipeline_completion_rate < 0.98) gateFailures.push("pipeline completion below 98%");
if (answerableRows.length) {
  if (report.metrics.answerable_cases.production_validation_rate < minimumAccuracy) gateFailures.push("answerable production validation below 95%");
  if (report.metrics.answerable_cases.generated_answer_accuracy < minimumAccuracy) gateFailures.push("answerable generated-answer accuracy below 95%");
  if (report.metrics.answerable_cases.grounding_pass_rate < minimumAccuracy) gateFailures.push("answerable grounding pass rate below 95%");
  if (report.metrics.answerable_cases.end_to_end_accuracy < minimumAccuracy) gateFailures.push("answerable end-to-end accuracy below 95%");
  if (useJudge && report.metrics.answerable_cases.composite_semantic_accuracy < minimumAccuracy) gateFailures.push("answerable composite semantic accuracy below 95%");
}
if (useJudge && report.metrics.judge_contract_valid_rate < 1) {
  gateFailures.push("judge contract validity below 100%");
}
if (report.metrics.contradiction_rate > 0) gateFailures.push("at least one forbidden contradiction was generated");
if (unanswerableRows.length && report.metrics.unanswerable_controls.correct_abstention_rate < 1) {
  gateFailures.push("unanswerable-control abstention below 100%");
}
// Grounded fallback guidance is useful diagnostics for unanswerable controls, but
// the release requirement is correct abstention without fabricated facts.
const minimumConsistency = 0.95;
if (repeats >= 3 && report.metrics.consistent_case_rate < minimumConsistency) {
  gateFailures.push(`consistent-case rate below ${Math.round(minimumConsistency * 100)}%`);
}
if (zeroPassCasesFailGate(repeats, report.zero_pass_case_ids)) {
  gateFailures.push("at least one logical case had no passing execution across repeated runs");
}
if (report.failure_categories.answer_key_marker_leak > 0) gateFailures.push("answer-key marker reached a production prompt");
if (maxP50Ms !== null && report.metrics.production_pipeline_latency_p50_ms > maxP50Ms) {
  gateFailures.push(`production pipeline p50 latency exceeded ${maxP50Ms} ms`);
}
if (maxP95Ms !== null && report.metrics.production_pipeline_latency_p95_ms > maxP95Ms) {
  gateFailures.push(`production pipeline p95 latency exceeded ${maxP95Ms} ms`);
}
if (maxProviderCalls !== null && report.metrics.production_provider_calls_p95 > maxProviderCalls) {
  gateFailures.push(`production provider-call p95 exceeded ${maxProviderCalls}`);
}
report.gate = {
  passed: gateFailures.length === 0,
  failures: gateFailures,
  zero_pass_policy: repeats > 1
    ? "fail_if_a_sampled_case_never_passes_across_repeated_runs"
    : "diagnostic_only_single_repeat_uses_95_percent_aggregate_answerable_threshold"
};

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const percent = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  console.log(
    `live-holdout-eval ${report.gate.passed ? "passed" : "failed"}: ` +
    `answerable ${percent(report.metrics.answerable_cases.generated_answer_accuracy)}, grounding ${percent(report.metrics.answerable_cases.grounding_pass_rate)}, ` +
    `end-to-end ${percent(report.metrics.answerable_cases.end_to_end_accuracy)}, abstention controls ${percent(report.metrics.unanswerable_controls.correct_abstention_rate)}, ` +
    `contradictions ${percent(report.metrics.contradiction_rate)}, ` +
    `consistent ${percent(report.metrics.consistent_case_rate)}, ` +
    `pipeline p50/p95 ${Math.round(report.metrics.production_pipeline_latency_p50_ms || 0)}/${Math.round(report.metrics.production_pipeline_latency_p95_ms || 0)} ms, ` +
    `provider calls avg/p95 ${(report.metrics.production_provider_calls_average || 0).toFixed(1)}/${report.metrics.production_provider_calls_p95 || 0}`
  );
  if (gateFailures.length) console.log(`Gate failures: ${gateFailures.join("; ")}`);
  if (report.zero_pass_case_ids.length) console.log(`Opaque zero-pass IDs: ${report.zero_pass_case_ids.join(", ")}`);
  if (report.inconsistent_case_ids.length) console.log(`Opaque inconsistent IDs: ${report.inconsistent_case_ids.join(", ")}`);
  if (showDetails) {
    for (const row of report.rows.filter((item) => !item.passed)) {
      console.log(`\n${row.id} variant ${row.variant_index + 1}: ${row.failure_codes.join(", ") || row.error}`);
      if (row.answer) console.log(row.answer);
    }
  }
}

if (!noGate && gateFailures.length) process.exitCode = 1;
