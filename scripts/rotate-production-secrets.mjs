import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import {
  apiReachable,
  hasFlag,
  loadProductionEnvironment,
  option,
  randomSecret,
  repositoryRoot,
  upsertEnvironmentValue,
  writeAtomic,
} from "./lib/nativeProductionOps.mjs";

const confirmation = "ROTATE-APPLICATION-SECRETS";
if (option("--confirm") !== confirmation) throw new Error(`必须显式传入 --confirm ${confirmation}`);
const requestedEnvPath = option("--env-file");
const { envPath, values } = loadProductionEnvironment(requestedEnvPath);
const activeEnvironment = !requestedEnvPath || envPath === path.join(repositoryRoot, ".env");
const apiIsRunning = activeEnvironment && await apiReachable(values);
if (apiIsRunning && !hasFlag("--defer-until-restart")) {
  throw new Error("API 正在运行，请先停止服务；如只更新下次启动配置，显式传入 --defer-until-restart");
}

const current = await readFile(envPath, "utf8");
const adminPassword = randomSecret(24);
const sessionSecret = randomSecret(48);
const rotated = upsertEnvironmentValue(
  upsertEnvironmentValue(current, "BIM_STUDIO_ADMIN_PASSWORD", adminPassword),
  "BIM_STUDIO_SESSION_SECRET",
  sessionSecret,
);
const id = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const recoveryPath = path.resolve(option("--recovery-file", path.join(repositoryRoot, "data", "secrets", `rotation-${id}.env`)));
const previousPath = `${envPath}.previous`;

// 恢复文件和旧配置均含敏感值，仅记录路径，不把内容写入终端。
await writeAtomic(recoveryPath, `BIM_STUDIO_ADMIN_PASSWORD=${adminPassword}\nBIM_STUDIO_SESSION_SECRET=${sessionSecret}\n`);
await copyFile(envPath, previousPath);
await writeAtomic(envPath, rotated);

process.stdout.write(`${JSON.stringify({
  ok: true,
  rotated: ["BIM_STUDIO_ADMIN_PASSWORD", "BIM_STUDIO_SESSION_SECRET"],
  recoveryPath,
  rollbackPath: previousPath,
  restartRequired: true,
  runningProcessUsesPreviousValues: apiIsRunning,
}, null, 2)}\n`);
