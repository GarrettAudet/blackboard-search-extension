import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const serviceWorkerSource = fs.readFileSync(new URL("../background/service-worker.js", import.meta.url), "utf8");
const sidepanelSource = fs.readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Could not extract ${startMarker}`);
  return source.slice(start, end);
}

const fetchHelperSource = sourceBetween(serviceWorkerSource, "async function fetchWithTimeout", "async function fetchCrawlPage");
const fetchContext = { AbortController, setTimeout, clearTimeout, fetch: null };
vm.createContext(fetchContext);
vm.runInContext("const DEFAULT_CRAWL_PAGE_TIMEOUT_MS = 20000;\n" + fetchHelperSource, fetchContext);

let observedSignal = null;
fetchContext.fetch = async (_url, options) => {
  observedSignal = options.signal;
  return { ok: true, status: 200 };
};
const fastResponse = await fetchContext.fetchWithTimeout("https://example.edu/fast", { credentials: "include" }, 100);
assert.equal(fastResponse.status, 200);
assert.ok(observedSignal && !observedSignal.aborted, "Bounded fetch did not receive a live AbortSignal.");

let aborted = false;
fetchContext.fetch = (_url, options) => new Promise((_resolve, reject) => {
  options.signal.addEventListener("abort", () => {
    aborted = true;
    const error = new Error("aborted");
    error.name = "AbortError";
    reject(error);
  }, { once: true });
});
const timeoutStarted = performance.now();
await assert.rejects(
  fetchContext.fetchWithTimeout("https://example.edu/stuck", {}, 25),
  (error) => error && error.code === "request_timeout" && /did not respond/i.test(error.message)
);
assert.ok(aborted, "Timed-out fetch was not aborted.");
assert.ok(performance.now() - timeoutStarted < 500, "Fetch timeout did not settle promptly.");

const crawlSource = sourceBetween(serviceWorkerSource, "async function crawlSite", "async function fetchWithTimeout");
const mutationQueueSource = sourceBetween(serviceWorkerSource, "let indexMutationTail", "function setupMediaRequestObservers");
const progress = [];
const pageTimeouts = [];
let storedResources = 0;
const crawlContext = {
  URL, Date, Set, Math, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
  console: { ...console, warn() {} },
  chrome: { storage: { local: { async get() { return { index_meta: { index_revision: 7 } }; } } } },
  DEFAULT_CRAWL_SEED_URL: "https://example.edu/root",
  normalizeUrlFrom(raw, base) { try { const url = new URL(raw, base); url.hash = ""; return url.href; } catch { return ""; } },
  defaultAllowedPrefix(seed) { return new URL(seed).origin + "/"; },
  clampInteger(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback; },
  emitCrawlProgress(payload) { progress.push(payload); },
  normalizeResource(item) { return { ...item, id: item.id || item.url || item.title || "resource" }; },
  async mergeScrape(payload, token) {
    token.assertActive();
    storedResources += (payload.resources || []).length;
    return { resource_count: storedResources };
  },
  isDefaultPortalUrl() { return false; },
  canQueuePage(url, options) {
    if (!url || options.visited.has(url) || options.queued.has(url)) return false;
    const parsed = new URL(url);
    return parsed.origin === options.seedOrigin && (!options.allowedPrefix || url.startsWith(options.allowedPrefix));
  },
  async sleep() {},
  async fetchCrawlPage(url, timeoutMs) {
    pageTimeouts.push(timeoutMs);
    if (/\/root$/.test(url)) return { final_url: url, resources: [], child_urls: ["/stuck", "/good"] };
    if (/\/stuck$/.test(url)) { const error = new Error("Blackboard did not respond within 5 seconds."); error.code = "request_timeout"; throw error; }
    return { final_url: url, resources: [{ id: "good-resource", title: "Good resource", url }], child_urls: [] };
  }
};
vm.createContext(crawlContext);
vm.runInContext(
  "const META_KEY = 'index_meta'; const DEFAULT_CRAWL_PAGE_TIMEOUT_MS = 20000; const CRAWL_HEARTBEAT_MS = 5000; const CRAWL_CHECKPOINT_TIMEOUT_MS = 25;\n" +
  mutationQueueSource + "\n" + crawlSource,
  crawlContext
);
const crawlResult = await crawlContext.crawlSite({ seed_url: "https://example.edu/root", max_pages: 10, delay_ms: 1, page_timeout_ms: 25 });
assert.equal(crawlResult.pages_crawled, 3);
assert.equal(crawlResult.queued_remaining, 0, "Crawler did not drain the queue after a failed page.");
assert.equal(crawlResult.failures.length, 1);
assert.equal(crawlResult.resource_count, 1);
assert.ok(pageTimeouts.every((value) => value === 5000), "Crawl page timeout was not clamped and forwarded.");
assert.ok(progress.some((item) => item.status === "page_failed" && item.failed_pages === 1));
assert.equal(progress.at(-1)?.status, "complete");
assert.ok(progress.some((item) => item.status === "checkpointing" || item.status === "finalizing"));
assert.ok(vm.runInContext("indexMutationSequence", crawlContext) > 0, "Crawler used the non-queued fallback checkpoint branch.");

const checkpointProgressStart = progress.length;
let releaseLateCheckpoint;
let lateCommits = 0;
const lateCheckpointGate = new Promise((resolve) => { releaseLateCheckpoint = resolve; });
crawlContext.mergeScrape = async (_payload, token) => {
  await lateCheckpointGate;
  token.assertActive();
  lateCommits += 1;
  return { resource_count: storedResources + 1 };
};
const checkpointStarted = performance.now();
const checkpointFailure = await crawlContext.crawlSite({ seed_url: "https://example.edu/root", max_pages: 10, delay_ms: 1 });
assert.equal(checkpointFailure.ok, false);
assert.match(checkpointFailure.error, /checkpoint did not finish/i);
assert.ok(performance.now() - checkpointStarted < 500, "Checkpoint timeout did not settle promptly.");
const postTimeoutMutation = await crawlContext.runIndexMutation("after_late_timeout", () => ({ ok: true }));
assert.equal(postTimeoutMutation.ok, true, "Revoked checkpoint did not release the mutation queue.");
releaseLateCheckpoint();
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
assert.equal(lateCommits, 0, "A checkpoint committed after its timeout response had already returned.");
const checkpointProgress = progress.slice(checkpointProgressStart);
assert.ok(checkpointProgress.some((item) => item.status === "checkpoint_error"));
assert.ok(!checkpointProgress.some((item) => item.status === "complete"), "Failed checkpoint incorrectly reported crawl completion.");

crawlContext.mergeScrape = async () => new Promise(() => {});
const hungCheckpointStarted = performance.now();
const hungCheckpointFailure = await crawlContext.crawlSite({ seed_url: "https://example.edu/root", max_pages: 10, delay_ms: 1 });
assert.equal(hungCheckpointFailure.ok, false);
assert.match(hungCheckpointFailure.error, /checkpoint did not finish/i);
assert.ok(performance.now() - hungCheckpointStarted < 500, "Permanently hung pre-commit checkpoint did not revoke promptly.");
const afterPermanentPrecommitHang = await crawlContext.runIndexMutation("after_permanent_precommit_hang", () => ({ ok: true }));
assert.equal(afterPermanentPrecommitHang.ok, true, "Permanently hung pre-commit work blocked all later mutations.");

let signalCommitStarted;
const commitStarted = new Promise((resolve) => { signalCommitStarted = resolve; });
crawlContext.__neverSettlingCommit = new Promise(() => {});
crawlContext.__signalCommitStarted = signalCommitStarted;
const inFlightCommit = vm.runInContext(`
  runIndexMutation("fixture_inflight_storage_commit", (token) => {
    token.beginCommit();
    globalThis.__signalCommitStarted();
    return globalThis.__neverSettlingCommit;
  }, { timeoutMs: 25 })
`, crawlContext);
await commitStarted;
const queuedBehindCommit = crawlContext.runIndexMutation("queued_behind_inflight_commit", () => ({ ok: true }));
const [commitState, followerState] = await Promise.all([
  Promise.race([
    inFlightCommit.then(() => "resolved", () => "rejected"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 75))
  ]),
  Promise.race([
    queuedBehindCommit.then(() => "resolved", () => "rejected"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 75))
  ])
]);
assert.equal(commitState, "pending", "An in-flight storage commit falsely reported rollback/retention after its commit boundary.");
assert.equal(followerState, "pending", "A later mutation was silently accepted behind an indeterminate storage commit.");
assert.match(sidepanelSource, /CRAWL_STALL_WATCHDOG_MS\s*=\s*35000/);
assert.match(sidepanelSource, /Indexing stopped responding/);
assert.match(sidepanelSource, /waiting \${payload\.waiting_seconds}s for Blackboard/);

console.log("crawl-resilience-check passed (bounded fetch, real queued checkpoints, revocable pre-commit timeout, late-commit prevention, queue recovery, indeterminate commit lock, watchdog)");
