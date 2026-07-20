import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const workerSource = fs.readFileSync(new URL("../background/service-worker.js", import.meta.url), "utf8");
const sessionSource = fs.readFileSync(new URL("../lib/blackboard-session.js", import.meta.url), "utf8");

function storageFixture(initial = {}) {
  const data = clone(initial);
  const fixture = {
    data,
    failNextSet: false,
    api: {
      async get(keys) {
        await Promise.resolve();
        if (typeof keys === "string") return { [keys]: clone(data[keys]) };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, clone(data[key])]));
        return clone(data);
      },
      async set(values) {
        await Promise.resolve();
        if (fixture.failNextSet) {
          fixture.failNextSet = false;
          throw new Error("synthetic storage failure");
        }
        Object.assign(data, clone(values));
      }
    }
  };
  return fixture;
}

const storage = storageFixture({
  resource_index: [], transcript_store: [], content_store: {}, resource_pack_store: [],
  detected_media_store: [], ignored_media_store: [], index_meta: {},
  assistant_settings: { provider: "test", apiKey: "preserve-me" }
});
let authenticated = true;
let accessDenied = false;
let listener = null;
const context = {
  console: { ...console, warn() {} },
  URL, URLSearchParams, Date, Set, Map, Promise, AbortController,
  TextEncoder, Uint8Array, crypto: crypto.webcrypto,
  setTimeout, clearTimeout, setInterval, clearInterval, structuredClone,
  importScripts() {},
  fetch: async (url) => ({
    ok: true,
    status: 200,
    url: String(url),
    headers: { get(name) { return /^content-type$/i.test(name) ? "text/html" : ""; } },
    async text() {
      if (accessDenied) return "<html><head><title>Access Denied</title></head><body><main>You are not authorized to access this Blackboard course.</main></body></html>";
      return authenticated ? "<main>Authenticated Blackboard course portal</main>" : "<form action='/login'><input name='username'><input type='password'><button>Sign in</button></form>";
    }
  }),
  chrome: {
    runtime: {
      lastError: null,
      onMessage: { addListener(fn) { listener = fn; } },
      sendMessage(_message, callback) { if (callback) callback(); }
    },
    storage: { local: storage.api }
  }
};
vm.createContext(context);
vm.runInContext(sessionSource, context);
vm.runInContext(workerSource, context);
assert.equal(typeof listener, "function");
authenticated = false;
await assert.rejects(
  vm.runInContext("fetchCrawlPage('https://lms.sc.tsinghua.edu.cn/course/login-probe', 5000)", context),
  (error) => error?.code === "authentication_lost",
  "A 200-status Blackboard login form was accepted as crawl content."
);
authenticated = true;
accessDenied = true;
await assert.rejects(
  vm.runInContext("fetchCrawlPage('https://lms.sc.tsinghua.edu.cn/course/access-denied-probe', 5000)", context),
  (error) => error?.code === "access_denied",
  "A 200-status Blackboard Access Denied page was accepted as crawl content."
);
const deniedSession = clone(await vm.runInContext("checkBlackboardSession({ seed_url: 'https://lms.sc.tsinghua.edu.cn/course/access-denied-probe' })", context));
assert.equal(deniedSession.ok, true);
assert.equal(deniedSession.authenticated, false);
assert.equal(deniedSession.reason, "access_denied");
accessDenied = false;

async function invoke(type, payload = {}) {
  const preparedPayload = clone(payload);
  if (type === "UPSERT_LOCAL_RESOURCES") {
    for (const entry of preparedPayload.resources || []) {
      if (entry.expected_index_revision === undefined) entry.expected_index_revision = Number(storage.data.index_meta?.index_revision || 0);
      if ((entry.operation || "add") === "replace" && !entry.expected_previous_extracted_text_sha256) {
        const target = (storage.data.resource_index || []).find((resource) => resource.id === entry.replace_resource_id);
        if (target?.extracted_text_sha256) entry.expected_previous_extracted_text_sha256 = target.extracted_text_sha256;
      }
    }
  }
  if (type === "REMOVE_LOCAL_RESOURCE") {
    if (preparedPayload.expected_index_revision === undefined) preparedPayload.expected_index_revision = Number(storage.data.index_meta?.index_revision || 0);
    const target = (storage.data.resource_index || []).find((resource) => resource.id === preparedPayload.resource_id);
    if (!preparedPayload.expected_previous_extracted_text_sha256 && target?.extracted_text_sha256) {
      preparedPayload.expected_previous_extracted_text_sha256 = target.extracted_text_sha256;
    }
  }
  if (type === "STORE_CONTENT" && preparedPayload.expected_hydration_token === undefined) {
    const target = (storage.data.resource_index || []).find((resource) => resource.id === preparedPayload.resource_id);
    if (target?.hydration_token) preparedPayload.expected_hydration_token = target.hydration_token;
  }
  if (type === "STORE_CONTENT" && !preparedPayload.content_fingerprint) {
    preparedPayload.content_fingerprint = crypto.createHash("sha256").update(`fixture:${preparedPayload.resource_id}:${preparedPayload.content || ""}`).digest("hex");
  }
  if (type === "STORE_CONTENT_BATCH") {
    for (const entry of preparedPayload.entries || []) {
      const target = (storage.data.resource_index || []).find((resource) => resource.id === entry.resource_id);
      if (entry.expected_hydration_token === undefined && target?.hydration_token) entry.expected_hydration_token = target.hydration_token;
      if (!entry.content_fingerprint) {
        entry.content_fingerprint = crypto.createHash("sha256").update(`fixture:${entry.resource_id}:${entry.content || ""}`).digest("hex");
      }
    }
  }
  context.__message = clone({ type, payload: preparedPayload });
  return clone(await vm.runInContext("handleMessage(globalThis.__message)", context));
}

async function invokeUnprepared(type, payload = {}) {
  context.__message = clone({ type, payload });
  return clone(await vm.runInContext("handleMessage(globalThis.__message)", context));
}

async function snapshot() {
  return invoke("GET_INDEX");
}

async function injectFixtureResource(resourceValue, content = "") {
  context.__injectResource = clone(resourceValue);
  context.__injectContent = content;
  await vm.runInContext(`(async () => {
    const stored = await chrome.storage.local.get([RESOURCE_KEY, TRANSCRIPT_KEY, CONTENT_KEY]);
    const resources = (stored[RESOURCE_KEY] || []).filter((item) => item.id !== globalThis.__injectResource.id);
    resources.push(globalThis.__injectResource);
    const bodies = { ...(stored[CONTENT_KEY] || {}) };
    if (globalThis.__injectContent) bodies[globalThis.__injectResource.id] = globalThis.__injectContent;
    else delete bodies[globalThis.__injectResource.id];
    await saveIndex(resources, stored[TRANSCRIPT_KEY] || [], bodies);
  })()`, context);
}

function corpusDigest(value) {
  const resources = [...(value.resources || [])]
    .map(({ first_seen_at, last_seen_at, discovered_at, hydration_token, ...resource }) => resource)
    .sort((a, b) => a.id.localeCompare(b.id));
  const content = Object.fromEntries(Object.entries(value.content_store || {}).sort(([a], [b]) => a.localeCompare(b)));
  const packs = (value.resource_packs || []).map(({ installed_at, updated_at, ...pack }) => pack);
  const transcripts = [...(value.transcripts || [])]
    .map(({ imported_at, updated_at, ...transcript }) => ({
      ...transcript,
      matched_resource_ids: [...(transcript.matched_resource_ids || [])].sort()
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const meta = Object.fromEntries(Object.entries(value.meta || {})
    .filter(([key]) => !["last_updated", "index_revision", "index_generation"].includes(key))
    .sort(([left], [right]) => left.localeCompare(right)));
  return crypto.createHash("sha256").update(JSON.stringify({ resources, content, packs, transcripts, meta })).digest("hex");
}

function derivedPackId(packId, raw, index = 0) {
  context.__packIdArgs = clone([packId, raw, index]);
  return vm.runInContext("derivedResourcePackItemId(...globalThis.__packIdArgs)", context);
}

function resource(id, type, title, contextText = "") {
  return {
    id, type, title,
    url: `https://lms.sc.tsinghua.edu.cn/content/${id}${type === "pdf" ? ".pdf" : ""}`,
    page_url: "https://lms.sc.tsinghua.edu.cn/course/root",
    page_title: "Lifecycle course", section: "Resources", context: contextText
  };
}

function localEntry({ clientId, fileHash, name, content, operation = "add", collisionAction = "add", replaceId = "", expectedHash = "" }) {
  return {
    client_id: clientId,
    operation,
    collision_action: collisionAction,
    replace_resource_id: replaceId,
    expected_previous_hash_sha256: expectedHash,
    collection_kind: "user_import",
    file_name: name,
    title: name,
    kind: "document",
    content_type: "text/plain",
    content_hash_sha256: fileHash,
    byte_size: 128,
    extracted_chars: content.length,
    body_verified: true,
    indexed_body_source: "extracted",
    content_origin: "user_import",
    content
  };
}

const officialBody = "Official lifecycle policy requires the cobalt arrival form before orientation. ".repeat(20);
await Promise.all([
  invoke("SCRAPE_PAGE", { resources: [resource("official-a", "page", "Official A", officialBody)] }),
  invoke("SCRAPE_PAGE", { resources: [resource("official-b", "page", "Official B", "Official B contains the amber registration deadline. ".repeat(20))] })
]);
let current = await snapshot();
assert.deepEqual(new Set(current.resources.map((item) => item.id)), new Set(["official-a", "official-b"]), "Concurrent serialized merges lost a resource.");
const firstCorpusDigest = corpusDigest(current);
const beforeStorageFailure = await snapshot();
storage.failNextSet = true;
await assert.rejects(
  invoke("SCRAPE_PAGE", { resources: [resource("official-a", "page", "Official A", officialBody)] }),
  /synthetic storage failure/,
  "Synthetic storage failure did not escape the mutation."
);
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeStorageFailure), "Failed storage commit changed the logical corpus.");
const recoveredMutation = await invoke("SCRAPE_PAGE", { resources: [resource("official-a", "page", "Official A", officialBody)] });
assert.equal(recoveredMutation.ok, true, "Mutation queue did not recover after a storage failure.");

for (let repeat = 0; repeat < 5; repeat += 1) {
  await invoke("SCRAPE_PAGE", { resources: [resource("official-a", "page", "Official A", officialBody)] });
}
current = await snapshot();
assert.equal(current.resources.length, 2, "Repeated indexing grew duplicate resources.");
assert.equal(corpusDigest(current), firstCorpusDigest, "Repeated indexing changed the logical corpus.");
const beforePageOverwrite = await snapshot();
const pageOverwriteBody = "A content-hydration route must not overwrite a managed page body outside page indexing.";
const pageOverwrite = await invokeUnprepared("STORE_CONTENT", {
  resource_id: "official-a", content: pageOverwriteBody,
  content_fingerprint: crypto.createHash("sha256").update("page overwrite bytes").digest("hex"),
  extracted_text_sha256: crypto.createHash("sha256").update(pageOverwriteBody).digest("hex"),
  expected_hydration_token: "fake-page-token"
});
assert.equal(pageOverwrite.error, "invalid_content_target");
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforePageOverwrite), "Hydration route overwrote a page resource.");

const renamedUrl = "https://lms.sc.tsinghua.edu.cn/content/rename-stable";
context.__legacyIdentityParts = ["resource", "page", renamedUrl, "Obsolete title"];
const legacyTitleId = vm.runInContext("stableId(globalThis.__legacyIdentityParts)", context);
await invoke("SCRAPE_PAGE", { resources: [{
  id: legacyTitleId, type: "page", title: "Obsolete title", url: renamedUrl,
  page_url: renamedUrl, page_title: "Obsolete title", section: "Policies",
  context: "Obsolete ochre rename body that must not remain after the same canonical URL is refreshed. ".repeat(12)
}] });
await invoke("SCRAPE_PAGE", { resources: [{
  type: "page", title: "Renamed stable title", url: renamedUrl,
  page_url: renamedUrl, page_title: "Renamed stable title", section: "Policies",
  context: "Revised sapphire rename body is the only current text for this canonical URL. ".repeat(12)
}] });
current = await snapshot();
const renamedResources = current.resources.filter((item) => item.url === renamedUrl);
assert.equal(renamedResources.length, 1, "A title change at one canonical URL grew a duplicate resource.");
assert.equal(renamedResources[0].title, "Renamed stable title");
assert.notEqual(renamedResources[0].id, legacyTitleId, "Legacy title-derived identity was not migrated.");
assert.equal(Object.hasOwn(current.content_store, legacyTitleId), false, "Legacy title-derived body became orphaned.");
assert.match(current.content_store[renamedResources[0].id], /Revised sapphire rename body/);
assert.doesNotMatch(current.content_store[renamedResources[0].id], /Obsolete ochre rename body/);

await invoke("SCRAPE_PAGE", { resources: [resource("attachment-a", "pdf", "Concise verified attachment")] });
current = await snapshot();
const newAttachmentToken = current.resources.find((item) => item.id === "attachment-a").hydration_token;
assert.match(newAttachmentToken, /^hydrate_/, "New file-like resource did not enter pending hydration state.");
const firstAttachmentFingerprint = crypto.createHash("sha256").update("first attachment identity").digest("hex");
await invoke("SCRAPE_PAGE", { resources: [{
  ...resource("attachment-a", "pdf", "Concise verified attachment"), content_fingerprint: firstAttachmentFingerprint
}] });
current = await snapshot();
const rotatedAttachmentToken = current.resources.find((item) => item.id === "attachment-a").hydration_token;
assert.match(rotatedAttachmentToken, /^hydrate_/);
assert.notEqual(rotatedAttachmentToken, newAttachmentToken, "Pending hydration token did not rotate when attachment fingerprint state changed.");
const beforeStaleFirstExtraction = await snapshot();
const staleFirstExtraction = await invoke("STORE_CONTENT", {
  resource_id: "attachment-a",
  content: "A slow first extraction must not commit after the attachment fingerprint changed.",
  content_fingerprint: crypto.createHash("sha256").update("stale first attachment bytes").digest("hex"),
  expected_hydration_token: newAttachmentToken
});
assert.equal(staleFirstExtraction.ok, false);
assert.equal(staleFirstExtraction.error, "stale_hydration_token");
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeStaleFirstExtraction), "Stale first extraction changed the corpus.");
const conciseBody = "Concise extracted attachment: bring the cobalt form, passport copy, and signed arrival confirmation.";
const conciseFingerprint = crypto.createHash("sha256").update("concise attachment bytes").digest("hex");
const conciseTextHash = crypto.createHash("sha256").update(conciseBody).digest("hex");
const beforeMissingHydrationToken = await snapshot();
const missingHydrationToken = await invokeUnprepared("STORE_CONTENT", {
  resource_id: "attachment-a", content: conciseBody,
  content_fingerprint: conciseFingerprint, extracted_text_sha256: conciseTextHash
});
assert.equal(missingHydrationToken.ok, false);
assert.equal(missingHydrationToken.error, "hydration_token_required");
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeMissingHydrationToken), "Missing hydration token changed the corpus.");
const beforeHydrationStorageFailure = await snapshot();
storage.failNextSet = true;
await assert.rejects(
  invoke("STORE_CONTENT", { resource_id: "attachment-a", content: conciseBody, content_fingerprint: conciseFingerprint }),
  /synthetic storage failure/
);
const afterHydrationStorageFailure = await snapshot();
assert.equal(corpusDigest(afterHydrationStorageFailure), corpusDigest(beforeHydrationStorageFailure), "Failed content storage changed the active corpus.");
assert.equal(afterHydrationStorageFailure.meta.index_revision, beforeHydrationStorageFailure.meta.index_revision, "Failed content storage advanced the revision.");
const stored = await invoke("STORE_CONTENT", { resource_id: "attachment-a", content: conciseBody });
assert.equal(stored.ok, true);
assert.equal(stored.status, "stored");
assert.equal(stored.resource_id, "attachment-a");
assert.equal(stored.content_length, conciseBody.length);
assert.equal(stored.extracted_text_sha256, conciseTextHash);
assert.match(stored.expected_hydration_token, /^hydrate_/);
assert.equal(stored.consumed_hydration_token, stored.expected_hydration_token);
current = await snapshot();
const attachment = current.resources.find((item) => item.id === "attachment-a");
assert.equal(attachment.body_verified, true);
assert.equal(attachment.indexed_body_source, "extracted");
assert.equal(attachment.content_origin, "extracted_attachment");
assert.equal(current.content_store["attachment-a"], conciseBody);

await invoke("SCRAPE_PAGE", { resources: [
  resource("attachment-b", "pdf", "Batch attachment B"),
  resource("attachment-c", "document", "Batch attachment C")
] });
const batchBodyB = "Verified batch-extracted body B contains the cerulean enrollment evidence and supporting details.";
const batchBodyC = "Verified batch-extracted body C contains the magenta housing evidence and supporting details.";
const batchStored = await invoke("STORE_CONTENT_BATCH", { entries: [
  { resource_id: "attachment-b", content: batchBodyB },
  { resource_id: "attachment-c", content: batchBodyC }
] });
assert.equal(batchStored.ok, true);
current = await snapshot();
for (const id of ["attachment-b", "attachment-c"]) {
  const item = current.resources.find((resourceItem) => resourceItem.id === id);
  assert.equal(item.body_verified, true);
  assert.equal(item.indexed_body_source, "extracted");
  assert.equal(item.content_origin, "extracted_attachment");
}
const beforeInvalidBatch = await snapshot();
const invalidBatch = await invoke("STORE_CONTENT_BATCH", { entries: [
  { resource_id: "attachment-b", content: "This changed body must never partially commit after validation failure." },
  { resource_id: "missing-attachment", content: "A missing target makes the entire extracted-content batch invalid." }
] });
assert.equal(invalidBatch.ok, false);
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeInvalidBatch), "Invalid extracted-content batch partially mutated the corpus.");

const attachmentFingerprintV1 = crypto.createHash("sha256").update("attachment b bytes v1").digest("hex");
const attachmentFingerprintV2 = crypto.createHash("sha256").update("attachment b bytes v2").digest("hex");
await invoke("SCRAPE_PAGE", { resources: [{
  ...resource("attachment-b", "pdf", "Batch attachment B"), content_fingerprint: attachmentFingerprintV1
}] });
assert.equal((await invoke("STORE_CONTENT", {
  resource_id: "attachment-b", content: batchBodyB, content_fingerprint: attachmentFingerprintV1
})).ok, true);
await invoke("SCRAPE_PAGE", { resources: [{
  ...resource("attachment-b", "pdf", "Batch attachment B"), content_fingerprint: attachmentFingerprintV1
}] });
current = await snapshot();
assert.equal(current.content_store["attachment-b"], batchBodyB, "Unchanged attachment fingerprint discarded a verified body.");
assert.equal(current.resources.find((item) => item.id === "attachment-b").body_verified, true);
const attachmentFingerprintC1 = crypto.createHash("sha256").update("attachment c bytes v1").digest("hex");
await invoke("SCRAPE_PAGE", { resources: [{
  ...resource("attachment-c", "document", "Batch attachment C"), content_fingerprint: attachmentFingerprintC1
}] });
assert.equal((await invoke("STORE_CONTENT", {
  resource_id: "attachment-c", content: batchBodyC, content_fingerprint: attachmentFingerprintC1
})).ok, true);
await invoke("SCRAPE_PAGE", { resources: [resource("attachment-c", "document", "Batch attachment C")] });
current = await snapshot();
const unknownFingerprintAttachment = current.resources.find((item) => item.id === "attachment-c");
assert.equal(current.content_store["attachment-c"], batchBodyC, "Unknown incoming fingerprint discarded the last-known readable body.");
assert.equal(unknownFingerprintAttachment.body_verified, false);
assert.equal(unknownFingerprintAttachment.indexed_body_source, "last_known_extracted");
assert.equal(unknownFingerprintAttachment.needs_body_hydration, true);
assert.equal(unknownFingerprintAttachment.body_revalidation_required, true);
assert.match(unknownFingerprintAttachment.hydration_token, /^hydrate_/);
await invoke("SCRAPE_PAGE", { resources: [{
  ...resource("attachment-b", "pdf", "Batch attachment B"), content_fingerprint: attachmentFingerprintV2
}] });
current = await snapshot();
const changedAttachment = current.resources.find((item) => item.id === "attachment-b");
assert.equal(Object.hasOwn(current.content_store, "attachment-b"), false, "Changed attachment fingerprint retained stale extracted text.");
assert.equal(changedAttachment.body_verified, false);
assert.equal(changedAttachment.needs_body_hydration, true);
assert.equal(changedAttachment.body_revalidation_required, true);
assert.equal(changedAttachment.indexed_body_source, "pending_extraction");
assert.match(changedAttachment.hydration_token, /^hydrate_/);
await invoke("SCRAPE_PAGE", { resources: [{
  ...resource("attachment-b", "pdf", "Batch attachment B"), content_fingerprint: attachmentFingerprintV2
}] });
current = await snapshot();
const missingBodySameFingerprint = current.resources.find((item) => item.id === "attachment-b");
assert.equal(Object.hasOwn(current.content_store, "attachment-b"), false);
assert.equal(missingBodySameFingerprint.body_verified, false, "Equal fingerprint without a stored body was marked verified.");
assert.equal(missingBodySameFingerprint.indexed_body_source, "pending_extraction");
assert.equal(missingBodySameFingerprint.needs_body_hydration, true);
assert.match(missingBodySameFingerprint.hydration_token, /^hydrate_/);

const localBodyV1 = "User imported local handbook says the violet desk accepts requests every Thursday morning.";
const localHashV1 = crypto.createHash("sha256").update("synthetic raw file bytes v1").digest("hex");
const localIdV1 = `user_import:${localHashV1}`;
const localPayloadV1 = localEntry({ clientId: "local-1", fileHash: localHashV1, name: "Local Handbook.txt", content: localBodyV1 });
const beforeLocalStorageFailure = await snapshot();
storage.failNextSet = true;
await assert.rejects(
  invoke("UPSERT_LOCAL_RESOURCES", { collection_kind: "user_import", resources: [localPayloadV1] }),
  /synthetic storage failure/
);
const afterLocalStorageFailure = await snapshot();
assert.equal(corpusDigest(afterLocalStorageFailure), corpusDigest(beforeLocalStorageFailure), "Failed local upsert changed the active corpus.");
assert.equal(afterLocalStorageFailure.meta.index_revision, beforeLocalStorageFailure.meta.index_revision, "Failed local upsert advanced the revision.");
let localResult = await invoke("UPSERT_LOCAL_RESOURCES", { collection_kind: "user_import", resources: [localPayloadV1] });
assert.equal(localResult.ok, true);
assert.equal(localResult.added, 1);
assert.equal(localResult.results[0].client_id, "local-1");
assert.equal(localResult.results[0].resource_id, localIdV1);
assert.equal(localResult.results[0].operation, "add");
assert.equal(localResult.results[0].status, "added");
assert.equal(localResult.results[0].content_hash_sha256, localHashV1);
assert.equal(localResult.results[0].extracted_text_sha256, crypto.createHash("sha256").update(localBodyV1).digest("hex"));
assert.equal(localResult.results[0].previous_resource_id, "");
assert.equal(localResult.committed_index_revision, localResult.expected_index_revision + 1);
assert.equal(localResult.results[0].committed_index_revision, localResult.committed_index_revision);
const afterFirstLocal = await snapshot();
const localOverwrite = await invokeUnprepared("STORE_CONTENT", { resource_id: localIdV1, content: "This hydration route must not overwrite a local file body.", content_fingerprint: "a".repeat(64), extracted_text_sha256: crypto.createHash("sha256").update("This hydration route must not overwrite a local file body.").digest("hex"), expected_hydration_token: "fake-token" });
assert.equal(localOverwrite.error, "invalid_content_target");
assert.equal(corpusDigest(await snapshot()), corpusDigest(afterFirstLocal), "Hydration route overwrote a user import.");
localResult = await invoke("UPSERT_LOCAL_RESOURCES", { collection_kind: "user_import", resources: [localPayloadV1] });
assert.equal(localResult.ok, true);
assert.equal(localResult.unchanged, 1, "Exact-hash duplicate was not a no-op.");
assert.equal(corpusDigest(await snapshot()), corpusDigest(afterFirstLocal), "Repeated exact import changed the logical corpus.");
const conflictingExtraction = localEntry({
  clientId: "local-conflict",
  fileHash: localHashV1,
  name: "Local Handbook.txt",
  content: "A different extracted body for the exact same raw-byte hash must require an explicit replacement."
});
const beforeExtractionConflict = await snapshot();
const extractionConflict = await invoke("UPSERT_LOCAL_RESOURCES", { collection_kind: "user_import", resources: [conflictingExtraction] });
assert.equal(extractionConflict.ok, false);
assert.match(extractionConflict.error, /extracted text differed/i);
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeExtractionConflict), "Same-raw/different-text conflict changed the corpus.");

assert.equal((await invoke("IMPORT_TRANSCRIPTS", { transcripts: [{
  id: "local-reference-transcript", title: "Synthetic reference fixture",
  segments: [{ start: "00:00", text: "Reference evidence unrelated to automatic title matching." }],
  matched_resource_ids: [localIdV1]
}] })).ok, true);
const transcriptDigestBefore = clone((await snapshot()).meta);
assert.equal((await invoke("IMPORT_TRANSCRIPTS", { transcripts: [{
  id: "local-reference-transcript", title: "Synthetic reference fixture",
  source_hint: "Metadata-only transcript provenance update",
  segments: [{ start: "00:00", text: "Reference evidence unrelated to automatic title matching." }],
  matched_resource_ids: [localIdV1]
}] })).ok, true);
current = await snapshot();
assert.equal(current.meta.content_body_digest, transcriptDigestBefore.content_body_digest, "Transcript metadata-only update changed resource bodies.");
assert.notEqual(current.meta.corpus_digest, transcriptDigestBefore.corpus_digest, "Transcript metadata-only update did not change the corpus digest.");
assert.equal((await invoke("IMPORT_TRANSCRIPTS", { transcripts: [{
  id: "invalid-reference-transcript", title: "Invalid graph reference fixture",
  segments: [{ start: "00:00", text: "A dangling resource id must be filtered centrally on save." }],
  matched_resource_ids: ["missing-resource-id"]
}] })).ok, true);
current = await snapshot();
assert.deepEqual(current.transcripts.find((item) => item.id === "invalid-reference-transcript").matched_resource_ids, [], "Central graph reconciliation retained an invalid incoming resource id.");
assert.equal(current.resources.some((item) => (item.transcript_ids || []).includes("invalid-reference-transcript")), false);
assert.equal((await invoke("IMPORT_TRANSCRIPTS", { transcripts: [{
  id: "explicit-reference-transcript", title: "Explicit graph reference fixture",
  segments: [{ start: "00:00", text: "A valid explicit relationship must be represented in both directions." }],
  matched_resource_ids: [localIdV1]
}] })).ok, true);
current = await snapshot();
assert.deepEqual(current.transcripts.find((item) => item.id === "explicit-reference-transcript").matched_resource_ids, [localIdV1]);
assert.equal(current.resources.find((item) => item.id === localIdV1).transcript_ids.includes("explicit-reference-transcript"), true, "Valid transcript relationship was not written bidirectionally.");

const localBodyV2 = "Updated local handbook says the violet desk now accepts requests every Friday afternoon.";
const localHashV2 = crypto.createHash("sha256").update("synthetic raw file bytes v2").digest("hex");
const localIdV2 = `user_import:${localHashV2}`;
const replacementPayload = localEntry({
  clientId: "local-2", fileHash: localHashV2, name: "Local Handbook.txt", content: localBodyV2,
  operation: "replace", collisionAction: "replace", replaceId: localIdV1, expectedHash: localHashV1
});
const beforeBadCas = await snapshot();
const activeReplacementRevision = Number(beforeBadCas.meta.index_revision);
const staleRevisionAndText = await invokeUnprepared("UPSERT_LOCAL_RESOURCES", { collection_kind: "user_import", resources: [{
  ...replacementPayload,
  expected_previous_extracted_text_sha256: "a".repeat(64),
  expected_index_revision: activeReplacementRevision + 57
}] });
assert.equal(staleRevisionAndText.ok, false);
assert.equal(staleRevisionAndText.error, "stale_index_revision");
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeBadCas), "Revision-99/text-B versus expected-revision/text-A counterexample changed the corpus.");
const staleExtractedText = await invokeUnprepared("UPSERT_LOCAL_RESOURCES", { collection_kind: "user_import", resources: [{
  ...replacementPayload,
  expected_previous_extracted_text_sha256: "a".repeat(64),
  expected_index_revision: activeReplacementRevision
}] });
assert.equal(staleExtractedText.ok, false);
assert.match(staleExtractedText.error, /different extracted text/i);
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeBadCas), "Extracted-text replacement CAS changed the corpus.");
localResult = await invoke("UPSERT_LOCAL_RESOURCES", { collection_kind: "user_import", resources: [{ ...replacementPayload, expected_previous_hash_sha256: "f".repeat(64) }] });
assert.equal(localResult.ok, false);
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeBadCas), "Failed replacement CAS changed the active corpus.");
localResult = await invoke("UPSERT_LOCAL_RESOURCES", { collection_kind: "user_import", resources: [replacementPayload] });
assert.equal(localResult.ok, true);
assert.equal(localResult.replaced, 1);
current = await snapshot();
assert.equal(current.resources.some((item) => item.id === localIdV1), false, "Valid replacement retained the old resource id.");
assert.equal(Object.hasOwn(current.content_store, localIdV1), false, "Valid replacement retained the old body.");
assert.equal(current.content_store[localIdV2], localBodyV2, "Valid replacement did not persist only the new body.");
const remappedLocalTranscript = current.transcripts.find((item) => item.id === "local-reference-transcript");
assert.deepEqual(remappedLocalTranscript.matched_resource_ids, [localIdV2], "Local replacement did not remap transcript references.");
context.__chainTranscript = [{ id: "chain", matched_resource_ids: ["old-a"] }];
const chained = clone(vm.runInContext("reconcileTranscriptResourceReferences(globalThis.__chainTranscript, new Map([['old-a','old-b'],['old-b','new-c']]), new Set(), new Set(['new-c']))", context));
assert.deepEqual(chained[0].matched_resource_ids, ["new-c"], "Chained resource-id remaps did not resolve to the final id.");

const keepBothBody = "Second handbook with the same filename contains the indigo weekend help-desk instructions.";
const keepBothHash = crypto.createHash("sha256").update("synthetic same-name raw bytes").digest("hex");
const keepBothId = `user_import:${keepBothHash}`;
localResult = await invoke("UPSERT_LOCAL_RESOURCES", { collection_kind: "user_import", resources: [localEntry({
  clientId: "local-3", fileHash: keepBothHash, name: "Local Handbook.txt", content: keepBothBody,
  operation: "add", collisionAction: "keep_both"
})] });
assert.equal(localResult.ok, true);
assert.equal(localResult.added, 1);
assert.notEqual(keepBothId, localIdV2);
current = await snapshot();
assert.equal(current.resources.some((item) => item.id === localIdV2), true);
assert.equal(current.resources.some((item) => item.id === keepBothId), true, "Keep-both did not create a distinct resource.");

const temporaryBody = "Temporary local file body used to verify replacement deduplication after concurrent import.";
const temporaryHash = crypto.createHash("sha256").update("temporary raw bytes").digest("hex");
const temporaryId = `user_import:${temporaryHash}`;
localResult = await invoke("UPSERT_LOCAL_RESOURCES", { collection_kind: "user_import", resources: [localEntry({
  clientId: "local-4", fileHash: temporaryHash, name: "Temporary.txt", content: temporaryBody
})] });
assert.equal(localResult.ok, true);
const destinationConflictBody = "Existing destination body with distinct extracted semantics that must not be overwritten.";
const destinationConflictHash = crypto.createHash("sha256").update("destination conflict raw bytes").digest("hex");
const destinationConflictId = `user_import:${destinationConflictHash}`;
assert.equal((await invoke("UPSERT_LOCAL_RESOURCES", { collection_kind: "user_import", resources: [localEntry({
  clientId: "destination-existing", fileHash: destinationConflictHash, name: "Destination.txt", content: destinationConflictBody
})] })).ok, true);
const beforeDestinationConflict = await snapshot();
const destinationCollision = await invoke("UPSERT_LOCAL_RESOURCES", { collection_kind: "user_import", resources: [localEntry({
  clientId: "destination-collision",
  fileHash: destinationConflictHash,
  name: "Temporary.txt",
  content: "Different extracted text for the same destination raw hash must not overwrite either resource.",
  operation: "replace",
  collisionAction: "replace",
  replaceId: temporaryId,
  expectedHash: temporaryHash
})] });
assert.equal(destinationCollision.ok, false);
assert.match(destinationCollision.error, /different raw or extracted content/i);
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeDestinationConflict), "Destination raw-hash/text-hash collision changed the corpus.");
assert.equal((await snapshot()).content_store[destinationConflictId], destinationConflictBody);
const beforeDedupeReplacement = await snapshot();
localResult = await invoke("UPSERT_LOCAL_RESOURCES", { collection_kind: "user_import", resources: [localEntry({
  clientId: "local-5", fileHash: keepBothHash, name: "Temporary.txt", content: keepBothBody,
  operation: "replace", collisionAction: "replace", replaceId: temporaryId, expectedHash: temporaryHash
})] });
assert.equal(localResult.ok, true);
assert.equal(localResult.results[0].deduplicated, true);
current = await snapshot();
assert.equal(current.resources.some((item) => item.id === temporaryId), false, "Deduplicating replacement retained its old target.");
assert.equal(Object.hasOwn(current.content_store, temporaryId), false, "Deduplicating replacement retained its old target body.");
assert.equal(current.resources.length, beforeDedupeReplacement.resources.length - 1);
assert.equal(current.content_store[keepBothId], keepBothBody);

const packBodyV1 = "Curated pack evidence says the silver shuttle departs at seven every weekday morning.";
const packRawV1 = { id: "pack-test-one", pack_resource_id: "one", document_id: "guide", title: "Guide", type: "document", content: packBodyV1, provenance: "community-authored guide" };
let packResult = await invoke("INSTALL_RESOURCE_PACK", {
  pack: { id: "test-pack", title: "Test Pack", version: "1" },
  resources: [packRawV1]
});
assert.equal(packResult.ok, true);
const packIdV1 = derivedPackId("test-pack", packRawV1);
const beforePackOverwrite = await snapshot();
const packOverwriteBody = "A content-hydration route must not overwrite a curated pack body.";
const packOverwrite = await invokeUnprepared("STORE_CONTENT", {
  resource_id: packIdV1, content: packOverwriteBody,
  content_fingerprint: crypto.createHash("sha256").update("pack overwrite bytes").digest("hex"),
  extracted_text_sha256: crypto.createHash("sha256").update(packOverwriteBody).digest("hex"),
  expected_hydration_token: "fake-pack-token"
});
assert.equal(packOverwrite.error, "invalid_content_target");
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforePackOverwrite), "Hydration route overwrote a curated pack resource.");
assert.equal((await invoke("IMPORT_TRANSCRIPTS", { transcripts: [{
  id: "pack-reference-transcript", title: "Synthetic pack reference fixture",
  segments: [{ start: "00:00", text: "Pack reference evidence unrelated to title matching." }],
  matched_resource_ids: [packIdV1]
}] })).ok, true);
const beforeBadPack = corpusDigest(await snapshot());
packResult = await invoke("INSTALL_RESOURCE_PACK", {
  pack: { id: "test-pack", title: "Test Pack", version: "bad" },
  resources: [{ id: "pack-test-one", title: "Guide", type: "document", content: "" }]
});
assert.equal(packResult.ok, false);
assert.equal(corpusDigest(await snapshot()), beforeBadPack, "Invalid pack update mutated the active corpus.");

const packBodyV2 = "Updated curated pack evidence says the silver shuttle departs at eight every weekday morning.";
const packRawV2 = { id: "pack-test-two", pack_resource_id: "two", document_id: "guide", title: "Guide", type: "document", content: packBodyV2, provenance: "community-authored guide" };
packResult = await invoke("INSTALL_RESOURCE_PACK", {
  pack: { id: "test-pack", title: "Test Pack", version: "2" },
  resources: [packRawV2]
});
assert.equal(packResult.ok, true);
const packIdV2 = derivedPackId("test-pack", packRawV2);
current = await snapshot();
assert.equal(current.resources.some((item) => item.id === packIdV1), false);
assert.equal(Object.hasOwn(current.content_store, packIdV1), false, "Removed pack body survived update.");
assert.equal(current.content_store[packIdV2], packBodyV2);
assert.deepEqual(current.transcripts.find((item) => item.id === "pack-reference-transcript").matched_resource_ids, [], "Pack pruning left a dangling transcript reference.");
const packMetadataDigestBefore = clone(current.meta);
const installedPackResource = current.resources.find((item) => item.id === packIdV2);
await injectFixtureResource({ ...installedPackResource, source_pack_page_range: "audit-pages-21-22" }, packBodyV2);
current = await snapshot();
assert.equal(current.meta.content_body_digest, packMetadataDigestBefore.content_body_digest, "Pack metadata-only update changed the body digest.");
assert.notEqual(current.meta.corpus_digest, packMetadataDigestBefore.corpus_digest, "Pack metadata-only update did not change the corpus digest.");
assert.equal((await invoke("INSTALL_RESOURCE_PACK", {
  pack: { id: "test-pack", title: "Test Pack", version: "2" }, resources: [packRawV2]
})).ok, true);
const beforePackStorageFailure = await snapshot();
storage.failNextSet = true;
await assert.rejects(
  invoke("INSTALL_RESOURCE_PACK", {
    pack: { id: "test-pack", title: "Test Pack", version: "2" }, resources: [packRawV2]
  }),
  /synthetic storage failure/,
  "Pack transaction storage failure did not escape."
);
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforePackStorageFailure), "Failed pack transaction changed the logical corpus.");
assert.equal((await invoke("INSTALL_RESOURCE_PACK", {
  pack: { id: "test-pack", title: "Test Pack", version: "2" }, resources: [packRawV2]
})).ok, true, "Pack mutation queue did not recover after storage rejection.");

let signalPackSession;
let releasePackSession;
const packSessionEntered = new Promise((resolve) => { signalPackSession = resolve; });
const packSessionRelease = new Promise((resolve) => { releasePackSession = resolve; });
context.__signalPackSession = signalPackSession;
context.__waitForPackSessionRelease = () => packSessionRelease;
vm.runInContext(`
  globalThis.__originalCheckBlackboardSession = checkBlackboardSession;
  globalThis.__packSessionChecks = 0;
  checkBlackboardSession = async function() {
    globalThis.__packSessionChecks += 1;
    if (globalThis.__packSessionChecks === 2) {
      globalThis.__signalPackSession();
      await globalThis.__waitForPackSessionRelease();
    }
    return { ok: true, authenticated: true };
  };
`, context);
const pendingPackInstall = invoke("INSTALL_RESOURCE_PACK", {
  pack: { id: "test-pack", title: "Test Pack", version: "2" },
  resources: [packRawV2]
});
await packSessionEntered;
const scrapeWhilePackSessionWaits = invoke("SCRAPE_PAGE", { resources: [resource("official-a", "page", "Official A", officialBody)] });
const scrapeCompletedOutsidePackQueue = await Promise.race([
  scrapeWhilePackSessionWaits.then((result) => result.ok),
  new Promise((resolve) => setTimeout(() => resolve(false), 100))
]);
releasePackSession();
assert.equal(scrapeCompletedOutsidePackQueue, true, "Resource-pack session verification held the global mutation queue.");
assert.equal((await pendingPackInstall).ok, true);
vm.runInContext("checkBlackboardSession = globalThis.__originalCheckBlackboardSession", context);
current = await snapshot();
assert.equal(current.resources.some((item) => item.id === "official-a"), true, "Pack commit overwrote a concurrent official mutation from a stale snapshot.");

const collisionCases = [
  { packId: "collision-official", owner: "official" },
  { packId: "collision-local", owner: "local" },
  { packId: "collision-other-pack", owner: "other_pack" }
];
for (const collisionCase of collisionCases) {
  const collisionRaw = {
    pack_resource_id: "target", document_id: "target", title: `Collision ${collisionCase.owner}`,
    type: "document", content: `Validated collision body for ${collisionCase.owner} ownership. `.repeat(8)
  };
  const collisionId = derivedPackId(collisionCase.packId, collisionRaw);
  const base = {
    id: collisionId,
    type: collisionCase.owner === "official" ? "page" : "document",
    title: `Existing ${collisionCase.owner} collision owner`,
    url: collisionCase.owner === "local" ? "" : `https://lms.sc.tsinghua.edu.cn/content/${collisionCase.packId}`,
    page_url: "https://lms.sc.tsinghua.edu.cn/course/root",
    page_title: "Collision fixture",
    section: "Collision fixture",
    context: "An existing managed resource owns this derived identifier.",
    body_verified: collisionCase.owner === "official" ? undefined : true,
    indexed_body_source: collisionCase.owner === "official" ? undefined : "extracted",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    transcript_ids: []
  };
  if (collisionCase.owner === "local") {
    base.collection_kind = "user_import";
    base.content_origin = "user_import";
    base.content_hash_sha256 = crypto.createHash("sha256").update(collisionId).digest("hex");
    base.extracted_text_sha256 = crypto.createHash("sha256").update(collisionRaw.content).digest("hex");
  }
  if (collisionCase.owner === "other_pack") {
    base.source_pack_id = "already-installed-pack";
    base.content_origin = "resource_pack";
  }
  await injectFixtureResource(base, collisionCase.owner === "official" ? "" : collisionRaw.content);
  const beforeCollision = await snapshot();
  const collisionResult = await invoke("INSTALL_RESOURCE_PACK", {
    pack: { id: collisionCase.packId, title: "Collision Pack", version: "1" },
    resources: [collisionRaw]
  });
  assert.equal(collisionResult.ok, false, `Pack collision with ${collisionCase.owner} ownership was accepted.`);
  assert.equal(collisionResult.error, "resource_pack_resource_id_collision");
  assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeCollision), `Rejected ${collisionCase.owner} collision mutated the corpus.`);
}
const baselineOverlapResources = [1, 2, 3].map((number) => ({
  id: `baseline-overlap-${number}`,
  type: "page",
  title: `Baseline overlap ${number}`,
  url: `https://lms.sc.tsinghua.edu.cn/course/baseline-${number}`,
  page_url: `https://lms.sc.tsinghua.edu.cn/course/baseline-${number}`,
  page_title: `Baseline overlap ${number}`,
  section: "Policies",
  context: `Stable baseline page ${number} contains indexed official evidence needed to validate overlap and retained body coverage. `.repeat(18)
}));
assert.equal((await invoke("SCRAPE_PAGE", { resources: baselineOverlapResources })).ok, true);
current = await snapshot();
const officialBaselineResources = current.resources.filter((item) => !item.source_pack_id && item.collection_kind !== "user_import" && item.content_origin !== "user_import");
assert.equal(officialBaselineResources.length, 10, "Identity-overlap fixture must begin with exactly ten official resources.");
context.__baselineOfficialResources = clone(officialBaselineResources);
context.__unrelatedTen = Array.from({ length: 10 }, (_, index) => resource(`unrelated-ten-${index}`, "page", `Unrelated ${index}`, `Unrelated replacement evidence ${index}. `.repeat(30))).map((item, index) => ({ ...item, page_url: `https://lms.sc.tsinghua.edu.cn/course/unrelated-ten-${index}` }));
context.__unrelatedSeven = clone(context.__unrelatedTen.slice(0, 7));
context.__mixedOverlap = clone([...officialBaselineResources.slice(0, 5), ...context.__unrelatedTen.slice(0, 2)]);
context.__sameIdentityEmpty = clone(officialBaselineResources.map((item) => ({ ...item, context: "" })));
context.__sameIdentityTiny = clone(officialBaselineResources.map((item) => ({ ...item, context: "Readable but deliberately tiny replacement body for coverage." })));
context.__sameIdentityGarbage = clone(officialBaselineResources.map((item) => ({ ...item, context: "Home menu navigation course tools announcements dashboard links footer help click view content resources. ".repeat(80) })));
await Promise.all([
  vm.runInContext("storeDetectedMedia({ id: 'media-a', kind: 'video', url: 'https://media.tsinghua.edu.cn/a.mp4', first_seen_at: '2026-01-01T00:00:00Z' })", context),
  vm.runInContext("storeDetectedMedia({ id: 'media-b', kind: 'video', url: 'https://media.tsinghua.edu.cn/b.mp4', first_seen_at: '2026-01-01T00:00:01Z' })", context)
]);
assert.deepEqual(new Set(storage.data.detected_media_store.map((item) => item.id)), new Set(["media-a", "media-b"]), "Concurrent media detections lost an update.");

const beforeBusyGuards = await snapshot();
vm.runInContext("activeCrawlMode = 'atomic_reindex'; activeCrawlPromise = new Promise(() => {})", context);
assert.equal((await invoke("CLEAR_INDEX", { preserve_resource_packs: true })).ok, false, "Clear was allowed during an active crawl.");
assert.equal((await invoke("REINDEX_SITE", { seed_url: "https://lms.sc.tsinghua.edu.cn/course/root" })).ok, false, "A second reindex was allowed during an active crawl.");
assert.equal((await invoke("SCRAPE_PAGE", { resources: [resource("busy-official", "page", "Busy mutation", officialBody)] })).error, "index_already_running", "Official scrape was accepted during atomic reindex.");
assert.equal((await invoke("STORE_CONTENT", { resource_id: "attachment-a", content: "Busy content must not commit." })).error, "index_already_running", "Attachment body was accepted during atomic reindex.");
assert.equal((await invoke("STORE_CONTENT_BATCH", { entries: [{ resource_id: "attachment-a", content: "Busy batch content must not commit." }] })).error, "index_already_running", "Attachment batch was accepted during atomic reindex.");
vm.runInContext("activeCrawlPromise = null; activeCrawlMode = ''", context);
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeBusyGuards), "Busy-guard rejection changed the active corpus.");

let releaseQueueBlock;
context.__queueBlock = new Promise((resolve) => { releaseQueueBlock = resolve; });
const blockingMutation = vm.runInContext("runIndexMutation('fixture_queue_block', () => globalThis.__queueBlock)", context);
await new Promise((resolve) => setImmediate(resolve));
const queuedClear = invoke("CLEAR_INDEX", { preserve_resource_packs: true });
await new Promise((resolve) => setImmediate(resolve));
vm.runInContext("activeCrawlMode = 'atomic_reindex'; activeCrawlPromise = new Promise(() => {})", context);
releaseQueueBlock();
await blockingMutation;
const queuedClearResult = await queuedClear;
assert.equal(queuedClearResult.ok, false, "Queued clear did not recheck crawl activity at execution time.");
assert.equal(queuedClearResult.error, "index_already_running");
vm.runInContext("activeCrawlPromise = null; activeCrawlMode = ''", context);
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeBusyGuards), "Queued busy rejection changed the active corpus.");

let releaseMediaQueueBlock;
context.__mediaQueueBlock = new Promise((resolve) => { releaseMediaQueueBlock = resolve; });
const mediaBlockingMutation = vm.runInContext("runIndexMutation('fixture_media_queue_block', () => globalThis.__mediaQueueBlock)", context);
await new Promise((resolve) => setImmediate(resolve));
context.__queuedDetection = {
  id: "queued-media-race", kind: "video", url: "https://media.tsinghua.edu.cn/queued-race.mp4",
  page_url: "https://lms.sc.tsinghua.edu.cn/course/root", page_title: "Queued media race"
};
const queuedMediaMerge = vm.runInContext("mergeDetectedDirectMedia(globalThis.__queuedDetection)", context);
await new Promise((resolve) => setImmediate(resolve));
vm.runInContext("activeCrawlMode = 'atomic_reindex'; activeCrawlPromise = new Promise(() => {})", context);
releaseMediaQueueBlock();
await mediaBlockingMutation;
await queuedMediaMerge;
vm.runInContext("activeCrawlPromise = null; activeCrawlMode = ''", context);
current = await snapshot();
assert.equal(current.resources.some((item) => item.url === "https://media.tsinghua.edu.cn/queued-race.mp4"), false, "Queued detected-media merge did not recheck atomic-reindex state.");

context.__reindexMode = "fail";
vm.runInContext(`
  globalThis.fetchCrawlPage = async function(url) {
    if (globalThis.__reindexMode === "denied") {
      const error = new Error("Synthetic Blackboard Access Denied response");
      error.code = "access_denied";
      throw error;
    }
    if (globalThis.__reindexMode === "fail") throw new Error("synthetic page failure");
    if (globalThis.__reindexMode === "login" && /\\/queued$/.test(url)) {
      return { final_url: url, session_authenticated: false, resources: [], child_urls: [], portal_entry_urls: [] };
    }
    if (globalThis.__reindexMode === "cas") {
      globalThis.__signalReindexFetch();
      await globalThis.__waitForReindexRelease();
    }
    const replacementFixtures = {
      same_count_zero_overlap: globalThis.__unrelatedTen,
      seventy_zero_overlap: globalThis.__unrelatedSeven,
      mixed_overlap: globalThis.__mixedOverlap,
      same_identity_empty: globalThis.__sameIdentityEmpty,
      same_identity_tiny: globalThis.__sameIdentityTiny,
      same_identity_garbage: globalThis.__sameIdentityGarbage
    };
    if (replacementFixtures[globalThis.__reindexMode]) return {
      final_url: url,
      session_authenticated: true,
      resources: replacementFixtures[globalThis.__reindexMode],
      child_urls: [], portal_entry_urls: []
    };
    const compact = globalThis.__reindexMode === "collapse";
    return {
      final_url: url,
      session_authenticated: true,
      resources: compact ? [{
        id: "official-collapse", type: "page", title: "Collapsed generation", url,
        page_url: url, page_title: "Collapsed generation", section: "Policies",
        context: "This deliberately incomplete crawl must never replace the active official corpus. ".repeat(20)
      }] : [
        {
          id: "official-new", type: "page", title: "New official generation", url,
          page_url: url, page_title: "New official generation", section: "Policies",
          context: "New generation official evidence contains the emerald enrollment rule. ".repeat(20)
        },
        {
          id: "official-extra", type: "page", title: "New official details", url: url + "?detail=1",
          page_url: url, page_title: "New official details", section: "Policies",
          context: "Additional official coverage confirms the turquoise registration workflow. ".repeat(20)
        },
        {
          id: "attachment-a", type: "pdf", title: "Concise verified attachment",
          url: "https://lms.sc.tsinghua.edu.cn/content/attachment-a.pdf", page_url: url,
          page_title: "New official generation", section: "Policies", context: "Attachment listing"
        },
        { id: "attachment-b", type: "pdf", title: "Batch attachment B", url: "https://lms.sc.tsinghua.edu.cn/content/attachment-b.pdf", page_url: url, page_title: "New official generation", section: "Policies", context: "Attachment listing" },
        { id: "attachment-c", type: "document", title: "Batch attachment C", url: "https://lms.sc.tsinghua.edu.cn/content/attachment-c", page_url: url, page_title: "New official generation", section: "Policies", context: "Attachment listing" },
        { id: "renamed-refresh", type: "page", title: "Renamed stable title", url: "https://lms.sc.tsinghua.edu.cn/content/rename-stable", page_url: "https://lms.sc.tsinghua.edu.cn/content/rename-stable", page_title: "Renamed stable title", section: "Policies", context: "Revalidated renamed policy content. ".repeat(20) },
        { id: "official-a", type: "page", title: "Official A", url: "https://lms.sc.tsinghua.edu.cn/content/official-a", page_url: url, page_title: "New official generation", section: "Policies", context: "Revalidated official A evidence. ".repeat(30) },
        { id: "official-concurrent", type: "page", title: "Concurrent official mutation", url: "https://lms.sc.tsinghua.edu.cn/content/official-concurrent", page_url: url, page_title: "New official generation", section: "Policies", context: "Concurrent official evidence remains present. ".repeat(30) },
        ...globalThis.__baselineOfficialResources.filter((item) => /^baseline-overlap-/.test(item.id))
      ],
      child_urls: ["truncated", "login"].includes(globalThis.__reindexMode) && !/\\/queued$/.test(url) ? ["https://lms.sc.tsinghua.edu.cn/course/queued"] : [],
      portal_entry_urls: []
    };
  };
`, context);
const beforeFailedReindex = await snapshot();
context.__reindexPayload = { seed_url: "https://lms.sc.tsinghua.edu.cn/course/root", max_pages: 2, delay_ms: 0 };
let reindexResult = clone(await vm.runInContext("reindexSite(globalThis.__reindexPayload)", context));
assert.equal(reindexResult.ok, false);
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeFailedReindex), "Failed full reindex changed the active generation.");

context.__reindexMode = "truncated";
context.__reindexPayload = { seed_url: "https://lms.sc.tsinghua.edu.cn/course/root", max_pages: 1, delay_ms: 0 };
const beforeTruncatedReindex = await snapshot();
reindexResult = clone(await vm.runInContext("reindexSite(globalThis.__reindexPayload)", context));
assert.equal(reindexResult.ok, false);
assert.match(reindexResult.error, /page limit/i);
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeTruncatedReindex), "Page-limited reindex changed the active generation.");

context.__reindexMode = "collapse";
context.__reindexPayload = { seed_url: "https://lms.sc.tsinghua.edu.cn/course/root", max_pages: 2, delay_ms: 0, allow_partial_reindex: true };
const beforeCollapsedReindex = await snapshot();
reindexResult = clone(await vm.runInContext("reindexSite(globalThis.__reindexPayload)", context));
assert.equal(reindexResult.ok, false);
assert.match(reindexResult.error, /coverage collapsed/i);
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeCollapsedReindex), "Low-coverage allow-partial reindex changed the active generation.");

context.__reindexMode = "login";
context.__reindexPayload = { seed_url: "https://lms.sc.tsinghua.edu.cn/course/root", max_pages: 2, delay_ms: 0, allow_partial_reindex: true };
const beforeMidLogin = await snapshot();
reindexResult = clone(await vm.runInContext("reindexSite(globalThis.__reindexPayload)", context));
assert.equal(reindexResult.ok, false);
assert.match(reindexResult.error, /authentication was lost/i);
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeMidLogin), "Mid-crawl login response changed the active generation.");

for (const [mode, label] of [
  ["same_count_zero_overlap", "same-count zero-overlap"],
  ["seventy_zero_overlap", "70%-count zero-overlap"],
  ["mixed_overlap", "five-shared plus unrelated"],
  ["same_identity_empty", "same-identity empty-body"],
  ["same_identity_tiny", "same-identity character-collapse"],
  ["same_identity_garbage", "same-identity equal-length semantic garbage"]
]) {
  context.__reindexMode = mode;
  context.__reindexPayload = { seed_url: "https://lms.sc.tsinghua.edu.cn/course/root", max_pages: 2, delay_ms: 0, allow_partial_reindex: true };
  const beforeRejectedGeneration = await snapshot();
  reindexResult = clone(await vm.runInContext("reindexSite(globalThis.__reindexPayload)", context));
  assert.equal(reindexResult.ok, false, `${label} generation was promoted.`);
  assert.match(reindexResult.error, /coverage collapsed/i);
  assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeRejectedGeneration), `${label} rejection changed the active generation.`);
}
context.__reindexMode = "denied";
context.__reindexPayload = { seed_url: "https://lms.sc.tsinghua.edu.cn/course/root", max_pages: 2, delay_ms: 0, allow_partial_reindex: true };
const beforeDeniedReindex = await snapshot();
reindexResult = clone(await vm.runInContext("reindexSite(globalThis.__reindexPayload)", context));
assert.equal(reindexResult.ok, false);
assert.match(reindexResult.error, /authentication was lost/i);
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeDeniedReindex), "Access-denied reindex changed the active generation.");

let signalReindexFetch;
let releaseReindexFetch;
const reindexFetchEntered = new Promise((resolve) => { signalReindexFetch = resolve; });
const reindexRelease = new Promise((resolve) => { releaseReindexFetch = resolve; });
context.__signalReindexFetch = signalReindexFetch;
context.__waitForReindexRelease = () => reindexRelease;
context.__reindexMode = "cas";
context.__reindexPayload = { seed_url: "https://lms.sc.tsinghua.edu.cn/course/root", max_pages: 2, delay_ms: 0 };
const casReindexPromise = vm.runInContext("reindexSite(globalThis.__reindexPayload)", context);
await reindexFetchEntered;
const concurrentOfficial = await invoke("SCRAPE_PAGE", { resources: [resource(
  "official-concurrent", "page", "Concurrent official mutation",
  "Concurrent mutation evidence must survive while stale full-reindex promotion is rejected. ".repeat(20)
)] });
assert.equal(concurrentOfficial.ok, true);
releaseReindexFetch();
reindexResult = clone(await casReindexPromise);
assert.equal(reindexResult.ok, false);
assert.match(reindexResult.error, /active index changed/i);
current = await snapshot();
assert.equal(current.resources.some((item) => item.id === "official-concurrent"), true, "Concurrent official mutation was overwritten by stale reindex promotion.");
assert.equal(current.resources.some((item) => item.id === "official-a"), true, "Rejected stale promotion changed the prior official generation.");

context.__reindexMode = "success";
context.__reindexPayload = { seed_url: "https://lms.sc.tsinghua.edu.cn/course/root", max_pages: 2, delay_ms: 0 };
const beforePromotionStorageFailure = await snapshot();
storage.failNextSet = true;
await assert.rejects(
  vm.runInContext("reindexSite(globalThis.__reindexPayload)", context),
  /synthetic storage failure/,
  "Atomic promotion storage rejection did not escape."
);
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforePromotionStorageFailure), "Failed atomic promotion changed the active generation.");
assert.equal((await invoke("SCRAPE_PAGE", { resources: [resource("official-a", "page", "Official A", officialBody)] })).ok, true, "Index queue did not recover after promotion storage rejection.");
assert.equal((await invoke("IMPORT_TRANSCRIPTS", { transcripts: [{
  id: "stale-official-transcript", title: "Removed official video transcript",
  source_class: "official_blackboard", collection_kind: "blackboard_detected", content_origin: "blackboard_caption",
  segments: [{ start: "00:00", text: "This stale official transcript must disappear with its removed owner." }],
  matched_resource_ids: ["official-b"]
}] })).ok, true);
reindexResult = clone(await vm.runInContext("reindexSite(globalThis.__reindexPayload)", context));
assert.equal(reindexResult.ok, true);
current = await snapshot();
assert.equal(current.resources.some((item) => item.id === "official-new"), true);
assert.equal(current.resources.some((item) => item.id === "official-a"), true, "Successful rebuild lost a retained Blackboard identity.");
assert.equal(current.resources.some((item) => item.id === "official-b"), false, "Successful rebuild retained removed Blackboard resource.");
assert.equal(current.transcripts.some((item) => item.id === "stale-official-transcript"), false, "Removed Blackboard video left a searchable orphan transcript.");
assert.equal(current.resources.some((item) => item.id === localIdV2), true, "Reindex removed the replaced user-import resource.");
assert.equal(current.resources.some((item) => item.id === keepBothId), true, "Reindex removed the keep-both user-import resource.");
assert.equal(current.resources.some((item) => item.id === packIdV2), true, "Reindex removed curated pack.");
assert.equal(current.content_store[localIdV2], localBodyV2);
assert.equal(current.content_store[keepBothId], keepBothBody);
assert.equal(current.content_store[packIdV2], packBodyV2);
const firstSuccessfulMeta = clone(current.meta);
const firstSuccessfulDigest = corpusDigest(current);
reindexResult = clone(await vm.runInContext("reindexSite(globalThis.__reindexPayload)", context));
assert.equal(reindexResult.ok, true, "Repeated successful full reindex failed.");
current = await snapshot();
assert.equal(corpusDigest(current), firstSuccessfulDigest, "Repeated full reindex changed the logical corpus.");
assert.equal(current.meta.resource_count, firstSuccessfulMeta.resource_count);
assert.equal(current.meta.content_body_digest, firstSuccessfulMeta.content_body_digest);
assert.equal(current.meta.corpus_digest, firstSuccessfulMeta.corpus_digest);
assert.deepEqual(current.meta.source_resource_counts, firstSuccessfulMeta.source_resource_counts);
assert.match(current.meta.content_body_digest, /^[a-f0-9]{64}$/);
assert.match(current.meta.corpus_digest, /^[a-f0-9]{64}$/);
assert.equal(current.meta.index_build_status, "complete");
const activeGenerationBeforeHydration = current.meta.index_generation;
const revisionBeforeHydration = Number(current.meta.index_revision);
const refreshedAttachment = current.resources.find((item) => item.id === "attachment-a");
assert.equal(current.content_store["attachment-a"], conciseBody, "Full reindex discarded the last-known extracted attachment body when no comparable fingerprint existed.");
assert.equal(refreshedAttachment.body_verified, false);
assert.equal(refreshedAttachment.needs_body_hydration, true);
assert.equal(refreshedAttachment.body_revalidation_required, true);
assert.equal(refreshedAttachment.indexed_body_source, "last_known_extracted");
assert.match(refreshedAttachment.hydration_token, /^hydrate_/);
const beforeStaleHydration = await snapshot();
const staleHydration = await invoke("STORE_CONTENT", {
  resource_id: "attachment-a",
  content: "A stale hydration response must not overwrite the indexed body.",
  content_fingerprint: crypto.createHash("sha256").update("stale attachment bytes").digest("hex"),
  expected_hydration_token: "hydrate_stale_token"
});
assert.equal(staleHydration.ok, false);
assert.equal(staleHydration.error, "stale_hydration_token");
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeStaleHydration), "Stale hydration token changed the corpus.");
const rehydratedBody = "Revalidated attachment body confirms the cobalt form, passport copy, and signed arrival confirmation.";
const rehydratedFingerprint = crypto.createHash("sha256").update("fresh attachment bytes").digest("hex");
const rehydratedTextHash = crypto.createHash("sha256").update(rehydratedBody).digest("hex");
const hydrationResult = await invoke("STORE_CONTENT", {
  resource_id: "attachment-a",
  content: rehydratedBody,
  content_fingerprint: rehydratedFingerprint,
  extracted_text_sha256: rehydratedTextHash,
  expected_hydration_token: refreshedAttachment.hydration_token
});
assert.equal(hydrationResult.ok, true);
current = await snapshot();
const hydratedAttachment = current.resources.find((item) => item.id === "attachment-a");
assert.equal(hydratedAttachment.body_verified, true);
assert.equal(hydratedAttachment.indexed_body_source, "extracted");
assert.equal(hydratedAttachment.needs_body_hydration, undefined);
assert.equal(hydratedAttachment.body_revalidation_required, undefined);
assert.equal(hydratedAttachment.hydration_token, undefined);
assert.equal(hydratedAttachment.content_fingerprint, rehydratedFingerprint);
assert.equal(hydratedAttachment.extracted_text_sha256, rehydratedTextHash);
assert.equal(current.content_store["attachment-a"], rehydratedBody);
assert.equal(Number(current.meta.index_revision), revisionBeforeHydration + 1, "One hydration commit did not advance the index revision exactly once.");
assert.equal(current.meta.index_generation, activeGenerationBeforeHydration, "Routine body hydration discarded the active generation.");
assert.equal(current.meta.index_build_status, "complete", "Routine body hydration discarded build status.");
assert.ok(Number(current.meta.index_revision) > 0, "Index revision was not persisted.");

const allIds = new Set(current.resources.map((item) => item.id));
assert.equal(allIds.size, current.resources.length, "Active corpus contains duplicate IDs.");
for (const contentId of Object.keys(current.content_store)) assert.ok(allIds.has(contentId), `Orphan body survived for ${contentId}.`);
assert.deepEqual(storage.data.assistant_settings, { provider: "test", apiKey: "preserve-me" }, "Index mutations changed API settings.");

const protectedRemoval = await invoke("REMOVE_LOCAL_RESOURCE", { resource_id: "official-new" });
assert.equal(protectedRemoval.ok, false, "Local-resource removal deleted a managed resource.");
const beforeStaleRemoval = await snapshot();
const staleRemoval = await invoke("REMOVE_LOCAL_RESOURCE", { resource_id: localIdV2, expected_previous_hash_sha256: "f".repeat(64) });
assert.equal(staleRemoval.ok, false);
assert.equal(corpusDigest(await snapshot()), corpusDigest(beforeStaleRemoval), "Stale removal CAS changed the active corpus.");
const beforeRemovalStorageFailure = await snapshot();
storage.failNextSet = true;
await assert.rejects(
  Promise.race([
    invoke("REMOVE_LOCAL_RESOURCE", { resource_id: localIdV2, expected_previous_hash_sha256: localHashV2 }),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("remove_deadlock_timeout")), 2000))
  ]),
  /synthetic storage failure/
);
const afterRemovalStorageFailure = await snapshot();
assert.equal(corpusDigest(afterRemovalStorageFailure), corpusDigest(beforeRemovalStorageFailure), "Failed local removal changed the active corpus.");
assert.equal(afterRemovalStorageFailure.meta.index_revision, beforeRemovalStorageFailure.meta.index_revision, "Failed local removal advanced the revision.");
const removedLocal = await Promise.race([
  invoke("REMOVE_LOCAL_RESOURCE", { resource_id: localIdV2, expected_previous_hash_sha256: localHashV2 }),
  new Promise((_resolve, reject) => setTimeout(() => reject(new Error("remove_deadlock_timeout")), 2000))
]);
assert.equal(removedLocal.ok, true);
assert.equal(removedLocal.status, "removed");
assert.equal(removedLocal.removed_hash_sha256, localHashV2);
assert.equal(removedLocal.expected_index_revision, removedLocal.removed_at_index_revision);
assert.equal(removedLocal.committed_index_revision, removedLocal.removed_at_index_revision + 1);
current = await snapshot();
assert.equal(current.resources.some((item) => item.id === localIdV2), false);
assert.equal(Object.hasOwn(current.content_store, localIdV2), false);
assert.equal(current.transcripts.find((item) => item.id === "local-reference-transcript").matched_resource_ids.includes(localIdV2), false, "Local removal left a dangling transcript reference.");
const remainingIds = new Set(current.resources.map((item) => item.id));
for (const transcript of current.transcripts) {
  for (const resourceId of transcript.matched_resource_ids || []) assert.ok(remainingIds.has(resourceId), `Dangling transcript reference survived for ${resourceId}.`);
}

const budgetResources = [];
const budgetContent = {};
for (let index = 0; index < 199; index += 1) {
  const rawHash = crypto.createHash("sha256").update(`budget-seed-${index}`).digest("hex");
  const body = `Persistent budget seed ${index} contains enough readable text for the cumulative corpus fixture.`;
  const id = `user_import:${rawHash}`;
  budgetResources.push({
    id, type: "document", title: `Budget ${index}.txt`, original_file_name: `Budget ${index}.txt`,
    collection_kind: "user_import", content_origin: "user_import", body_verified: true,
    indexed_body_source: "extracted", content_hash_sha256: rawHash,
    extracted_text_sha256: crypto.createHash("sha256").update(body).digest("hex"), transcript_ids: []
  });
  budgetContent[id] = body;
}
const budgetStorage = storageFixture({
  resource_index: budgetResources, transcript_store: [], content_store: budgetContent,
  index_meta: { index_revision: 99 }, resource_pack_store: [], detected_media_store: [], ignored_media_store: []
});
context.chrome.storage.local = budgetStorage.api;
const budgetBodyA = "First cumulative budget addition contains enough readable extracted text to be indexed safely.";
const budgetHashA = crypto.createHash("sha256").update("budget-add-a").digest("hex");
const budgetAddA = localEntry({ clientId: "budget-a", fileHash: budgetHashA, name: "Budget A.txt", content: budgetBodyA });
budgetAddA.expected_index_revision = 99;
const budgetFirst = await invokeUnprepared("UPSERT_LOCAL_RESOURCES", { collection_kind: "user_import", resources: [budgetAddA] });
assert.equal(budgetFirst.ok, true);
assert.equal(budgetFirst.committed_index_revision, 100);
const budgetBodyB = "Second cumulative budget addition must be rejected because prior batches already reached the file limit.";
const budgetHashB = crypto.createHash("sha256").update("budget-add-b").digest("hex");
const budgetAddB = localEntry({ clientId: "budget-b", fileHash: budgetHashB, name: "Budget B.txt", content: budgetBodyB });
budgetAddB.expected_index_revision = 100;
const budgetBeforeRejectedBatch = clone(budgetStorage.data);
const budgetSecond = await invokeUnprepared("UPSERT_LOCAL_RESOURCES", { collection_kind: "user_import", resources: [budgetAddB] });
assert.equal(budgetSecond.ok, false);
assert.equal(budgetSecond.error, "local_resource_budget_exceeded");
assert.match(budgetSecond.detail, /Remove an indexed local file/i);
assert.equal(budgetStorage.data.resource_index.filter((item) => item.collection_kind === "user_import").length, 200);
assert.equal(budgetStorage.data.index_meta.index_revision, 100);
assert.deepEqual(budgetStorage.data, budgetBeforeRejectedBatch, "A later batch bypassed the persistent local-resource corpus budget.");
const charSeedBody = "x".repeat(10_000_000 - 50);
const charSeedRawHash = crypto.createHash("sha256").update("char-budget-seed").digest("hex");
const charSeedId = `user_import:${charSeedRawHash}`;
const charBudgetStorage = storageFixture({
  resource_index: [{
    id: charSeedId, type: "document", title: "Character Budget.txt", original_file_name: "Character Budget.txt",
    collection_kind: "user_import", content_origin: "user_import", body_verified: true,
    indexed_body_source: "extracted", content_hash_sha256: charSeedRawHash,
    extracted_text_sha256: crypto.createHash("sha256").update(charSeedBody).digest("hex"), transcript_ids: []
  }],
  transcript_store: [], content_store: { [charSeedId]: charSeedBody }, index_meta: { index_revision: 7 },
  resource_pack_store: [], detected_media_store: [], ignored_media_store: []
});
context.chrome.storage.local = charBudgetStorage.api;
const charOverflowBody = "This additional extracted body crosses the persistent ten-million-character corpus budget.";
const charOverflowHash = crypto.createHash("sha256").update("char-budget-overflow").digest("hex");
const charOverflow = localEntry({ clientId: "char-overflow", fileHash: charOverflowHash, name: "Overflow.txt", content: charOverflowBody });
charOverflow.expected_index_revision = 7;
const charBudgetResult = await invokeUnprepared("UPSERT_LOCAL_RESOURCES", {
  collection_kind: "user_import", resources: [charOverflow]
});
assert.equal(charBudgetResult.ok, false);
assert.equal(charBudgetResult.error, "local_resource_budget_exceeded");
assert.equal(charBudgetStorage.data.resource_index.length, 1);
assert.equal(charBudgetStorage.data.content_store[charSeedId].length, 10_000_000 - 50);
assert.equal(charBudgetStorage.data.index_meta.index_revision, 7);
context.chrome.storage.local = storage.api;

authenticated = false;
const beforeLoggedOut = corpusDigest(current);
const loggedOutStart = await invoke("REINDEX_SITE", { seed_url: "https://lms.sc.tsinghua.edu.cn/course/root" });
assert.equal(loggedOutStart.ok, false);
assert.equal(corpusDigest(await snapshot()), beforeLoggedOut, "Logged-out reindex changed the active corpus.");

const legacyMissingAttachment = resource("legacy-missing-attachment", "pdf", "Legacy missing attachment");
const legacyReadableAttachment = resource("legacy-readable-attachment", "pdf", "Legacy readable attachment");
const legacyRemovedOwner = resource(
  "legacy-removed-owner", "page", "Legacy removed official owner",
  "Legacy official owner contains temporary indexed policy evidence before it disappears. ".repeat(20)
);
const legacyReadableBody = "Legacy extracted visa guidance lists the passport, application, insurance, registration, and residence-permit details required after arrival. ".repeat(20);
storage.data.resource_index.push(legacyMissingAttachment, legacyReadableAttachment, legacyRemovedOwner);
storage.data.content_store[legacyReadableAttachment.id] = legacyReadableBody;
storage.data.content_store[legacyRemovedOwner.id] = legacyRemovedOwner.context;
storage.data.transcript_store.push(
  {
    id: "legacy-unmatched-user-transcript", title: "Legacy personal notes",
    source_hint: "Imported before provenance fields existed",
    segments: [{ start: "00:00", text: "Legacy personal transcript evidence must survive an ordinary reindex." }],
    matched_resource_ids: []
  },
  {
    id: "legacy-removed-official-transcript", title: "Legacy removed official video",
    source_hint: "Detected before provenance fields existed",
    segments: [{ start: "00:00", text: "Legacy official transcript evidence must disappear with its owner." }],
    matched_resource_ids: [legacyRemovedOwner.id]
  }
);
current = await snapshot();
const migratedMissingAttachment = current.resources.find((item) => item.id === legacyMissingAttachment.id);
const migratedReadableAttachment = current.resources.find((item) => item.id === legacyReadableAttachment.id);
assert.equal(migratedMissingAttachment.body_verified, false);
assert.equal(migratedMissingAttachment.indexed_body_source, "pending_extraction");
assert.match(migratedMissingAttachment.hydration_token, /^hydrate_/, "Legacy bodyless attachment did not receive a hydration token.");
assert.equal(migratedReadableAttachment.body_verified, false);
assert.equal(migratedReadableAttachment.indexed_body_source, "last_known_extracted");
assert.equal(current.content_store[legacyReadableAttachment.id], legacyReadableBody);
assert.match(migratedReadableAttachment.hydration_token, /^hydrate_/, "Legacy readable attachment did not receive a revalidation token.");
assert.equal(current.transcripts.find((item) => item.id === "legacy-unmatched-user-transcript").source_class, "user_import");
assert.equal(current.transcripts.find((item) => item.id === "legacy-removed-official-transcript").source_class, "official_blackboard");
const legacyHydration = await invoke("STORE_CONTENT", {
  resource_id: legacyMissingAttachment.id,
  content: "Fresh extraction of the legacy attachment contains readable arrival and registration instructions."
});
assert.equal(legacyHydration.ok, true, "Legacy attachment could not hydrate without a full reindex.");
context.__reindexMode = "success";
context.__reindexPayload = { seed_url: "https://lms.sc.tsinghua.edu.cn/course/root", max_pages: 2, delay_ms: 0 };
reindexResult = clone(await vm.runInContext("reindexSite(globalThis.__reindexPayload)", context));
assert.equal(reindexResult.ok, true, "Legacy migration made the next healthy reindex fail.");
current = await snapshot();
assert.equal(current.transcripts.some((item) => item.id === "legacy-unmatched-user-transcript"), true, "Legacy user transcript was deleted on first reindex.");
assert.equal(current.transcripts.some((item) => item.id === "legacy-removed-official-transcript"), false, "Legacy removed-official transcript survived as orphan evidence.");
assert.equal(current.resources.some((item) => item.id === legacyRemovedOwner.id), false);

const revisionBeforeClear = Number(current.meta.index_revision);
const clearResult = await invoke("CLEAR_INDEX", { preserve_resource_packs: true });
assert.equal(clearResult.ok, true);
current = await snapshot();
assert.equal(current.resources.some((item) => !item.source_pack_id && item.collection_kind !== "user_import" && item.content_origin !== "user_import"), false, "Successful clear retained official Blackboard resources.");
assert.equal(current.resources.some((item) => item.id === keepBothId), true, "Preserving collections during clear removed a user import.");
assert.equal(current.resources.some((item) => item.id === packIdV2), true, "Preserving collections during clear removed an installed pack.");
assert.deepEqual(current.transcripts, [], "Clear retained transcript references.");
assert.equal(Number(current.meta.index_revision), revisionBeforeClear + 1, "Clear did not advance revision exactly once.");
assert.equal(current.meta.index_build_status, "complete");
assert.match(current.meta.content_body_digest, /^[a-f0-9]{64}$/);
assert.match(current.meta.corpus_digest, /^[a-f0-9]{64}$/);
assert.deepEqual(storage.data.assistant_settings, { provider: "test", apiKey: "preserve-me" }, "Clear changed API settings.");

authenticated = true;
context.__reindexMode = "collapse";
context.__reindexPayload = { seed_url: "https://lms.sc.tsinghua.edu.cn/course/root", max_pages: 1, delay_ms: 0, allow_partial_reindex: true };
reindexResult = clone(await vm.runInContext("reindexSite(globalThis.__reindexPayload)", context));
assert.equal(reindexResult.ok, true, "First-index exception rejected a valid nonempty crawl without an official baseline.");
current = await snapshot();
assert.equal(current.resources.some((item) => item.id === "official-collapse"), true);
assert.equal(current.resources.some((item) => item.id === keepBothId), true, "First index removed a preserved user import.");
assert.equal(current.resources.some((item) => item.id === packIdV2), true, "First index removed a preserved pack.");
for (const [source, count] of Object.entries(current.meta.source_resource_counts || {})) {
  assert.equal(Number.isInteger(count) && count >= 0, true, `Invalid per-source resource count for ${source}.`);
}

console.log("index-lifecycle-check passed (serialized union/recovery, dual-hash local CAS, transcript referential integrity, queue-time busy guards, namespaced atomic pack preservation, auth/coverage/CAS rollback, fingerprint-aware hydration, metadata digests, clear/first-index lifecycle)");
