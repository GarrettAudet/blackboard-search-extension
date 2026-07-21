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
  --suite v1|v2          Holdout/corpus suite to execute (default: v1)
  --seed VALUE            Seed for case order and variant selection (default: live-release)
  --repeats N             Seeded variant rotations, 1-6 (default: 1)
  --case IDS              Comma-separated opaque holdout IDs
  --case-limit N          Randomized cases per repeat (default: all)
  --judge                 Add a separate answer-key-aware judge call after generation
  --judge-provider NAME   Optional different provider for the judge
  --judge-model NAME      Optional different model for the judge
  --judge-api-key-env VAR Optional different key environment variable for the judge
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
if (!new Set(["v1", "v2"]).has(suite)) throw new Error("Choose --suite v1 or --suite v2.");
const seed = valueAfter("--seed", selfTest ? "mock-self-test" : "live-release");
const repeats = selfTest ? 1 : numberAfter("--repeats", 1, 1, 6);
const delayMs = selfTest ? 0 : numberAfter("--delay-ms", 0, 0, 60000);
const caseLimitArgument = valueAfter("--case-limit", "");
const caseLimit = caseLimitArgument ? numberAfter("--case-limit", 18, 1, 1000) : Number.POSITIVE_INFINITY;
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
  liveMockMode: selfTest
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
  globalThis.__liveProviderTrace = [];
  globalThis.__livePhase = "idle";
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

  callChatCompletion = async (request) => {
    const stage = __liveProviderStage(request);
    const promptText = (request?.messages || []).map((message) => String(message?.content || "")).join("\\n");
    const answerKeyMarkerPresent = promptText.includes("<ANSWER_KEY_EVALUATION_ONLY>");
    const opaqueCandidateIdPresent = /\\b(?:E\\d{3}|D\\d+C\\d{2})\\b/.test(promptText);
    const credentialMarkerPresent = Boolean(liveSettings.apiKey && promptText.includes(liveSettings.apiKey));
    globalThis.__liveProviderTrace.push({
      phase: globalThis.__livePhase,
      stage,
      answerKeyMarkerPresent,
      opaqueCandidateIdPresent,
      credentialMarkerPresent
    });
    if (globalThis.__livePhase === "production" && (answerKeyMarkerPresent || credentialMarkerPresent)) {
      throw new Error("Evaluation or credential content reached a production prompt.");
    }
    if (liveMockMode) {
      if (stage === "planner") return globalThis.__liveMockPlan;
      if (stage === "selector") return __liveMockSelectorResponse(request);
      if (stage === "deep_selector") return __liveMockDeepSelectorResponse(request);
      if (stage === "verifier") return __liveMockVerifierResponse(request);
      if (stage === "reviewer" || stage === "recovery" || stage === "answer") return __liveStructuredAnswerResponse(globalThis.__liveMockAnswer);
      if (stage === "judge") {
        return JSON.stringify({ correct: true, score: 1, missing_facts: [], contradictions: [], reason: "Mock answer matches." });
      }
      return __liveStructuredAnswerResponse(globalThis.__liveMockAnswer);
    }
    return await __liveRealCallChatCompletion(request);
  };

  globalThis.__runLiveProductionPipeline = async (query) => {
    globalThis.__livePhase = "production";
    const traceStart = globalThis.__liveProviderTrace.length;
    try {
      const baseRetrievalQuery = buildRetrievalQuery(query, []);
      const plan = await buildQueryPlan(query, [], baseRetrievalQuery);
      const retrievalQuery = enhanceRetrievalQueryForIntent(
        query,
        plannedRetrievalQuery(plan, query, baseRetrievalQuery),
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
        plan
      );
      const sources = evidenceSelection.sources.slice(0, 8);
      const synthesisSources = expandAnswerSourcesForSynthesis(query, sources, [], plan);
      const promptSources = answerPromptSources(synthesisSources, 5, MAX_ANSWER_SOURCE_TEXT_CHARS);
      const answer = await generateVerifiedApiAnswer(query, synthesisSources, [], retrievalQuery, plan);
      const cleanNotFound = isCleanNotFoundAnswer(answer?.text || "");
      const validation = cleanNotFound
        ? { ok: true, reasons: [], cleanNotFound: true }
        : citedAnswerValidation(query, answer, synthesisSources, retrievalQuery);
      return {
        plan,
        retrievalQuery,
        retrievalQueries,
        sources: promptSources.map((promptSource, index) => ({
          documentId: synthesisSources[index]?.source_pack_document_id || synthesisSources[index]?.resource_id || sourceDedupeKey(synthesisSources[index]),
          title: promptSource.title,
          text: String(promptSource.text || ""),
          score: Number(synthesisSources[index]?.score) || 0,
          promptSourceId: promptSource.id
        })),
        answer: { text: String(answer?.text || ""), sourceCount: Array.isArray(answer?.sources) ? answer.sources.length : 0 },
        validation: { ok: Boolean(validation.ok), reasons: [...(validation.reasons || [])], cleanNotFound },
        evidenceSelection: {
          mode: evidenceSelection.mode,
          selectorCalls: evidenceSelection.selector_calls,
          deepReadCalls: evidenceSelection.deep_read_calls
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
        maxTokens: 600,
        messages: [
          {
            role: "system",
            content:
              "You are a strict holdout evaluator, not a user-facing assistant. Return JSON only with fields correct, score, missing_facts, contradictions, and reason. " +
              "Judge the candidate against the answer key. Accept faithful paraphrases and equivalent numeric formats. Mark any forbidden contradiction incorrect. " +
              "For abstain_or_qualify cases, require both a clear limitation and the useful supported guidance. Do not improve or rewrite the answer."
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
    .replace(/[’']/g, "'")
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
function canonicalToken(token) {
  let value = numberWords.get(token) || token;
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
function factMatches(answerText, pattern) {
  const requiredTokens = canonicalTokens(pattern);
  const actualTokens = canonicalTokens(answerText);
  return orderedTokenWindowMatch(requiredTokens, actualTokens);
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
function evidenceGroupPass(group, sources) {
  const source = sources.slice(0, 5).find((item) => item.documentId === group.document_id);
  if (!source) return false;
  const haystack = normalized(source.text);
  return (group.patterns_all || []).every((pattern) => haystack.includes(normalized(pattern)));
}
function scoreAnswer(testCase, pipelineResult) {
  const answerText = String(pipelineResult?.answer?.text || "");
  const requiredPatterns = testCase.answer_key.patterns_all || [];
  const missingFacts = requiredPatterns.filter((pattern) => !factMatches(answerText, pattern));
  const contradictions = forbiddenMatches(answerText, testCase.answer_key.forbidden_patterns || []);
  const requiredNumbers = Array.from(new Set(requiredPatterns.flatMap(numericFacts)));
  const answerNumbers = new Set(numericFacts(answerText));
  const missingNumbers = requiredNumbers.filter((number) => !answerNumbers.has(number));
  const behaviorPassed = testCase.answer_key.required_behavior !== "abstain_or_qualify" || hasQualification(answerText);
  const citationNumbers = Array.from(answerText.matchAll(/\[(\d+)\]/g), (match) => Number(match[1]));
  const citationsPassed =
    citationNumbers.length > 0 &&
    Number(pipelineResult?.answer?.sourceCount || 0) > 0 &&
    citationNumbers.every((number) => number >= 1 && number <= pipelineResult.answer.sourceCount);
  const expectedDocuments = testCase.expected_documents || [];
  const retrievedDocumentIds = pipelineResult.sources.slice(0, 5).map((source) => source.documentId);
  const missingDocuments = expectedDocuments.filter((id) => !retrievedDocumentIds.includes(id));
  const evidenceResults = (testCase.evidence_groups || []).map((group) => evidenceGroupPass(group, pipelineResult.sources));
  const productionFailure = /could not produce a reliable cited answer/i.test(answerText);
  const requiredFactsPassed = missingFacts.length === 0;
  const safetyPassed =
    !productionFailure &&
    Boolean(pipelineResult.validation?.ok) &&
    citationsPassed &&
    missingNumbers.length === 0 &&
    contradictions.length === 0 &&
    behaviorPassed;
  const generatedAnswerPassed = safetyPassed && requiredFactsPassed;
  const groundingPassed = missingDocuments.length === 0 && evidenceResults.every(Boolean);
  return {
    passed: generatedAnswerPassed && groundingPassed,
    generatedAnswerPassed,
    requiredFactsPassed,
    safetyPassed,
    groundingPassed,
    productionValidationPassed: Boolean(pipelineResult.validation?.ok),
    citationsPassed,
    behaviorPassed,
    productionFailure,
    missingFacts,
    missingNumbers,
    contradictions,
    missingDocuments,
    missingEvidenceGroups: evidenceResults.filter((value) => !value).length
  };
}

function evaluatedAnswerPassed(score, judgeResult = null, judgeEnabled = false) {
  if (!score?.safetyPassed) return false;
  return judgeEnabled ? Boolean(judgeResult?.correct) : Boolean(score.requiredFactsPassed);
}

function evaluatedExecutionPassed(score, judgeResult = null, judgeEnabled = false) {
  return evaluatedAnswerPassed(score, judgeResult, judgeEnabled) && Boolean(score?.groundingPassed);
}

function parseJsonObject(text) {
  const clean = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    const parsed = JSON.parse(clean);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(clean.slice(start, end + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch (_nestedError) {
      return null;
    }
  }
}

async function runProductionPipeline(query) {
  context.__liveQuery = query;
  vm.runInContext("globalThis.__livePipelinePromise = __runLiveProductionPipeline(globalThis.__liveQuery);", context);
  return await context.__livePipelinePromise;
}
async function runJudge(question, answer, answerKey) {
  context.__liveJudgePayload = { question, answer, answerKey };
  vm.runInContext("globalThis.__liveJudgePromise = __runLiveJudge(globalThis.__liveJudgePayload);", context);
  const response = await context.__liveJudgePromise;
  const parsed = parseJsonObject(response);
  if (!parsed || typeof parsed.correct !== "boolean") throw new Error("Judge returned malformed JSON.");
  return {
    correct: parsed.correct,
    score: Math.max(0, Math.min(1, Number(parsed.score) || 0)),
    missingFacts: Array.isArray(parsed.missing_facts) ? parsed.missing_facts.map(String).slice(0, 12) : [],
    contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions.map(String).slice(0, 12) : [],
    reason: String(parsed.reason || "").slice(0, 500)
  };
}

async function runSelfTest() {
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
  const pipelineResult = await runProductionPipeline(testCase.variants[0]);
  const score = scoreAnswer(testCase, pipelineResult);
  if (!score.passed) {
    throw new Error("Mocked production pipeline did not pass scoring: " + JSON.stringify({ score, pipelineResult }, null, 2));
  }
  if (
    pipelineResult.sources.length > 5 ||
    pipelineResult.sources.some((source, index) => source.promptSourceId !== index + 1 || source.text.length > 1500000) ||
    pipelineResult.sources.reduce((sum, source) => sum + source.text.length, 0) > 2500000
  ) {
    throw new Error("Self-test scoring exceeded the five-source high document-context safety ceilings.");
  }
  const normalStages = pipelineResult.providerTrace.map((entry) => entry.stage);
  const normalDeepStageCount = normalStages.filter((stage) => stage === "deep_selector").length;
  const normalMiddleStages = normalStages.slice(2, -2);
  if (
    pipelineResult.evidenceSelection?.mode !== "semantic_deep_read" ||
    pipelineResult.evidenceSelection?.deepReadCalls < 1 ||
    pipelineResult.evidenceSelection?.deepReadCalls > 9 ||
    normalDeepStageCount !== pipelineResult.evidenceSelection?.deepReadCalls ||
    normalStages[0] !== "planner" ||
    normalStages[1] !== "selector" ||
    normalStages.at(-2) !== "answer" ||
    normalStages.at(-1) !== "verifier" ||
    normalMiddleStages.some((stage) => stage !== "deep_selector")
  ) {
    throw new Error("Self-test did not exercise bounded planner -> semantic selector/deep-read -> draft synthesis -> grounding verifier: " + JSON.stringify(pipelineResult.providerTrace));
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
  for (const requiredStage of ["planner", "selector", "deep_selector", "answer", "reviewer", "recovery"]) {
    if (!policyStages.includes(requiredStage)) {
      throw new Error(`Policy self-test omitted ${requiredStage}: ${policyStages.join(",")}`);
    }
  }
  if (
    policyPipelineResult.evidenceSelection?.deepReadCalls < 1 ||
    policyPipelineResult.evidenceSelection?.deepReadCalls > 9 ||
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
  const productionTrace = context.__liveProviderTrace.filter((entry) => entry.phase === "production");
  const evaluationTrace = context.__liveProviderTrace.filter((entry) => entry.phase === "evaluation");
  if (!acceptingJudge?.correct || forbiddenNetworkCalls !== 0) throw new Error("Mock judge failed or the self-test attempted network access.");
  if (productionTrace.some((entry) => entry.answerKeyMarkerPresent)) throw new Error("Answer-key marker leaked into production prompts.");
  if (!evaluationTrace.some((entry) => entry.stage === "judge" && entry.answerKeyMarkerPresent)) {
    throw new Error("Self-test did not keep answer-key content inside the post-production judge phase.");
  }
  if (
    !productionTrace.some((entry) => entry.stage === "planner") ||
    !productionTrace.some((entry) => entry.stage === "selector") ||
    !productionTrace.some((entry) => entry.stage === "answer") ||
    !productionTrace.some((entry) => entry.stage === "verifier")
  ) {
    throw new Error("Self-test did not exercise planner, semantic selector, answer generation, and grounding verification.");
  }
  if (productionTrace.some((entry) => entry.credentialMarkerPresent)) {
    throw new Error("Provider credentials leaked into a production prompt.");
  }
  console.log(`live-holdout-eval ${suite} self-test passed (no network; planner -> semantic selector/deep-read -> adaptive full-document synthesis -> grounding verifier with bounded reviewer/recovery; high context safety ceilings; answer-key/judge separation)`);
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
    const offset = seedNumber(`${seed}|variant|${testCase.id}`) % testCase.variants.length;
    const variantIndex = (offset + repeat) % testCase.variants.length;
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
  let error = "";
  try {
    // Deliberate security boundary: production receives only the user question. The answer key is first read by scoring below.
    pipelineResult = await runProductionPipeline(item.query);
    deterministicScore = scoreAnswer(item.testCase, pipelineResult);
    if (useJudge) judge = await runJudge(item.query, pipelineResult.answer.text, item.testCase.answer_key);
  } catch (caught) {
    error = redact(caught).slice(0, 1000);
  }
  const markerLeak = (pipelineResult?.providerTrace || []).some((entry) => entry.answerKeyMarkerPresent);
  const answerPassed = Boolean(evaluatedAnswerPassed(deterministicScore, judge, useJudge) && !markerLeak && !error);
  const passed = Boolean(answerPassed && deterministicScore?.groundingPassed);
  rows.push({
    id: item.testCase.id,
    kind: item.testCase.kind,
    repeat: item.repeat,
    variantIndex: item.variantIndex,
    answerPassed,
    passed,
    elapsedMs: performance.now() - rowStarted,
    error,
    markerLeak,
    score: deterministicScore,
    judge,
    providerStages: (pipelineResult?.providerTrace || []).map((entry) => entry.stage),
    sourceDocumentIds: (pipelineResult?.sources || []).slice(0, 5).map((source) => source.documentId),
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
const rate = (predicate) => rows.filter(predicate).length / Math.max(1, rows.length);
const report = {
  suite,
  suite_id: fixture.suite_id,
  seed,
  repeats,
  scheduled_executions: schedule.length,
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
    pipeline_completion_rate: rate((row) => !row.error),
    production_validation_rate: rate((row) => row.score?.productionValidationPassed),
    generated_answer_accuracy: rate((row) => row.answerPassed),
    deterministic_required_fact_rate: rate((row) => row.score?.requiredFactsPassed),
    grounding_pass_rate: rate((row) => row.score?.groundingPassed),
    end_to_end_accuracy: rate((row) => row.passed),
    contradiction_rate: rate((row) => (row.score?.contradictions || []).length > 0),
    citation_pass_rate: rate((row) => row.score?.citationsPassed),
    judge_accuracy: useJudge ? rate((row) => row.judge?.correct) : null,
    consistent_case_rate: repeats > 1
      ? caseSummaries.filter((item) => item.passes === item.attempts).length / Math.max(1, caseSummaries.length)
      : null
  },
  zero_pass_case_ids: caseSummaries.filter((item) => item.passes === 0).map((item) => item.id),
  inconsistent_case_ids: repeats > 1
    ? caseSummaries.filter((item) => item.passes > 0 && item.passes < item.attempts).map((item) => item.id)
    : [],
  failure_categories: {
    provider_or_runtime_error: rows.filter((row) => row.error).length,
    production_validation: rows.filter((row) => !row.error && !row.score?.productionValidationPassed).length,
    missing_required_fact: rows.filter((row) =>
      (row.score?.missingFacts || []).length > 0 && (!useJudge || !row.judge?.correct)
    ).length,
    deterministic_pattern_miss: rows.filter((row) => (row.score?.missingFacts || []).length > 0).length,
    semantic_judge_rescue: useJudge
      ? rows.filter((row) => row.answerPassed && !row.score?.requiredFactsPassed && row.judge?.correct).length
      : 0,
    numeric_fact: rows.filter((row) => (row.score?.missingNumbers || []).length > 0).length,
    forbidden_contradiction: rows.filter((row) => (row.score?.contradictions || []).length > 0).length,
    behavior: rows.filter((row) => row.score && !row.score.behaviorPassed).length,
    citation: rows.filter((row) => row.score && !row.score.citationsPassed).length,
    retrieval_or_evidence: rows.filter((row) => row.score && !row.score.groundingPassed).length,
    judge: useJudge ? rows.filter((row) => !row.judge?.correct).length : 0,
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
    elapsed_ms: row.elapsedMs,
    error: row.error,
    failure_codes: [
      row.score && !row.score.productionValidationPassed ? "production_validation" : "",
      (row.score?.missingFacts || []).length && (!useJudge || !row.judge?.correct) ? "missing_required_fact" : "",
      (row.score?.missingNumbers || []).length ? "numeric_fact" : "",
      (row.score?.contradictions || []).length ? "forbidden_contradiction" : "",
      row.score && !row.score.behaviorPassed ? "behavior" : "",
      row.score && !row.score.citationsPassed ? "citation" : "",
      row.score && !row.score.groundingPassed ? "retrieval_or_evidence" : "",
      useJudge && !row.judge?.correct ? "judge" : "",
      row.markerLeak ? "answer_key_marker_leak" : ""
    ].filter(Boolean),
    provider_stages: row.providerStages,
    source_document_ids: row.sourceDocumentIds,
    ...(showDetails ? { answer: row.answer, deterministic_score: row.score, judge_result: row.judge } : {})
  }))
};

const gateFailures = [];
if (report.metrics.pipeline_completion_rate < 0.98) gateFailures.push("pipeline completion below 98%");
if (report.metrics.production_validation_rate < 0.90) gateFailures.push("production validation below 90%");
if (report.metrics.generated_answer_accuracy < 0.90) gateFailures.push("generated-answer accuracy below 90%");
if (report.metrics.grounding_pass_rate < 0.90) gateFailures.push("grounding pass rate below 90%");
if (report.metrics.end_to_end_accuracy < 0.90) gateFailures.push("end-to-end accuracy below 90%");
if (report.metrics.contradiction_rate > 0) gateFailures.push("at least one forbidden contradiction was generated");
if (useJudge && report.metrics.judge_accuracy < 0.90) gateFailures.push("judge accuracy below 90%");
const minimumConsistency = suite === "v2" ? 0.95 : 0.85;
if (repeats >= 3 && report.metrics.consistent_case_rate < minimumConsistency) {
  gateFailures.push(`consistent-case rate below ${Math.round(minimumConsistency * 100)}%`);
}
if (report.zero_pass_case_ids.length) gateFailures.push("at least one logical case had no passing execution");
if (report.failure_categories.answer_key_marker_leak > 0) gateFailures.push("answer-key marker reached a production prompt");
report.gate = { passed: gateFailures.length === 0, failures: gateFailures };

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const percent = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  console.log(
    `live-holdout-eval ${report.gate.passed ? "passed" : "failed"}: ` +
    `answer ${percent(report.metrics.generated_answer_accuracy)}, grounding ${percent(report.metrics.grounding_pass_rate)}, ` +
    `end-to-end ${percent(report.metrics.end_to_end_accuracy)}, contradictions ${percent(report.metrics.contradiction_rate)}, ` +
    `consistent ${percent(report.metrics.consistent_case_rate)}`
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
