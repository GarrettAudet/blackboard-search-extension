import fs from "node:fs";
import vm from "node:vm";

const sidepanelPath = new URL("../sidepanel/sidepanel.js", import.meta.url);
const source = fs.readFileSync(sidepanelPath, "utf8");
const runtimeStart = source.indexOf("chrome.runtime.onMessage.addListener");
const testableSource = runtimeStart > 0 ? source.slice(0, runtimeStart) : source;

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
  }
];
state.contentStore = {
  "todo-page": state.resources[0].context,
  "survey-link": state.resources[1].context,
  "home-page": state.resources[2].context
};
state.transcripts = [];
state.settings = { hasApiKey: true };

const query = "What are the current to do's?";
const results = searchIndex(query);
const answer = buildDirectAnswer(query, results);
globalThis.__regression = { results, answer };
`,
  context,
  { filename: "sidepanel-regression.vm.js" }
);

const { results, answer } = context.__regression;
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

console.log("regression-check passed");
