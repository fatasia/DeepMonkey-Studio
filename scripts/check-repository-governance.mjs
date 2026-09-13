import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LICENSE_ID = "LicenseRef-Deep-Monkey-Community-1.0";

export const REQUIRED_FILES = [
  "README.md",
  "README.en.md",
  "LICENSE",
  "LICENSE.zh-CN.md",
  "LICENSING.md",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "SUPPORT.md",
  "GOVERNANCE.md",
  "CHANGELOG.md",
  "docs/open-source-release-checklist.md",
  "config/third-party-license-overrides.json",
  "config/repository-large-file-exceptions.json",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/dependabot.yml",
  ".github/workflows/repository-governance.yml",
];

const GOVERNANCE_DOCS = REQUIRED_FILES.filter((path) => path.endsWith(".md"));
const MAX_TRACKED_FILE_BYTES = 5 * 1024 * 1024;
const LARGE_FILE_EXCEPTIONS_PATH = "config/repository-large-file-exceptions.json";

const REQUIRED_TEXT = {
  "LICENSE": [
    "Deep Monkey Community Source License 1.0",
    "not an Open Source license",
    '"Organization" means any corporation',
    "Covered Misconduct",
    "Declaration on Fundamental Principles and Rights at Work",
    "https://www.ilo.org/topics-and-sectors/fundamental-principles-and-rights-work",
    "two days free from",
    "performance compensation, overtime",
    "unlawfully collects workers' or users' personal information",
    "视用户为韭菜，视员工为家奴",
    "social-insurance contributions",
    "consumer-protection law",
    "A Restricted Organization may not use, copy, modify, distribute, deploy, access",
    "No person may make Restricted Use",
    "Publishing source code, paying a fee",
    "all first-party applications, packages, tools, scripts",
  ],
  "README.md": ["[简体中文](README.md)", "[English](README.en.md)", "pnpm gate:repository", "对于非受限企业与个人为 MIT 协议"],
  "LICENSE.zh-CN.md": ["受约束不当行为", "ILO 基本劳动权利", "国际劳工组织关于工作中基本原则和权利宣言", "每七日", "加班报酬", "奖金、绩效报酬", "非法收集职工或用户个人信息", "社会保险", "盘剥用户", "6. 视用户为韭菜，视员工为家奴", "未实施受约束不当行为", "受限组织不得使用、复制、修改、分发、部署、访问、评估、测试、研究本软件", "公开源码、支付费用"],
  "README.en.md": ["[简体中文](README.md)", "source-available", "Publishing source or paying a fee creates no exception"],
  "LICENSING.md": ["Usage matrix", "source-available", "Prohibited for every purpose"],
  "CONTRIBUTING.md": ["Contribution certification", "pnpm gate:repository", "CHANGELOG.md"],
  "GOVERNANCE.md": ["Project Steward", "default branch must be protected", "Semantic Versioning"],
  "SECURITY.md": ["Do not disclose", "private vulnerability reporting"],
  "CHANGELOG.md": ["## Unreleased"],
  "THIRD_PARTY_NOTICES.md": ["lockfile is the authoritative inventory", "MPL-2.0", "LGPL-2.1"],
};

export function isForbiddenTrackedPath(input) {
  const path = input.replaceAll("\\", "/");
  const basename = path.split("/").at(-1) ?? path;
  if (/^\.env(?:\..+)?$/i.test(basename) && !/\.example$/i.test(basename)) return true;
  if (/\.(?:key|pem|p12|pfx|jks|keystore)$/i.test(basename)) return true;
  if (/^(?:auto\.crt|login-verification\.png)$/i.test(basename)) return true;
  return /(^|\/)(?:node_modules|dist|build|target|coverage|logs|test-output|artifacts|data|\.cache|\.runtime-logs|\.chrome-ui-check[^/]*)(\/|$)/i.test(path);
}

export function isValidPullRequestTitle(title) {
  if (!title) return true;
  return /^(?:feat|fix|docs|refactor|perf|test|build|ci|chore|revert)(?:\([a-z0-9._/-]+\))?!?: .{3,}$/u.test(title);
}

export function isValidLargeFileException(entry) {
  return Boolean(entry && typeof entry.path === "string" && entry.path.length > 0
    && !entry.path.includes("\\") && typeof entry.reason === "string" && entry.reason.trim().length >= 20
    && typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/i.test(entry.sha256));
}

function largeFileExceptions(root, fail) {
  try {
    const manifest = JSON.parse(read(root, LARGE_FILE_EXCEPTIONS_PATH));
    const entries = Array.isArray(manifest.files) ? manifest.files : [];
    const exceptions = new Map();
    for (const entry of entries) {
      if (!isValidLargeFileException(entry)) {
        fail(`${LARGE_FILE_EXCEPTIONS_PATH} contains an invalid entry`);
        continue;
      }
      if (exceptions.has(entry.path)) fail(`${LARGE_FILE_EXCEPTIONS_PATH} duplicates path: ${entry.path}`);
      exceptions.set(entry.path, entry);
    }
    return exceptions;
  } catch (error) {
    fail(`${LARGE_FILE_EXCEPTIONS_PATH} is invalid JSON: ${error.message}`);
    return new Map();
  }
}

export function findBrokenLocalLinks(root, documentPath, content) {
  const broken = [];
  const pattern = /!?(?:\[[^\]]*\])\(([^)]+)\)/g;
  for (const match of content.matchAll(pattern)) {
    let target = match[1].trim().replace(/^<|>$/g, "");
    if (!target || /^(?:[a-z]+:|#)/i.test(target)) continue;
    target = target.split("#", 1)[0].split("?", 1)[0];
    try { target = decodeURIComponent(target); } catch { /* Keep the literal target. */ }
    if (!target || isAbsolute(target)) continue;
    const absolute = resolve(root, dirname(documentPath), target);
    const insideRoot = relative(root, absolute);
    if (insideRoot.startsWith("..") || !existsSync(absolute)) broken.push(match[1]);
  }
  return broken;
}

function read(root, path) {
  return readFileSync(join(root, path), "utf8");
}

function trackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

export function existingPackageFiles(root, files = trackedFiles(root)) {
  return files.filter(
    (path) => (path === "package.json" || path.endsWith("/package.json")) && existsSync(join(root, path)),
  );
}

export function validateRepository(root) {
  const failures = [];
  const fail = (message) => failures.push(message);
  const largeExceptions = largeFileExceptions(root, fail);

  for (const path of REQUIRED_FILES) {
    const absolute = join(root, path);
    if (!existsSync(absolute) || statSync(absolute).size === 0) fail(`missing or empty required file: ${path}`);
  }

  for (const [path, phrases] of Object.entries(REQUIRED_TEXT)) {
    if (!existsSync(join(root, path))) continue;
    const content = read(root, path);
    for (const phrase of phrases) if (!content.includes(phrase)) fail(`${path} is missing required text: ${phrase}`);
  }

  if (existsSync(join(root, "package.json"))) {
    try {
      const manifest = JSON.parse(read(root, "package.json"));
      if (manifest.license !== LICENSE_ID) fail(`package.json license must be ${LICENSE_ID}`);
      if (manifest.repository?.url !== "git+https://github.com/fatasia/bim-studio.git") fail("package.json repository URL is missing or incorrect");
      if (!manifest.scripts?.["gate:repository"]?.includes("check-repository-governance")) fail("package.json must expose gate:repository");
      for (const script of ["verify:release", "verify:gpu-release"]) {
        if (!manifest.scripts?.[script]?.includes("pnpm gate:repository")) fail(`${script} must include pnpm gate:repository`);
        if (!manifest.scripts?.[script]?.includes("pnpm audit:licenses")) fail(`${script} must include pnpm audit:licenses`);
      }
    } catch (error) {
      fail(`package.json is invalid JSON: ${error.message}`);
    }
  }

  for (const path of existingPackageFiles(root)) {
    try {
      const license = JSON.parse(read(root, path)).license;
      if (path !== "package.json" && license && license !== LICENSE_ID && !license.startsWith("SEE LICENSE IN ")) {
        fail(`${path} declares conflicting first-party license: ${license}`);
      }
    } catch (error) {
      fail(`${path} is invalid JSON: ${error.message}`);
    }
  }

  const manifestRequirements = {
    "packages/deep-engine/package.json": "SEE LICENSE IN ../../LICENSE",
    "tools/unity/com.bim-studio.bridge/package.json": "SEE LICENSE IN LICENSE.md",
  };
  for (const [path, expected] of Object.entries(manifestRequirements)) {
    if (!existsSync(join(root, path))) continue;
    const license = JSON.parse(read(root, path)).license;
    if (license !== expected) fail(`${path} license must be ${expected}`);
  }

  const cargoRequirements = {
    "packages/deep-engine-native/Cargo.toml": 'license-file = "../../LICENSE"',
    "apps/desktop/src-tauri/Cargo.toml": 'license-file = "../../../LICENSE"',
  };
  for (const [path, declaration] of Object.entries(cargoRequirements)) {
    if (existsSync(join(root, path)) && !read(root, path).includes(declaration)) fail(`${path} must declare ${declaration}`);
  }

  const unityLicense = "tools/unity/com.bim-studio.bridge/LICENSE.md";
  if (existsSync(join(root, unityLicense)) && read(root, unityLicense) !== read(root, "LICENSE")) fail(`${unityLicense} must exactly match LICENSE`);

  for (const path of GOVERNANCE_DOCS) {
    if (!existsSync(join(root, path))) continue;
    for (const target of findBrokenLocalLinks(root, path, read(root, path))) fail(`${path} has broken local link: ${target}`);
  }

  for (const path of trackedFiles(root)) {
    if (isForbiddenTrackedPath(path)) fail(`forbidden generated, local, or sensitive tracked path: ${path}`);
    const absolute = join(root, path);
    if (existsSync(absolute) && statSync(absolute).isFile() && statSync(absolute).size > MAX_TRACKED_FILE_BYTES) {
      const exception = largeExceptions.get(path);
      if (!exception) {
        fail(`tracked file exceeds 5 MiB; publish as a release artifact or document an exception: ${path}`);
      } else {
        const sha256 = createHash("sha256").update(readFileSync(absolute)).digest("hex");
        if (sha256.toLowerCase() !== exception.sha256.toLowerCase()) fail(`large-file exception hash mismatch: ${path}`);
      }
    }
  }

  if (!isValidPullRequestTitle(process.env.PR_TITLE ?? "")) fail(`invalid Pull Request title: ${process.env.PR_TITLE}`);
  return failures;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const root = resolve(dirname(currentFile), "..");
  const failures = validateRepository(root);
  if (failures.length) {
    console.error(`Repository governance gate failed (${failures.length}):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("Repository governance gate passed.");
  }
}
