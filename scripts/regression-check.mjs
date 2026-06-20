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
      onMessage: { addListener() {} }
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
  "resources-page": state.resources[7].context
};
state.transcripts = [];
state.settings = { hasApiKey: true };

const query = "What are the current to do's?";
const results = searchIndex(query);
const answer = buildDirectAnswer(query, results);
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
const linkTypedPdfHydrates = shouldHydrateResourceContent(state.resources.find((resource) => resource.id === "visa-faq-pdf"), true);
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
globalThis.__regression = { results, answer, mandarinIsCapability, mandarinResults, mandarinFollowUpQuery, mandarinFollowUpSources, courseListSources, normalizedPlanner, plannedCourseQuery, parsedReviewJson, packingHydrationCandidates, visaHydrationCandidates, linkTypedPdfHydrates, preparedMandarinSources, preparedMandarinSourcesWithShell, alignedCitations, strippedLinkAnswer };
`,
  context,
  { filename: "sidepanel-regression.vm.js" }
);

const { results, answer, mandarinIsCapability, mandarinResults, mandarinFollowUpQuery, mandarinFollowUpSources, courseListSources, normalizedPlanner, plannedCourseQuery, parsedReviewJson, packingHydrationCandidates, visaHydrationCandidates, linkTypedPdfHydrates, preparedMandarinSources, preparedMandarinSourcesWithShell, alignedCitations, strippedLinkAnswer } = context.__regression;
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
for (const expectedVisaResource of ["x1-visa-pdf", "visa-faq-pdf"]) {
  if (!visaHydrationCandidates.some((resource) => resource.id === expectedVisaResource)) {
    throw new Error(`Expected visa query to hydrate linked visa PDFs before answering.\n\n${JSON.stringify(visaHydrationCandidates, null, 2)}`);
  }
}
if (!linkTypedPdfHydrates) {
  throw new Error("Expected link resources with .pdf titles to be hydratable files.");
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

console.log("regression-check passed");
