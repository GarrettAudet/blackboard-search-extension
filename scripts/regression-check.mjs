import fs from "node:fs";
import vm from "node:vm";

const modulePaths = [
  new URL("../lib/answer-formatting.js", import.meta.url),
  new URL("../lib/llm-client.js", import.meta.url),
  new URL("../lib/search-index.js", import.meta.url)
];
const moduleSource = modulePaths.map((path) => fs.readFileSync(path, "utf8")).join("\n\n");
const sidepanelPath = new URL("../sidepanel/sidepanel.js", import.meta.url);
const sidepanelSource = fs.readFileSync(sidepanelPath, "utf8");
const runtimeStart = sidepanelSource.indexOf("chrome.runtime.onMessage.addListener");
const testableSidepanelSource = runtimeStart > 0 ? sidepanelSource.slice(0, runtimeStart) : sidepanelSource;
const testableSource = `${moduleSource}\n\n${testableSidepanelSource}`;

const context = {
  console,
  URL,
  setTimeout,
  clearTimeout,
  fetch: async () => {
    throw new Error("fetch should not run in regression-check");
  },
  document: {
    getElementById() {
      return mockElement();
    },
    createElement() {
      return mockElement();
    }
  },
  chrome: {
    runtime: {
      sendMessage() {},
      getManifest() { return { version: "test-version" }; },
      onMessage: { addListener() {} }
    },
    tabs: {
      async create() {}
    },
    storage: {
      local: {
        async get() {
          return {};
        },
        async set() {}
      }
    }
  }
};

function mockElement() {
  const element = {
    textContent: "",
    value: "",
    disabled: false,
    className: "",
    classList: {
      add() {},
      remove() {},
      toggle() {}
    },
    style: {},
    content: null,
    addEventListener() {},
    append() {},
    remove() {},
    querySelector() {
      return mockElement();
    },
    cloneNode() {
      return mockElement();
    },
    scrollIntoView() {}
  };
  element.content = { firstElementChild: element };
  return element;
}

vm.createContext(context);
vm.runInContext(
  `${testableSource}

state.resources = [
  {
    id: "todo-page",
    type: "page",
    title: "To Do - Class of 2026-2027 Pre-program",
    url: "https://lms.sc.tsinghua.edu.cn/todo",
    page_title: "To Do - Class of 2026-2027 Pre-program",
    section: "Class of 2026-2027 Pre-program",
    context:
      "To Do\\n\\n" +
      "\\u3010Deadline 23:59 on Jun 23 2026 (UTC+8)\\u30112026-27 Capstone Preliminary Interest Survey\\n" +
      "Review the 2026-27 Partner Organizations Proposed Topics and fill out the 2026-27 Capstone Preliminary Interest Survey by 23:59 on Jun 23, 2026 (UTC+8) to indicate your interest in the Capstone project. The survey is mandatory for all C11 students.\\n" +
      "You can access the survey by: click the link: https://schwarzmancollege.wjx.cn/vm/PDLsioY.aspx Scan the QR Code:\\n\\n" +
      "\\u3010Deadline 23:59 on Jun 30 2026 (UTC+8)\\u3011Prerequisite Course Exemption Application\\n" +
      "Attached Files: Prerequisite Course Exemption Application Form. Students who wish to be exempted from the course and meet the exemption requirements should submit the Course Exemption Application by 23:59 on June 30, 2026 (UTC+8)."
  },
  {
    id: "survey-link",
    type: "link",
    title: "2026-27 Capstone Preliminary Interest Survey",
    url: "https://schwarzmancollege.wjx.cn/vm/PDLsioY.aspx",
    page_title: "To Do - Class of 2026-2027 Pre-program",
    section: "Class of 2026-2027 Pre-program",
    context:
      "ncollege to avoid any delay for your inbound flight booking You can access the survey by: click the link: https://schwarzmancollege.wjx.cn/vm/PDLsioY.aspx Scan the QR Code:"
  },
  {
    id: "home-page",
    type: "page",
    title: "Home - Class of 2026-2027 Pre-program",
    url: "https://lms.sc.tsinghua.edu.cn/home",
    page_title: "Home - Class of 2026-2027 Pre-program",
    section: "Class of 2026-2027 Pre-program",
    context:
      "Actions All Items (0) What's Due Actions Select Date: Go Today (0) Nothing Due Today Tomorrow (0) This Week (0) Future (0) Last Updated: June 19, 2026 6:25 AM"
  },
  {
    id: "language-study",
    type: "page",
    title: "Language Study - Class of 2026-2027 Pre-program",
    url: "https://lms.sc.tsinghua.edu.cn/language-study",
    page_title: "Language Study - Class of 2026-2027 Pre-program",
    section: "Class of 2026-2027 Pre-program",
    context:
      "Language Study Chinese language resources include Mandarin placement materials, course preparation notes, and recommended study resources for incoming students."
  },
  {
    id: "packing-pdf",
    type: "pdf",
    title: "Packing List for Students (2026).pdf",
    url: "https://lms.sc.tsinghua.edu.cn/bbcswebdav/pid-123-dt-content-rid-456_1/xid-456_1",
    page_title: "Resources - Class of 2026-2027 Pre-program",
    section: "Class of 2026-2027 Pre-program Resources",
    context: "Packing List for Students (2026).pdf"
  },
  {
    id: "english-language-pdf",
    type: "pdf",
    title: "English Language Resources (2026).pdf",
    url: "https://lms.sc.tsinghua.edu.cn/english-language.pdf",
    page_title: "Language Study - Class of 2026-2027 Pre-program",
    section: "Class of 2026-2027 Pre-program Language Study",
    context: "English Language Resources (2026).pdf English language practice materials and writing resources."
  },
  {
    id: "course-calendar",
    type: "page",
    title: "Course Calendar - Class of 2026-2027 Pre-program",
    url: "https://lms.sc.tsinghua.edu.cn/course-calendar",
    page_title: "Course Calendar - Class of 2026-2027 Pre-program",
    section: "Class of 2026-2027 Pre-program Academics",
    context:
      "Course Calendar and Course Schedule. The list of courses has been released in the calendar. Students can review the academic calendar, course offerings, modules, and class schedule for the 2026-2027 pre-program."
  },
  {
    id: "resources-page",
    type: "page",
    title: "Resources - Class of 2026-2027 Pre-program",
    url: "https://lms.sc.tsinghua.edu.cn/resources",
    page_title: "Resources - Class of 2026-2027 Pre-program",
    section: "Class of 2026-2027 Pre-program Resources",
    context:
      "Resources Content Blackboard User Guideline- Incoming Students.pdf Packing List for Students (2026).pdf OBTAINING YOUR X1 STUDENT VISA 2026.pdf Visa FAQ 2026.pdf WeChat Registration FAQ 2026 BB.pdf"
  },
  {
    id: "x1-visa-pdf",
    type: "pdf",
    title: "OBTAINING YOUR X1 STUDENT VISA 2026.pdf",
    url: "https://lms.sc.tsinghua.edu.cn/bbcswebdav/pid-visa-dt-content-rid-x1_1",
    page_url: "https://lms.sc.tsinghua.edu.cn/resources",
    page_title: "Resources - Class of 2026-2027 Pre-program",
    section: "Class of 2026-2027 Pre-program Resources",
    context: "OBTAINING YOUR X1 STUDENT VISA 2026.pdf"
  },
  {
    id: "visa-faq-pdf",
    type: "link",
    title: "Visa FAQ 2026.pdf",
    url: "https://lms.sc.tsinghua.edu.cn/bbcswebdav/pid-visa-faq-dt-content-rid-faq_1",
    page_url: "https://lms.sc.tsinghua.edu.cn/resources",
    page_title: "Resources - Class of 2026-2027 Pre-program",
    section: "Class of 2026-2027 Pre-program Resources",
    context: "Visa FAQ 2026.pdf"
  }
];
state.contentStore = {
  "todo-page": state.resources[0].context,
  "survey-link": state.resources[1].context,
  "home-page": state.resources[2].context,
  "language-study": state.resources[3].context,
  "english-language-pdf": state.resources[5].context,
  "course-calendar": state.resources[6].context,
  "resources-page": state.resources[7].context,
  "x1-visa-pdf": "Page 1: OBTAINING YOUR X1 STUDENT VISA 2026. Step 1: CHECK YOUR PASSPORT - Valid for at least 6 months after your planned departure from China and at least 4 blank pages. Step 2: FIND YOUR LOCAL CHINESE EMBASSY/CONSULATE. Step 5: RECEIVE UNIVERSITY DOCUMENTS BY EMAIL OR MAIL: JW202 Form and Tsinghua University Admission Notice. Complete the visa application form and prepare a recent photo.",
  "visa-faq-pdf": "Page 1: Visa FAQ 2026. Important notice: regulations and policy on visa and immigration often change without warning. X1 visa students should prepare passport documents, JW202, admission notice, visa application materials, and check local embassy requirements."
};
state.transcripts = [];
state.settings = { hasApiKey: true };
state.resources = state.resources;
setIndexStatusSummary();
const statusSummaryText = els.statusText.textContent;

const query = "What are the current to do's?";
const results = searchIndex(query);
const answer = buildDirectAnswer(query, results);
const alternateTaskQuery = "Do I have any to do's?";
const alternateTaskRetrievalQuery = enhanceRetrievalQueryForIntent(
  alternateTaskQuery,
  alternateTaskQuery,
  { intent: "task_deadline", retrieval_query: alternateTaskQuery, source_preferences: [] }
);
const alternateTaskSources = prepareAnswerSources(searchIndex(alternateTaskRetrievalQuery), alternateTaskRetrievalQuery);
const alternateTaskAnswer = buildDirectAnswer(alternateTaskQuery, alternateTaskSources);
const mandarinQuery = "Have they gives us any mandarin resources to learn from?";
const mandarinIsCapability = isCapabilityQuestion(mandarinQuery);
const mandarinResults = searchIndex(mandarinQuery);
state.conversation = [
  {
    user: mandarinQuery,
    assistant: "Chinese Language Learning Resources include Mandarin placement preparation, survival Chinese, and key vocabulary and grammar lists."
  }
];
const mandarinFollowUpQuery = buildRetrievalQuery("Can you link me some specific resources", getConversationMemory());
const mandarinFollowUpSources = prepareAnswerSources(searchIndex(mandarinFollowUpQuery), mandarinFollowUpQuery);
const courseListQuery = "Have they released the list of courses?";
const courseListRawResults = [
  {
    score: 999,
    resource_id: "language-study",
    kind: "page",
    title: "Announcements - Chinese Language Learning Resources",
    source: "Chinese Language Learning Resources Announcements",
    text: "Key Vocabulary and Grammar for Each Level Chinese Class includes course material for placement preparation."
  },
  {
    score: 990,
    resource_id: "capstone-topic",
    kind: "link",
    title: "2026-27 Partner Organizations Proposed Topics",
    source: "Class of 2026-2027 Pre-program To Do",
    text: "Review the partner organization proposed topics and fill out the capstone survey."
  },
  ...searchIndex(courseListQuery)
];
const courseListSources = prepareAnswerSources(courseListRawResults, courseListQuery);
const myClassesSources = prepareAnswerSources(searchIndex("What classes do I have?"), "What classes do I have?");
const taskSourcesWithCourseShell = prepareAnswerSources(
  [
    ...searchIndex(query),
    {
      score: 360,
      kind: "link",
      title: "Class of 2026-2027 Pre-program",
      source: "Class of 2026-2027 Pre-program To Do - To Do - Class of 2026-2027 Pre-program",
      text: "Class of 2026-2027 Pre-program Class of 2026-2027 Pre-program To Do To Do Class of 2026-2027 Pre-program To Do To Do Class of 2026-2027 Pre-program"
    }
  ],
  query
);
const parsedPlannerJson = parseJsonObjectFromText(
  "planner output: " +
    JSON.stringify({
      intent: "course_list",
      rewritten_question: "Have they released the list of courses?",
      retrieval_query: "released course list course calendar schedule",
      source_preferences: ["course calendar", "class schedule", "academic calendar"],
      needs_video_search: false,
      scope: "in_scope",
      confidence: 0.87
    }) +
    " end"
);
const normalizedPlanner = normalizeQueryPlan(parsedPlannerJson, courseListQuery, courseListQuery);
const plannedCourseQuery = plannedRetrievalQuery(normalizedPlanner, courseListQuery, courseListQuery);
const parsedReviewJson = parseJsonObjectFromText(
  '{"approved":false,"answer":"The course calendar contains the released course list [1].","reason":"Removed unsupported text."}'
);
const packingHydrationCandidates = findHydrationCandidatesForQuery("What stuff should I pack for China?", []);
const savedVisaContent = state.contentStore["x1-visa-pdf"];
const savedVisaFaqContent = state.contentStore["visa-faq-pdf"];
delete state.contentStore["x1-visa-pdf"];
delete state.contentStore["visa-faq-pdf"];
const visaHydrationCandidates = findHydrationCandidatesForQuery("What do I need for the Chinese visa?", [
  {
    score: 340,
    resource_id: "resources-page",
    kind: "page",
    title: "Resources - Class of 2026-2027 Pre-program",
    text: state.resources[7].context,
    source: "Class of 2026-2027 Pre-program Resources"
  }
]);
state.contentStore["x1-visa-pdf"] = savedVisaContent;
state.contentStore["visa-faq-pdf"] = savedVisaFaqContent;
const linkTypedPdfHydrates = shouldHydrateResourceContent(state.resources.find((resource) => resource.id === "visa-faq-pdf"), true);
const visaAnswerSourcesWithBody = prepareAnswerSources(searchIndex("What do I need for the X1 visa?"), "What do I need for the X1 visa?");
const visaReviewerFallback = preserveEvidenceBackedAnswer(
  "What do I need for the X1 visa?",
  { text: "I could not find that in the indexed Blackboard resources.", sources: visaAnswerSourcesWithBody },
  { text: "I could not find that in the indexed Blackboard resources.", sources: visaAnswerSourcesWithBody },
  visaAnswerSourcesWithBody,
  "What do I need for the X1 visa?"
);
const preparedMandarinSources = prepareAnswerSources(
  [
    {
      score: 200,
      kind: "pdf",
      title: "English Language Resources (2026).pdf",
      source: "Class of 2026-2027 Pre-program Language Study",
      text: "English Language Resources (2026).pdf English Language Resources English language practice materials"
    },
    {
      score: 190,
      kind: "announcement",
      title: "Chinese Language Learning Resources",
      source: "Chinese Language Learning Resources Announcements",
      text: "Chinese Language Learning Resources include key vocabulary, grammar, Mandarin placement preparation, and survival Chinese lessons."
    }
  ],
  mandarinQuery
);
const preparedMandarinSourcesWithShell = prepareAnswerSources(
  [
    {
      score: 260,
      kind: "link",
      title: "https://lms.sc.tsinghua.edu.cn/webapps/blackboard/execute/courseMain?course_id=_771_1",
      source: "Chinese Language Learning Resources Announcements - Announcements - Chinese Language Learning Resources",
      url: "https://lms.sc.tsinghua.edu.cn/webapps/blackboard/execute/courseMain?course_id=_771_1",
      text: "https://lms.sc.tsinghua.edu.cn/webapps/blackboard/execute/courseMain?course_id=_771_1 Chinese Language Learning Resources Announcements Announcements Chinese Language Learning Resources"
    },
    {
      score: 180,
      kind: "announcement",
      title: "Chinese Language Learning Resources",
      source: "Chinese Language Learning Resources Announcements",
      text: "Chinese Language Learning Resources include key vocabulary, grammar, Mandarin placement preparation, and survival Chinese lessons."
    }
  ],
  mandarinQuery
);
const alignedCitations = alignAnswerCitations(
  "Use the first source [1] and the course page [5].",
  [
    { title: "Chinese source 1", score: 100, kind: "page", text: "one" },
    { title: "Unused source 2", score: 90, kind: "page", text: "two" },
    { title: "Unused source 3", score: 80, kind: "page", text: "three" },
    { title: "Unused source 4", score: 70, kind: "page", text: "four" },
    { title: "Chinese source 5", score: 60, kind: "page", text: "five" }
  ]
);
const strippedLinkAnswer = cleanAnswerText(
  "These resources help students study Chinese [1], [2]. Links to the relevant Blackboard courses are:\\n" +
    "- https://lms.sc.tsinghua.edu.cn/webapps/blackboard/execute/courseMain?course_id=_771_1\\n" +
    "- https://lms.sc.tsinghua.edu.cn/webapps/blackboard/execute/courseMain?course_id=_1150_1",
  2
);
const packingSourcesWithoutBody = prepareAnswerSources(searchIndex("What should I pack for China?"), "What should I pack for China?");
const packingDocumentReadinessIssue = documentReadinessIssueForQuery(
  "What should I pack for China?",
  "What should I pack for China?",
  packingSourcesWithoutBody,
  { hydrated: 0, failed: 1, candidates: packingHydrationCandidates },
  defaultRagPlan("What should I pack for China?")
);
const fakePackingSnippet = "Packing List for Students (2026).pdf Class of 2026-2027 Pre-program Resources Resources Content Blackboard User Guideline Incoming Students Packing List for Students (2026).pdf OBTAINING YOUR X1 STUDENT VISA 2026.pdf Visa FAQ 2026.pdf WeChat Registration FAQ 2026 BB.pdf Click for more options Open source";
const packingFakeSnippetIsReadable = resourceHasReadableBody(state.resources.find((resource) => resource.id === "packing-pdf"), fakePackingSnippet);
state.contentStore["packing-pdf"] = "Page 1: Packing List for Students 2026. Bring passport and copies of key documents, visa paperwork, admission notice, JW202 if applicable, prescription medication in original packaging, doctor letters for prescriptions, basic over-the-counter medicine, adapters, chargers, clothing layers, professional clothes, comfortable walking shoes, toiletries, glasses or contacts, insurance information, bank cards, some cash, emergency contacts, arrival address, vaccination records, and luggage items needed for daily life in China. Page 2: Recommended items include cold medicine, allergy medicine, pain relievers, sunscreen, personal hygiene products, small gifts, and copies of important forms.";
const packingSourcesWithBody = prepareAnswerSources(searchIndex("What should I pack for China?"), "What should I pack for China?");
const packingReviewerFallback = preserveEvidenceBackedAnswer(
  "What should I pack for China?",
  { text: "I could not find that in the indexed Blackboard resources.", sources: packingSourcesWithBody },
  { text: "I could not find that in the indexed Blackboard resources.", sources: packingSourcesWithBody },
  packingSourcesWithBody,
  "What should I pack for China?"
);
const packingDocumentReadinessAfterBody = documentReadinessIssueForQuery(
  "What should I pack for China?",
  "What should I pack for China?",
  packingSourcesWithoutBody,
  { hydrated: 1, failed: 0, candidates: packingHydrationCandidates },
  defaultRagPlan("What should I pack for China?")
);
const visaAuditText = buildRagAudit("What do I need for the X1 visa?");
const packingAuditText = buildRagAudit("What should I pack for China?");
const auditCommandChecks = [isAuditCommand("/audit"), isAuditCommand("/audit x1 visa"), !isAuditCommand("audit x1 visa")];
delete state.contentStore["packing-pdf"];
const feedbackFormUrl = buildFeedbackFormUrl(
  "The packing answer missed medications.",
  "https://example.com/feedback?source=extension",
  {
    suggestions: "bot_suggestions",
    otherIssues: "software_issues",
    version: "version",
    resources: "resource_count",
    searchableBodies: "searchable_bodies",
    timestamp: "sent_at"
  }
);
const unconfiguredFeedbackFormUrl = buildFeedbackFormUrl("The packing answer missed medications.", "");
const introText = introMessageText();
const indexCommandChecks = [isIndexCommand("/index"), isIndexCommand("/reindex"), !isIndexCommand("what is indexed?")];
globalThis.__regression = { results, answer, alternateTaskRetrievalQuery, alternateTaskSources, alternateTaskAnswer, mandarinIsCapability, mandarinResults, mandarinFollowUpQuery, mandarinFollowUpSources, courseListSources, myClassesSources, taskSourcesWithCourseShell, normalizedPlanner, plannedCourseQuery, parsedReviewJson, packingHydrationCandidates, visaHydrationCandidates, linkTypedPdfHydrates, visaReviewerFallback, preparedMandarinSources, preparedMandarinSourcesWithShell, alignedCitations, strippedLinkAnswer, packingDocumentReadinessIssue, packingDocumentReadinessAfterBody, packingReviewerFallback, packingFakeSnippetIsReadable, visaAuditText, packingAuditText, auditCommandChecks, statusSummaryText, feedbackFormUrl, unconfiguredFeedbackFormUrl, introText, indexCommandChecks };
`,
  context,
  { filename: "sidepanel-regression.vm.js" }
);

const { results, answer, alternateTaskRetrievalQuery, alternateTaskSources, alternateTaskAnswer, mandarinIsCapability, mandarinResults, mandarinFollowUpQuery, mandarinFollowUpSources, courseListSources, myClassesSources, taskSourcesWithCourseShell, normalizedPlanner, plannedCourseQuery, parsedReviewJson, packingHydrationCandidates, visaHydrationCandidates, linkTypedPdfHydrates, visaReviewerFallback, preparedMandarinSources, preparedMandarinSourcesWithShell, alignedCitations, strippedLinkAnswer, packingDocumentReadinessIssue, packingDocumentReadinessAfterBody, packingReviewerFallback, packingFakeSnippetIsReadable, visaAuditText, packingAuditText, auditCommandChecks, statusSummaryText, feedbackFormUrl, unconfiguredFeedbackFormUrl, introText, indexCommandChecks } = context.__regression;
if (!/resources indexed; \d+ searchable bodies/.test(statusSummaryText)) {
  throw new Error(`Expected status summary helper to set index summary, got: ${statusSummaryText}`);
}
if (!results.length) throw new Error("Expected To Do page to rank for task query.");
if (!answer || !answer.text) throw new Error("Expected a deterministic To Do answer.");
for (const expected of [
  "2026-27 Capstone Preliminary Interest Survey",
  "23:59 on Jun 23 2026",
  "Review the 2026-27 Partner Organizations Proposed Topics",
  "Prerequisite Course Exemption Application",
  "23:59 on Jun 30 2026"
]) {
  if (!answer.text.includes(expected)) {
    throw new Error(`Expected answer to include: ${expected}\n\n${answer.text}`);
  }
}
for (const forbidden of ["ncollege", "Actions All Items", "Nothing Due Today", "I found 8"]) {
  if (answer.text.includes(forbidden)) {
    throw new Error(`Answer contains noisy duplicate text: ${forbidden}\n\n${answer.text}`);
  }
}
if (/\n\s*Sources\s*:/i.test(answer.text)) {
  throw new Error(`Answer should not include an inline Sources section.\n\n${answer.text}`);
}
if (!answer.text.includes("I found 2 current To Do items")) {
  throw new Error(`Expected exactly two To Do items.\n\n${answer.text}`);
}
if (!/deadline|action items|mandatory/i.test(alternateTaskRetrievalQuery)) {
  throw new Error(`Expected alternate task query to be expanded for deadline/task retrieval.\n\n${alternateTaskRetrievalQuery}`);
}
if (!alternateTaskSources.some((source) => source.resource_id === "todo-page")) {
  throw new Error(`Expected alternate task query to retrieve the To Do page.\n\n${JSON.stringify(alternateTaskSources, null, 2)}`);
}
if (!alternateTaskAnswer || !alternateTaskAnswer.text.includes("I found 2 current To Do items")) {
  throw new Error(`Expected alternate task phrasing to produce the concrete To Do answer.\n\n${alternateTaskAnswer?.text || "no answer"}`);
}

if (mandarinIsCapability) {
  throw new Error("Mandarin resources query was incorrectly routed as a capability/index question.");
}
if (!mandarinResults.some((result) => result.resource_id === "language-study")) {
  throw new Error(`Expected Mandarin query to retrieve language-study resource.\n\n${JSON.stringify(mandarinResults, null, 2)}`);
}
if (!/mandarin|chinese|language/i.test(mandarinFollowUpQuery)) {
  throw new Error(`Expected Mandarin follow-up retrieval query to preserve prior topic.\n\n${mandarinFollowUpQuery}`);
}
if (!mandarinFollowUpSources.some((source) => source.resource_id === "language-study" || /Chinese Language Learning Resources/i.test(source.title || source.text || ""))) {
  throw new Error(`Expected Mandarin follow-up source list to keep Chinese-language resources.\n\n${JSON.stringify(mandarinFollowUpSources, null, 2)}`);
}
if (mandarinFollowUpSources.some((source) => /English Language Resources/i.test(source.title || source.text || ""))) {
  throw new Error(`Mandarin follow-up sources should exclude English-language resource hits.\n\n${JSON.stringify(mandarinFollowUpSources, null, 2)}`);
}
if (!courseListSources.length || courseListSources[0].resource_id !== "course-calendar") {
  throw new Error(`Expected released course-list query to prioritize the course calendar.\n\n${JSON.stringify(courseListSources, null, 2)}`);
}
if (!myClassesSources.length || myClassesSources[0].resource_id !== "course-calendar") {
  throw new Error(`Expected "What classes do I have?" to prioritize the course calendar.\n\n${JSON.stringify(myClassesSources, null, 2)}`);
}
if (taskSourcesWithCourseShell.some((source) => /^Class of 2026-2027 Pre-program$/i.test(source.title || ""))) {
  throw new Error(`Generic course shell links should not appear as answer sources.\n\n${JSON.stringify(taskSourcesWithCourseShell, null, 2)}`);
}
if (courseListSources.some((source) => /Chinese Language Learning Resources|Capstone Preliminary Interest|Partner Organizations Proposed Topics/i.test(source.title || source.text || ""))) {
  throw new Error(`Course-list sources should exclude unrelated Chinese-language and capstone hits when a calendar match exists.\n\n${JSON.stringify(courseListSources, null, 2)}`);
}
if (normalizedPlanner.intent !== "course_list" || normalizedPlanner.scope !== "in_scope" || normalizedPlanner.confidence !== 0.87) {
  throw new Error(`Expected fenced planner JSON to normalize correctly.\n\n${JSON.stringify(normalizedPlanner, null, 2)}`);
}
if (!/course calendar/i.test(plannedCourseQuery) || !/class schedule/i.test(plannedCourseQuery)) {
  throw new Error(`Expected planned retrieval query to include source preferences.\n\n${plannedCourseQuery}`);
}
if (!parsedReviewJson || parsedReviewJson.answer !== "The course calendar contains the released course list [1].") {
  throw new Error(`Expected reviewer JSON to parse cleanly.\n\n${JSON.stringify(parsedReviewJson, null, 2)}`);
}
if (!packingHydrationCandidates.some((resource) => resource.id === "packing-pdf")) {
  throw new Error(`Expected packing query to target the packing PDF for body-text extraction.\n\n${JSON.stringify(packingHydrationCandidates, null, 2)}`);
}
if (!packingDocumentReadinessIssue || !/could not read the file contents/i.test(packingDocumentReadinessIssue.text)) {
  throw new Error(`Expected packing query to fail closed when the PDF body is unreadable.

${JSON.stringify(packingDocumentReadinessIssue, null, 2)}`);
}
if (packingFakeSnippetIsReadable) {
  throw new Error("Expected crawler/link snippets for PDFs not to count as readable document body text.");
}
if (packingDocumentReadinessAfterBody) {
  throw new Error(`Expected packing query to proceed once the PDF body is available.

${JSON.stringify(packingDocumentReadinessAfterBody, null, 2)}`);
}
if (context.isCouldNotFindAnswer(packingReviewerFallback.text) || !/passport|prescription|adapters|packing/i.test(packingReviewerFallback.text)) {
  throw new Error(`Reviewer fallback should preserve packing evidence instead of returning not-found.\n\n${packingReviewerFallback.text}`);
}
for (const expectedVisaResource of ["x1-visa-pdf", "visa-faq-pdf"]) {
  if (!visaHydrationCandidates.some((resource) => resource.id === expectedVisaResource)) {
    throw new Error(`Expected visa query to hydrate linked visa PDFs before answering.\n\n${JSON.stringify(visaHydrationCandidates, null, 2)}`);
  }
}
if (!linkTypedPdfHydrates) {
  throw new Error("Expected link resources with .pdf titles to be hydratable files.");
}
if (context.isCouldNotFindAnswer(visaReviewerFallback.text) || !/passport|jw202|admission notice|visa application/i.test(visaReviewerFallback.text)) {
  throw new Error(`Reviewer fallback should preserve visa evidence instead of returning not-found.\n\n${visaReviewerFallback.text}`);
}
if (preparedMandarinSources.some((source) => /English Language Resources/i.test(source.title || source.text || ""))) {
  throw new Error(`Mandarin answer sources should exclude English-language resource hits.\n\n${JSON.stringify(preparedMandarinSources, null, 2)}`);
}
if (!preparedMandarinSources.some((source) => /Chinese Language Learning Resources/i.test(source.title || ""))) {
  throw new Error(`Mandarin answer sources should keep Chinese-language resources.\n\n${JSON.stringify(preparedMandarinSources, null, 2)}`);
}
if (preparedMandarinSourcesWithShell.some((source) => /^https?:\/\//i.test(source.title || ""))) {
  throw new Error(`Mandarin answer sources should exclude raw Blackboard course shell links.\n\n${JSON.stringify(preparedMandarinSourcesWithShell, null, 2)}`);
}
if (!preparedMandarinSourcesWithShell.some((source) => source.kind === "announcement" && /Chinese Language Learning Resources/i.test(source.title || ""))) {
  throw new Error(`Mandarin answer sources should keep the useful announcement when a course shell also matches.\n\n${JSON.stringify(preparedMandarinSourcesWithShell, null, 2)}`);
}
if (alignedCitations.text.includes("[5]") || !alignedCitations.text.includes("[1]") || !alignedCitations.text.includes("[2]")) {
  throw new Error(`Citation numbers should be compacted with no gaps.\n\n${alignedCitations.text}`);
}
if (alignedCitations.sources.length !== 2 || alignedCitations.sources[1].title !== "Chinese source 5") {
  throw new Error(`Displayed sources should be exactly the cited compacted sources.\n\n${JSON.stringify(alignedCitations.sources, null, 2)}`);
}
if (/https?:\/\//i.test(strippedLinkAnswer) || /Links to the relevant Blackboard courses/i.test(strippedLinkAnswer)) {
  throw new Error(`Answer cleanup should remove raw Blackboard link sections.\n\n${strippedLinkAnswer}`);
}
if (!strippedLinkAnswer.includes("These resources help students study Chinese [1], [2].")) {
  throw new Error(`Answer cleanup should preserve the actual answer text and citations.\n\n${strippedLinkAnswer}`);
}

if (!/example\.com\/feedback/.test(feedbackFormUrl) || !/bot_suggestions=The\+packing\+answer\+missed\+medications/.test(feedbackFormUrl) || !/software_issues=/.test(feedbackFormUrl) || !/version=test-version/.test(feedbackFormUrl) || !/resource_count=/.test(feedbackFormUrl) || !/searchable_bodies=/.test(feedbackFormUrl) || !/sent_at=/.test(feedbackFormUrl)) {
  throw new Error(`Expected feedback command to build a pre-filled feedback form URL with context.\n\n${feedbackFormUrl}`);
}
if (unconfiguredFeedbackFormUrl !== "") {
  throw new Error(`Expected missing feedback form configuration to return an empty URL.\n\n${unconfiguredFeedbackFormUrl}`);
}
if (!indexCommandChecks.every(Boolean)) {
  throw new Error(`Expected /index and /reindex to be recognized without treating normal index questions as commands.\n\n${JSON.stringify(indexCommandChecks)}`);
}
if (!auditCommandChecks.every(Boolean)) {
  throw new Error(`Expected /audit command recognition to be scoped to slash commands.\n\n${JSON.stringify(auditCommandChecks)}`);
}
if (!/Query audit: What do I need for the X1 visa/i.test(visaAuditText) || !/OBTAINING YOUR X1 STUDENT VISA 2026/i.test(visaAuditText) || !/Pipeline risk flags/i.test(visaAuditText)) {
  throw new Error(`Expected visa audit to expose query pipeline, risk flags, and the correct visa PDF.\n\n${visaAuditText}`);
}
if (!/Query audit: What should I pack for China/i.test(packingAuditText) || !/Packing List for Students \(2026\)/i.test(packingAuditText) || !/Final answer sources after filtering\/dedupe/i.test(packingAuditText)) {
  throw new Error(`Expected packing audit to expose the packing PDF and final answer sources.\n\n${packingAuditText}`);
}
if (/Current index:|resources indexed|Transcript groups include/i.test(introText) || !/\/feedback/.test(introText) || !/\/index/.test(introText)) {
  throw new Error(`Intro text should be friendly, mention /index and /feedback, and avoid internal index dumps.\n\n${introText}`);
}
console.log("regression-check passed");
