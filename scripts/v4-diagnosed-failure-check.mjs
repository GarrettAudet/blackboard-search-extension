import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const productionRoot = path.resolve(process.argv[2] || path.join(scriptDirectory, ".."));
const readProduction = (relativePath) => fs.readFileSync(path.join(productionRoot, ...relativePath.split("/")), "utf8");
const moduleSource = [
  "lib/answer-formatting.js",
  "lib/llm-client.js",
  "lib/search-index.js"
].map(readProduction).join("\n\n");
const sidepanelSource = readProduction("sidepanel/sidepanel.js");
const runtimeStart = sidepanelSource.indexOf("chrome.runtime.onMessage.addListener");
if (runtimeStart < 0) throw new Error("Could not isolate the side-panel runtime.");

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

const warnings = [];
const context = {
  console: {
    ...console,
    warn(...values) { warnings.push(values.map((value) => String(value?.message || value)).join(" ")); }
  },
  URL,
  setTimeout,
  clearTimeout,
  AbortController,
  fetch: async () => { throw new Error("Network is forbidden in v4-diagnosed-failure-check."); },
  document: { getElementById() { return mockElement(); }, createElement() { return mockElement(); } },
  chrome: {
    runtime: {
      sendMessage() {}, getManifest() { return { version: "diagnosed-regression-test" }; },
      getURL(path) { return "chrome-extension://diagnosed-regression/" + path; }, onMessage: { addListener() {} }
    },
    tabs: { async create() {} }, storage: { local: { async get() { return {}; }, async set() {} } }
  }
};
vm.createContext(context);
vm.runInContext(moduleSource + "\n\n" + sidepanelSource.slice(0, runtimeStart), context);
vm.runInContext(`
  state.resources = [];
  state.contentStore = {};
  state.transcripts = [];
  state.settings = {
    provider: "openrouter",
    model: "synthetic-regression-model",
    apiKey: "SYNTHETIC_TEST_KEY",
    hasApiKey: true
  };
  invalidateSearchIndexCache();
`, context);

let nextResultIndex = 1;
function result({ parent, title, text, score = 2000, sourcePack = true }) {
  const index = nextResultIndex++;
  return {
    resource_id: `synthetic-resource-${index}`,
    source_pack_id: sourcePack ? "synthetic-pack" : "",
    source_pack_document_id: parent,
    source_pack_document_title: title,
    source_pack_page_range: `section-${index}`,
    source_pack_provenance: "official indexed synthetic guidance",
    source_provenance: "official indexed synthetic guidance",
    kind: "document",
    title,
    base_title: title,
    source: "Synthetic indexed corpus",
    url: `https://example.invalid/${parent}/${index}`,
    text,
    score,
    has_body: true,
    search_part_index: index,
    search_part_count: 20,
    retrieval_route_ranks: [{ routeIndex: 0, rankIndex: index - 1 }],
    retrieval_route_queries: [{ routeIndex: 0, rankIndex: index - 1, query: title }]
  };
}

function stageFor(request) {
  const system = String(request?.messages?.find((message) => message.role === "system")?.content || "");
  if (/deep-read evidence selector/i.test(system)) return "deep";
  if (/semantic evidence selector/i.test(system)) return "selector";
  if (/semantic grounding verifier/i.test(system)) return "verifier";
  if (/grounding repair (?:reviewer|writer)/i.test(system)) return "reviewer";
  if (/(?:Write only|Create) the final user-facing answer/i.test(system)) return "recovery";
  return "answer";
}

function payloadFor(request) {
  const user = String(request?.messages?.find((message) => message.role === "user")?.content || "");
  const start = user.indexOf("{");
  if (start < 0) throw new Error("Expected a JSON payload in the synthetic selector request.");
  return JSON.parse(user.slice(start));
}

function candidateId(payload, marker) {
  return payload.candidates.find((candidate) => String(candidate.text || "").includes(marker))?.candidate_id || null;
}

function selectorResponse(payload, ids, { insufficient = false, deepReadCandidateId = null } = {}) {
  const available = ids.filter(Boolean);
  return JSON.stringify({
    facet_selections: payload.facets.map((facet) => ({
      facet_id: facet.facet_id,
      candidate_ids: available.slice(0, 3)
    })),
    insufficient,
    deep_read_candidate_id: deepReadCandidateId
  });
}

function structuredAnswer(text, sourceIds = [1]) {
  return JSON.stringify({
    not_found: false,
    answer_blocks: [{ text, source_ids: sourceIds }]
  });
}

function cleanNotFound() {
  return JSON.stringify({ not_found: true, answer_blocks: [] });
}

async function runSelection({ query, results, fallback, plan, responder, memory = [] }) {
  const requests = [];
  context.__testQuery = query;
  context.__testResults = results;
  context.__testFallback = fallback;
  context.__testPlan = plan;
  context.__testMemory = memory;
  context.__testQueries = [query, plan.retrieval_query, ...(plan.search_queries || [])];
  context.__testResponder = async (request) => {
    requests.push(request);
    return await responder(request, requests);
  };
  vm.runInContext(`
    callChatCompletion = async (request) => await globalThis.__testResponder(request);
    globalThis.__testPromise = selectSemanticEvidenceForApi(
      globalThis.__testQuery,
      globalThis.__testResults,
      globalThis.__testFallback,
      globalThis.__testQueries,
      globalThis.__testPlan.retrieval_query,
      globalThis.__testPlan,
      globalThis.__testMemory
    );
  `, context);
  return { selection: await context.__testPromise, requests };
}

async function runAnswer({ query, sources, plan, responder, memory = [] }) {
  const requests = [];
  context.__answerQuery = query;
  context.__answerSources = sources;
  context.__answerPlan = plan;
  context.__answerMemory = memory;
  context.__answerResponder = async (request) => {
    requests.push(request);
    return await responder(request, requests);
  };
  vm.runInContext(`
    callChatCompletion = async (request) => await globalThis.__answerResponder(request);
    globalThis.__answerPromise = generateVerifiedApiAnswer(
      globalThis.__answerQuery,
      globalThis.__answerSources,
      globalThis.__answerMemory,
      globalThis.__answerPlan.retrieval_query,
      globalThis.__answerPlan
    );
  `, context);
  return { answer: await context.__answerPromise, requests };
}

function planFor(question) {
  return {
    intent: "document_question",
    scope: "in_scope",
    rewritten_question: question,
    retrieval_query: question,
    search_queries: [question],
    source_preferences: [],
    confidence: 1
  };
}

const failures = [];
const passed = [];
async function check(code, test) {
  try {
    if (await test()) passed.push(code);
    else failures.push(code);
  } catch (error) {
    failures.push(`${code}:RUNTIME_${String(error?.message || error).replace(/[^A-Za-z0-9]+/g, "_").slice(0, 100)}`);
  }
}

await check("INVALID_SELECTOR_BOUNDED_REPAIR", async () => {
  const query = "How should a club request room access?";
  const target = result({
    parent: "access-guide", title: "Room Access Guide",
    text: "REPAIR_TARGET Submit the room access request before the club meeting."
  });
  const fallback = result({
    parent: "fallback-guide", title: "Unrelated Guide",
    text: "FALLBACK_ONLY General background with no room-access procedure."
  });
  let selectorAttempts = 0;
  const run = await runSelection({
    query, results: [target, fallback], fallback: [fallback], plan: planFor(query),
    responder: (request) => {
      if (stageFor(request) !== "selector") throw new Error("Unexpected stage during selector repair.");
      selectorAttempts += 1;
      if (selectorAttempts === 1) return "malformed selector output";
      const payload = payloadFor(request);
      return selectorResponse(payload, [candidateId(payload, "REPAIR_TARGET")]);
    }
  });
  return selectorAttempts === 2 &&
    run.selection.mode !== "deterministic_fallback" &&
    run.selection.sources.some((source) => /REPAIR_TARGET/.test(source.text));
});

await check("UNSAFE_FACET_SELECTION_SALVAGE", async () => {
  const query = "Summarize reservation approval and reimbursement records.";
  const approval = result({
    parent: "event-guide", title: "Event Guide",
    text: "APPROVAL_TARGET Obtain reservation approval before committing funds."
  });
  const reimbursement = result({
    parent: "event-guide", title: "Event Guide",
    text: "REIMBURSEMENT_TARGET Retain the reimbursement record after the activity."
  });
  const distractor = result({
    parent: "garden-guide", title: "Garden Guide",
    text: "BOTANICAL_DISTRACTOR Seedlings prefer indirect morning light."
  });
  let selectorAttempts = 0;
  const run = await runSelection({
    query, results: [approval, reimbursement, distractor], fallback: [distractor], plan: planFor(query),
    responder: (request) => {
      if (stageFor(request) !== "selector") throw new Error("Unexpected stage during facet salvage.");
      selectorAttempts += 1;
      const payload = payloadFor(request);
      const approvalId = candidateId(payload, "APPROVAL_TARGET");
      const reimbursementId = candidateId(payload, "REIMBURSEMENT_TARGET");
      const distractorId = candidateId(payload, "BOTANICAL_DISTRACTOR");
      if (selectorAttempts > 1) return selectorResponse(payload, [approvalId, reimbursementId]);
      return JSON.stringify({
        facet_selections: payload.facets.map((facet, index) => ({
          facet_id: facet.facet_id,
          candidate_ids: index === 0
            ? [approvalId, reimbursementId, distractorId]
            : [index % 2 ? approvalId : reimbursementId]
        })),
        insufficient: false,
        deep_read_candidate_id: null
      });
    }
  });
  const text = run.selection.sources.map((source) => source.text).join("\n");
  const salvaged = run.selection.mode !== "deterministic_fallback" &&
    /APPROVAL_TARGET/.test(text) && /REIMBURSEMENT_TARGET/.test(text) && !/BOTANICAL_DISTRACTOR/.test(text);
  if (!salvaged) {
    throw new Error("Unsafe facet salvage diagnostics " + JSON.stringify({
      selectorAttempts, mode: run.selection.mode, reason: run.selection.reason,
      stages: run.requests.map(stageFor), text
    }));
  }
  return true;
});

await check("MULTI_PARENT_DEEP_READ", async () => {
  const query = "Explain alpha access and beta records.";
  const alphaOverview = result({
    parent: "alpha-parent", title: "Alpha Access",
    text: "ALPHA_OVERVIEW Alpha access is documented in this indexed guide."
  });
  const betaOverview = result({
    parent: "beta-parent", title: "Beta Records",
    text: "BETA_OVERVIEW Beta records are documented in this indexed guide."
  });
  const cachedDetails = [
    {
      id: "zzz-cached-alpha-detail",
      type: "document",
      title: "Alpha Access Detail",
      url: "https://example.invalid/alpha-parent/cached-detail",
      source_pack_id: "synthetic-pack",
      source_pack_document_id: "alpha-parent",
      source_pack_document_title: "Alpha Access",
      source_pack_provenance: "official indexed synthetic guidance"
    },
    {
      id: "zzz-cached-beta-detail",
      type: "document",
      title: "Beta Records Detail",
      url: "https://example.invalid/beta-parent/cached-detail",
      source_pack_id: "synthetic-pack",
      source_pack_document_id: "beta-parent",
      source_pack_document_title: "Beta Records",
      source_pack_provenance: "official indexed synthetic guidance"
    }
  ];
  const blockerResources = Array.from({ length: 65 }, (_, index) => ({
    id: `aaa-initial-pool-blocker-${String(index).padStart(2, "0")}`,
    type: "document",
    title: `Explain Alpha Access and Beta Records ${index}`,
    url: `https://example.invalid/initial-blocker/${index}`,
    source_pack_id: "synthetic-pack",
    source_pack_document_id: `blocker-parent-${index}`,
    source_pack_document_title: `Initial Pool Blocker ${index}`,
    source_pack_provenance: "official indexed synthetic guidance"
  }));
  const cachedContent = Object.fromEntries([
    [
      cachedDetails[0].id,
      "ALPHA_DETAIL Complete the alpha access form before entry. " +
        "This synthetic indexed paragraph preserves the cached parent detail without exposing private data. ".repeat(16)
    ],
    [
      cachedDetails[1].id,
      "BETA_DETAIL Retain the beta record after submission. " +
        "This synthetic indexed paragraph preserves the cached parent detail without exposing private data. ".repeat(16)
    ],
    ...blockerResources.map((resource, index) => [
      resource.id,
      (`Explain alpha access and beta records. Alpha access and beta records are required indexed topics ${index}. `).repeat(14)
    ])
  ]);
  context.__multiParentCachedResources = [...blockerResources, ...cachedDetails];
  context.__multiParentCachedContent = cachedContent;
  vm.runInContext(`
    state.resources = globalThis.__multiParentCachedResources;
    state.contentStore = globalThis.__multiParentCachedContent;
    invalidateSearchIndexCache();
  `, context);
  const deepParents = new Set();
  let initialDetailVisible = false;
  let run;
  try {
    run = await runSelection({
      query,
      results: [alphaOverview, betaOverview],
      fallback: [alphaOverview, betaOverview],
      plan: planFor(query),
      responder: (request) => {
        const payload = payloadFor(request);
        if (stageFor(request) === "selector") {
          initialDetailVisible ||= payload.candidates.some((candidate) => /(?:ALPHA|BETA)_DETAIL/.test(candidate.text));
          const alpha = candidateId(payload, "ALPHA_OVERVIEW");
          const beta = candidateId(payload, "BETA_OVERVIEW");
          return selectorResponse(payload, [alpha, beta], { insufficient: true, deepReadCandidateId: alpha });
        }
        if (stageFor(request) === "deep") {
          deepParents.add(String(payload.candidates[0]?.parent_id || ""));
          const alpha = candidateId(payload, "ALPHA_DETAIL");
          const beta = candidateId(payload, "BETA_DETAIL");
          const selected = [alpha, beta].filter(Boolean).slice(0, 1);
          return JSON.stringify({
            facet_selections: payload.facets.map((facet) => ({ facet_id: facet.facet_id, candidate_ids: selected })),
            insufficient: !selected.length
          });
        }
        throw new Error("Unexpected stage during multi-parent deep read.");
      }
    });
  } finally {
    vm.runInContext(`
      state.resources = [];
      state.contentStore = {};
      invalidateSearchIndexCache();
    `, context);
  }
  const text = run.selection.sources.map((source) => source.text).join("\n");
  const passed = !initialDetailVisible && deepParents.size >= 2 &&
    /ALPHA_DETAIL/.test(text) && /BETA_DETAIL/.test(text);
  if (!passed) throw new Error("Multi-parent deep-read diagnostics " + JSON.stringify({
    initialDetailVisible,
    deepParents: [...deepParents],
    stages: run.requests.map(stageFor),
    mode: run.selection.mode,
    reason: run.selection.reason,
    text
  }));
  return true;
});

await check("COMPOUND_ADJACENT_FRAGMENT_SELECTION", async () => {
  const query = "State the compound eligibility requirement.";
  const overview = result({
    parent: "compound-parent", title: "Compound Eligibility",
    text: "COMPOUND_OVERVIEW The eligibility requirement has two adjacent parts."
  });
  const first = result({
    parent: "compound-parent", title: "Compound Eligibility",
    text: "COMPOUND_PART_ONE Applicants submit the eligibility form."
  });
  const second = result({
    parent: "compound-parent", title: "Compound Eligibility",
    text: "COMPOUND_PART_TWO Applicants retain the confirmation record."
  });
  const run = await runSelection({
    query, results: [overview, first, second], fallback: [overview], plan: planFor(query),
    responder: (request) => {
      const payload = payloadFor(request);
      if (stageFor(request) === "selector") {
        const overviewId = candidateId(payload, "COMPOUND_OVERVIEW");
        return selectorResponse(payload, [overviewId], { insufficient: true, deepReadCandidateId: overviewId });
      }
      if (stageFor(request) === "deep") {
        const ids = [candidateId(payload, "COMPOUND_PART_ONE"), candidateId(payload, "COMPOUND_PART_TWO")].filter(Boolean);
        return JSON.stringify({
          facet_selections: payload.facets.map((facet) => ({ facet_id: facet.facet_id, candidate_ids: ids })),
          insufficient: ids.length < 2
        });
      }
      throw new Error("Unexpected stage during compound fragment selection.");
    }
  });
  const text = run.selection.sources.map((source) => source.text).join("\n");
  return /COMPOUND_PART_ONE/.test(text) && /COMPOUND_PART_TWO/.test(text);
});

await check("RESOLVED_FOLLOWUP_PROPAGATION", async () => {
  const rawQuestion = "What about that requirement?";
  const resolvedQuestion = "What documentation is required for the synthetic activity request?";
  const memory = [
    { user: "What is required for the synthetic activity request?", assistant: "It has a documentation requirement." }
  ];
  const overview = result({
    parent: "followup-parent", title: "Activity Request",
    text: "FOLLOWUP_OVERVIEW The synthetic activity request has a documentation requirement."
  });
  const detail = result({
    parent: "followup-parent", title: "Activity Request",
    text: "FOLLOWUP_DETAIL Submit the activity request form before the event."
  });
  const plan = planFor(resolvedQuestion);
  const selectionRun = await runSelection({
    query: rawQuestion, results: [overview, detail], fallback: [overview], plan, memory,
    responder: (request) => {
      const payload = payloadFor(request);
      if (stageFor(request) === "selector") {
        const overviewId = candidateId(payload, "FOLLOWUP_OVERVIEW");
        return selectorResponse(payload, [overviewId], { insufficient: true, deepReadCandidateId: overviewId });
      }
      if (stageFor(request) === "deep") {
        const detailId = candidateId(payload, "FOLLOWUP_DETAIL");
        return JSON.stringify({
          facet_selections: payload.facets.map((facet) => ({ facet_id: facet.facet_id, candidate_ids: detailId ? [detailId] : [] })),
          insufficient: !detailId
        });
      }
      throw new Error("Unexpected stage during follow-up selection.");
    }
  });
  const answerRun = await runAnswer({
    query: rawQuestion,
    sources: selectionRun.selection.sources,
    plan,
    memory,
    responder: (request) => stageFor(request) === "verifier"
      ? JSON.stringify({ answerable: true, supported: true, complete: true, contradiction: false })
      : structuredAnswer("Submit the activity request form before the event.")
  });
  const selectorRequest = selectionRun.requests.find((request) => stageFor(request) === "selector");
  const deepRequest = selectionRun.requests.find((request) => stageFor(request) === "deep");
  const answerRequest = answerRun.requests.find((request) => stageFor(request) === "answer");
  const verifierRequest = answerRun.requests.find((request) => stageFor(request) === "verifier");
  if (!selectorRequest || !answerRequest || !verifierRequest) {
    throw new Error("Follow-up propagation stage diagnostics " + JSON.stringify({ selection: selectionRun.requests.map(stageFor), answer: answerRun.requests.map(stageFor) }));
  }
  const selectorPayload = payloadFor(selectorRequest);
  const deepPayload = deepRequest ? payloadFor(deepRequest) : null;
  const answerUser = String(answerRequest?.messages?.find((message) => message.role === "user")?.content || "");
  const verifierUser = String(verifierRequest?.messages?.find((message) => message.role === "user")?.content || "");
  return selectorPayload.question === resolvedQuestion &&
    selectorPayload.rewritten_question === resolvedQuestion &&
    (!deepPayload || deepPayload.question === resolvedQuestion) &&
    answerUser.includes(`Question:\n${resolvedQuestion}`) &&
    verifierUser.includes(`Question:\n${resolvedQuestion}`);
});

await check("ANSWERABLE_SELECTION_CANNOT_ABSTAIN", async () => {
  const query = "What must be submitted before entry?";
  const source = result({
    parent: "entry-parent", title: "Entry Requirement",
    text: "ANSWERABLE_TARGET Submit the access request before entry."
  });
  const run = await runAnswer({
    query, sources: [source], plan: planFor(query),
    responder: (request) => {
      const stage = stageFor(request);
      if (stage === "answer") return cleanNotFound();
      if (stage === "verifier") {
        return JSON.stringify({
          answerable: true,
          supported: true,
          complete: true,
          contradiction: false
        });
      }
      if (stage === "reviewer" || stage === "recovery") {
        return structuredAnswer("Submit the access request before entry.");
      }
      throw new Error("Unexpected stage during answerability guard test.");
    }
  });
  return !/^I could not find that/i.test(run.answer.text) &&
    /access request/i.test(run.answer.text) && run.answer.sources.length === 1;
});

await check("TERMINAL_CONFLICT_REPAIR_PRESERVES_SUPPORTED_ANSWER", async () => {
  const namedQuery = "Which synthetic form is required?";
  const namedSource = result({
    parent: "form-parent", title: "Synthetic Form Requirement",
    text: "Submit Form AB 12 before registration."
  });
  const namedRun = await runAnswer({
    query: namedQuery, sources: [namedSource], plan: planFor(namedQuery),
    responder: (request) => stageFor(request) === "verifier"
      ? JSON.stringify({ answerable: true, supported: true, complete: true, contradiction: false })
      : structuredAnswer("Submit the AB12 form before registration.")
  });

  const polarityQuery = "Which synthetic lab may visitors use?";
  const polaritySource = result({
    parent: "lab-parent", title: "Synthetic Lab Access",
    text: "Visitors cannot use Lab A. Visitors may use Lab B."
  });
  const polarityRun = await runAnswer({
    query: polarityQuery, sources: [polaritySource], plan: planFor(polarityQuery),
    responder: (request) => stageFor(request) === "verifier"
      ? JSON.stringify({ answerable: true, supported: true, complete: true, contradiction: false })
      : structuredAnswer("Visitors may use Lab B.")
  });
  return /AB12/.test(namedRun.answer.text) && namedRun.answer.sources.length === 1 &&
    /Lab B/.test(polarityRun.answer.text) && polarityRun.answer.sources.length === 1;
});

if (warnings.some((warning) => /SYNTHETIC_TEST_KEY/.test(warning))) {
  failures.push("SYNTHETIC_CREDENTIAL_LEAK");
}

const report = {
  suite: "v4_diagnosed_failure_regressions",
  production_root: productionRoot,
  scenarios: 7,
  passed: passed.length,
  failed: failures.length,
  passed_codes: passed,
  failure_codes: failures,
  network_calls: 0,
  private_holdout_content_used: false
};
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
