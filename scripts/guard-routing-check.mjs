import fs from "node:fs";
import vm from "node:vm";

const modulePaths = [
  new URL("../lib/answer-formatting.js", import.meta.url),
  new URL("../lib/llm-client.js", import.meta.url),
  new URL("../lib/search-index.js", import.meta.url)
];
const sidepanelSource = fs.readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");
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

const context = {
  console,
  URL,
  AbortController,
  setTimeout,
  clearTimeout,
  fetch: async () => { throw new Error("Network access is forbidden in guard-routing-check."); },
  document: {
    getElementById() { return mockElement(); },
    createElement() { return mockElement(); }
  },
  chrome: {
    runtime: {
      sendMessage() {},
      getManifest() { return { version: "guard-routing-check" }; },
      getURL(path) { return `chrome-extension://guard-test/${path}`; },
      onMessage: { addListener() {} }
    },
    tabs: { async create() {} },
    storage: { local: { async get() { return {}; }, async set() {} } }
  }
};
vm.createContext(context);
vm.runInContext(
  modulePaths.map((path) => fs.readFileSync(path, "utf8")).join("\n\n") + "\n\n" + sidepanelSource.slice(0, runtimeStart),
  context
);

function evaluate(functionName, value) {
  context.__guardValue = value;
  return vm.runInContext(`${functionName}(__guardValue)`, context);
}

const queryCases = [
  ["Chinese grammar", "isChineseLanguageQuery", "Where are the Chinese grammar tutoring materials?", true],
  ["Mandarin pronunciation", "isChineseLanguageQuery", "How can I practice Mandarin pronunciation?", true],
  ["Mandarin level", "isChineseLanguageQuery", "Which Mandarin level has advanced materials?", true],
  ["survival Chinese", "isChineseLanguageQuery", "Show the survival Chinese lessons.", true],
  ["HSK placement", "isChineseLanguageQuery", "Are HSK placement resources available?", true],
  ["Chinese students", "isChineseLanguageQuery", "Can mainland Chinese students register for Tsinghua courses?", false],
  ["Chinese citizens", "isChineseLanguageQuery", "Are Chinese citizens eligible for the scholarship program?", false],
  ["Chinese nationals", "isChineseLanguageQuery", "Do Chinese nationals need a visa?", false],
  ["Chinese applicants", "isChineseLanguageQuery", "Can Chinese applicants use this admissions form?", false],
  ["Chinese-speaking person", "isChineseLanguageQuery", "Can a Chinese-speaking doctor help at the clinic?", false],
  ["Chinese assistance", "isChineseLanguageQuery", "Is Chinese language assistance available at the hospital?", false],
  ["English practice", "isEnglishLanguageQuery", "Where can I practice English pronunciation?", true],
  ["English grammar", "isEnglishLanguageQuery", "Show English grammar materials.", true],
  ["English course", "isEnglishLanguageQuery", "Which English course should I take?", true],
  ["English writing", "isEnglishLanguageQuery", "How do I improve my English writing skills?", true],
  ["English resources", "isEnglishLanguageQuery", "Where are the English language resources?", true],
  ["English students", "isEnglishLanguageQuery", "Can English students access career resources?", false],
  ["English citizens", "isEnglishLanguageQuery", "Are English citizens eligible for this fellowship?", false],
  ["English nationals", "isEnglishLanguageQuery", "Do English nationals need an entry visa?", false],
  ["English applicants", "isEnglishLanguageQuery", "Can English applicants use the admissions portal?", false],
  ["English-speaking staff", "isEnglishLanguageQuery", "Which hospitals have English-speaking staff?", false],
  ["English translation", "isEnglishLanguageQuery", "Is an English translation required for the visa application?", false],
  ["anything due", "isTaskDeadlineQuery", "Is anything due today?", true],
  ["due status", "isTaskDeadlineQuery", "What is my due status?", true],
  ["current tasks", "isTaskDeadlineQuery", "Which current tasks are still pending?", true],
  ["survey obligation", "isTaskDeadlineQuery", "Do I need to complete the survey before Friday?", true],
  ["application requirement", "isTaskDeadlineQuery", "Is the funding application mandatory?", true],
  ["form obligation", "isTaskDeadlineQuery", "Must I submit the reimbursement form?", true],
  ["course assignment", "isTaskDeadlineQuery", "What must I do for the course assignment?", true],
  ["nothing due", "isTaskDeadlineQuery", "Nothing is due this week.", true],
  ["explicit visa tasks", "isTaskDeadlineQuery", "What are my current visa tasks?", true],
  ["visa need-to-do", "isTaskDeadlineQuery", "What do I need to do for my X1 visa?", false],
  ["visa application", "isTaskDeadlineQuery", "Must I complete the visa application before arrival?", false],
  ["visa deadline", "isTaskDeadlineQuery", "Is the visa application deadline today?", false],
  ["packing guidance", "isTaskDeadlineQuery", "What should I pack for China?", false],
  ["application documents", "isTaskDeadlineQuery", "What documents do I need for the scholarship application?", false],
  ["application capability", "isTaskDeadlineQuery", "Can the funding application accommodate dietary restrictions?", false],
  ["class start", "isTaskDeadlineQuery", "When do classes begin after orientation?", false],
  ["event documentation", "isTaskDeadlineQuery", "What approvals and documentation do I need before spending event funds?", false]
];

const resourceCases = [
  [
    "explicit English language metadata",
    { title: "English Language Workshop", section: "Learning Resources", text: "Unrelated body text." },
    true
  ],
  [
    "qualified English grammar title",
    { title: "English Grammar Exercises", section: "Student Materials", text: "Unrelated body text." },
    true
  ],
  [
    "qualified English practice title",
    { title: "Practice English Pronunciation", section: "Workshops", text: "Unrelated body text." },
    true
  ],
  [
    "English student resources",
    { title: "English Student Resources", section: "Student Services", text: "General student support." },
    false
  ],
  [
    "body-only language phrase",
    { title: "Hospital Guide", section: "Student Services", text: "English language resources and practice." },
    false
  ],
  [
    "visa document in English",
    { title: "Visa Application in English", section: "Immigration", text: "Application instructions." },
    false
  ],
  [
    "English-speaking hospitals",
    { title: "English-speaking Hospitals", section: "Health Services", text: "Clinic directory." },
    false
  ],
  [
    "English version metadata",
    { title: "Tsinghua University Hospital", page_title: "English Version", text: "Clinic directory." },
    false
  ]
];

const failures = [];
for (const [label, functionName, query, expected] of queryCases) {
  const actual = Boolean(evaluate(functionName, query));
  if (actual !== expected) failures.push({ label, functionName, query, expected, actual });
}
for (const [label, resource, expected] of resourceCases) {
  const actual = Boolean(evaluate("isEnglishLanguageResource", resource));
  if (actual !== expected) failures.push({ label, functionName: "isEnglishLanguageResource", expected, actual });
}
delete context.__guardValue;

if (failures.length) {
  throw new Error(`guard-routing-check failed:\n${JSON.stringify(failures, null, 2)}`);
}
console.log(`guard-routing-check passed (${queryCases.length} query cases, ${resourceCases.length} metadata cases)`);
