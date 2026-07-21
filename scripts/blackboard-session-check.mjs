import fs from "node:fs";
import vm from "node:vm";

const helperSource = fs.readFileSync(new URL("../lib/blackboard-session.js", import.meta.url), "utf8");
const context = { URL };
vm.createContext(context);
vm.runInContext(helperSource, context);

const assess = context.BlackboardSession?.assessBlackboardSession;
if (typeof assess !== "function") throw new Error("Blackboard session helper did not load.");

const portalUrl = "https://lms.sc.tsinghua.edu.cn/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1";
const cases = [
  {
    name: "authenticated portal",
    expected: true,
    input: {
      requested_url: portalUrl,
      final_url: portalUrl,
      status: 200,
      content_type: "text/html; charset=utf-8",
      body: "<html><body><nav>Courses</nav><a href='/logout'>Logout</a></body></html>"
    }
  },
  {
    name: "SSO redirect",
    expected: false,
    input: {
      requested_url: portalUrl,
      final_url: "https://id.tsinghua.edu.cn/login?service=lms",
      status: 200,
      content_type: "text/html",
      body: "<html><body>Single sign-on</body></html>"
    }
  },
  {
    name: "same-origin login URL",
    expected: false,
    input: {
      requested_url: portalUrl,
      final_url: "https://lms.sc.tsinghua.edu.cn/webapps/login/",
      status: 200,
      content_type: "text/html",
      body: "<html><body>Blackboard</body></html>"
    }
  },
  {
    name: "password form",
    expected: false,
    input: {
      requested_url: portalUrl,
      final_url: portalUrl,
      status: 200,
      content_type: "text/html",
      body: "<form id='login'><input name='user'><input type='password'></form>"
    }
  },
  {
    name: "login prompt without password input",
    expected: false,
    input: {
      requested_url: portalUrl,
      final_url: portalUrl,
      status: 200,
      content_type: "text/html",
      body: "<main><h1>Sign in</h1><p>Select an identity provider or enter your username.</p></main>"
    }
  },
  {
    name: "HTTP failure",
    expected: false,
    input: {
      requested_url: portalUrl,
      final_url: portalUrl,
      status: 401,
      content_type: "text/html",
      body: "Unauthorized"
    }
  },
  {
    name: "non-HTML response",
    expected: false,
    input: {
      requested_url: portalUrl,
      final_url: portalUrl,
      status: 200,
      content_type: "application/json",
      body: "{}"
    }
  }
];

for (const testCase of cases) {
  const result = assess(testCase.input);
  if (result.authenticated !== testCase.expected) {
    throw new Error(testCase.name + ": expected authenticated=" + testCase.expected + ", got " + JSON.stringify(result));
  }
}

const serviceWorkerSource = fs.readFileSync(new URL("../background/service-worker.js", import.meta.url), "utf8");
const sidepanelSource = fs.readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");

const sessionFunctionStart = serviceWorkerSource.indexOf("async function checkBlackboardSession");
const sessionFunctionEnd = serviceWorkerSource.indexOf("async function dismissMediaCandidate", sessionFunctionStart);
const sessionFunctionSource = serviceWorkerSource.slice(sessionFunctionStart, sessionFunctionEnd);
if (!/fetchWithTimeout\([\s\S]*BLACKBOARD_SESSION_TIMEOUT_MS\s*,\s*async\s*\(response\)[\s\S]*await\s+readResponseTextPrefix\(response\)/.test(sessionFunctionSource)) {
  throw new Error("Blackboard session verification must keep its timeout active through the response body.");
}

if (!/case\s+["']CHECK_BLACKBOARD_SESSION["']/.test(serviceWorkerSource)) {
  throw new Error("Service worker does not expose CHECK_BLACKBOARD_SESSION.");
}
const handlerStart = sidepanelSource.indexOf("async function handleResourcePackCommand");
const handlerEnd = sidepanelSource.indexOf("async function installOptionalResourcePack", handlerStart);
const handlerSource = sidepanelSource.slice(handlerStart, handlerEnd);
const sessionCheckIndex = handlerSource.indexOf('sendMessage("CHECK_BLACKBOARD_SESSION")');
const installIndex = handlerSource.indexOf("installOptionalResourcePack(config)");
if (sessionCheckIndex < 0 || installIndex < 0 || sessionCheckIndex > installIndex) {
  throw new Error("Resource-pack installation must verify Blackboard before reading or installing the pack.");
}
if (!/if\s*\(!session\.authenticated\)[\s\S]*return;/.test(handlerSource)) {
  throw new Error("Resource-pack handler does not fail closed when Blackboard is logged out.");
}
const installerStart = serviceWorkerSource.indexOf("async function installResourcePack");
const installerEnd = serviceWorkerSource.indexOf("function normalizeResourcePack", installerStart);
const installerSource = serviceWorkerSource.slice(installerStart, installerEnd);
const installerSessionIndex = installerSource.indexOf("checkBlackboardSession");
const installerWriteIndex = installerSource.indexOf("chrome.storage.local.get");
if (installerSessionIndex < 0 || installerWriteIndex < 0 || installerSessionIndex > installerWriteIndex) {
  throw new Error("Background pack installation must verify Blackboard before reading or writing index state.");
}
if (!/if\s*\(!session\.authenticated\)[\s\S]*return\s+\{\s*ok:\s*false/.test(installerSource)) {
  throw new Error("Background pack installation does not fail closed when Blackboard is logged out.");
}
const crawlStart = serviceWorkerSource.indexOf("async function startCrawlSite");
const crawlEnd = serviceWorkerSource.indexOf("async function crawlSite", crawlStart);
const crawlSource = serviceWorkerSource.slice(crawlStart, crawlEnd);
const crawlSessionIndex = crawlSource.indexOf("checkBlackboardSession");
const crawlLaunchIndex = crawlSource.indexOf("activeCrawlPromise = crawlSite");
if (crawlSessionIndex < 0 || crawlLaunchIndex < 0 || crawlSessionIndex > crawlLaunchIndex) {
  throw new Error("Full Blackboard indexing must verify the session before launching the crawler.");
}

console.log("blackboard-session-check passed (" + cases.length + " cases)");
