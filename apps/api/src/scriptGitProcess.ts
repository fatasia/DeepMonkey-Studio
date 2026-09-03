import { spawn } from "node:child_process";
import { ScriptGitError } from "./scriptGitTypes.js";

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitCommandRunner {
  run(cwd: string, args: readonly string[], timeoutMs?: number): Promise<GitCommandResult>;
}

const MAX_OUTPUT_BYTES = 256 * 1024;

export class NativeGitCommandRunner implements GitCommandRunner {
  constructor(
    private readonly command = "git",
    private readonly defaultTimeoutMs = 30_000,
  ) {}

  run(cwd: string, args: readonly string[], timeoutMs = this.defaultTimeoutMs): Promise<GitCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, [...args], {
        cwd,
        windowsHide: true,
        shell: false,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let timedOut = false;

      const append = (target: "stdout" | "stderr", chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          child.kill();
          reject(new ScriptGitError("GIT_OPERATION_FAILED", "Git 输出超过安全上限，操作已终止", 502));
          return;
        }
        if (target === "stdout") stdout += chunk.toString();
        else stderr += chunk.toString();
      };
      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      timer.unref();

      child.once("error", (error) => {
        clearTimeout(timer);
        const unavailable = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(new ScriptGitError(
          unavailable ? "GIT_UNAVAILABLE" : "GIT_OPERATION_FAILED",
          unavailable ? "未找到系统 Git，请安装 Git 后重试" : `Git 启动失败：${error.message}`,
          unavailable ? 503 : 502,
        ));
      });
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new ScriptGitError("GIT_TIMEOUT", "Git 操作超时，未执行覆盖或重置", 504));
          return;
        }
        resolve({ exitCode: exitCode ?? -1, stdout, stderr });
      });
    });
  }
}

/** Git 错误可能回显远端地址；返回前移除 URL 中潜在的用户信息。 */
export function sanitizeGitOutput(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1")
    .replace(/\r?\n/g, " ")
    .trim()
    .slice(0, 500);
}
