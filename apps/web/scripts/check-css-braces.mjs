// 一次性 CSS 语法自检:改动文件的括号平衡检查(非交付物)。
import { readFileSync } from "node:fs";
const files = ["base.css", "dashboard-workspace.css", "platform-components.css", "platform-pages.css", "centers.css", "resourceGovernance.css", "scene-manager.css", "operations-study.css"];
let allOk = true;
for (const f of files) {
  const s = readFileSync(new URL(`../src/styles/${f}`, import.meta.url), "utf8");
  const clean = s.replace(/\/\*[\s\S]*?\*\//g, "");
  let open = 0, close = 0, line = 1, ok = true;
  for (const ch of clean) {
    if (ch === "\n") line++;
    if (ch === "{") open++;
    if (ch === "}") { close++; if (close > open) { console.log(`${f}: 多余 } 于行 ${line}`); ok = false; break; } }
  }
  if (open !== close) { console.log(`${f}: 括号不平衡 open=${open} close=${close}`); ok = false; }
  if (ok) console.log(`${f}: OK (${open} 规则块)`);
  allOk = allOk && ok;
}
process.exit(allOk ? 0 : 1);
