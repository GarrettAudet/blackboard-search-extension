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
  },
  {
    id: "visa-faq-pdf-direct",
    type: "pdf",
    title: "Visa FAQ 2026.pdf",
    url: "https://lms.sc.tsinghua.edu.cn/bbcswebdav/pid-visa-faq-dt-content-rid-faq_1/courses/SC2026-27/Visa%20FAQ%202026.pdf",
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
  "visa-faq-pdf": "Page 1: Visa FAQ 2026. Before you book your travel, please carefully read the travel policy. Please begin your visa application as early as possible after you receive the JW202 and Tsinghua Admission Notice, as China visas may now take up longer than the past years to process, and in many countries you may be required to appear in person for fingerprinting. X1 visa students should prepare passport documents, JW202, admission notice, visa application materials, and check local embassy requirements.",
  "visa-faq-pdf-direct": "Page 1: Visa FAQ 2026. Before you book your travel, please carefully read the travel policy. Please begin your visa application as early as possible after you receive the JW202 and Tsinghua Admission Notice, as China visas may now take up longer than the past years to process, and in many countries you may be required to appear in person for fingerprinting. X1 visa students should prepare passport documents, JW202, admission notice, visa application materials, and check local embassy requirements."
};
const notificationSettingsResources = [
  {
    id: "notification-settings-course",
    type: "page",
    title: "Current Notification Setting: Class of 2026-2027 Pre-program",
    url: "https://lms.sc.tsinghua.edu.cn/webapps/blackboard/execute/editNotificationSettings?course_id=preprogram",
    page_title: "Current Notification Setting: Class of 2026-2027 Pre-program",
    section: "Blackboard Learn",
    context: "Settings On/Off Check to select all items Notification Dashboard Check to select all items Email Check to select all items Mobile Check to select all items Announcement Available Assignment Available Assignment Due Assignment Needs Grading Assignment Past Due Survey Available Survey Due Survey Overdue Test Available Test Due Test Overdue Unread Blog Posts Unread Discussion Board Messages Click Submit to proceed."
  },
  {
    id: "change-settings-one",
    type: "page",
    title: "Change Settings - Blackboard Learn",
    url: "https://lms.sc.tsinghua.edu.cn/webapps/blackboard/execute/editNotificationSettings?course_id=one",
    page_title: "Change Settings - Blackboard Learn",
    section: "Change Settings - Blackboard Learn",
    context: "SC_GRA_UPDATED Item Due Item Graded Journal Comment Item Posted Journal Needs Grading SCORM Content Item Available Course Message Assignment Past Due Survey Available Survey Due Survey Overdue Test Available Test Due Test Overdue Unread Blog Posts Submit to proceed."
  },
  {
    id: "change-settings-two",
    type: "page",
    title: "Change Settings - Blackboard Learn",
    url: "https://lms.sc.tsinghua.edu.cn/webapps/blackboard/execute/editNotificationSettings?course_id=two",
    page_title: "Change Settings - Blackboard Learn",
    section: "Change Settings - Blackboard Learn",
    context: "SC_GRA_UPDATED Item Due Item Graded Journal Comment Item Posted Journal Needs Grading SCORM Content Item Available Course Message Assignment Past Due Survey Available Survey Due Survey Overdue Test Available Test Due Test Overdue Unread Blog Posts Email Mobile Submit to proceed."
  }
];
state.resources.push(...notificationSettingsResources);
for (const resource of notificationSettingsResources) state.contentStore[resource.id] = resource.context;
state.transcripts = [];
state.settings = { hasApiKey: true };
state.resources = state.resources;
setIndexStatusSummary();
const statusSummaryText = els.statusText.textContent;

const query = "Are there any current to do's?";
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
const notificationSettingsFlags = notificationSettingsResources.map((resource) =>
  isBlackboardConfigurationResult({ ...resource, text: resource.context, source: resource.section })
);
const completeResources = state.resources;
const completeContentStore = state.contentStore;
state.resources = notificationSettingsResources;
state.contentStore = Object.fromEntries(notificationSettingsResources.map((resource) => [resource.id, resource.context]));
invalidateSearchIndexCache();
const settingsOnlyQuery = "Are there any current to do's?";
const settingsOnlyRawResults = searchIndex(settingsOnlyQuery);
const settingsOnlySources = prepareAnswerSources(settingsOnlyRawResults, settingsOnlyQuery);
const settingsOnlyAnswer = buildDirectAnswer(settingsOnlyQuery, settingsOnlySources);
const emptyToDoBody =
  "To Do &ndash; Class of 2026-2027 Pre-program To Do &ndash; Class of 2026-2027 Pre-program " +
  "Open Quick Links Page Landmarks Content Outline Keyboard Shortcuts Global Menu Activity Updates Top Frame Tabs " +
  "Current Location Class of 2026-2027 Pre-program To Do Course Menu Home IT Orientation VIDEOS To Do " +
  "Academics (Read Before Orientation) Language Study Career Development Materials Resources Webinars " +
  "International Student To Do Content There is no content to display.";
const emptyToDoResource = {
  id: "empty-todo-page",
  type: "resource",
  title: "Content",
  url: "https://lms.sc.tsinghua.edu.cn/webapps/blackboard/content/listContent.jsp?course_id=preprogram&content_id=todo",
  page_title: "Blackboard Learn",
  section: "Class of 2026-2027 Pre-program",
  context: emptyToDoBody
};
state.resources = [...notificationSettingsResources, emptyToDoResource];
state.contentStore = {
  ...Object.fromEntries(notificationSettingsResources.map((resource) => [resource.id, resource.context])),
  [emptyToDoResource.id]: emptyToDoBody
};
invalidateSearchIndexCache();
const emptyToDoRawResults = searchIndex(settingsOnlyQuery);
const emptyToDoSources = prepareAnswerSources(emptyToDoRawResults, settingsOnlyQuery);
const emptyToDoAnswer = buildDirectAnswer(settingsOnlyQuery, emptyToDoSources);
state.resources = completeResources;
state.contentStore = completeContentStore;
invalidateSearchIndexCache();

const semanticDuplicatePages = dedupeSourceCandidates(
  [
    {
      score: 240,
      resource_id: "orientation-page-a",
      kind: "page",
      title: "Orientation Overview - Blackboard Learn",
      source: "Class of 2026-2027 Pre-program Orientation - Orientation Overview - Blackboard Learn",
      url: "https://lms.sc.tsinghua.edu.cn/webapps/content/listContent.jsp?content_id=one",
      text: "Orientation Overview. Review the arrival schedule and required orientation sessions.",
      has_body: true
    },
    {
      score: 230,
      resource_id: "orientation-page-b",
      kind: "page",
      title: "Orientation Overview - Blackboard Learn",
      source: "Class of 2026-2027 Pre-program Orientation - Orientation Overview - Blackboard Learn",
      url: "https://lms.sc.tsinghua.edu.cn/webapps/content/listContent.jsp?content_id=two",
      text: "Orientation Overview. Required sessions and the arrival schedule are listed here.",
      has_body: true
    }
  ],
  "orientation overview schedule"
);
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
const savedVisaFaqDirectContent = state.contentStore["visa-faq-pdf-direct"];
delete state.contentStore["x1-visa-pdf"];
delete state.contentStore["visa-faq-pdf"];
delete state.contentStore["visa-faq-pdf-direct"];
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
state.contentStore["x1-visa-pdf"] = savedVisaContent;
state.contentStore["visa-faq-pdf"] = savedVisaFaqContent;
state.contentStore["visa-faq-pdf-direct"] = savedVisaFaqDirectContent;
const cleanedMarkdownAnswer = cleanAnswerText("The current Blackboard **To Do** task is **Capstone** &ndash; due [1].", 1);
const x1NeedToDoIsTask = isTaskDeadlineQuery("What do I need to do for the x1 visa?");
const visaNeedToDoSources = prepareAnswerSources(searchIndex("What do I need to do for the x1 visa?"), "What do I need to do for the x1 visa?");
const visaTaskWordSources = prepareAnswerSources(searchIndex("What are the current to do visa tasks?"), "What are the current to do visa tasks?");
const visaAnswerSourcesWithBody = prepareAnswerSources(searchIndex("What do I need for the X1 visa?"), "What do I need for the X1 visa?");
const duplicateVisaSources = prepareAnswerSources(searchIndex("What do I need for the X1 visa?"), "What do I need for the X1 visa?");
const duplicateVisaFaqCount = duplicateVisaSources.filter((source) => /Visa FAQ 2026/i.test(source.title || source.base_title || "")).length;
const exactVisaQuote = "Please begin your visa application as early as possible after you receive the JW202 and Tsinghua Admission Notice, as China visas may now take up longer than the past years to process, and in many countries you may be required to appear in person for fingerprinting.";
const exactQuoteQuery = 'Why did you say that when I found this "' + exactVisaQuote + '"';
const exactQuoteSources = prepareAnswerSources(searchIndex(exactQuoteQuery), exactQuoteQuery);
const exactQuoteProblem = exactQuoteIssueForQuery(exactQuoteQuery, exactQuoteQuery, exactQuoteSources);
const missingQuoteText = "Submit your visa application 1 month prior to your planned trip. Do not apply more than 3 months before your travel date.";
const missingQuoteQuery = 'Where did you see this "' + missingQuoteText + '"';
const missingQuoteSources = prepareAnswerSources(searchIndex(missingQuoteQuery), missingQuoteQuery);
const missingQuoteProblem = exactQuoteIssueForQuery(missingQuoteQuery, missingQuoteQuery, missingQuoteSources);
const sourceLocationPreserved = preserveEvidenceBackedAnswer(
  "Where did you see that I should apply approximately one month before intended travel?",
  { text: "I could not find that in the indexed Blackboard resources.", sources: visaAnswerSourcesWithBody },
  { text: "You should apply approximately one month before travel based on standard best practice [1].", sources: visaAnswerSourcesWithBody },
  visaAnswerSourcesWithBody,
  "Where did you see that I should apply approximately one month before intended travel?"
);
const unreadDocExactQuoteProblem = exactQuoteIssueForQuery(
  exactQuoteQuery,
  exactQuoteQuery,
  [
    {
      score: 260,
      kind: "document",
      title: "Prerequisite Course Exemption Application Form.doc",
      source: "Class of 2026-2027 Pre-program To Do",
      text: "Prerequisite Course Exemption Application Form.doc Attached Files",
      url: "https://lms.sc.tsinghua.edu.cn/form.doc"
    }
  ]
);
const residenceVisaQuery = "What do I need for my Residence visa?";
const residenceVisaSources = prepareAnswerSources(searchIndex(residenceVisaQuery), residenceVisaQuery);
const residenceVisaDraft = alignAnswerCitations(
  "For the X1 visa process:\\n\\n- Check that your passport will remain valid and has enough blank pages [1].\\n- Obtain the JW202 form and Tsinghua admission notice [1].\\n- Follow your local Chinese embassy or consulate's application requirements and prepare the visa form and photo [1].",
  residenceVisaSources
);
const visaReviewerFallback = preserveEvidenceBackedAnswer(
  residenceVisaQuery,
  { text: "I could not find that in the indexed Blackboard resources.", sources: visaAnswerSourcesWithBody },
  residenceVisaDraft,
  residenceVisaSources,
  residenceVisaQuery
);
const rawResidenceVisaAnswer = enforceCitedAnswer(
  residenceVisaQuery,
  {
    text: "I found relevant information in the indexed resources:\\n\\n- Page 1: OBTAINING YOUR X1 VISA Step 1: CHECK YOUR PASSPORT [1]",
    sources: residenceVisaDraft.sources
  },
  residenceVisaSources,
  residenceVisaQuery
);
const partiallyUncitedResidenceVisaAnswer = enforceCitedAnswer(
  residenceVisaQuery,
  {
    text: "Check that your passport is valid [1].\\nBring the JW202 form and admission notice to support your application.",
    sources: residenceVisaDraft.sources
  },
  residenceVisaSources,
  residenceVisaQuery
);
const irrelevantResidenceVisaAnswer = enforceCitedAnswer(
  residenceVisaQuery,
  {
    text: "The program admitted its first class in 2016 and is highly selective [1].",
    sources: [{ score: 381, kind: "pdf", title: "Program Overview.pdf", text: "The program admitted its first class in 2016 and is highly selective." }]
  },
  residenceVisaSources,
  residenceVisaQuery
);
const citedFollowUpAnswer = enforceCitedAnswer(
  "What about that?",
  { text: "You need the JW202 form and Tsinghua admission notice for the visa application [1].", sources: residenceVisaDraft.sources },
  residenceVisaSources,
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
invalidateSearchIndexCache();
const packingSourcesWithBody = prepareAnswerSources(searchIndex("What should I pack for China?"), "What should I pack for China?");
const packingDraft = alignAnswerCitations(
  "Pack your passport and key document copies, prescription medication in its original packaging, adapters and chargers, suitable clothing, and your arrival and emergency information [1].",
  packingSourcesWithBody
);
const packingReviewerFallback = preserveEvidenceBackedAnswer(
  "What should I pack for China?",
  { text: "I could not find that in the indexed Blackboard resources.", sources: packingSourcesWithBody },
  packingDraft,
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
const resourcePackCommandChecks = [
  isResourcePackCommand("/SchwarzmanC11"),
  isResourcePackCommand("/schwarzmanc11"),
  !isResourcePackCommand("SchwarzmanC11"),
  resourcePackResourceType({}, "chrome-extension://test/resource-packs/schwarzman-c11/files/Guide.PDF", "") === "pdf",
  safeResourcePackId("Arrival Guide.pdf") === "arrival-guide-pdf"
];
const packChunkOne = {
  score: 200,
  kind: "pdf",
  resource_id: "pack_schwarzman-c11_survival-guide-pages-001-008",
  source_pack_id: "schwarzman-c11",
  source_pack_document_id: "survival-guide",
  source_pack_document_title: "Schwarzman Scholars Survival Guide.pdf",
  title: "Schwarzman Scholars Survival Guide.pdf",
  text: "Page 1: arrival and Beijing survival notes"
};
const packChunkTwo = {
  ...packChunkOne,
  resource_id: "pack_schwarzman-c11_survival-guide-pages-009-019",
  text: "Page 9: housing and daily life notes"
};
const resourcePackDocumentReferenceChecks = [
  sourceDedupeKey(packChunkOne) === sourceDedupeKey(packChunkTwo),
  cleanSourceTitle(packChunkOne) === "Schwarzman Scholars Survival Guide.pdf"
];
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
globalThis.__regression = { results, answer, cleanedMarkdownAnswer, x1NeedToDoIsTask, visaNeedToDoSources, visaTaskWordSources, duplicateVisaSources, duplicateVisaFaqCount, exactQuoteSources, exactQuoteProblem, missingQuoteProblem, sourceLocationPreserved, unreadDocExactQuoteProblem, alternateTaskRetrievalQuery, alternateTaskSources, alternateTaskAnswer, notificationSettingsFlags, settingsOnlyRawResults, settingsOnlySources, settingsOnlyAnswer, emptyToDoRawResults, emptyToDoSources, emptyToDoAnswer, semanticDuplicatePages, mandarinIsCapability, mandarinResults, mandarinFollowUpQuery, mandarinFollowUpSources, courseListSources, myClassesSources, taskSourcesWithCourseShell, normalizedPlanner, plannedCourseQuery, parsedReviewJson, packingHydrationCandidates, visaHydrationCandidates, linkTypedPdfHydrates, visaReviewerFallback, residenceVisaSources, rawResidenceVisaAnswer, partiallyUncitedResidenceVisaAnswer, irrelevantResidenceVisaAnswer, citedFollowUpAnswer, preparedMandarinSources, preparedMandarinSourcesWithShell, alignedCitations, strippedLinkAnswer, packingDocumentReadinessIssue, packingDocumentReadinessAfterBody, packingReviewerFallback, packingFakeSnippetIsReadable, visaAuditText, packingAuditText, auditCommandChecks, resourcePackCommandChecks, resourcePackDocumentReferenceChecks, statusSummaryText, feedbackFormUrl, unconfiguredFeedbackFormUrl, introText, indexCommandChecks };
`,
  context,
  { filename: "sidepanel-regression.vm.js" }
);

const { results, answer, cleanedMarkdownAnswer, x1NeedToDoIsTask, visaNeedToDoSources, visaTaskWordSources, duplicateVisaSources, duplicateVisaFaqCount, exactQuoteSources, exactQuoteProblem, missingQuoteProblem, sourceLocationPreserved, unreadDocExactQuoteProblem, alternateTaskRetrievalQuery, alternateTaskSources, alternateTaskAnswer, notificationSettingsFlags, settingsOnlyRawResults, settingsOnlySources, settingsOnlyAnswer, emptyToDoRawResults, emptyToDoSources, emptyToDoAnswer, semanticDuplicatePages, mandarinIsCapability, mandarinResults, mandarinFollowUpQuery, mandarinFollowUpSources, courseListSources, myClassesSources, taskSourcesWithCourseShell, normalizedPlanner, plannedCourseQuery, parsedReviewJson, packingHydrationCandidates, visaHydrationCandidates, linkTypedPdfHydrates, visaReviewerFallback, residenceVisaSources, rawResidenceVisaAnswer, partiallyUncitedResidenceVisaAnswer, irrelevantResidenceVisaAnswer, citedFollowUpAnswer, preparedMandarinSources, preparedMandarinSourcesWithShell, alignedCitations, strippedLinkAnswer, packingDocumentReadinessIssue, packingDocumentReadinessAfterBody, packingReviewerFallback, packingFakeSnippetIsReadable, visaAuditText, packingAuditText, auditCommandChecks, resourcePackCommandChecks, resourcePackDocumentReferenceChecks, statusSummaryText, feedbackFormUrl, unconfiguredFeedbackFormUrl, introText, indexCommandChecks } = context.__regression;

const chineseX1DirectAnswer = vm.runInContext(
  `(() => {
    const query = "What do I need for the Chinese X1 visa?";
    const sources = prepareAnswerSources(searchIndex(query), query);
    return {
      deterministic: hasDeterministicDirectAnswerIntent(query),
      answer: buildDirectAnswer(query, sources)
    };
  })()`,
  context
);
if (!chineseX1DirectAnswer.deterministic || !chineseX1DirectAnswer.answer?.sources?.length ||
    !/passport/i.test(chineseX1DirectAnswer.answer?.text || "") ||
    !/JW202/i.test(chineseX1DirectAnswer.answer?.text || "") ||
    !/\[\d+\]/.test(chineseX1DirectAnswer.answer?.text || "")) {
  throw new Error(`The exact live Chinese X1 visa query did not produce a deterministic cited answer.\n\n${JSON.stringify(chineseX1DirectAnswer, null, 2)}`);
}

const leakedReviewerOutput = [
  "I could not find that in the indexed resources.",
  "",
  "The provided search results focus heavily on visa logistics and general expat tips, but they do not contain a consolidated set of practical tips.",
  "The draft answer includes specific claims that are not explicitly supported by the provided source text. I must reject the unsupported parts.",
  "",
  "Let's re-evaluate. Can I extract enough tips from the sources to answer the question?",
  "- Source 1: Beijing is crowded and English is not widely spoken.",
  "- Source 2: Four transport modes are listed."
].join("\n");
const recoveredBeijingAnswer =
  "Set up WeChat for messaging, payments, and restaurant ordering, and use Didi or the subway to get around Beijing [1].";
const reviewerFixture = {
  score: 240,
  kind: "document",
  title: "Schwarzman Life in China Webinar transcript",
  source: "Optional webinar transcripts - Schwarzman C11",
  text:
    "Tips for living in Beijing: WeChat is used for messages, payments, and restaurant ordering. " +
    "Didi is used for rides, and the Beijing subway is a common way to get around.",
  source_pack_id: "schwarzman-c11",
  source_pack_document_id: "life-in-china-webinar",
  source_pack_provenance: "program webinar transcript",
  has_body: true
};

function structuredReviewerResponse(text) {
  const sourceIds = Array.from(new Set(Array.from(String(text || "").matchAll(/\[(\d+)\]/g), (match) => Number(match[1]))));
  const blockText = String(text || "")
    .replace(/\[\d+\]/g, "")
    .replace(/\s+([.!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return JSON.stringify({
    not_found: false,
    answer_blocks: [{ text: blockText, source_ids: sourceIds }]
  });
}

async function runReviewerSimulation(responses) {
  context.__reviewResponses = [...responses];
  context.__reviewCallCount = 0;
  context.__reviewFixture = reviewerFixture;
  vm.runInContext(`
    state.settings = { provider: "openrouter", model: "test-model", apiKey: "test-key", hasApiKey: true };
    callChatCompletion = async () => {
      globalThis.__reviewCallCount += 1;
      const response = globalThis.__reviewResponses.shift();
      if (typeof response !== "string") throw new Error("Reviewer simulation ran out of responses.");
      return response;
    };
    globalThis.__reviewPromise = reviewApiAnswer(
      "Any tips for living in Beijing?",
      "Use these practical Beijing tips [1].",
      [globalThis.__reviewFixture],
      [],
      "Any tips for living in Beijing?",
      defaultRagPlan("Any tips for living in Beijing?")
    );
  `, context);
  return { text: await context.__reviewPromise, calls: context.__reviewCallCount };
}

const malformedReviewerRecovery = await runReviewerSimulation([leakedReviewerOutput]);
const validReviewerJson = await runReviewerSimulation([structuredReviewerResponse(recoveredBeijingAnswer)]);
const doubleMalformedReviewer = await runReviewerSimulation([leakedReviewerOutput]);
const extraKeyReviewerJson = await runReviewerSimulation([
  JSON.stringify({ not_found: false, answer_blocks: [{ text: "Set up WeChat for messaging.", source_ids: [1] }], reason: "This extra key must invalidate the object." })
]);
const adversarialReviewerAnswers = [
  "Analysis: The draft needs another source check before it can be shown [1].",
  "Reasoning: The evidence appears sufficient, so this could be returned [1].",
  "Critique: The draft should cite a different excerpt [1].",
  "I need to verify the cited evidence before answering [1].",
  "I should remove the unsupported claim and cite the source [1].",
  "I must evaluate whether the draft is supported [1].",
  "Let me review the evidence before I rewrite the answer [1].",
  "The answer should remove unsupported details before display [1].",
  "My analysis is that the draft can be approved [1]."
];
const adversarialReviewerRuns = [];
for (const adversarialAnswer of adversarialReviewerAnswers) {
  adversarialReviewerRuns.push(
    await runReviewerSimulation([structuredReviewerResponse(adversarialAnswer)])
  );
}
context.__leakedReviewerOutput = leakedReviewerOutput;
context.__reviewFixture = reviewerFixture;
const guardedReviewerLeak = vm.runInContext(`
  enforceCitedAnswer(
    "Any tips for living in Beijing?",
    { text: globalThis.__leakedReviewerOutput, sources: [globalThis.__reviewFixture] },
    [globalThis.__reviewFixture],
    "Any tips for living in Beijing?"
  );
`, context);
const broadRejectedDraft = vm.runInContext(`
  preserveEvidenceBackedAnswer(
    "Any tips for living in Beijing?",
    { text: "I could not find that in the indexed resources.", sources: [globalThis.__reviewFixture] },
    { text: "Use unsupported robot delivery and restaurant-price recommendations in Beijing [1].", sources: [globalThis.__reviewFixture] },
    [globalThis.__reviewFixture],
    "Any tips for living in Beijing?"
  );
`, context);
const supportedClaimAnswer = vm.runInContext(`
  enforceCitedAnswer(
    "Any tips for living in Beijing?",
    { text: "Use WeChat for messaging, payments, and restaurant ordering, and use Didi or the subway for travel [1].", sources: [globalThis.__reviewFixture] },
    [globalThis.__reviewFixture],
    "Any tips for living in Beijing?"
  );
`, context);
const supportedAnswerWithFraming = vm.runInContext(`
  enforceCitedAnswer(
    "Any tips for living in Beijing?",
    { text: "Here are the main recommendations from the indexed resources.\\n\\n- Use WeChat for messaging, payments, and restaurant ordering, and use Didi or the subway for travel [1].", sources: [globalThis.__reviewFixture] },
    [globalThis.__reviewFixture],
    "Any tips for living in Beijing?"
  );
`, context);
const unsupportedClaimAnswer = vm.runInContext(`
  enforceCitedAnswer(
    "Any tips for living in Beijing?",
    { text: "Use DaZhongDianPing for robot deliveries and expect every restaurant meal to cost 30 yuan [1].", sources: [globalThis.__reviewFixture] },
    [globalThis.__reviewFixture],
    "Any tips for living in Beijing?"
  );
`, context);
const partiallyUnsupportedClaimAnswer = vm.runInContext(`
  enforceCitedAnswer(
    "Any tips for living in Beijing?",
    { text: "Use WeChat for messaging, payments, and restaurant ordering. Every restaurant meal costs exactly 30 yuan [1].", sources: [globalThis.__reviewFixture] },
    [globalThis.__reviewFixture],
    "Any tips for living in Beijing?"
  );
`, context);
const reviewerLeakPattern = /provided search results|draft answer|must reject|let'?s re-evaluate|source\s+\d+\s*:/i;

if (malformedReviewerRecovery.calls !== 1 || malformedReviewerRecovery.text !== "" || reviewerLeakPattern.test(malformedReviewerRecovery.text)) {
  throw new Error(`Malformed reviewer output should return control to the orchestrated recovery stage.\n\n${JSON.stringify(malformedReviewerRecovery, null, 2)}`);
}
if (validReviewerJson.calls !== 1 || validReviewerJson.text !== recoveredBeijingAnswer) {
  throw new Error(`Valid reviewer JSON should be accepted without a recovery request.\n\n${JSON.stringify(validReviewerJson, null, 2)}`);
}
if (extraKeyReviewerJson.calls !== 1 || extraKeyReviewerJson.text !== "") {
  throw new Error("Reviewer JSON with any key outside the structured answer contract must be rejected. " + JSON.stringify(extraKeyReviewerJson, null, 2));
}
if (adversarialReviewerRuns.some((run) => run.calls !== 1 || run.text !== "")) {
  throw new Error("Reviewer analysis/process language escaped through a structured answer block. " + JSON.stringify(adversarialReviewerRuns, null, 2));
}
if (doubleMalformedReviewer.calls !== 1 || doubleMalformedReviewer.text !== "" || reviewerLeakPattern.test(doubleMalformedReviewer.text)) {
  throw new Error(`Malformed reviewer output leaked instead of returning an empty repair result.\n\n${JSON.stringify(doubleMalformedReviewer, null, 2)}`);
}
if (!/could not produce a reliable cited answer/i.test(guardedReviewerLeak.text) || reviewerLeakPattern.test(guardedReviewerLeak.text)) {
  throw new Error(`The final display guard allowed reviewer process text through.\n\n${guardedReviewerLeak.text}`);
}
if (!context.isCouldNotFindAnswer(broadRejectedDraft.text) || /robot delivery|restaurant-price/i.test(broadRejectedDraft.text)) {
  throw new Error(`A rejected broad-answer draft was incorrectly revived.\n\n${broadRejectedDraft.text}`);
}
if (/could not produce/i.test(supportedClaimAnswer.text) || !/\[1\]/.test(supportedClaimAnswer.text)) {
  throw new Error(`A source-supported Beijing claim failed the claim-level answer guard.\n\n${supportedClaimAnswer.text}`);
}
if (/could not produce/i.test(supportedAnswerWithFraming.text) || !/\[1\]/.test(supportedAnswerWithFraming.text)) {
  throw new Error(`A supported answer was rejected because of a harmless uncited framing line.\n\n${supportedAnswerWithFraming.text}`);
}
if (!/could not produce a reliable cited answer/i.test(unsupportedClaimAnswer.text)) {
  throw new Error(`Unsupported named and numeric Beijing claims passed the claim-level answer guard.\n\n${unsupportedClaimAnswer.text}`);
}
if (
  /could not produce/i.test(partiallyUnsupportedClaimAnswer.text) ||
  context.answerClaimsSupportedByCitedSources(partiallyUnsupportedClaimAnswer.text, partiallyUnsupportedClaimAnswer.sources) !== false
) {
  throw new Error(`The deterministic guard should leave absence-only semantic support to the verifier while retaining lexical overlap as a negative diagnostic.\n\n${partiallyUnsupportedClaimAnswer.text}`);
}

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
const notificationNoise = /Current Notification Setting|Change Settings|Needs Grading|SCORM Content Item|Journal Comment|Unread Blog Posts/i;
if (alternateTaskSources.some((source) => notificationNoise.test(`${source.title} ${source.source} ${source.text}`))) {
  throw new Error(`Notification settings survived task source filtering.\n\n${JSON.stringify(alternateTaskSources, null, 2)}`);
}
if (notificationNoise.test(alternateTaskAnswer.text)) {
  throw new Error(`Notification settings vocabulary survived task answer sanity checks.\n\n${alternateTaskAnswer.text}`);
}
if (notificationSettingsFlags.some((flag) => !flag)) {
  throw new Error(`A screenshot-derived Blackboard configuration page was not recognized: ${JSON.stringify(notificationSettingsFlags)}`);
}
if (settingsOnlyRawResults.length || settingsOnlySources.length) {
  throw new Error(`A settings-only index produced searchable task evidence.\n\n${JSON.stringify({ settingsOnlyRawResults, settingsOnlySources }, null, 2)}`);
}
if (!/could not verify current To Do items/i.test(settingsOnlyAnswer?.text || "") || settingsOnlyAnswer.sources.length) {
  throw new Error(`A settings-only index did not fail safely at the task-answer layer.\n\n${JSON.stringify(settingsOnlyAnswer, null, 2)}`);
}
if (
  emptyToDoSources.length !== 1 ||
  emptyToDoSources[0].resource_id !== "empty-todo-page" ||
  !/no active tasks/i.test(emptyToDoAnswer?.text || "") ||
  emptyToDoAnswer.sources.length !== 1 ||
  notificationNoise.test(`${emptyToDoAnswer.text} ${emptyToDoSources.map((source) => source.title).join(" ")}`)
) {
  throw new Error(`The live To Do empty state was not preserved and answered directly.\n\n${JSON.stringify({ emptyToDoRawResults, emptyToDoSources, emptyToDoAnswer }, null, 2)}`);
}
if (semanticDuplicatePages.length !== 1 || semanticDuplicatePages[0].matched_resource_ids?.length !== 2) {
  throw new Error(`Semantically identical Blackboard pages were not collapsed into one source.\n\n${JSON.stringify(semanticDuplicatePages, null, 2)}`);
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
if (/\*\*|&ndash;|&mdash;/.test(cleanedMarkdownAnswer)) {
  throw new Error(`Answer cleanup should strip markdown and decode HTML entities.\n\n${cleanedMarkdownAnswer}`);
}
if (x1NeedToDoIsTask) {
  throw new Error('A domain-specific X1 visa question should not be routed as a generic To Do query just because it says "need to do".');
}
if (!visaNeedToDoSources.some((source) => source.resource_id === "x1-visa-pdf")) {
  throw new Error(`Expected X1 need-to-do query to keep the actual X1 visa PDF.\n\n${JSON.stringify(visaNeedToDoSources, null, 2)}`);
}
if (!visaTaskWordSources.length || !visaTaskWordSources.some((source) => source.resource_id === "x1-visa-pdf")) {
  throw new Error(`Expected visa task wording to route to visa sources, not generic Blackboard To Do shell text.\n\n${JSON.stringify(visaTaskWordSources, null, 2)}`);
}
if (duplicateVisaFaqCount !== 1) {
  throw new Error(`Expected duplicate Visa FAQ sources to collapse to one card.\n\n${JSON.stringify(duplicateVisaSources, null, 2)}`);
}
if (exactQuoteProblem) {
  throw new Error(`Expected exact quote query to proceed when the indexed source contains the quote.\n\n${JSON.stringify(exactQuoteProblem, null, 2)}`);
}
if (!exactQuoteSources.some((source) => /Visa FAQ 2026/i.test(source.title || source.base_title || ""))) {
  throw new Error(`Expected exact quote query to retrieve Visa FAQ 2026.\n\n${JSON.stringify(exactQuoteSources, null, 2)}`);
}
if (!missingQuoteProblem || !/exact quoted text/i.test(missingQuoteProblem.text)) {
  throw new Error(`Expected missing quote query to fail closed without inventing timing guidance.\n\n${JSON.stringify(missingQuoteProblem, null, 2)}`);
}
if (!context.isCouldNotFindAnswer(sourceLocationPreserved.text)) {
  throw new Error(`Expected source-location questions not to revive inferred best-practice timing.\n\n${sourceLocationPreserved.text}`);
}
if (!unreadDocExactQuoteProblem || !/exact quoted text/i.test(unreadDocExactQuoteProblem.text)) {
  throw new Error(`Expected unread .doc listings not to count as evidence for an exact quote.\n\n${JSON.stringify(unreadDocExactQuoteProblem, null, 2)}`);
}
if (visaTaskWordSources.some((source) => /Open Quick Links|Page Landmarks|Keyboard Shortcuts|&ndash;/i.test(`${source.title} ${source.source} ${source.text}`))) {
  throw new Error(`Answer sources should exclude Blackboard navigation chrome and decoded entity junk.\n\n${JSON.stringify(visaTaskWordSources, null, 2)}`);
}if (courseListSources.some((source) => /Chinese Language Learning Resources|Capstone Preliminary Interest|Partner Organizations Proposed Topics/i.test(source.title || source.text || ""))) {
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
  const diagnostics = vm.runInContext(`({
    draft: packingDraft,
    support: answerClaimsSupportedByCitedSources(packingDraft.text, packingDraft.sources),
    usable: isUsableCitedAnswer("What should I pack for China?", packingDraft, packingSourcesWithBody),
    sourceText: fullTextForResult(packingDraft.sources[0]),
    evidenceScore: sourceEvidenceScore("What should I pack for China?", packingDraft.sources[0])
  })`, context);
  throw new Error(`Reviewer fallback should preserve packing evidence instead of returning not-found.\n\n${packingReviewerFallback.text}\n\n${JSON.stringify(diagnostics, null, 2)}`);
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
if (!/\[\d+\]/.test(visaReviewerFallback.text) || !visaReviewerFallback.sources.length) {
  throw new Error(`Residence-visa fallback must remain cited.\n\n${JSON.stringify(visaReviewerFallback, null, 2)}`);
}
if (/I found relevant information in the indexed resources|(?:^|\n)\s*-?\s*Page\s+\d+\s*:/i.test(visaReviewerFallback.text)) {
  throw new Error(`Residence-visa fallback exposed raw retrieval excerpts.\n\n${visaReviewerFallback.text}`);
}
if (!residenceVisaSources.some((source) => /X1|Visa FAQ/i.test(source.title || source.base_title || ""))) {
  throw new Error(`The exact residence-visa query did not retrieve a visa document.\n\n${JSON.stringify(residenceVisaSources, null, 2)}`);
}
if (!/could not produce a reliable cited answer/i.test(rawResidenceVisaAnswer.text) || /Page\s+\d+\s*:|I found relevant information/i.test(rawResidenceVisaAnswer.text)) {
  throw new Error(`Raw residence-visa excerpts were not rejected by the answer guard.\n\n${rawResidenceVisaAnswer.text}`);
}
if (!/could not produce a reliable cited answer/i.test(partiallyUncitedResidenceVisaAnswer.text)) {
  throw new Error(`A partially uncited checklist was allowed through the answer guard.\n\n${partiallyUncitedResidenceVisaAnswer.text}`);
}
const irrelevantResidenceVisaDiagnostic = context.citedAnswerValidation(
  "What do I need for my Residence visa?",
  irrelevantResidenceVisaAnswer,
  residenceVisaSources,
  "What do I need for my Residence visa?"
);
if (
  /could not produce/i.test(irrelevantResidenceVisaAnswer.text) ||
  irrelevantResidenceVisaDiagnostic.diagnostics.visa_source_classifier_mismatch !== true
) {
  throw new Error(`Question relevance must remain a diagnostic for the semantic verifier, not a brittle deterministic rejection.\n\n${JSON.stringify(irrelevantResidenceVisaDiagnostic, null, 2)}`);
}
if (/could not produce/i.test(citedFollowUpAnswer.text) || !/\[1\]/.test(citedFollowUpAnswer.text)) {
  throw new Error(`A grounded cited follow-up answer was incorrectly rejected.\n\n${citedFollowUpAnswer.text}`);
}
if (visaReviewerFallback.sources.some((source) => !context.isVisaResult(source))) {
  throw new Error(`Residence-visa fallback retained a non-visa cited source.\n\n${JSON.stringify(visaReviewerFallback.sources, null, 2)}`);
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
const repairedChineseSublevelAnswer = context.cleanAnswerText(
  "There are a total of nine Chinese placement sub-levels: beginning levels are 1A, 1B, and 1C; intermediate levels are 2A and 2B; advanced levels are 3A and 3B [1]. The written test is sent in early July, while the speaking and reading test happens during orientation [1].",
  1
);
if (!strippedLinkAnswer.includes("These resources help students study Chinese [1], [2].")) {
  throw new Error(`Answer cleanup should preserve the actual answer text and citations.\n\n${strippedLinkAnswer}`);
}
if (/\b1A\b|\b2A\b|\b3A\b/.test(repairedChineseSublevelAnswer) || !/nine Chinese placement sub-levels \[1\]/i.test(repairedChineseSublevelAnswer)) {
  throw new Error(`Chinese placement cleanup should not preserve an incomplete level enumeration beside the nine-sublevel claim.\n\n${repairedChineseSublevelAnswer}`);
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
if (!resourcePackCommandChecks.every(Boolean)) {
  throw new Error(`Expected optional resource-pack command recognition and file typing to stay stable.\n\n${JSON.stringify(resourcePackCommandChecks)}`);
}
if (!resourcePackDocumentReferenceChecks.every(Boolean)) {
  throw new Error(`Expected resource-pack chunks to cite/dedupe as their parent document.\n\n${JSON.stringify(resourcePackDocumentReferenceChecks)}`);
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
if (/SchwarzmanC11|optional packs?|pack command/i.test(introText)) {
  throw new Error(`Intro text should not reveal hidden community-resource pack commands.\n\n${introText}`);
}
console.log("regression-check passed");
