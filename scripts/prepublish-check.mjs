import { spawnSync } from "node:child_process";
import fs from "node:fs";

const checks = [
  ["node", ["--check", "background/service-worker.js"]],
  ["node", ["--check", "content/scraper.js"]],
  ["node", ["--check", "sidepanel/sidepanel.js"]],
  ["node", ["--check", "lib/answer-formatting.js"]],
  ["node", ["--check", "lib/blackboard-session.js"]],
  ["node", ["--check", "lib/llm-client.js"]],
  ["node", ["--check", "lib/search-index.js"]],
  ["node", ["scripts/blackboard-session-check.mjs"]],
  ["node", ["scripts/crawl-resilience-check.mjs"]],
  ["node", ["scripts/llm-client-check.mjs"]],
  ["node", ["scripts/guard-routing-check.mjs"]],
  ["node", ["scripts/answer-pipeline-check.mjs"]],
  ["node", ["scripts/answer-grounding-check.mjs"]],
  ["node", ["scripts/semantic-evidence-selector-check.mjs"]],
  ["node", ["scripts/v4-diagnosed-failure-check.mjs"]],
  ["node", ["scripts/retrieval-hardening-check.mjs"]],
  ["node", ["scripts/semantic-selector-ceiling-v2.mjs"]],
  ["node", ["scripts/retrieval-quality-check.mjs"]],
  ["node", ["scripts/holdout-eval.mjs", "--seed", "prepublish", "--repeats", "3"]],
  ["node", ["scripts/live-holdout-eval.mjs", "--suite", "v1", "--self-test"]],
  ["node", ["scripts/live-holdout-eval.mjs", "--suite", "v2", "--self-test"]],
  ["node", ["scripts/resource-pack-check.mjs"]],
  ["node", ["scripts/offline-index-integration-check.mjs"]],
  ["node", ["scripts/regression-check.mjs"]]
];

function run(command, args) {
  const label = [command, ...args].join(" ");
  process.stdout.write(`\n> ${label}\n`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

JSON.parse(fs.readFileSync("manifest.json", "utf8"));
console.log("manifest ok");

for (const [command, args] of checks) run(command, args);

console.log("\nprepublish-check passed");
