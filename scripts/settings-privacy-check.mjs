import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Exercise production settings functions with synthetic keys and in-memory storage.
// No browser, resource pack, course content, environment secrets, or live fetch.
const source = fs.readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../sidepanel/sidepanel.html", import.meta.url), "utf8");
const client = fs.readFileSync(new URL("../lib/llm-client.js", import.meta.url), "utf8");
function between(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, "Production settings function boundaries changed.");
  return source.slice(a, b);
}
let stored = {};
let failWrite = false;
let writeGate = null;
let indexGate = null;
let writeCalls = 0;
const requests = [];
const element = () => ({ value: "", placeholder: "", textContent: "", disabled: false });
const els = Object.fromEntries(["providerSelect", "modelInput", "apiKeyInput", "setupState", "removeApiKeyBtn", "saveSettingsBtn"].map((key) => [key, element()]));
const state = { settings: {}, meta: {} };
const context = {
  state, els, console, AbortController, setTimeout, clearTimeout,
  chrome: { storage: { local: {
    async get() { return structuredClone(stored); },
    async set(value) {
      writeCalls += 1;
      if (writeGate) await writeGate.promise;
      if (failWrite) throw new Error("Synthetic storage failure");
      Object.assign(stored, structuredClone(value));
    }
  } } },
  setStatus() {},
  async sendMessage() { return indexGate ? await indexGate.promise : { ok: true }; },
  isLaunchSearchResource() { return true; },
  sanitizeLoadedContentStore(value) { return value; },
  invalidateSearchIndexCache() {},
  legacyTruncationRiskIds() { return new Set(); },
  render() { context.renderSettings(); },
  async hydrateMissingSearchableContent() {},
  fetch: async (url, options) => {
    requests.push({ url, authorization: options.headers.Authorization });
    return { ok: true, status: 200, async text() {
      return JSON.stringify({ choices: [{ message: { content: "Synthetic answer" }, finish_reason: "stop" }] });
    } };
  }
};
vm.createContext(context);
vm.runInContext('const SETTINGS_KEY = "synthetic_settings";\n' +
  between("let settingsRevision = 0;", "async function scanActiveTab()") +
  between("function renderSettings()", "function renderTranscripts()") + client, context);

function reset(provider = "openai") {
  state.settings = { provider, model: "synthetic-model", apiKey: "fake-original-key", hasApiKey: true };
  stored = { synthetic_settings: { provider, model: "synthetic-model", apiKey: "fake-original-key" } };
  els.apiKeyInput.value = "";
  context.renderSettings();
  failWrite = false;
}
reset();
await context.saveSettings();
assert.equal(state.settings.apiKey, "fake-original-key", "Same-provider blank saves must retain the saved key.");
assert.equal((await context.loadSettings()).apiKey, "fake-original-key");

for (const from of ["openai", "openrouter", "deepseek"]) {
  for (const to of ["openai", "openrouter", "deepseek"].filter((value) => value !== from)) {
    reset(from);
    els.providerSelect.value = to;
    // Also test the save boundary directly, independent of the UI change event.
    await context.saveSettings();
    assert.equal(state.settings.apiKey, "", from + " key crossed into " + to);
    assert.equal(state.settings.hasApiKey, false);
    assert.equal((await context.loadSettings()).hasApiKey, false);
    assert.equal(stored.synthetic_settings.provider, to);
  }
}

reset();
els.apiKeyInput.value = "fake-unsaved-old-provider-key";
els.providerSelect.value = "deepseek";
context.handleProviderChange();
assert.equal(els.apiKeyInput.value, "", "Provider changes must discard unsaved old-provider keys.");
assert.match(els.apiKeyInput.placeholder, /Enter a key/);
els.providerSelect.value = "openai";
context.handleProviderChange();
assert.match(els.apiKeyInput.placeholder, /Saved/);
await context.saveSettings();
assert.equal(state.settings.apiKey, "fake-original-key", "Switching back before saving must preserve the original provider's key.");

reset();
els.providerSelect.value = "deepseek";
context.handleProviderChange();
els.apiKeyInput.value = "  fake-new-provider-key  ";
await context.saveSettings();
assert.equal(state.settings.apiKey, "fake-new-provider-key");
assert.equal(els.apiKeyInput.value, "");
await context.callChatCompletion({ ...state.settings, messages: [{ role: "user", content: "Synthetic question" }] });
assert.equal(requests.length, 1);
assert.equal(requests[0].url, "https://api.deepseek.com/v1/chat/completions");
assert.equal(requests[0].authorization, "Bearer fake-new-provider-key");
assert.ok(!JSON.stringify(requests).includes("fake-original-key"));

els.apiKeyInput.value = "fake-pending-key";
await context.removeApiKey();
assert.equal(state.settings.apiKey, "");
assert.equal(state.settings.hasApiKey, false);
assert.equal(els.apiKeyInput.value, "");
assert.equal(els.removeApiKeyBtn.disabled, true);
assert.equal((await context.loadSettings()).apiKey, "");
await context.saveSettings();
assert.equal(state.settings.apiKey, "", "Saving after removal must not restore the old key.");
await context.removeApiKey();
assert.equal((await context.loadSettings()).hasApiKey, false, "Removal must be repeatable.");

reset();
failWrite = true;
await assert.rejects(context.removeApiKey(), /Synthetic storage failure/);
assert.equal(state.settings.apiKey, "fake-original-key", "Failed removal must not claim the saved key is gone.");
els.providerSelect.value = "deepseek";
await assert.rejects(context.saveSettings(), /Synthetic storage failure/);
assert.equal(state.settings.provider, "openai", "Failed saves must retain the previous provider/key association.");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// A slow removal must block repeated removes and blank saves that could restore the key.
reset();
writeGate = deferred();
const beforeRemoval = writeCalls;
const removing = context.removeApiKey();
assert.equal(els.saveSettingsBtn.disabled, true);
assert.equal(els.removeApiKeyBtn.disabled, true);
assert.equal(els.providerSelect.disabled, true);
assert.equal(els.apiKeyInput.disabled, true);
await context.saveSettings();
await context.removeApiKey();
assert.equal(writeCalls, beforeRemoval + 1);
writeGate.resolve();
await removing;
writeGate = null;
assert.equal(stored.synthetic_settings.apiKey, "");
assert.equal(state.settings.apiKey, "");
assert.equal(els.saveSettingsBtn.disabled, false);
assert.equal(els.providerSelect.disabled, false);

// A pending save also excludes concurrent writes and provider-change handling.
reset();
writeGate = deferred();
const beforeSave = writeCalls;
els.apiKeyInput.value = "fake-replacement-key";
const saving = context.saveSettings();
await context.saveSettings();
await context.removeApiKey();
els.providerSelect.value = "deepseek"; // programmatic event while UI is disabled
context.handleProviderChange();
assert.equal(els.apiKeyInput.value, "");
assert.equal(els.providerSelect.value, "openai");
assert.equal(writeCalls, beforeSave + 1);
writeGate.resolve();
await saving;
writeGate = null;
assert.equal(state.settings.provider, "openai");
assert.equal(state.settings.apiKey, "fake-replacement-key");
assert.equal(els.providerSelect.value, "openai");
assert.equal(els.apiKeyInput.value, "");

// Failure releases the lock and permits an explicit retry.
reset();
writeGate = deferred();
const failingRemoval = context.removeApiKey();
writeGate.reject(new Error("Deferred storage failure"));
await assert.rejects(failingRemoval, /Deferred storage failure/);
writeGate = null;
assert.equal(els.saveSettingsBtn.disabled, false);
assert.equal(els.removeApiKeyBtn.disabled, false);
await context.removeApiKey();
assert.equal(state.settings.hasApiKey, false);

// A refresh that captured the old key must not resurrect it after removal.
reset();
indexGate = deferred();
const staleRefresh = context.refreshAll();
await Promise.resolve();
await context.removeApiKey();
indexGate.resolve({ ok: true });
await staleRefresh;
indexGate = null;
assert.equal(state.settings.apiKey, "");
assert.equal(state.settings.hasApiKey, false);

// Refresh begun during a write is stale too, even if it finishes after the write.
reset();
writeGate = deferred();
const pendingRemoval = context.removeApiKey();
indexGate = deferred();
const duringWriteRefresh = context.refreshAll();
await Promise.resolve();
writeGate.resolve();
await pendingRemoval;
writeGate = null;
indexGate.resolve({ ok: true });
await duringWriteRefresh;
indexGate = null;
assert.equal(state.settings.apiKey, "");

// Background render must discard a draft key when resetting its provider.
reset();
els.providerSelect.value = "deepseek";
context.handleProviderChange();
els.apiKeyInput.value = "fake-unsaved-deepseek-key";
await context.refreshAll();
assert.equal(els.providerSelect.value, "openai");
assert.equal(els.apiKeyInput.value, "");
await context.saveSettings();
assert.equal(state.settings.apiKey, "fake-original-key");

assert.match(html, /id="removeApiKeyBtn"[^>]*type="button"/);
assert.ok(source.includes('els.providerSelect.addEventListener("change", handleProviderChange)'));
assert.ok(source.includes('els.removeApiKeyBtn.addEventListener("click", () => removeApiKey().catch(reportError))'));
console.log("settings-privacy-check passed (same-provider retention, six provider switches, unsaved-key clearing, switch-back, mocked provider authentication, removal/reload/repeat, storage failure, mutation exclusion/retry, stale refreshes, draft-provider reset, UI wiring)");
