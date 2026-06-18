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

state.resources = [{
  id: "todo-page",
  type: "page",
  title: "To Do - Class of 2026-2027 Pre-program",
  url: "https://lms.sc.tsinghua.edu.cn/todo",
  page_title: "To Do - Class of 2026-2027 Pre-program",
  section: "Class of 2026-2027 Pre-program",
  context: "To Do\\n\\nDeadline 23:59 on Jun 23 2026 (UTC+8) 2026-27 Capstone Preliminary Interest Survey. Review the 2026-27 Partner Organizations Proposed Topics and fill out the 2026-27 Capstone Preliminary Interest Survey by 23:59 on Jun 23, 2026 (UTC+8). The survey is mandatory for all C11 students."
}];
state.contentStore = {
  "todo-page": state.resources[0].context
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
  "Review the 2026-27 Partner Organizations Proposed Topics"
]) {
  if (!answer.text.includes(expected)) {
    throw new Error(`Expected answer to include: ${expected}\n\n${answer.text}`);
  }
}

console.log("regression-check passed");
