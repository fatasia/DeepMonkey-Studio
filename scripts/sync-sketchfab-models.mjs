// Sketchfab source-b cache only. Review-required files are not automatically published.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { syncSourceBModels } from "./lib/sourceBModelSync.mjs";

const output = path.resolve(process.env.BIM_STUDIO_SOURCE_B_CACHE ?? "data/external-assets/source-b");
const keyPath = path.resolve("data/external-assets/source-b/api-keys.env");
const token = (await readFile(keyPath, "utf8")).match(/^SKETCHFAB_API_TOKEN\s*=\s*([^\r\n]+)$/m)?.[1]?.trim();
if (!token) throw new Error("缺少source-b下载凭据；不修改开发登录账号");
const keywords = argument("keywords", "safety barrier,electric motor,robot gripper").split(",").map(value => value.trim()).filter(Boolean);
const result = await syncSourceBModels({ output, keywords, perKeyword: Number(argument("per-keyword", "2")), maxNew: Number(argument("max-new", "6")), apiJson });
console.log(JSON.stringify({ output, ...result }, null, 2));
if (result.errors.length) process.exitCode = 1;

async function apiJson(relativePath) {
  const url = new URL(`/v3${relativePath}`, "https://api.sketchfab.com");
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(url, { headers: { Authorization: `Token ${token}`, "User-Agent": "BimStudioAssetSync/2.0" }, signal: AbortSignal.timeout(45_000) });
    if (response.status === 429 && attempt < 4) {
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, attempt * 6000));
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Sketchfab API HTTP ${response.status}`); }
    return response.json();
  }
  throw new Error("Sketchfab API持续限流，请保留缓存稍后重试");
}
function argument(name, fallback) { return process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback; }
