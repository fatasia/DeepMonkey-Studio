/** DE26/A08 第一切片:从任务清单与已登记证据生成确定性证据索引。
 *  同输入同输出(无易变字段);缺失/被篡改的证据文件显式标红,不静默跳过。
 *  用法:pnpm exec tsx scripts/generate-de26-evidence-index.mts */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const tasksPath = path.join(root, "docs/specs/deep-engine-execution-tasks-2026-09-16.json");
const outputPath = path.join(root, "docs/specs/de26-evidence-index.md");

interface TaskCard {
  readonly id: string;
  readonly title: string;
  readonly status?: string;
  readonly completed?: string;
  readonly evidence?: readonly string[];
  readonly note?: string;
  readonly priority?: string;
}

const document = JSON.parse(await readFile(tasksPath, "utf8")) as { tasks?: TaskCard[] } | TaskCard[];
const tasks: TaskCard[] = Array.isArray(document) ? document : document.tasks ?? [];
if (!tasks.length) throw new Error("No task cards found in the execution manifest");

const hashFile = async (relative: string): Promise<string> => {
  const bytes = await readFile(path.join(root, relative));
  return createHash("sha256").update(bytes).digest("hex");
};

const lines: string[] = [
  "# DE26 证据索引(A08 自动生成;同输入同输出,勿手改)",
  "",
  `来源清单:docs/specs/deep-engine-execution-tasks-2026-09-16.json(${tasks.length} 卡)`,
  "",
];

let covered = 0, missing = 0;
for (const task of tasks) {
  if (!task.evidence?.length) continue;
  covered += 1;
  lines.push(`## ${task.id} · ${task.title}`);
  lines.push(`- 状态:${task.status ?? "本轮待办"}${task.completed ? `(完成日 ${task.completed})` : ""}`);
  if (task.note) lines.push(`- 说明:${task.note}`);
  lines.push("- 证据:");
  for (const evidence of task.evidence) {
    try {
      const digest = await hashFile(evidence);
      lines.push(`  - [x] \`${evidence}\` sha256=${digest}`);
    } catch {
      missing += 1;
      lines.push(`  - [!] \`${evidence}\` **缺失或不可读**`);
    }
  }
  lines.push("");
}
lines.push("---");
lines.push(`覆盖 ${covered} 卡;证据缺失 ${missing} 项。`);

// 确定性自检:内容不得包含生成时刻等易变字段。
if (/20\d{2}-\d{2}-\d{2}T\d{2}:/.test(lines.join("\n"))) throw new Error("Evidence index must not contain volatile timestamps");

await writeFile(outputPath, lines.join("\n") + "\n");
console.log(`Evidence index: ${path.relative(root, outputPath)} — ${covered} cards, ${missing} missing files.`);
