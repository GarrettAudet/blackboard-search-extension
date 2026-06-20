import { spawnSync } from "node:child_process";
import fs from "node:fs";

const checks = [
  ["node", ["--check", "background/service-worker.js"]],
  ["node", ["--check", "content/scraper.js"]],
  ["node", ["--check", "sidepanel/sidepanel.js"]],
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
