// Provider API client and prompt source formatting helpers.
// Loaded before sidepanel.js.

const CHAT_COMPLETION_MAX_TOKENS = 5000;
const CHAT_COMPLETION_TRANSIENT_ATTEMPTS = 3;
const CHAT_COMPLETION_RETRY_BASE_MS = 250;
const CHAT_COMPLETION_RETRY_MAX_MS = 2000;
const CHAT_COMPLETION_TIMEOUT_MAX_MS = 120000;

async function callChatCompletion({
  provider,
  apiKey,
  model,
  messages,
  maxTokens = 1400,
  temperature = 0,
  timeoutMs = 45000
}) {
  const config = providerConfig(provider, apiKey);
  const normalizedTemperature = Math.max(0, Math.min(1, Number(temperature) || 0));
  const normalizedTimeoutMs = Math.max(1000, Math.min(CHAT_COMPLETION_TIMEOUT_MAX_MS, Number(timeoutMs) || 45000));
  let tokenBudget = Math.max(100, Math.min(CHAT_COMPLETION_MAX_TOKENS, Math.round(Number(maxTokens) || 1400)));
  let retriedForLength = false;

  while (true) {
    const json = await requestChatCompletionJson({
      config,
      model,
      messages,
      temperature: normalizedTemperature,
      maxTokens: tokenBudget,
      timeoutMs: normalizedTimeoutMs
    });
    const choice = json.choices?.[0] || null;
    const finishReason = String(choice?.finish_reason || "").trim().toLowerCase();

    if (finishReason === "length") {
      if (retriedForLength) {
        throw new Error("Provider response was truncated again after retrying with a larger token budget.");
      }
      if (tokenBudget >= CHAT_COMPLETION_MAX_TOKENS) {
        throw new Error("Provider response was truncated at the maximum token budget.");
      }
      tokenBudget = largerCompletionTokenBudget(tokenBudget);
      retriedForLength = true;
      continue;
    }
    if (finishReason && finishReason !== "stop") {
      const safeReason = finishReason.replace(/[^a-z0-9_.-]/g, "_").slice(0, 80) || "unknown";
      throw new Error(`Provider returned an unusable completion (finish_reason: ${safeReason}).`);
    }

    const content = choice?.message?.content || choice?.text || "";
    if (typeof content !== "string") throw new Error("Provider returned malformed answer content.");
    if (!content.trim()) throw new Error("Provider returned an empty answer.");
    return content;
  }
}

async function requestChatCompletionJson({ config, model, messages, temperature, maxTokens, timeoutMs }) {
  for (let attempt = 0; attempt < CHAT_COMPLETION_TRANSIENT_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let text = "";

    try {
      response = await fetch(config.url, {
        method: "POST",
        headers: config.headers,
        signal: controller.signal,
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens })
      });
      text = await response.text();
    } catch (error) {
      clearTimeout(timeout);
      if (attempt + 1 < CHAT_COMPLETION_TRANSIENT_ATTEMPTS) {
        await waitForProviderRetry(providerRetryBackoffMs(attempt));
        continue;
      }
      if (isProviderTimeoutError(error)) {
        throw new Error(`Provider request timed out after ${CHAT_COMPLETION_TRANSIENT_ATTEMPTS} attempts.`);
      }
      const detail = String(error?.message || error || "Network request failed").slice(0, 220);
      throw new Error(`Provider network request failed after ${CHAT_COMPLETION_TRANSIENT_ATTEMPTS} attempts: ${detail}`);
    } finally {
      clearTimeout(timeout);
    }

    const parsed = tryParseProviderJson(text);
    if (!response.ok) {
      if (isTransientProviderStatus(response.status) && attempt + 1 < CHAT_COMPLETION_TRANSIENT_ATTEMPTS) {
        await waitForProviderRetry(providerRetryDelayMs(response, attempt));
        continue;
      }
      if (!parsed) {
        throw new Error(`Provider returned HTTP ${response.status} with a non-JSON response: ${text.slice(0, 180)}`);
      }
      const message = parsed.error?.message || parsed.message || text || `HTTP ${response.status}`;
      throw new Error(String(message));
    }

    if (!parsed) throw new Error(`Provider returned non-JSON response: ${text.slice(0, 180)}`);
    return parsed;
  }

  throw new Error("Provider request failed after bounded retries.");
}

function tryParseProviderJson(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function isTransientProviderStatus(status) {
  const code = Number(status) || 0;
  return code === 408 || code === 429 || (code >= 500 && code <= 599);
}

function isProviderTimeoutError(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError" || /timed?\s*out/i.test(String(error?.message || ""));
}

function largerCompletionTokenBudget(current) {
  return Math.min(CHAT_COMPLETION_MAX_TOKENS, Math.max(current + 400, Math.ceil(current * 1.75)));
}

function providerRetryBackoffMs(attempt) {
  return Math.min(CHAT_COMPLETION_RETRY_MAX_MS, CHAT_COMPLETION_RETRY_BASE_MS * (2 ** Math.max(0, attempt)));
}

function providerRetryDelayMs(response, attempt) {
  const fallback = providerRetryBackoffMs(attempt);
  const value = String(response?.headers?.get?.("Retry-After") || "").trim();
  if (!value) return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(CHAT_COMPLETION_RETRY_MAX_MS, seconds * 1000));
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return fallback;
  return Math.max(0, Math.min(CHAT_COMPLETION_RETRY_MAX_MS, timestamp - Date.now()));
}

function waitForProviderRetry(delayMs) {
  const bounded = Math.max(0, Math.min(CHAT_COMPLETION_RETRY_MAX_MS, Number(delayMs) || 0));
  return bounded ? new Promise((resolve) => setTimeout(resolve, bounded)) : Promise.resolve();
}

function providerConfig(provider, apiKey) {
  const commonHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };
  if (provider === "openai") {
    return {
      url: "https://api.openai.com/v1/chat/completions",
      headers: commonHeaders
    };
  }
  if (provider === "deepseek") {
    return {
      url: "https://api.deepseek.com/v1/chat/completions",
      headers: commonHeaders
    };
  }
  return {
    url: "https://openrouter.ai/api/v1/chat/completions",
    headers: {
      ...commonHeaders,
      "HTTP-Referer": "chrome-extension://blackboard-transcript-search",
      "X-Title": "Blackboard Search Extension"
    }
  };
}

function escapePromptSourceField(value, { attribute = false } = {}) {
  let escaped = String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  if (attribute) escaped = escaped.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return escaped;
}

function formatSourcesForPrompt(sources) {
  return sources
    .map((source) => {
      const field = (value) => escapePromptSourceField(value);
      return [
        `<SOURCE id="${escapePromptSourceField(source.id, { attribute: true })}">`,
        `kind: ${field(source.kind)}`,
        source.source_class ? `source_class: ${field(source.source_class)}` : "",
        `authority_validated: ${source.authority_validated === true ? "true" : "false"}`,
        source.body_evidence_state ? `body_evidence_state: ${field(source.body_evidence_state)}` : "",
        `body_revalidation_required: ${source.body_revalidation_required === true ? "true" : "false"}`,
        source.provenance ? `provenance: ${field(source.provenance)}` : "",
        `title: ${field(source.title)}`,
        `source: ${field(source.source)}`,
        source.page_range ? `location: pages ${field(source.page_range)}` : "",
        source.timestamp ? `timestamp: ${field(source.timestamp)}` : "",
        source.url ? `url: ${field(source.url)}` : "",
        "text:",
        field(source.text),
        "</SOURCE>"
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}
