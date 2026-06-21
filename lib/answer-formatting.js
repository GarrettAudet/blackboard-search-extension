// Answer text cleanup and citation/source alignment helpers.
// Loaded before sidepanel.js.

function cleanAnswerText(value, sourceCount = 0) {
  let text = stripPlainTextMarkdown(stripInlineLinksSection(stripInlineSourcesSection(decodeBasicHtmlEntities(String(value || "").trim()))));
  text = text.replace(/\]\s*\[/g, "], [");
  if (sourceCount > 0) {
    text = text.replace(/\[(\d+)\]/g, (match, numberText) => {
      const number = Number.parseInt(numberText, 10);
      return number >= 1 && number <= sourceCount ? match : "";
    });
  }
  return text
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeBasicHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;/gi, "-")
    .replace(/&mdash;/gi, "-")
    .replace(/&hellip;/gi, "...")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : " ";
    })
    .replace(/&#(\d+);/g, (_match, number) => {
      const codePoint = Number.parseInt(number, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : " ";
    });
}

function stripPlainTextMarkdown(text) {
  return String(text || "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/`([^`\n]+)`/g, "$1");
}
function alignAnswerCitations(value, sources = []) {
  const sourceList = Array.isArray(sources) ? sources : [];
  const placeholderPrefix = "__BB_SOURCE_CITATION_";
  const used = [];
  const seen = new Set();
  let text = String(value || "").replace(/\[(\d+)\]/g, (match, numberText) => {
    const sourceNumber = Number.parseInt(numberText, 10);
    if (!Number.isFinite(sourceNumber) || sourceNumber < 1 || sourceNumber > sourceList.length) return "";
    if (!seen.has(sourceNumber)) {
      seen.add(sourceNumber);
      used.push(sourceNumber);
    }
    return `${placeholderPrefix}${sourceNumber}__`;
  });

  if (!used.length) {
    return {
      text: cleanAnswerText(text, sourceList.length),
      sources: sourceList.slice(0, Math.min(4, sourceList.length))
    };
  }

  const remap = new Map(used.map((sourceNumber, index) => [sourceNumber, index + 1]));
  text = text.replace(new RegExp(`${placeholderPrefix}(\\d+)__`, "g"), (_match, numberText) => {
    const sourceNumber = Number.parseInt(numberText, 10);
    return `[${remap.get(sourceNumber)}]`;
  });
  return {
    text: cleanAnswerText(text, used.length),
    sources: used.map((sourceNumber) => sourceList[sourceNumber - 1]).filter(Boolean)
  };
}

function stripInlineSourcesSection(text) {
  return String(text || "")
    .replace(/\n{2,}\s*(Sources|Resources used|References)\s*:\s*[\s\S]*$/i, "")
    .trim();
}

function stripInlineLinksSection(text) {
  const lines = String(text || "").split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (isStandaloneSourceUrlLine(line)) continue;
    if (isInlineLinkHeading(line)) continue;
    const withoutSourceUrls = line.replace(/\s*[-*:]?\s*https?:\/\/[^\s)]+(?:blackboard|tsinghua|panopto)[^\s)]*/gi, "").trimEnd();
    const withoutLinkHeading = stripTrailingInlineLinkHeading(withoutSourceUrls);
    if (!withoutLinkHeading.trim() && line !== "") continue;
    kept.push(withoutLinkHeading);
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isStandaloneSourceUrlLine(line) {
  return /^\s*(?:[-*]\s*)?https?:\/\/\S+\s*$/i.test(String(line || ""));
}

function stripTrailingInlineLinkHeading(line) {
  return String(line || "")
    .replace(
      /\s*(?:links? to (?:the )?(?:relevant )?blackboard courses? are|relevant blackboard courses? are|blackboard links? are|direct links? are|for direct access(?: and further exploration)?(?:,? the course link is)?):?\s*$/i,
      ""
    )
    .trimEnd();
}

function isInlineLinkHeading(line) {
  return /^\s*(?:[-*]\s*)?(?:links?|direct links?|relevant links?|blackboard links?|links? to (?:the )?(?:relevant )?blackboard courses?|for direct access(?: and further exploration)?)[^:]{0,120}:\s*$/i.test(
    String(line || "")
  );
}