#!/usr/bin/env node
/**
 * Read-only privacy gate for the public repository export.
 *
 * The development repository keeps its existing history. This check is run
 * against the tracked public tree before it is released.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = new Set(process.argv.slice(2));
const root = resolve(process.cwd());
const excluded = [
  /^\.git\//,
  /^docs\/(handoffs|reports)\//,
  /^docs\/active-task-recovery-ledger\.md$/,
  /^test-output\//,
  /^build-trial\//,
  /^data\//,
  /^\.env(?:\.|$)/,
  /^apps\/desktop\/local-api-bundle\//,
  /^scripts\/verify-public-history\.mjs$/,
];
const binaryExtensions = /\.(onnx|bin|wasm|png|jpe?g|gif|webp|ico|glb|gltf|rvt|rfa|jt|x_b|x_t|zip|7z|exe|dll|pdb|mp4|webm|woff2?)$/i;

// These are private identifiers and local paths that must not enter a public
// release tree.
const forbidden = [
  /[A-Z]:\\Users\\[^\\\r\n]+/i,
  /D:\\Documents\\(?:ChatGPT|bim)\\[^\r\n]*/i,
];

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean).filter((file) => !excluded.some((re) => re.test(file)));
}

const findings = [];
for (const file of trackedFiles()) {
  const full = resolve(root, file);
  if (!existsSync(full)) continue;
  if (binaryExtensions.test(file)) continue;
  let text;
  try { text = readFileSync(full, 'utf8'); } catch { continue; }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (forbidden.some((pattern) => pattern.test(line))) {
      findings.push(`${file}:${index + 1}`);
    }
  });
}

if (args.has('--history')) {
  for (const pattern of forbidden) {
    const result = execFileSync('git', ['log', '--all', '--oneline', '-S', pattern.source], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (result) console.log(`history-match ${pattern}:\n${result}`);
  }
}

if (findings.length) {
  console.error(`public-history: ${findings.length} forbidden match(es)`);
  findings.slice(0, 50).forEach((item) => console.error(`  ${item}`));
  process.exit(1);
}
console.log(`public-history: PASS (${trackedFiles().length} exported-path candidates scanned)`);
