# Blackboard Search Extension

Blackboard Search Extension is a Chrome side-panel extension for searching Blackboard course materials and asking grounded questions about them. It indexes the Blackboard pages and files a signed-in user can already access, stores that searchable index locally in Chrome, and answers questions from the best-matching sources using a user-configured API provider.

The project is intentionally built as a local-first browser extension: there is no shared application server, no central Blackboard corpus, and no attempt to bypass institutional access controls.

## Demo

![Blackboard Search Extension demo](docs/demo/blackboard-search-demo.gif)

The demo shows the core flow: index Blackboard content, ask a question, get an answer grounded in matched resources, expand the source list, and open the original Blackboard page or file.

## What It Does

- Indexes Blackboard pages available to the user's active logged-in browser session.
- Indexes course pages, announcements, links, PDFs, and readable Office-style documents.
- Stores the searchable resource index and extracted text in `chrome.storage.local`.
- Ranks local matches before sending anything to an API provider.
- Sends only the user's question and selected top snippets when API answering is enabled.
- Supports OpenAI, DeepSeek, and OpenRouter with a user-provided API key.
- Shows expandable source cards so answers can be checked against the original material.
- Provides chat commands for reindexing, feedback, and retrieval diagnostics.

## What It Does Not Do

- It does not bypass Blackboard login, roles, permissions, or file access rules.
- It does not upload the full local Blackboard index to a shared server by default.
- It does not include embedded API keys, GitHub tokens, or private write credentials.
- It does not claim affiliation with Blackboard, Anthology, or any institution.
- The `main` branch is focused on text and document search. Experimental video/transcript work should stay isolated until it does not degrade the core search experience.

## Tech Stack

- **Chrome Extension Manifest V3** for packaging, permissions, background service worker, content scripts, action icon, and side panel.
- **Chrome Side Panel API** for the chat and setup UI.
- **Vanilla JavaScript, HTML, and CSS** for the extension interface. There is no frontend build step.
- **Chrome storage APIs** for local settings, API-key presence state, resource metadata, extracted content, and indexing state.
- **Content scripts** for reading Blackboard pages from the user's authenticated browser context.
- **Background service worker** for indexing, document fetching, extraction coordination, and storage updates.
- **PDF.js** for browser-side PDF text extraction.
- **Local retrieval logic** in `lib/search-index.js` for normalization, chunk ranking, source deduplication, and snippet selection.
- **Provider client logic** in `lib/llm-client.js` for OpenAI-compatible chat completion calls.
- **Node.js scripts** for syntax checks, regression tests, prepublish checks, and store asset generation.
- **Python + Pillow** for generated Chrome Web Store artwork.

## How It Works

1. The user logs in to Blackboard normally in Chrome.
2. The extension indexes configured Blackboard domains using the user's existing browser session.
3. Resource metadata is stored in `resource_index`.
4. Extracted searchable text is stored in `content_store`.
5. A user question is normalized and matched against the local index.
6. The highest-value snippets are sent to the selected API provider with instructions to answer only from the provided excerpts.
7. The side panel renders the answer and expandable source cards.

The result is a retrieval-augmented workflow that keeps Blackboard discovery local while still letting the user ask natural-language questions.

## Privacy Model

The extension is designed around local control.

- The index, extracted text, settings, and API-key configuration are stored locally in Chrome.
- The user supplies their own API provider and key.
- When answering is enabled, the extension sends the question and top matched snippets to the configured provider.
- The full local index is not uploaded to a shared backend by default.
- Blackboard access remains governed by the user's existing Blackboard session and permissions.

For the user-facing policy, see [PRIVACY.md](PRIVACY.md).

## Install Locally

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the repository folder.
6. Open Blackboard and sign in normally.
7. Open the Blackboard Search side panel.
8. Run `/index` to build the local resource index.
9. Open **Setup** and configure the API provider, model, and API key.
10. Ask questions about indexed Blackboard materials.

After pulling updates, reload the unpacked extension from `chrome://extensions` before testing again.

## Chat Commands

```text
/index
```

Builds or refreshes the local Blackboard index. Use this after first install, after course content changes, or when a source seems missing.

```text
/feedback [optional note]
```

Opens the configured feedback form, if feedback collection is enabled. If the user includes a note, the extension can prefill the first feedback field.

```text
/audit [question]
```

Runs a local retrieval diagnostic for a question. It reports index health, top raw matches, answer sources, hydration candidates, duplicate clusters, and signs that strong evidence exists but the answer layer missed it.

## Configuration Notes

### API Providers

The default provider is OpenRouter, but the extension also supports OpenAI and DeepSeek.

Recommended model examples:

```text
openrouter/auto
openai/gpt-4.1-mini
deepseek-chat
```

The API key is entered in the extension setup screen and stored locally by Chrome. Do not commit provider API keys or private credentials to this repository.

### Feedback Form

Feedback collection is optional. Configure `FEEDBACK_FORM_URL` and `FEEDBACK_FORM_FIELD_MAP` in `sidepanel/sidepanel.js` if you want `/feedback` to open a form.

Recommended visible questions:

```text
Suggestions for the bot
```

```text
Any other issues you're experiencing that software could help with?
```

Use only public form URLs or safe field identifiers. Never embed private write tokens, service-account credentials, GitHub tokens, or provider API keys in the extension.

### Host Permissions

The manifest controls which Blackboard or institution domains the extension can access. Before publishing or forking publicly, review `host_permissions` in [manifest.json](manifest.json) and keep them limited to the domains the extension actually needs.

## Repository Structure

```text
assets/icons/                 Extension icons
background/service-worker.js  Indexing, storage, document handling, and background messages
content/scraper.js            Blackboard page extraction content script
docs/demo/                    Demo media
docs/store/                   Chrome Web Store image assets
docs/testing.md               Manual and automated release checklist
lib/answer-formatting.js      Answer cleanup and citation formatting
lib/llm-client.js             API provider request client
lib/search-index.js           Local ranking, retrieval, dedupe, and snippet logic
sample-data/                  Example-only data for development and regression tests
scripts/                      Store asset generation and publish checks
sidepanel/                    Side-panel UI, setup flow, commands, and answer rendering
manifest.json                 Chrome extension manifest
PRIVACY.md                    User-facing privacy policy
```

## Development

There is no build step. Edit the files directly, then reload the unpacked extension from `chrome://extensions`.

Useful checks:

```powershell
node --check background\service-worker.js
node --check content\scraper.js
node --check sidepanel\sidepanel.js
node scripts\regression-check.mjs
node scripts\prepublish-check.mjs
```

`node scripts\prepublish-check.mjs` is the main release gate. It parses the manifest, checks the JavaScript entry points, and runs the local retrieval/regression suite.

## Testing Before Release

Before packaging for the Chrome Web Store:

- Reload the unpacked extension and test a clean install.
- Run `/index` after signing in to Blackboard.
- Ask representative course, deadline, document, and policy questions.
- Confirm answers are grounded in indexed material.
- Expand source cards and verify that `Open source` opens the expected page or file.
- Confirm source numbering is compact and does not skip numbers.
- Confirm the answer body does not expose raw Blackboard URLs or duplicate source blocks.
- Run `node scripts\prepublish-check.mjs`.

See [docs/testing.md](docs/testing.md) for the full smoke-test and release checklist.

## Public Repository Safety

This README is written for a public repository. Before publishing a fork or release, also verify:

- No real API keys, service tokens, private write credentials, or personal access tokens are committed.
- Any feedback form URL is intended to be public.
- Manifest host permissions are scoped to the intended Blackboard domains.
- Sample data is synthetic, anonymized, or safe to share.
- Store screenshots do not reveal private student data, course rosters, grades, or institution-only materials.

## Branch Strategy

- `main`: production-oriented text and document search for Chrome Web Store packaging.
- Feature branches: isolate experimental indexing, transcript, or retrieval behavior until regression checks and manual QA show no degradation to the core text/PDF workflow.

## License

Add a license before distributing this repository publicly if one has not already been selected.
