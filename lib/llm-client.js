// Provider API client and prompt source formatting helpers.
// Loaded before sidepanel.js.

async function callChatCompletion({ provider, apiKey, model, messages }) {
  const config = providerConfig(provider, apiKey);
  const response = await fetch(config.url, {
    method: "POST",
    headers: config.headers,
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 5000
    })
  });

  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_error) {
    throw new Error(`Provider returned non-JSON response: ${text.slice(0, 180)}`);
  }

  if (!response.ok) {
    const message = json.error?.message || json.message || text || `HTTP ${response.status}`;
    throw new Error(message);
  }

  const content = json.choices?.[0]?.message?.content || json.choices?.[0]?.text || "";
  if (!content) throw new Error("Provider returned an empty answer.");
  return content;
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

function formatSourcesForPrompt(sources) {
  return sources
    .map((source) =>
      [
        `<SOURCE id="${source.id}">`,
        `kind: ${source.kind}`,
        `title: ${source.title}`,
        `source: ${source.source}`,
        source.timestamp ? `timestamp: ${source.timestamp}` : "",
        source.url ? `url: ${source.url}` : "",
        "text:",
        source.text,
        "</SOURCE>"
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");
}

