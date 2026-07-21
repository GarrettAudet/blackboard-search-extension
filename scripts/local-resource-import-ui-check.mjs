import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const moduleSource = [
  "../lib/answer-formatting.js",
  "../lib/llm-client.js",
  "../lib/search-index.js"
].map((file) => fs.readFileSync(new URL(file, import.meta.url), "utf8")).join("\n\n");
const sidepanelSource = fs.readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../sidepanel/sidepanel.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../sidepanel/sidepanel.css", import.meta.url), "utf8");
const privacy = fs.readFileSync(new URL("../PRIVACY.md", import.meta.url), "utf8");
const runtimeStart = sidepanelSource.indexOf("chrome.runtime.onMessage.addListener");
if (runtimeStart < 0) throw new Error("Could not isolate the side-panel runtime.");

function mockElement() {
  const element = {
    textContent: "", value: "", disabled: false, files: [], className: "", dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, append() {}, remove() {}, setAttribute() {}, click() {}, focus() { this.focused = true; },
    querySelector() { return mockElement(); }, querySelectorAll() { return []; },
    cloneNode() { return mockElement(); }, scrollIntoView() {}
  };
  element.content = { firstElementChild: element };
  return element;
}

const context = {
  console,
  URL,
  TextDecoder,
  TextEncoder,
  DataView,
  Uint8Array,
  ArrayBuffer,
  Blob,
  Response,
  DecompressionStream,
  crypto: webcrypto,
  setTimeout,
  clearTimeout,
  confirm() { return true; },
  document: {
    getElementById() { return mockElement(); },
    createElement() { return mockElement(); },
    querySelectorAll() { return []; }
  },
  chrome: {
    runtime: {
      sendMessage() {}, getManifest() { return { version: "local-resource-test" }; },
      getURL(path) { return "chrome-extension://local-resource-test/" + path; }, onMessage: { addListener() {} }
    },
    tabs: { async create() {} }, storage: { local: { async get() { return {}; }, async set() {} } }
  }
};
context.window = context;
vm.createContext(context);
vm.runInContext(moduleSource + "\n\n" + sidepanelSource.slice(0, runtimeStart), context);

// Static accessibility/disclosure contracts. Event wiring is inspected statically; helper behavior is exercised below.
assert.match(html, /id="localResourcesPanel"[\s\S]*aria-busy="false"/);
assert.match(html, /id="localResourceFileInput"[\s\S]*tabindex="-1"[\s\S]*aria-label="Choose local resource files"[\s\S]*multiple[\s\S]*accept="\.pdf,\.docx,\.pptx,\.xlsx,\.txt,\.md,\.markdown,\.csv"/);
assert.match(html, /id="localResourceDropzone"[\s\S]*role="button"[\s\S]*tabindex="0"/);
assert.match(html, /id="localResourceStatus"[\s\S]*role="status"[\s\S]*aria-live="polite"/);
assert.match(html, /bounded relevant excerpts and their filenames may be sent to your selected provider/i);
assert.match(privacy, /bounded set of candidate excerpts[\s\S]*files added to My resources[\s\S]*to that provider/i);
assert.match(privacy, /does not persist the raw file, file blob, or local filesystem path/i);
assert.match(privacy, /full local index and raw imported files are not sent to the provider/i);
assert.match(css, /\.local-resource-dropzone:focus-visible/);
assert.match(sidepanelSource, /setAttribute\("aria-label", `Discard /);
assert.match(sidepanelSource, /setAttribute\("aria-label", `Update /);
assert.match(sidepanelSource, /setAttribute\("aria-label", `Remove /);
assert.match(sidepanelSource, /if \(focusControl && typeof focusControl\.focus === "function"\) focusControl\.focus\(\)/);
assert.match(sidepanelSource, /localResourceMaintenanceControls\(\)[\s\S]*els\.refreshBtn[\s\S]*els\.crawlBtn[\s\S]*els\.clearBtn/);
assert.match(sidepanelSource, /localResourceMaintenanceControls\(\)[\s\S]*els\.queryInput[\s\S]*els\.searchBtn/);
assert.match(sidepanelSource, /async function handleAsk[\s\S]*if \(localResourceBusy\)/);
assert.match(sidepanelSource, /async function handleIndexCommand[\s\S]*if \(localResourceBusy\)/);
assert.match(sidepanelSource, /Refresh My resources to verify before retrying/);
assert.match(sidepanelSource, /Clear all indexed Blackboard, optional-pack, and My resources content/);
assert.match(sidepanelSource, /\["replace", "Replace existing"\], \["keep_both", "Keep both"\], \["skip", "Cancel \/ skip"\]/);

context.__supportedNames = ["a.pdf", "b.docx", "c.pptx", "d.xlsx", "e.txt", "f.md", "g.markdown", "h.csv"];
context.__legacyNames = ["a.doc", "b.rtf", "c.odt", "d.ppt", "e.xls"];
const typeContract = vm.runInContext(`({
  supported: globalThis.__supportedNames.map((name) => Boolean(localResourceFileDescriptor(name))),
  legacy: globalThis.__legacyNames.map((name) => Boolean(localResourceFileDescriptor(name))),
  sanitized: normalizeLocalResourceFileName("C:\\\\secret\\\\notes.txt")
})`, context);
assert.ok(Array.from(typeContract.supported).every(Boolean), "A claimed local-import format was not accepted.");
assert.ok(Array.from(typeContract.legacy).every((value) => !value), "A legacy format was incorrectly claimed as supported.");
assert.equal(typeContract.sanitized, "notes.txt", "A local path was not reduced to a basename.");

// Office zip safety and semantic XLSX extraction.
context.__safeZipMetadata = [{ flags: 0, compressionMethod: 8, compressedSize: 100, uncompressedSize: 500, selected: true }];
context.__bombZipMetadata = [{ flags: 0, compressionMethod: 8, compressedSize: 100, uncompressedSize: 70 * 1024 * 1024, selected: true }];
context.__encryptedZipMetadata = [{ flags: 1, compressionMethod: 8, compressedSize: 100, uncompressedSize: 500, selected: true }];
context.__unsupportedZipMetadata = [{ flags: 0, compressionMethod: 12, compressedSize: 100, uncompressedSize: 500, selected: true }];
const zipSafety = vm.runInContext(`(() => {
  const capture = (entries) => {
    try { validateOfficeZipEntryMetadata(entries); return "accepted"; }
    catch (error) { return String(error.message || error); }
  };
  return {
    safe: capture(globalThis.__safeZipMetadata),
    bomb: capture(globalThis.__bombZipMetadata),
    encrypted: capture(globalThis.__encryptedZipMetadata),
    unsupported: capture(globalThis.__unsupportedZipMetadata),
    tooMany: capture(Array.from({ length: OFFICE_ZIP_MAX_ENTRIES + 1 }, () => ({
      flags: 0, compressionMethod: 8, compressedSize: 1, uncompressedSize: 1, selected: false
    })))
  };
})()`, context);
assert.equal(zipSafety.safe, "accepted");
assert.match(zipSafety.bomb, /uncompressed data exceeds|XML entry exceeds/i);
assert.match(zipSafety.encrypted, /encrypted/i);
assert.match(zipSafety.unsupported, /unsupported.*compression/i);
assert.match(zipSafety.tooMany, /more than.*entries/i);
assert.ok(
  sidepanelSource.indexOf("validateOfficeZipEntryMetadata(metadata)") < sidepanelSource.indexOf("for (const entry of metadata.filter"),
  "Office zip metadata was not validated before inflate."
);
context.__xlsxEntries = [
  { name: "xl/sharedStrings.xml", text: "<sst><si><t>Deadline</t></si><si><t>August 26</t></si></sst>" },
  { name: "xl/worksheets/sheet1.xml", text: '<worksheet><sheetData><row r="4"><c r="A4" t="s"><v>0</v></c><c r="B4" t="s"><v>1</v></c><c r="C4" t="inlineStr"><is><t>Bring passport</t></is></c></row></sheetData></worksheet>' }
];
const xlsxText = vm.runInContext("extractXlsxWorkbookText(globalThis.__xlsxEntries)", context);
assert.match(xlsxText, /Sheet 1, row 4: A4 = Deadline; B4 = August 26; C4 = Bring passport\./);

context.__realisticXlsx = createStoredZip({
  "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  "xl/workbook.xml": '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="0"/><sheets><sheet name="Deadline Tracker" sheetId="1" r:id="rId1"/><sheet name="Flags &amp; Formula" sheetId="2" r:id="rId2"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/custom-deadlines.xml"/><Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
  "xl/styles.xml": '<?xml version="1.0"?><styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>',
  "xl/sharedStrings.xml": '<?xml version="1.0"?><sst><si><r><t>Application</t></r><r><t> deadline</t></r></si></sst>',
  "xl/worksheets/custom-deadlines.xml": '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Bring passport</t></is></c><c r="C1" s="1"><v>45530</v></c><c r="D1" t="b"><v>1</v></c><c r="E1"><f>SUM(3,4)</f><v>7</v></c></row></sheetData></worksheet>',
  "xl/worksheets/sheet2.xml": '<?xml version="1.0"?><worksheet><sheetData><row r="2"><c r="A2" t="inlineStr"><is><t>Second sheet</t></is></c></row></sheetData></worksheet>'
});
context.__realisticXlsxPromise = createPromise(context, "extractXlsxText(globalThis.__realisticXlsx)");
const realisticXlsxText = await context.__realisticXlsxPromise;
assert.match(realisticXlsxText, /Deadline Tracker, row 1:/);
assert.match(realisticXlsxText, /A1 = Application deadline/);
assert.match(realisticXlsxText, /C1 = 2024-08-26/);
assert.match(realisticXlsxText, /D1 = true/);
assert.match(realisticXlsxText, /E1 = 7 \(cached result; formula =SUM\(3,4\)\)/);
assert.match(realisticXlsxText, /Flags & Formula, row 2: A2 = Second sheet/);
assert.equal(vm.runInContext("xlsxSerialDate(0, true)", context), "1904-01-01");

// Fatal text decoding accepts BOM-tagged UTF-16 and rejects invalid UTF-8/binary garbage.
context.__utf16le = new Uint8Array([0xff, 0xfe, 0x56, 0x00, 0x69, 0x00, 0x73, 0x00, 0x61, 0x00, 0x20, 0x00, 0x66, 0x00, 0x6f, 0x00, 0x72, 0x00, 0x6d, 0x00]).buffer;
context.__invalidUtf8 = new Uint8Array([0xc3, 0x28]).buffer;
context.__binary = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).buffer;
const decoding = vm.runInContext(`(() => {
  const capture = (buffer) => {
    try { return { ok: true, text: validateLocalExtractedText(decodeLocalTextBuffer(buffer)) }; }
    catch (error) { return { ok: false, error: String(error.message || error) }; }
  };
  return {
    utf16: capture(globalThis.__utf16le),
    invalid: capture(globalThis.__invalidUtf8),
    binary: capture(globalThis.__binary)
  };
})()`, context);
assert.equal(decoding.utf16.ok, true);
assert.equal(decoding.utf16.text, "Visa form");
assert.equal(decoding.invalid.ok, false);
assert.equal(decoding.binary.ok, false);

// Dual-hash duplicate identity: exact means raw bytes AND extracted semantics.
context.__existingLocal = [{
  id: "local-old",
  collection_kind: "user_import",
  file_name: "notes.txt",
  content_hash_sha256: "a".repeat(64),
  extracted_text_sha256: "c".repeat(64)
}];
context.__sameIdentity = { name: "copy.txt", content_hash_sha256: "a".repeat(64), extracted_text_sha256: "c".repeat(64) };
context.__sameRawDifferentText = { name: "other.txt", content_hash_sha256: "a".repeat(64), extracted_text_sha256: "d".repeat(64) };
context.__sameName = { name: "notes.txt", content_hash_sha256: "b".repeat(64), extracted_text_sha256: "d".repeat(64) };
const collisionContract = vm.runInContext(`({
  exact: classifyLocalResourceCandidate(globalThis.__sameIdentity, globalThis.__existingLocal, []),
  changedExtraction: classifyLocalResourceCandidate(globalThis.__sameRawDifferentText, globalThis.__existingLocal, []),
  sameName: classifyLocalResourceCandidate(globalThis.__sameName, globalThis.__existingLocal, [])
})`, context);
assert.equal(collisionContract.exact.status, "duplicate");
assert.notEqual(collisionContract.changedExtraction.status, "duplicate", "Same raw bytes with changed extraction were suppressed as an exact duplicate.");
assert.equal(collisionContract.sameName.status, "needs_collision_choice");

const replacementContract = vm.runInContext(`(() => {
  localResourcePreflightItems = [{
    client_id: "candidate-1", name: "notes.txt", type_label: "TXT", kind: "document",
    content_type: "text/plain", content_hash_sha256: "${"b".repeat(64)}",
    extracted_text_sha256: "${"d".repeat(64)}", byte_size: 12,
    extracted_chars: 11, content: "hello world", status: "needs_collision_choice",
    existing_resource_id: "local-old", existing_hash_sha256: "${"a".repeat(64)}",
    existing_extracted_text_sha256: "${"c".repeat(64)}"
  }];
  applyLocalResourceCollisionChoice("candidate-1", "replace");
  const replace = localResourceUpsertPayload(localResourcePreflightItems[0]);
  applyLocalResourceCollisionChoice("candidate-1", "keep_both");
  const keepBoth = localResourceUpsertPayload(localResourcePreflightItems[0]);
  applyLocalResourceCollisionChoice("candidate-1", "skip");
  const skip = localResourceUpsertPayload(localResourcePreflightItems[0]);
  return { replace, keepBoth, skip };
})()`, context);
assert.equal(replacementContract.replace.operation, "replace");
assert.equal(replacementContract.replace.replace_resource_id, "local-old");
assert.equal(replacementContract.replace.expected_previous_extracted_text_sha256, "c".repeat(64));
assert.equal(replacementContract.keepBoth.operation, "add");
assert.equal(replacementContract.keepBoth.collision_action, "keep_both");
assert.equal(replacementContract.skip, null);

// Preflight supports partial success, raw/file caps, extracted-text caps, and bounded commit messages.
const validText = new TextEncoder().encode("A small but searchable local note about campus transport and late shuttle access.").buffer;
context.__validTextFile = {
  name: "transport.md", type: "text/markdown", size: validText.byteLength,
  async arrayBuffer() { return validText; }
};
context.__unsupportedFile = {
  name: "legacy.doc", type: "application/msword", size: 4,
  async arrayBuffer() { return new Uint8Array([1, 2, 3, 4]).buffer; }
};
context.__oversizedReadCalled = false;
context.__oversizedFile = {
  name: "huge.txt", type: "text/plain", size: 26 * 1024 * 1024,
  async arrayBuffer() { globalThis.__oversizedReadCalled = true; return new ArrayBuffer(0); }
};
context.__partialPromise = createPromise(context, `createLocalResourcePreflightBatch(
  [globalThis.__validTextFile, globalThis.__unsupportedFile], [], [], null
)`);
const partial = await context.__partialPromise;
assert.deepEqual(Array.from(partial, (item) => item.status), ["ready", "error"]);
assert.ok(partial[0].extracted_chars > 0 && partial[0].content_hash_sha256.length === 64);
assert.equal(partial[0].extracted_text_sha256.length, 64);

context.__oversizedPromise = createPromise(context, `extractLocalResourceFile(globalThis.__oversizedFile).then(
  () => "accepted", error => String(error.message || error)
)`);
assert.match(await context.__oversizedPromise, /25 MB/);
assert.equal(context.__oversizedReadCalled, false);

const bounds = vm.runInContext(`(() => {
  const capture = (files, pending = []) => {
    try { assertLocalResourcePreflightSelectionWithinBounds(files, pending); return "accepted"; }
    catch (error) { return String(error.message || error); }
  };
  return {
    count: capture(Array.from({ length: LOCAL_RESOURCE_MAX_PREFLIGHT_FILES + 1 }, (_, index) => ({ name: index + ".txt", size: 1 }))),
    raw: capture([{ name: "a.txt", size: 60 * 1024 * 1024 }, { name: "b.txt", size: 50 * 1024 * 1024 }]),
    extractedUsage: localResourcePreflightUsage([{ status: "ready", byte_size: 1, content: "x".repeat(LOCAL_RESOURCE_MAX_PREFLIGHT_EXTRACTED_CHARS) }]).extractedChars,
    batches: partitionLocalResourcePayloads(Array.from({ length: LOCAL_RESOURCE_MAX_COMMIT_FILES + 1 }, (_, index) => ({ client_id: String(index), content: "ok" }))),
    charBatches: partitionLocalResourcePayloads([{ client_id: "a", content: "x".repeat(1100000) }, { client_id: "b", content: "y".repeat(1100000) }])
  };
})()`, context);
assert.match(bounds.count, /at most 24 files/i);
assert.match(bounds.raw, /100 MB/i);
assert.equal(bounds.extractedUsage, 5000000);
context.__extractedCapPromise = createPromise(context, `createLocalResourcePreflightBatch(
  [globalThis.__validTextFile], [], [{ status: "ready", byte_size: 1, content: "x".repeat(LOCAL_RESOURCE_MAX_PREFLIGHT_EXTRACTED_CHARS) }], null
)`);
const extractedCap = await context.__extractedCapPromise;
assert.equal(extractedCap[0].status, "error");
assert.match(extractedCap[0].detail, /character aggregate preflight limit/i);
assert.deepEqual(Array.from(bounds.batches, (batch) => batch.length), [6, 1]);
assert.deepEqual(Array.from(bounds.charBatches, (batch) => batch.length), [1, 1]);

context.__payloadItem = {
  ...partial[0],
  file: { secret: true }, path: "C:\\secret\\transport.md", blob: new Blob(["secret"]),
  buffer: new Uint8Array([1, 2, 3]).buffer
};
const payload = vm.runInContext("localResourceUpsertPayload(globalThis.__payloadItem)", context);
const serializedPayload = JSON.stringify(payload);
const forbiddenPayloadKeys = new Set(["file", "path", "blob", "buffer", "bytes", "array_buffer"]);
const payloadStack = [payload];
while (payloadStack.length) {
  const value = payloadStack.pop();
  if (!value || typeof value !== "object") continue;
  assert.equal(value instanceof Blob, false);
  assert.equal(value instanceof ArrayBuffer || ArrayBuffer.isView(value), false);
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbiddenPayloadKeys.has(key.toLowerCase()), false, `Forbidden raw payload field: ${key}`);
    payloadStack.push(child);
  }
}
assert.doesNotMatch(serializedPayload, /C:\\\\secret/i);
assert.equal(payload.collection_kind, "user_import");
assert.equal(typeof payload.content, "string");
assert.equal(payload.extracted_text_sha256.length, 64);

const removalPayload = vm.runInContext(`(() => {
  state.meta = { index_revision: 42 };
  return localResourceRemovePayload(globalThis.__existingLocal[0]);
})()`, context);
assert.equal(removalPayload.collection_kind, "user_import");
assert.equal(removalPayload.expected_previous_hash_sha256, "a".repeat(64));
assert.equal(removalPayload.expected_previous_extracted_text_sha256, "c".repeat(64));
assert.equal(removalPayload.expected_index_revision, 42);

const discardFocus = vm.runInContext(`(() => {
  els.localResourcePickerBtn.focused = false;
  localResourcePreflightItems = [{ client_id: "discard-only", name: "discard.txt", status: "ready", content: "discard body", content_hash_sha256: "a".repeat(64), extracted_text_sha256: "b".repeat(64) }];
  discardLocalResourcePreflight("discard-only");
  return { pending: localResourcePreflightItems.length, pickerFocused: Boolean(els.localResourcePickerBtn.focused), status: els.localResourceStatus.textContent };
})()`, context);
assert.equal(discardFocus.pending, 0);
assert.equal(discardFocus.pickerFocused, true);
assert.match(discardFocus.status, /No files waiting/i);

const corpusUsageLabel = vm.runInContext(`(() => {
  state.resources = [{ id: "usage-1", collection_kind: "user_import", type: "document", title: "Usage.txt" }];
  state.contentStore = { "usage-1": "x".repeat(123) };
  renderLocalResourceLibrary();
  return els.localResourceCount.textContent;
})()`, context);
assert.match(corpusUsageLabel, /1\/200 files[\s\S]*123\/10,000,000 characters/);

// Positive per-file acknowledgements are mandatory, and a refresh error cannot relabel a committed write as unchanged.
context.__commitTemplate = {
  client_id: "commit-1", name: "commit.txt", type_label: "TXT", kind: "document",
  content_type: "text/plain", content_hash_sha256: "e".repeat(64),
  extracted_text_sha256: "f".repeat(64), byte_size: 12, extracted_chars: 80,
  content: "This is a confirmed and searchable local resource body with enough details for testing.",
  status: "ready", collision_action: "add"
};
context.__acklessPromise = createPromise(context, `(() => {
  localResourcePreflightItems = [{ ...globalThis.__commitTemplate }];
  sendMessage = async () => ({ ok: true, results: [] });
  refreshAll = async () => {};
  return commitLocalResourcePreflight();
})()`);
await context.__acklessPromise;
const ackless = vm.runInContext("({ pending: localResourcePreflightItems.length, status: els.localResourceStatus.textContent })", context);
assert.equal(ackless.pending, 1);
assert.match(ackless.status, /Outcome unconfirmed[\s\S]*verify/i);

context.__committedRefreshPromise = createPromise(context, `(() => {
  localResourcePreflightItems = [{ ...globalThis.__commitTemplate }];
  sendMessage = async (_type, request) => ({
    ok: true,
    expected_index_revision: request.resources[0].expected_index_revision,
    committed_index_revision: request.resources[0].expected_index_revision + 1,
    results: request.resources.map((item) => ({
      client_id: item.client_id, ok: true, operation: item.operation, status: "added",
      resource_id: "user_import:" + item.content_hash_sha256,
      content_hash_sha256: item.content_hash_sha256,
      extracted_text_sha256: item.extracted_text_sha256,
      previous_resource_id: "",
      expected_index_revision: item.expected_index_revision,
      committed_index_revision: item.expected_index_revision + 1
    }))
  });
  refreshAll = async () => { throw new Error("display unavailable"); };
  return commitLocalResourcePreflight();
})()`);
await context.__committedRefreshPromise;
const committedRefresh = vm.runInContext("({ pending: localResourcePreflightItems.length, status: els.localResourceStatus.textContent })", context);
assert.equal(committedRefresh.pending, 0);
assert.match(committedRefresh.status, /Confirmed 1 local file[\s\S]*display could not refresh/);
assert.doesNotMatch(committedRefresh.status, /left unchanged/i);

context.__explicitRejectPromise = createPromise(context, `(() => {
  localResourcePreflightItems = [{ ...globalThis.__commitTemplate }];
  sendMessage = async () => ({ ok: false, error: "local_resource_budget_exceeded", detail: "Remove a file." });
  refreshAll = async () => { throw new Error("refresh should not run for explicit rejection"); };
  return commitLocalResourcePreflight();
})()`);
await context.__explicitRejectPromise;
const explicitReject = vm.runInContext("({ pending: localResourcePreflightItems.length, status: els.localResourceStatus.textContent })", context);
assert.equal(explicitReject.pending, 1);
assert.match(explicitReject.status, /No files were stored/);
assert.match(explicitReject.status, /left unchanged/);

context.__multiBatchRevisions = [];
context.__multiBatchPromise = createPromise(context, `(() => {
  state.meta = { index_revision: 70 };
  localResourcePreflightItems = Array.from({ length: 7 }, (_, index) => ({
    ...globalThis.__commitTemplate,
    client_id: "batch-" + index,
    name: "batch-" + index + ".txt",
    content_hash_sha256: String(index + 1).repeat(64),
    extracted_text_sha256: String(index + 2).repeat(64)
  }));
  sendMessage = async (_type, request) => {
    const expected = request.resources[0].expected_index_revision;
    globalThis.__multiBatchRevisions.push(expected);
    const committed = expected + 1;
    return {
      ok: true, expected_index_revision: expected, committed_index_revision: committed,
      results: request.resources.map((item) => ({
        client_id: item.client_id, ok: true, operation: item.operation, status: "added",
        resource_id: "user_import:" + item.content_hash_sha256,
        content_hash_sha256: item.content_hash_sha256,
        extracted_text_sha256: item.extracted_text_sha256,
        previous_resource_id: "",
        expected_index_revision: expected,
        committed_index_revision: committed
      }))
    };
  };
  refreshAll = async () => {};
  return commitLocalResourcePreflight();
})()`);
await context.__multiBatchPromise;
assert.deepEqual(Array.from(context.__multiBatchRevisions), [70, 71]);
assert.equal(vm.runInContext("localResourcePreflightItems.length", context), 0);

const strictReceiptContract = vm.runInContext(`(() => {
  const payload = { ...localResourceUpsertPayload(globalThis.__commitTemplate), expected_index_revision: 9 };
  const valid = { client_id: payload.client_id, ok: true, operation: "add", status: "added",
    resource_id: "user_import:" + payload.content_hash_sha256, content_hash_sha256: payload.content_hash_sha256,
    extracted_text_sha256: payload.extracted_text_sha256, previous_resource_id: "", expected_index_revision: 9,
    committed_index_revision: 10 };
  return { valid: localResourceUpsertAckMatches(payload, valid, 10), wrongId: localResourceUpsertAckMatches(payload, { ...valid, resource_id: "user_import:wrong" }, 10), ackOnly: localResourceUpsertAckMatches(payload, { client_id: payload.client_id, ok: true }, 10) };
})()`, context);
assert.equal(strictReceiptContract.valid, true);
assert.equal(strictReceiptContract.wrongId, false);
assert.equal(strictReceiptContract.ackOnly, false);

// PDF page bounds fail before extraction and always clean up parser state.
context.__pdfDestroyed = 0;
context.pdfjsLib = {
  GlobalWorkerOptions: {},
  getDocument() {
    return {
      promise: Promise.resolve({
        numPages: 751,
        async destroy() { context.__pdfDestroyed += 1; }
      }),
      async destroy() { context.__pdfDestroyed += 1; }
    };
  }
};
context.__pdfPromise = createPromise(context, "extractPdfText(new ArrayBuffer(8)).then(() => 'accepted', error => String(error.message || error))");
assert.match(await context.__pdfPromise, /more than 750 pages/i);
assert.equal(context.__pdfDestroyed, 1);

context.__pdfDestroyed = 0;
context.__pdfPageCleaned = 0;
context.pdfjsLib = {
  GlobalWorkerOptions: {},
  getDocument() {
    return {
      promise: Promise.resolve({
        numPages: 1,
        async getPage() {
          return {
            async getTextContent() { return { items: Array.from({ length: 25001 }, () => ({ str: "x" })) }; },
            cleanup() { context.__pdfPageCleaned += 1; }
          };
        },
        async destroy() { context.__pdfDestroyed += 1; }
      })
    };
  }
};
context.__pdfItemCapPromise = createPromise(context, "extractPdfText(new ArrayBuffer(8)).then(() => 'accepted', error => String(error.message || error))");
assert.match(await context.__pdfItemCapPromise, /25,000-item safety limit/i);
assert.equal(context.__pdfPageCleaned, 1);
assert.equal(context.__pdfDestroyed, 1);

context.__pastDeadlineRead = false;
context.__pastDeadlineFile = {
  name: "late.txt", size: 10,
  async arrayBuffer() { globalThis.__pastDeadlineRead = true; return new ArrayBuffer(10); }
};
context.__pastDeadlinePromise = createPromise(context, "extractLocalResourceFile(globalThis.__pastDeadlineFile, Date.now() - 1).then(() => 'accepted', error => String(error.message || error))");
assert.match(await context.__pastDeadlinePromise, /aggregate extraction limit/i);
assert.equal(context.__pastDeadlineRead, false);

// User imports cannot impersonate official evidence, and stale evidence is explicit in the prompt.
context.__userImpostor = {
  id: "user-x1", collection_kind: "user_import", content_origin: "user_import",
  type: "document", title: "Official Tsinghua X1 Visa Admission Notice",
  text: "Bring the JW202 form and Tsinghua University Admission Notice for the visa application."
};
context.__arrivalPack = {
  id: "pack-arrival", source_pack_id: "schwarzman-c11",
  source_pack_document_id: "international-logistics-webinar", type: "document",
  title: "International Logistics Webinar",
  text: "Apply for the residence permit within 30 days after arrival."
};
const authority = vm.runInContext(`({
  sourceClass: sourceClassForResult(globalThis.__userImpostor),
  provenance: promptSourceProvenance(globalThis.__userImpostor),
  composite: buildX1ArrivalCompositeAnswer([globalThis.__userImpostor, globalThis.__arrivalPack])
})`, context);
assert.equal(authority.sourceClass, "user_import");
assert.match(authority.provenance, /not official Blackboard guidance/);
assert.equal(authority.composite, null, "A user import impersonated the required official X1 source.");

context.__genericBlackboard = {
  id: "bb-unverified", type: "document", title: "Visa application requirements",
  search_managed_blackboard_record: true, source_authority: "official",
  text: "The visa application requires the admission notice and JW202 form before submission."
};
context.__validatedBlackboard = { ...context.__genericBlackboard, id: "bb-validated", authority_verified: true };
context.__spoofedUserAuthority = { ...context.__genericBlackboard, id: "user-spoof", collection_kind: "user_import", content_origin: "user_import", authority_verified: true };
const authoritySeparation = vm.runInContext(`(() => {
  const facet = { facet_id: "F01", text: "official visa application requirements admission notice JW202" };
  const candidate = (id, result) => ({ id, parentId: id, result, text: result.text, prompt: { route_types: ["raw"] } });
  const generic = candidate("E1", globalThis.__genericBlackboard);
  const validated = candidate("E2", globalThis.__validatedBlackboard);
  return {
    genericValidated: hasValidatedSourceAuthority(globalThis.__genericBlackboard),
    validatedValidated: hasValidatedSourceAuthority(globalThis.__validatedBlackboard),
    spoofValidated: hasValidatedSourceAuthority(globalThis.__spoofedUserAuthority),
    genericProvenance: promptSourceProvenance(globalThis.__genericBlackboard),
    validatedProvenance: promptSourceProvenance(globalThis.__validatedBlackboard),
    spoofProvenance: promptSourceProvenance(globalThis.__spoofedUserAuthority),
    rankGap: semanticCandidateRankForFacet(facet, validated, facet.text) - semanticCandidateRankForFacet(facet, generic, facet.text)
  };
})()`, context);
assert.equal(authoritySeparation.genericValidated, false);
assert.equal(authoritySeparation.validatedValidated, true);
assert.equal(authoritySeparation.spoofValidated, false);
assert.equal(authoritySeparation.genericProvenance, "Blackboard-indexed resource; authority unknown");
assert.match(authoritySeparation.validatedProvenance, /validated official Blackboard\/university guidance/);
assert.match(authoritySeparation.spoofProvenance, /user-imported local resource; not official/);
assert.equal(authoritySeparation.rankGap, 5000, "Unvalidated Blackboard ownership received the explicit-authority ranking bonus.");
assert.match(sidepanelSource, /hasExplicitAuthorityIntent\(resolvedQuestion\) && hasValidatedSourceAuthority\(candidate\.result\) \? 10000 : 0/);

context.__staleSource = {
  id: "stale-1", type: "document", title: "Current deadline policy",
  search_managed_blackboard_record: true,
  text: "The application deadline is September 1 and the form is required.",
  body_verified: false, indexed_body_source: "last_known_extracted",
  body_revalidation_required: true, search_body_evidence_state: "stale_last_known_extracted"
};
context.__freshSource = {
  id: "fresh-1", type: "document", title: "Current deadline policy",
  search_managed_blackboard_record: true,
  text: "The application deadline is September 15 and the form is required.",
  body_verified: true, indexed_body_source: "extracted",
  search_body_evidence_state: "verified_extracted"
};
const freshness = vm.runInContext(`(() => {
  const prompt = answerPromptSource(globalThis.__staleSource, 0, 5000);
  return {
    prompt,
    serialized: formatSourcesForPrompt([prompt]),
    chosen: directAnswerSourceWithEvidence([globalThis.__staleSource, globalThis.__freshSource], null, [])
  };
})()`, context);
assert.equal(freshness.prompt.body_evidence_state, "stale_last_known_extracted");
assert.equal(freshness.prompt.body_revalidation_required, true);
assert.match(freshness.prompt.provenance, /stale last-known extraction; revalidation pending/);
assert.match(freshness.serialized, /body_evidence_state: stale_last_known_extracted/);
assert.match(freshness.serialized, /body_revalidation_required: true/);
assert.match(freshness.serialized, /stale last-known extraction; revalidation pending/);
assert.equal(freshness.chosen.id, "fresh-1", "Comparable fresh evidence did not outrank stale retained evidence.");
assert.match(vm.runInContext("groundedAnswerPolicyInstruction()", context), /current or time-sensitive questions[\s\S]*never present stale/i);
const staleValidation = vm.runInContext(`(() => ({
  unqualified: citedAnswerValidation(
    "What is the current application deadline?",
    { text: "The current application deadline is September 1. [1]", sources: [globalThis.__staleSource] },
    [globalThis.__staleSource]
  ),
  qualified: citedAnswerValidation(
    "What is the current application deadline?",
    { text: "The last-known indexed deadline is September 1, pending revalidation, and it may be outdated. [1]", sources: [globalThis.__staleSource] },
    [globalThis.__staleSource]
  ),
  fresh: citedAnswerValidation(
    "What is the current application deadline?",
    { text: "The current application deadline is September 15. [1]", sources: [globalThis.__freshSource] },
    [globalThis.__freshSource]
  )
}))()`, context);
assert.equal(staleValidation.unqualified.ok, false);
assert.match(Array.from(staleValidation.unqualified.reasons).join(" "), /stale last-known evidence/i);
assert.equal(staleValidation.qualified.ok, true);
assert.equal(staleValidation.fresh.ok, true);

// Stale readable bodies are queued, hydrated through bounded STORE_CONTENT_BATCH calls, and never written one-at-a-time.
context.__hydrationCalls = [];
context.__hydrationResources = Array.from({ length: 7 }, (_, index) => ({
  id: "hydrate-" + index,
  url: "https://blackboard.example/file-" + index + ".pdf",
  type: "pdf",
  title: "Hydration file " + index,
  body_verified: false,
  indexed_body_source: "last_known_extracted",
  body_revalidation_required: true,
  hydration_token: "token-" + index
}));
context.__hydrationPromise = createPromise(context, `(() => {
  state.contentStore = Object.fromEntries(globalThis.__hydrationResources.map((resource) => [
    resource.id,
    "Retained last-known extracted body that remains searchable while its attachment is revalidated."
  ]));
  state.hydrationDiagnostics = {};
  extractSearchableResourceContent = async (resource) => ({
    content: "Fresh verified extracted attachment body for " + resource.id + " with enough searchable detail.",
    content_fingerprint: "1".repeat(64),
    extracted_text_sha256: "2".repeat(64)
  });
  sendMessage = async (type, request) => {
    globalThis.__hydrationCalls.push({ type, request });
    return {
      ok: true,
      stored: request.entries.map((entry) => ({
        resource_id: entry.resource_id,
        status: "stored",
        content_length: entry.content.length,
        content_fingerprint: entry.content_fingerprint,
        extracted_text_sha256: entry.extracted_text_sha256,
        expected_hydration_token: entry.expected_hydration_token,
        consumed_hydration_token: entry.expected_hydration_token
      }))
    };
  };
  return hydrateResourceContentBatch(globalThis.__hydrationResources);
})()`);
const hydrationResult = await context.__hydrationPromise;
assert.equal(hydrationResult.hydrated, 7);
assert.equal(hydrationResult.failed, 0);
assert.deepEqual(Array.from(context.__hydrationCalls, (call) => call.type), ["STORE_CONTENT_BATCH", "STORE_CONTENT_BATCH"]);
assert.deepEqual(Array.from(context.__hydrationCalls, (call) => call.request.entries.length), [6, 1]);
assert.ok(context.__hydrationCalls.every((call) => call.request.entries.every((entry) =>
  entry.content_fingerprint.length === 64 &&
  entry.extracted_text_sha256.length === 64 &&
  entry.expected_hydration_token.startsWith("token-")
)));

// On-demand hydration is concurrency-bounded even when a caller requests a higher limit.
context.__concurrentHydrationResources = Array.from({ length: 5 }, (_, index) => ({
  id: "concurrent-hydrate-" + index,
  url: "https://blackboard.example/concurrent-" + index + ".pdf",
  type: "pdf",
  title: "Concurrent hydration file " + index,
  body_verified: false,
  needs_body_hydration: true,
  hydration_token: "concurrent-token-" + index
}));
context.__concurrentHydrationPromise = createPromise(context, `(() => {
  state.contentStore = {};
  state.hydrationDiagnostics = {};
  globalThis.__activeHydrations = 0;
  globalThis.__maximumActiveHydrations = 0;
  extractSearchableResourceContent = async (resource) => {
    globalThis.__activeHydrations += 1;
    globalThis.__maximumActiveHydrations = Math.max(
      globalThis.__maximumActiveHydrations,
      globalThis.__activeHydrations
    );
    await new Promise((resolve) => setTimeout(resolve, 8));
    globalThis.__activeHydrations -= 1;
    return {
      content: "Fresh verified searchable body for " + resource.id + " with detailed indexed evidence.",
      content_fingerprint: "5".repeat(64),
      extracted_text_sha256: "6".repeat(64)
    };
  };
  sendMessage = async (_type, request) => ({
    ok: true,
    stored: request.entries.map((entry) => ({
      resource_id: entry.resource_id,
      status: "stored",
      content_length: entry.content.length,
      content_fingerprint: entry.content_fingerprint,
      extracted_text_sha256: entry.extracted_text_sha256,
      expected_hydration_token: entry.expected_hydration_token,
      consumed_hydration_token: entry.expected_hydration_token
    }))
  });
  return hydrateResourceContentBatch(globalThis.__concurrentHydrationResources, "", { concurrency: 99 });
})()`);
const concurrentHydration = await context.__concurrentHydrationPromise;
assert.equal(concurrentHydration.hydrated, 5);
assert.equal(concurrentHydration.attempted, 5);
assert.equal(context.__maximumActiveHydrations, 2, "File extraction exceeded the two-request concurrency ceiling.");

// A failed extraction is not retried by every subsequent question.
context.__cooldownHydrationResource = {
  id: "cooldown-hydrate",
  url: "https://blackboard.example/cooldown.pdf",
  type: "pdf",
  title: "Cooldown hydration file",
  body_verified: false,
  needs_body_hydration: true,
  hydration_token: "cooldown-token"
};
context.__cooldownHydrationPromise = createPromise(context, `(() => {
  const resource = globalThis.__cooldownHydrationResource;
  state.contentStore = {};
  extractSearchableResourceContent = async () => { throw new Error("temporary extraction failure"); };
  return hydrateResourceContentBatch([resource]).then((result) => ({
    result,
    retryEligible: shouldHydrateResourceContent(resource, true)
  }));
})()`);
const cooldownHydration = await context.__cooldownHydrationPromise;
assert.equal(cooldownHydration.result.failed, 1);
assert.equal(cooldownHydration.retryEligible, false, "A failed file bypassed the hydration retry cooldown.");

// A broad question with strong readable evidence answers immediately and moves unread files to background work.
context.__transportHydrationResources = Array.from({ length: 6 }, (_, index) => ({
  id: "transport-unread-" + index,
  url: "https://blackboard.example/transport-" + index + ".pdf",
  type: "pdf",
  title: "Beijing transportation reference " + index,
  context: "Beijing transportation subway ride hailing shared bikes and trains",
  body_verified: false,
  needs_body_hydration: true,
  hydration_token: "transport-token-" + index
}));
context.__readableTransportResult = {
  id: "transport-readable",
  resource_id: "transport-readable",
  kind: "document",
  title: "Public Transportation in Beijing",
  source: "Schwarzman C11 community resources",
  url: "https://community.example/transport",
  text: "Beijing transportation includes the subway, ride hailing, shared bikes, high speed trains, and the 12306 railway service. This indexed guide explains practical navigation and payment details.",
  has_body: true,
  score: 500
};
context.__transportPlan = vm.runInContext(`(() => {
  state.resources = globalThis.__transportHydrationResources;
  state.contentStore = {};
  return targetedHydrationPlan(
    "How should I navigate transportation in Beijing?",
    "Beijing transportation subway ride hailing shared bike high speed train 12306",
    [globalThis.__readableTransportResult],
    defaultRagPlan("How should I navigate transportation in Beijing?")
  );
})()`, context);
assert.equal(context.__transportPlan.canAnswerImmediately, true);
assert.equal(context.__transportPlan.blockingCandidates.length, 0);
assert.equal(context.__transportPlan.backgroundCandidates.length, 6);

context.__transportBlockingPlan = vm.runInContext(`targetedHydrationPlan(
  "How should I navigate transportation in Beijing?",
  "Beijing transportation subway ride hailing shared bike high speed train 12306",
  [{ ...globalThis.__readableTransportResult, has_body: false, text: "Blackboard file listing" }],
  defaultRagPlan("How should I navigate transportation in Beijing?")
)`, context);
assert.equal(context.__transportBlockingPlan.canAnswerImmediately, false);
assert.equal(context.__transportBlockingPlan.blockingCandidates.length, 2);
assert.equal(context.__transportBlockingPlan.backgroundCandidates.length, 4);

context.__hydrationRefreshes = 0;
context.__hydrationUnconfirmedPromise = createPromise(context, `(() => {
  const resource = { ...globalThis.__hydrationResources[0],
    body_verified: false, indexed_body_source: "last_known_extracted",
    body_revalidation_required: true, hydration_token: "token-unconfirmed"
  };
  state.contentStore = { [resource.id]: "Retained stale body pending revalidation with enough readable text." };
  extractSearchableResourceContent = async () => ({
    content: "Fresh body whose write receipt will be intentionally incomplete for the test.",
    content_fingerprint: "3".repeat(64), extracted_text_sha256: "4".repeat(64)
  });
  sendMessage = async () => ({ ok: true, stored: [{ resource_id: resource.id, content_length: 72 }] });
  refreshAll = async () => { globalThis.__hydrationRefreshes += 1; };
  return hydrateResourceContentBatch([resource]);
})()`);
const hydrationUnconfirmed = await context.__hydrationUnconfirmedPromise;
assert.equal(hydrationUnconfirmed.hydrated, 0);
assert.equal(hydrationUnconfirmed.failed, 1);
assert.equal(context.__hydrationRefreshes, 1);
assert.match(vm.runInContext("state.hydrationDiagnostics[globalThis.__hydrationResources[0].id].error", context), /outcome unconfirmed/i);
assert.doesNotMatch(
  sidepanelSource.slice(sidepanelSource.indexOf("async function hydrateResourceContentBatch"), sidepanelSource.indexOf("function shouldHydrateResourceContent")),
  /sendMessage\("STORE_CONTENT"/,
  "The production hydrator still performs one worker write per resource."
);

context.__removeBehaviorPromise = createPromise(context, `(() => {
  const resource = { id: "user_import:" + "a".repeat(64), collection_kind: "user_import", type: "document", title: "Remove.txt", original_file_name: "Remove.txt", content_hash_sha256: "a".repeat(64), extracted_text_sha256: "b".repeat(64) };
  state.resources = [resource]; state.contentStore = { [resource.id]: "Readable removal body." }; state.meta = { index_revision: 12 };
  els.localResourcePickerBtn.focused = false;
  sendMessage = async (_type, payload) => ({
    ok: true, status: "removed", removed: 1, resource_id: payload.resource_id,
    removed_hash_sha256: payload.expected_previous_hash_sha256,
    removed_extracted_text_sha256: payload.expected_previous_extracted_text_sha256,
    expected_index_revision: payload.expected_index_revision,
    removed_at_index_revision: payload.expected_index_revision,
    committed_index_revision: payload.expected_index_revision + 1
  });
  refreshAll = async () => { state.resources = []; state.contentStore = {}; state.meta = { index_revision: 13 }; };
  return removeLocalResource(resource.id).then(() => ({ focused: Boolean(els.localResourcePickerBtn.focused), status: els.localResourceStatus.textContent }));
})()`);
const removeBehavior = await context.__removeBehaviorPromise;
assert.equal(removeBehavior.focused, true);
assert.match(removeBehavior.status, /Removed/i);

context.__removeUnconfirmedPromise = createPromise(context, `(() => {
  const resource = { id: "user_import:" + "c".repeat(64), collection_kind: "user_import", type: "document", title: "Unconfirmed.txt", original_file_name: "Unconfirmed.txt", content_hash_sha256: "c".repeat(64), extracted_text_sha256: "d".repeat(64) };
  state.resources = [resource]; state.contentStore = { [resource.id]: "Readable unconfirmed removal body." }; state.meta = { index_revision: 20 };
  sendMessage = async () => { throw new Error("response channel closed"); };
  return removeLocalResource(resource.id).then(() => "unexpected success", () => els.localResourceStatus.textContent);
})()`);
assert.match(await context.__removeUnconfirmedPromise, /outcome is unconfirmed[\s\S]*verify before retrying/i);

const busyGuards = await createPromise(context, `(() => {
  localResourceBusy = true;
  els.queryInput.value = "Question must remain in the composer";
  let crawlCalls = 0;
  crawlSite = async () => { crawlCalls += 1; };
  return Promise.all([
    handleAsk({ preventDefault() {} }),
    handleIndexCommand("/reindex")
  ]).then(() => ({ query: els.queryInput.value, crawlCalls, status: els.localResourceStatus.textContent }));
})()`);
assert.equal(busyGuards.query, "Question must remain in the composer");
assert.equal(busyGuards.crawlCalls, 0);
assert.match(busyGuards.status, /Finish the current My resources change/i);
vm.runInContext("localResourceBusy = false", context);
assert.equal(vm.runInContext("shouldHydrateResourceContent({ ...globalThis.__staleSource, url: 'https://blackboard.example/stale.pdf' }, true)", context), true);

// Transactional reindex is direct; no destructive pre-clear is performed by the side panel.
const reindexSource = sidepanelSource.slice(
  sidepanelSource.indexOf("async function handleIndexCommand"),
  sidepanelSource.indexOf("function isFeedbackCommand")
);
assert.match(reindexSource, /crawlSite\(\{ fullReindex: isFullReindex \}\)/);
assert.doesNotMatch(reindexSource, /CLEAR_INDEX|refreshAll\(/);
assert.match(sidepanelSource, /sendMessage\(fullReindex \? "REINDEX_SITE" : "CRAWL_SITE"/);
assert.match(sidepanelSource, /els\.crawlBtn\.addEventListener\("click"[\s\S]*crawlSite\(\{ fullReindex: true \}\)/);

console.log(
  "Local-resource checks passed (format truthfulness, decoding/ZIP/PDF bounds, semantic XLSX, aggregate limits, dual-hash identity, CAS payloads, strict mutation acknowledgements, authority isolation, stale-evidence prompt policy, batched revalidation, direct transactional reindex, and static accessibility/disclosure wiring)."
);

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf8");
    const body = Buffer.from(value, "utf8");
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...localParts, central, eocd]);
  return new Uint8Array(archive).buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPromise(target, expression) {
  vm.runInContext(`globalThis.__createdPromise = ${expression};`, target);
  return target.__createdPromise;
}
