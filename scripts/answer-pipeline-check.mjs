import fs from "node:fs";
import vm from "node:vm";

const packRoot = new URL("../resource-packs/schwarzman-c11/", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("pack.json", packRoot), "utf8"));
const resources = [];
const contentStore = {};

for (const raw of manifest.resources || []) {
  const id = ("pack_" + manifest.id + "_" + raw.id).slice(0, 120);
  resources.push({
    id,
    type: raw.type || "document",
    title: raw.document_title || raw.title,
    url: new URL(raw.url || raw.text_url || "", "chrome-extension://pipeline/resource-packs/schwarzman-c11/pack.json").href,
    page_url: "chrome-extension://pipeline/resource-packs/schwarzman-c11/pack.json",
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

resources.push(
  {
    id: "official-x1-visa",
    type: "pdf",
    title: "OBTAINING YOUR X1 STUDENT VISA 2026.pdf",
    url: "https://lms.sc.tsinghua.edu.cn/official-x1-visa.pdf",
    page_title: "Resources - Class of 2026-2027 Pre-program",
    section: "Class of 2026-2027 Pre-program Resources",
    authority_verified: true,
    context: "Official Blackboard X1 visa guidance"
  },
  {
    id: "official-packing-list",
    type: "pdf",
    title: "Packing List for Students (2026).pdf",
    url: "https://lms.sc.tsinghua.edu.cn/official-packing-list.pdf",
    page_title: "Resources - Class of 2026-2027 Pre-program",
    section: "Class of 2026-2027 Pre-program Resources",
    authority_verified: true,
    context: "Official Blackboard packing list"
  },
  {
    id: "official-mandarin-resources",
    type: "announcement",
    title: "Chinese Language Learning Resources",
    url: "https://lms.sc.tsinghua.edu.cn/chinese-language-resources",
    page_title: "Chinese Language Learning Resources",
    section: "Chinese Language Learning Resources Announcements",
    authority_verified: true,
    context: "Mandarin placement and study materials"
  },
  {
    id: "official-academic-calendar",
    type: "pdf",
    title: "Slides_C11 Academic Webinar.pdf",
    url: "https://lms.sc.tsinghua.edu.cn/official-academic-calendar.pdf",
    page_title: "C11 Academic Webinar",
    section: "Official Blackboard academic materials",
    authority_verified: true,
    body_verified: true,
    indexed_body_source: "extracted",
    context: "Official indexed Blackboard academic-calendar slides"
  }
);
contentStore["official-x1-visa"] =
  "Page 1: OBTAINING YOUR X1 STUDENT VISA 2026. Check that your passport remains valid for at least 6 months after your planned departure from China and has at least 4 blank pages. Obtain the JW202 Form and Tsinghua University Admission Notice. Complete the visa application form, prepare a recent photo, and follow the requirements of your local Chinese embassy or consulate.";
contentStore["official-packing-list"] =
  "Page 1: Packing List for Students 2026. Bring your passport and copies of key documents, visa paperwork, admission notice, JW202 if applicable, prescription medication in original packaging, doctor letters for prescriptions, adapters, chargers, clothing layers, professional clothes, comfortable walking shoes, toiletries, insurance information, bank cards, emergency contacts, and your arrival address.";
contentStore["official-mandarin-resources"] =
  "Chinese Language Learning Resources include key vocabulary and grammar structures for each Mandarin level, placement preparation, and survival Chinese materials.";
contentStore["official-academic-calendar"] =
  "Page 9: After the orientation and course-registration process, classes begin on September 14th.";

const moduleSource = [
  "../lib/answer-formatting.js",
  "../lib/llm-client.js",
  "../lib/search-index.js"
].map((file) => fs.readFileSync(new URL(file, import.meta.url), "utf8")).join("\n\n");
const sidepanelSource = fs.readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");
const runtimeStart = sidepanelSource.indexOf("chrome.runtime.onMessage.addListener");

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
  setTimeout,
  clearTimeout,
  AbortController,
  fetch: async () => { throw new Error("Network access is forbidden in answer-pipeline-check."); },
  document: {
    getElementById() { return mockElement(); },
    createElement() { return mockElement(); }
  },
  chrome: {
    runtime: {
      sendMessage() {},
      getManifest() { return { version: "pipeline-test" }; },
      getURL(path) { return "chrome-extension://pipeline/" + path; },
      onMessage: { addListener() {} }
    },
    tabs: { async create() {} },
    storage: { local: { async get() { return {}; }, async set() {} } }
  },
  pipelineResources: resources,
  pipelineContentStore: contentStore
};

vm.createContext(context);
vm.runInContext(moduleSource + "\n\n" + sidepanelSource.slice(0, runtimeStart), context);
vm.runInContext(`
state.resources = pipelineResources;
state.contentStore = pipelineContentStore;
state.transcripts = [];
state.settings = { provider: "openrouter", model: "test-model", apiKey: "test-key", hasApiKey: true };
invalidateSearchIndexCache();
`, context);

async function runPipeline(query, responses) {
  context.__pipelineQuery = query;
  context.__pipelineResponses = [...responses];
  context.__pipelineCallCount = 0;
  context.__pipelineProviderStages = [];
  vm.runInContext(String.raw`
    function __adaptPipelineStructuredAnswerMock(response, system) {
      if (!/answer_blocks must be an array/i.test(system) || /semantic grounding verifier/i.test(system)) return response;
      let candidate = String(response || '');
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 2 && 'not_found' in parsed && 'answer_blocks' in parsed) return candidate;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 1 && typeof parsed.answer === 'string') candidate = parsed.answer;
        else return candidate;
      } catch (_error) {}
      if (/^I could not find that in the indexed resources\.?$/i.test(candidate.trim())) return JSON.stringify({ not_found: true, answer_blocks: [] });
      const rawBlocks = candidate.split(/\n+/).map((block) => block.trim()).filter(Boolean).filter((block, index, blocks) => !(index === 0 && blocks.length > 1 && /^(?:here|below|the following|in short|overall|based)/i.test(block)));
      const answer_blocks = rawBlocks.map((block) => ({
        text: block.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim(),
        source_ids: Array.from(new Set(Array.from(block.matchAll(/\[(\d+)\]/g), (match) => Number(match[1]))))
      }));
      return JSON.stringify({ not_found: false, answer_blocks });
    }
    callChatCompletion = async (request) => {
      globalThis.__pipelineCallCount += 1;
      const systemText = String(request?.messages?.find((message) => message.role === "system")?.content || "");
      const stage = /query planner/i.test(systemText)
        ? "planner"
        : /semantic grounding verifier/i.test(systemText)
          ? "verifier"
          : /grounding repair (?:reviewer|writer)/i.test(systemText)
            ? "reviewer"
            : /(?:Write only|Create) the final user-facing answer/i.test(systemText)
              ? "recovery"
              : "answer";
      globalThis.__pipelineProviderStages.push(stage);
      const response = globalThis.__pipelineResponses.shift();
      if (typeof response !== "string") {
        throw new Error("Pipeline simulation ran out of provider responses at stage " + stage + ".");
      }
      return __adaptPipelineStructuredAnswerMock(response, systemText);
    };
    globalThis.__pipelinePromise = (async () => {
      const baseRetrievalQuery = buildRetrievalQuery(globalThis.__pipelineQuery, []);
      const plan = await buildQueryPlan(globalThis.__pipelineQuery, [], baseRetrievalQuery);
      const retrievalQuery = enhanceRetrievalQueryForIntent(
        globalThis.__pipelineQuery,
        plannedRetrievalQuery(plan, globalThis.__pipelineQuery, baseRetrievalQuery),
        plan
      );
      const retrievalQueries = retrievalQueriesForPlan(
        globalThis.__pipelineQuery,
        baseRetrievalQuery,
        retrievalQuery,
        plan
      );
      const sources = prepareAnswerSources(searchAcrossRetrievalQueries(retrievalQueries), retrievalQuery);
      const queuedDraft = String(globalThis.__pipelineResponses[0] || "");
      const draftProbe = alignAnswerCitations(cleanAnswerText(queuedDraft, sources.length), sources);
      const draftValidation = citedAnswerValidation(globalThis.__pipelineQuery, draftProbe, sources, retrievalQuery);
      const directAnswer = buildDirectAnswer(globalThis.__pipelineQuery, sources);
      const route = shouldUseLlm(globalThis.__pipelineQuery, sources)
        ? "llm"
        : directAnswer
          ? "direct"
          : "local";
      const finalAnswer = route === "llm"
        ? await generateVerifiedApiAnswer(
            globalThis.__pipelineQuery,
            sources,
            [],
            retrievalQuery,
            plan
          )
        : directAnswer || { text: buildLocalAnswer(globalThis.__pipelineQuery, sources, retrievalQuery), sources };
      return {
        route,
        directAnswerUsed: route === "direct",
        deterministicIntent: hasDeterministicDirectAnswerIntent(globalThis.__pipelineQuery),
        callCount: globalThis.__pipelineCallCount,
        providerStages: [...globalThis.__pipelineProviderStages],
        plan,
        retrievalQuery,
        retrievalQueries,
        documentIds: sources.map((source) => source.source_pack_document_id || source.resource_id || sourceDedupeKey(source)),
        duplicateKeys: sources.length - new Set(sources.map(sourceDedupeKey)).size,
        draftValidation,
        answer: finalAnswer
      };
    })();
  `, context);
  return await context.__pipelinePromise;
}
function runDirectPipeline(query) {
  context.__pipelineQuery = query;
  vm.runInContext(`
    (() => {
      const retrievalQuery = enhanceRetrievalQueryForIntent(
        globalThis.__pipelineQuery,
        globalThis.__pipelineQuery,
        defaultRagPlan(globalThis.__pipelineQuery)
      );
      const sources = prepareAnswerSources(searchIndex(retrievalQuery), retrievalQuery);
      const answer = buildDirectAnswer(globalThis.__pipelineQuery, sources);
      globalThis.__directPipelineResult = {
        deterministic: hasDeterministicDirectAnswerIntent(globalThis.__pipelineQuery),
        retrievalQuery,
        retrievedSourceIds: sources.map((source) => source.source_pack_document_id || source.resource_id || sourceDedupeKey(source)),
        sourceIds: (answer?.sources || []).map((source) => source.source_pack_document_id || source.resource_id || sourceDedupeKey(source)),
        answer
      };
    })();
  `, context);
  return context.__directPipelineResult;
}

function plannerResponseFor(testCase) {
  return JSON.stringify({
    intent: testCase.intent || "document_question",
    rewritten_question: testCase.rewritten || testCase.query,
    retrieval_query: testCase.retrieval,
    search_queries: testCase.searchQueries || [testCase.query, testCase.retrieval],
    source_preferences: testCase.sourcePreferences || [],
    scope: "in_scope",
    confidence: 0.98
  });
}

const semanticSupportedVerdict = JSON.stringify({ answerable: true, supported: true, complete: true, contradiction: false });
const semanticUnsupportedVerdict = JSON.stringify({ answerable: true, supported: false, complete: false, contradiction: false });
const semanticJustifiedAbstentionVerdict = JSON.stringify({ answerable: false, supported: true, complete: true, contradiction: false });

const query = "Could you explain whether I can choose a group or individual capstone?";
const capstoneCase = {
  query,
  rewritten: "Can students choose a group capstone or an individual capstone?",
  retrieval: "group capstone individual capstone choose either option academic webinar",
  searchQueries: [
    "group capstone individual capstone",
    "academic webinar capstone choose group or individual"
  ],
  sourcePreferences: ["academic webinar"]
};
const plannerResponse = plannerResponseFor(capstoneCase);
const supportedDraft =
  "Here is the answer from the indexed resources.\n\nYou can choose either a group capstone or an individual capstone [1].";
const cleanRun = await runPipeline(query, [plannerResponse, supportedDraft, semanticSupportedVerdict]);

if (
  cleanRun.route !== "llm" ||
  cleanRun.directAnswerUsed ||
  cleanRun.callCount !== 3 ||
  cleanRun.providerStages.join(",") !== "planner,answer,verifier"
) {
  throw new Error("A valid answer did not use the normal LLM route: " + JSON.stringify(cleanRun, null, 2));
}
if (!cleanRun.documentIds.includes("academic-webinar") || cleanRun.duplicateKeys !== 0) {
  throw new Error("Planner/retrieval did not return one deduplicated academic parent source: " + JSON.stringify(cleanRun, null, 2));
}
if (/could not produce/i.test(cleanRun.answer.text) || !/group capstone/i.test(cleanRun.answer.text) || !/\[1\]/.test(cleanRun.answer.text)) {
  throw new Error("A supported, naturally framed answer did not survive the full pipeline: " + JSON.stringify(cleanRun, null, 2));
}

const answerCases = [
  {
    name: "Mandarin resource location",
    query: "Where can I find the grammar structures and vocabulary for each Mandarin level?",
    retrieval: "Chinese Language Learning Resources key vocabulary grammar structures each Mandarin level",
    searchQueries: [
      "grammar structures vocabulary each Mandarin level",
      "Chinese Language Learning Resources key vocabulary grammar"
    ],
    expectedSources: ["official-mandarin-resources"],
    draft: "The level-by-level grammar structures and vocabulary are in Chinese Language Learning Resources [1].",
    phrases: [/grammar/i, /vocabulary/i],
    evidence: [/key vocabulary/i, /grammar structures/i]
  },
  {
    name: "dining accommodations",
    query: "Can the dining hall accommodate halal, gluten-free, and kosher meals?",
    retrieval: "C11 Student Life Webinar dining hall halal gluten free kosher",
    searchQueries: [
      "dining hall halal gluten free kosher meals",
      "student life webinar dietary accommodations"
    ],
    expectedSources: ["student-life-webinar"],
    draft:
      "Halal meals can be difficult to accommodate, although the team may be able to arrange them depending on supplier consistency [1].\n\n" +
      "Gluten-free options are usually possible, while kosher meals are not available in the College dining hall [1].",
    phrases: [/halal/i, /gluten-free/i, /kosher/i],
    evidence: [/halal/i, /gluten[- ]free/i, /kosher/i]
  },
  {
    name: "subway payment",
    query: "How do I pay for the Beijing subway with Alipay?",
    retrieval: "Beijing subway Alipay transportation QR code metro payment",
    searchQueries: [
      "pay Beijing subway with Alipay",
      "transportation QR code metro Alipay"
    ],
    expectedSources: ["beijing-transportation-workshop"],
    draft:
      "Set up Alipay, complete passport verification, link a payment card, and activate the Beijing transportation QR code. At the subway, open the metro QR code in Alipay and scan it at the gate [1].",
    phrases: [/Alipay/i, /QR code/i],
    evidence: [/alipay/i, /transportation qr code/i]
  },
  {
    name: "class start",
    query: "When do classes begin after orientation?",
    retrieval: "academic webinar classes begin September 14 orientation",
    searchQueries: [
      "classes begin after orientation",
      "academic webinar September 14 class start"
    ],
    expectedSources: ["official-academic-calendar"],
    draft: "Classes begin on September 14, after academic orientation and the course sign-up period [1].",
    phrases: [/September 14/i],
    evidence: [/classes begin/i, /september 14/i]
  },
  {
    name: "visa plus arrival",
    query: "Using the official visa guidance and the C11 resources, what documents do I need for my X1 visa, and what must I do after arriving in China?",
    retrieval: "official X1 visa JW202 admission notice after arrival residence permit within 30 days",
    searchQueries: [
      "official X1 visa documents JW202 admission notice",
      "after arrival China convert X1 residence permit 30 days"
    ],
    expectedSources: ["official-x1-visa", "international-logistics-webinar"],
    draft:
      "Before travel, check your passport, obtain the JW202 form and Tsinghua University Admission Notice, and follow the application requirements of the Chinese embassy or consulate responsible for your location [1].\n\n" +
      "After entering China, convert the X1 visa to a residence permit within 30 days. The process starts after the official College arrival because it requires documents from Tsinghua and the Beijing medical-exam process [2].",
    phrases: [/JW202/i, /within 30 days/i],
    evidence: [/jw202/i, /residence permit/i]
  },
  {
    name: "packing plus baggage",
    query: "Using the official packing list and the C11 student-life guidance, make me a departure-day checklist, including what belongs in my carry-on and my baggage allowance.",
    retrieval: "official packing list carry on prescription original packaging C11 baggage allowance 23 kilograms",
    searchQueries: [
      "official packing list prescription medication original packaging",
      "student life carry-on checked bag 23 kilograms"
    ],
    expectedSources: ["official-packing-list", "student-life-webinar"],
    draft:
      "From the official packing list, bring your passport and document copies, visa paperwork, admission notice and JW202 if applicable, and prescription medication in its original packaging with supporting doctor letters [1].\n\n" +
      "Keep prescription medication and the original prescription in your carry-on. The standard inbound-flight allowance is one checked bag weighing 23 kilograms [2].",
    phrases: [/carry-on/i, /23 kilograms/i],
    evidence: [/original packaging/i, /23 kilograms/i]
  },
  {
    name: "visitors plus clubs",
    query: "What are the visitor rules, and what student clubs can I join?",
    retrieval: "student life visitor guest rules orientation 1030 clubs Tsinghua",
    searchQueries: [
      "visitor guest rules orientation 10:30",
      "student clubs Schwarzman Tsinghua"
    ],
    expectedSources: ["student-life-webinar"],
    draft:
      "Guests are not allowed during orientation from August 26 through September 12. During the school year, guests must be checked in and out, normally cannot visit residential floors, and must leave the College by 10:30 p.m. [1].\n\n" +
      "The guidance recommends joining clubs at both Schwarzman and the wider Tsinghua university community [1].",
    phrases: [/10:30 p\.m\./i, /clubs/i],
    evidence: [/1030/i, /clubs/i]
  },
  {
    name: "inbound baggage typo",
    query: "how many bag can i checked on flight to bejing?",
    retrieval: "inbound flight checked bag baggage allowance 23 kilograms Beijing",
    searchQueries: [
      "checked bags flight to Beijing",
      "inbound flight one checked bag 23 kilograms"
    ],
    expectedSources: ["student-life-webinar"],
    draft: "The standard inbound-flight allowance is one checked bag weighing 23 kilograms. An additional bag must be budgeted separately [1].",
    phrases: [/one checked bag/i, /23 kilograms/i],
    evidence: [/checked bag/i, /23 kilograms/i]
  },
  {
    name: "resident permit documents typo",
    query: "Are there any documents i need to bring for the residence permit",
    retrieval: "resident permit residence permit documents passport JW202 admission notice physical exam PSB registration photos",
    searchQueries: [
      "resident permit documents to bring",
      "residence permit passport JW202 admission notice physical exam PSB registration photos"
    ],
    expectedSources: ["international-logistics-webinar"],
    draft:
      "For the residence permit process, bring/prepare your passport and the Tsinghua visa documents, including your JW202 form and Admission Notice. The C11 guidance also says the X1 visa must be converted to a residence permit within 30 days after entering China, and that your passport may be held during processing [1].",
    phrases: [/residence permit/i, /passport/i, /JW202/i],
    evidence: [/residence permit/i, /passport/i, /JW202/i]
  },
  {
    name: "event funding holdout",
    query: "What approvals and documentation do I need before spending money on a student event?",
    retrieval: "student event funding approval documentation before spending reimbursement",
    searchQueries: [
      "student event approval documents before spending",
      "Events team SCSA Proposal for Funding Form written approval reimbursement fapiao"
    ],
    sourcePreferences: ["Schwarzman Scholars Survival Guide"],
    expectedSources: ["survival-guide"],
    draft:
      "Before spending money, talk to the Events team, submit the Proposal for Funding Form, and obtain written approval; the guide recommends doing this ideally two weeks in advance [1].\n\n" +
      "For reimbursement, retain a proper fapiao with Tsinghua's tax and item details, explain how the expense builds community and how many people benefit, include the price per head, and provide a participant name list [1].",
    phrases: [/Proposal for Funding Form/i, /written approval/i, /fapiao/i, /participant name list/i],
    evidence: [/proposal for funding/i, /written approval/i, /fapiao/i, /name list/i]
  },
  {
    name: "hospital billing holdout",
    query: "Which hospitals bill the insurance provider directly, and what paperwork should I retain after visiting Tsinghua University Hospital?",
    retrieval: "hospital direct billing insurance paperwork Tsinghua University Hospital",
    searchQueries: [
      "hospitals direct bill insurance Beijing United Family Oasis",
      "Tsinghua University Hospital reimbursement fapiao prescription doctor notes"
    ],
    sourcePreferences: ["Schwarzman Scholars Survival Guide"],
    expectedSources: ["survival-guide"],
    draft:
      "Beijing United Family Hospital and Oasis International bill the insurer directly, so you do not pay up front [1].\n\n" +
      "Tsinghua University Hospital is claim-and-reimburse. Retain every fapiao, prescription, and doctor's diagnosis or treatment note for the reimbursement claim [1].",
    phrases: [/Beijing United Family/i, /Oasis/i, /directly/i, /fapiao/i, /prescription/i, /doctor/i],
    evidence: [/beijing united family/i, /oasis/i, /fapiao/i, /doctor/i]
  }
];

for (const testCase of answerCases) {
  const result = await runPipeline(testCase.query, [plannerResponseFor(testCase), testCase.draft, semanticSupportedVerdict]);
  const answerText = result.answer?.text || "";
  const evidenceText = (result.answer?.sources || []).map((source) => String(source.text || "")).join(" ");

  if (
    result.route !== "llm" ||
    result.directAnswerUsed ||
    result.callCount !== 3 ||
    result.providerStages.join(",") !== "planner,answer,verifier"
  ) {
    const namedTermDiagnostics = testCase.draft.split(/\n+/).filter(Boolean).map((block) => {
      const citationNumbers = Array.from(block.matchAll(/\[(\d+)\]/g), (match) => Number(match[1]));
      const citedText = citationNumbers
        .map((number) => result.draftValidation?.sourceList?.[number - 1]?.text || "")
        .join(" ");
      return context.deterministicNamedTerms(block).map((term) => ({
        term,
        supported: context.sourceSupportsNamedTerm(citedText, term)
      }));
    });
        const numericDiagnostics = context.answerClaimBlocks(testCase.draft).flatMap((block) => {
      const citationNumbers = Array.from(block.matchAll(/\[(\d+)\]/g), (match) => Number(match[1]));
      const citedSources = citationNumbers.map((number) => result.draftValidation?.sourceList?.[number - 1]).filter(Boolean);
      return context.splitSentences(block.replace(/\[(\d+)\]/g, " ")).map((claim) => ({
        claim,
        bindings: context.numericClaimBindings(claim, testCase.query),
        conflict: context.citedNumericClaimConflict(claim, citedSources, testCase.query)
      }));
    });
    throw new Error("A content question bypassed or failed the LLM route: " + JSON.stringify({ testCase, result, namedTermDiagnostics, numericDiagnostics }, null, 2));
  }
  for (let index = 0; index < testCase.expectedSources.length; index += 1) {
    if (result.documentIds[index] !== testCase.expectedSources[index]) {
      throw new Error("Retrieval omitted or reordered expected evidence: " + JSON.stringify({ testCase, result }, null, 2));
    }
  }
  if (
    !result.answer?.sources?.length ||
    !/\[\d+\]/.test(answerText) ||
    /could not produce|strongest matching details/i.test(answerText) ||
    /(?:^|\n)\s*-?\s*Page\s+\d+\s*:/i.test(answerText)
  ) {
    throw new Error("The final answer was not synthesized, cited LLM prose: " + JSON.stringify({ testCase, result }, null, 2));
  }
  if ((testCase.phrases || []).some((pattern) => !pattern.test(answerText))) {
    throw new Error("The final answer omitted required answer facts: " + JSON.stringify({ testCase, result }, null, 2));
  }
  if ((testCase.evidence || []).some((pattern) => !pattern.test(evidenceText))) {
    throw new Error("The cited retrieval excerpts omitted answer-key evidence: " + JSON.stringify({ testCase, result }, null, 2));
  }
}

const broadTransportationQuery = "How should I travel around Beijing day to day?";
const broadTransportationBadDraft =
  "Use OmniTransit because Beijing has exactly 99 transport networks, including the subway, ride-hailing, shared bikes, and buses [1].";
const broadTransportationSafeRepair =
  "Beijing's main day-to-day transport options are the subway, ride-hailing services, shared bikes, and buses [1].";
const broadTransportationRepairRun = await runPipeline(broadTransportationQuery, [
  plannerResponseFor({
    query: broadTransportationQuery,
    retrieval: "Beijing transportation subway ride hailing shared bikes buses",
    searchQueries: ["Beijing four ways subway ride hailing shared bike bus"]
  }),
  broadTransportationBadDraft,
  broadTransportationSafeRepair,
  semanticSupportedVerdict
]);
if (
  broadTransportationRepairRun.providerStages.join(",") !== "planner,answer,reviewer,verifier" ||
  broadTransportationRepairRun.answer.text !== broadTransportationSafeRepair ||
  broadTransportationRepairRun.answer.pipeline_diagnostics?.[0]?.reason_codes?.some((code) =>
    code === "numeric_conflict" || code === "named_entity_conflict"
  ) !== true
) {
  throw new Error("A broad overview with incidental unsupported details was not reduced to the grounded enumerated categories: " + JSON.stringify(broadTransportationRepairRun, null, 2));
}

const negativeCase = {
  query: "What is the exact printer model and per-page printing fee?",
  retrieval: "printer model per-page printing fee IT helpdesk",
  searchQueries: ["printer model printing fee", "IT helpdesk library printer"],
  sourcePreferences: ["Schwarzman Scholars Survival Guide"]
};
const cleanNotFoundAnswer = "I could not find that in the indexed resources.";
const negativeRun = await runPipeline(negativeCase.query, [
  plannerResponseFor(negativeCase),
  cleanNotFoundAnswer,
  semanticJustifiedAbstentionVerdict
]);
if (
  negativeRun.callCount !== 3 ||
  negativeRun.providerStages.join(",") !== "planner,answer,verifier" ||
  negativeRun.answer.text !== cleanNotFoundAnswer ||
  negativeRun.answer.sources.length !== 0
) {
  throw new Error("A corroborated hard-negative abstention was not returned cleanly: " + JSON.stringify(negativeRun, null, 2));
}

const unsupportedDraft =
  "Students must complete the capstone in teams of exactly 4 and receive dean approval [1].";
const repairedAnswer =
  "You can choose either a group capstone or an individual capstone [1].";
const repairedRun = await runPipeline(query, [
  plannerResponse,
  unsupportedDraft,
  semanticUnsupportedVerdict,
  JSON.stringify({ answer: repairedAnswer }),
  semanticSupportedVerdict
]);

if (
  repairedRun.callCount !== 5 ||
  repairedRun.providerStages.join(",") !== "planner,answer,verifier,reviewer,verifier" ||
  /could not produce/i.test(repairedRun.answer.text) ||
  !/individual capstone/i.test(repairedRun.answer.text)
) {
  throw new Error("The reviewer did not repair an unsupported draft: " + JSON.stringify(repairedRun, null, 2));
}

const recoveredRun = await runPipeline(query, [
  plannerResponse,
  unsupportedDraft,
  semanticUnsupportedVerdict,
  JSON.stringify({ answer: unsupportedDraft }),
  semanticUnsupportedVerdict,
  repairedAnswer,
  semanticSupportedVerdict
]);
if (
  recoveredRun.callCount !== 7 ||
  recoveredRun.providerStages.join(",") !== "planner,answer,verifier,reviewer,verifier,recovery,verifier" ||
  !/individual capstone/i.test(recoveredRun.answer.text) ||
  /exactly 4|dean approval/i.test(recoveredRun.answer.text)
) {
  throw new Error("A validation failure did not trigger bounded LLM recovery: " + JSON.stringify(recoveredRun, null, 2));
}

const reviewerMetaPayloads = [
  JSON.stringify({ answer: "Analysis: I need to verify the draft before returning it [1]." }),
  JSON.stringify({ answer: "Reasoning: The answer should remove an unsupported detail [1]." }),
  JSON.stringify({ answer: "Let me review the evidence before I rewrite the answer [1]." }),
  JSON.stringify({ answer: repairedAnswer, reason: "Extra reviewer key must invalidate this object." })
];
for (const reviewerMetaPayload of reviewerMetaPayloads) {
  const reviewerMetaRecovery = await runPipeline(query, [
    plannerResponse,
    unsupportedDraft,
    semanticUnsupportedVerdict,
    reviewerMetaPayload,
    repairedAnswer,
    semanticSupportedVerdict
  ]);
  if (
    reviewerMetaRecovery.callCount !== 6 ||
    reviewerMetaRecovery.providerStages.join(",") !== "planner,answer,verifier,reviewer,recovery,verifier" ||
    !/individual capstone/i.test(reviewerMetaRecovery.answer.text) ||
    /Analysis:|Reasoning:|Let me review|Extra reviewer key/i.test(reviewerMetaRecovery.answer.text)
  ) {
    throw new Error("Reviewer meta output did not route through bounded recovery. " + JSON.stringify(reviewerMetaRecovery, null, 2));
  }
}

const reviewerMetaFailClosed = await runPipeline(query, [
  plannerResponse,
  unsupportedDraft,
  semanticUnsupportedVerdict,
  JSON.stringify({ answer: "I should remove the unsupported claim and cite a source [1]." }),
  "The answer should be rewritten after I evaluate the evidence [1]."
]);
if (
  reviewerMetaFailClosed.callCount !== 5 ||
  reviewerMetaFailClosed.providerStages.join(",") !== "planner,answer,verifier,reviewer,recovery" ||
  !/could not produce a reliable cited answer/i.test(reviewerMetaFailClosed.answer.text) ||
  reviewerMetaFailClosed.answer.sources.length !== 0
) {
  throw new Error("Repeated reviewer meta output did not fail closed. " + JSON.stringify(reviewerMetaFailClosed, null, 2));
}
const rejectedRun = await runPipeline(query, [
  plannerResponse,
  unsupportedDraft,
  semanticUnsupportedVerdict,
  JSON.stringify({ answer: unsupportedDraft }),
  semanticUnsupportedVerdict,
  unsupportedDraft,
  semanticUnsupportedVerdict
]);
if (
  !/could not produce a reliable cited answer/i.test(rejectedRun.answer.text) ||
  /strongest matching details/i.test(rejectedRun.answer.text) ||
  rejectedRun.answer.sources.length !== 0
) {
  throw new Error("A failed LLM repair did not fail honestly without a snippet dump: " + JSON.stringify(rejectedRun, null, 2));
}

async function runProductionApiRoute(testCase) {
  context.__productionRouteCase = {
    query: testCase.query,
    planner: plannerResponseFor(testCase),
    draft: testCase.draft || "I could not find that in the indexed resources.",
    memory: testCase.memory || []
  };
  vm.runInContext(`
    (() => {
      globalThis.__productionRouteStages = [];
      globalThis.__productionDirectCalls = 0;
      if (!globalThis.__productionOriginalBuildDirectAnswer) {
        globalThis.__productionOriginalBuildDirectAnswer = buildDirectAnswer;
      }
      buildDirectAnswer = (...args) => {
        globalThis.__productionDirectCalls += 1;
        return globalThis.__productionOriginalBuildDirectAnswer(...args);
      };
      hydrateLikelyResourceContentForQuery = async () => ({ hydrated: false });
      buildQueryPlan = async (query, _memory, fallbackRetrievalQuery) => {
        globalThis.__productionRouteStages.push("planner");
        return normalizeQueryPlan(JSON.parse(globalThis.__productionRouteCase.planner), query, fallbackRetrievalQuery);
      };
      selectSemanticEvidenceForApi = async (_query, _results, deterministicSources) => {
        globalThis.__productionRouteStages.push("selector");
        return { sources: deterministicSources, mode: "route-test" };
      };
      buildApiAnswer = async () => {
        globalThis.__productionRouteStages.push("synthesis");
        return globalThis.__productionRouteCase.draft;
      };
      verifyApiAnswerGrounding = async () => {
        globalThis.__productionRouteStages.push("semantic-verifier");
        return { answerable: true, supported: true, complete: true, contradiction: false };
      };
      callChatCompletion = async () => {
        throw new Error("Unexpected provider call in production-route regression.");
      };
      state.settings = {
        provider: "openrouter",
        model: "test-model",
        apiKey: "route-test-key",
        hasApiKey: true
      };
      state.conversation = globalThis.__productionRouteCase.memory;
      els.queryInput.value = globalThis.__productionRouteCase.query;
      globalThis.__productionPreparedMatch = isPreparedDirectAnswerQuery(globalThis.__productionRouteCase.query);
      globalThis.__productionCapabilityMatch = isCapabilityQuestion(globalThis.__productionRouteCase.query);
      globalThis.__productionRoutePromise = handleAsk({ preventDefault() {} });
    })();
  `, context);
  await context.__productionRoutePromise;
  return {
    stages: [...context.__productionRouteStages],
    directCalls: context.__productionDirectCalls,
    preparedMatch: context.__productionPreparedMatch,
    capabilityMatch: context.__productionCapabilityMatch
  };
}

const preparedFailureDomainCases = answerCases.slice(0, 8);
if (preparedFailureDomainCases.length !== 8) {
  throw new Error("Expected eight prepared failure-domain cases.");
}
for (const testCase of preparedFailureDomainCases) {
  const productionRoute = await runProductionApiRoute(testCase);
  if (
    !productionRoute.preparedMatch ||
    productionRoute.directCalls !== 0 ||
    productionRoute.stages.join(",") !== "selector,synthesis,semantic-verifier"
  ) {
    throw new Error(
      "A prepared failure-domain question bypassed the production LLM route: " +
      JSON.stringify({ testCase: testCase.name, productionRoute }, null, 2)
    );
  }
}

const mixedCapabilityCase = {
  ...answerCases[2],
  name: "mixed capability/content route",
  query: "Coverage check: how do I pay for the Beijing subway with Alipay?"
};
const mixedCapabilityRoute = await runProductionApiRoute(mixedCapabilityCase);
if (
  !mixedCapabilityRoute.preparedMatch ||
  mixedCapabilityRoute.capabilityMatch ||
  mixedCapabilityRoute.directCalls !== 0 ||
  mixedCapabilityRoute.stages.join(",") !== "selector,synthesis,semantic-verifier"
) {
  throw new Error(
    "An API-configured mixed capability/content question bypassed the production LLM route: " +
    JSON.stringify(mixedCapabilityRoute, null, 2)
  );
}

const followUpRoute = await runProductionApiRoute({
  ...answerCases[0],
  name: "conversation-dependent follow-up route",
  query: "What happens after that?",
  memory: [{
    user: "What is the capstone submission deadline?",
    assistant: "The indexed task page provides the capstone deadline."
  }]
});
if (followUpRoute.stages.join(",") !== "planner,selector,synthesis,semantic-verifier") {
  throw new Error(
    "A conversation-dependent follow-up bypassed the semantic planner: " +
    JSON.stringify(followUpRoute, null, 2)
  );
}

console.log(
  "answer-pipeline-check passed (10 answer-keyed content cases cover planning/synthesis/verification; standalone production questions bypass the planner while conversation-dependent follow-ups retain it; independently verified reviewer/recovery; no extractive answer fallback)"
);
