import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * ps-schema-probe CLI 桥(2026-09-26 定案,R1 扩展):
 * - CLI 由 scripts/build-parasolid-probe.mjs 构建到 apps/api/dist/ps-schema-probe/;
 *   未构建时运行时探测为空,所有调用方自动维持既有行为(不引入新档)。
 * - `PARASOLID_SCHEMA_CATALOG` 指向部署方自备的 Parasolid 官方 schema catalog 文本
 *   (版权件,不随包交付);未配置时桥只能输出 census 证据,trim 不解码。
 * - geometry 模式(R1 MVP):`--geometry` 在权威 B-Rep 基础上返回逐面三角网格
 *   (faces + losses + 资源统计);旧版 CLI 不认识该参数会以退出码 2 失败,
 *   调用方按"无 geometry 字段"回落既有语义 —— 因此 geometry 请求失败时
 *   调用方必须再降级为 census/brep 请求,而不是直接抛错。
 * - CLI 崩溃/超时/输出超限一律抛错,由调用方决定回落语义;本模块不吞错误。
 */
export interface ParasolidProbeConfig {
  /** 可执行文件路径;测试可注入任意命令(如 Node 解释器 + mock 脚本)。 */
  command: string;
  /** 命令前缀参数(如 Node mock 的脚本路径);CLI 自身参数追加在其后。 */
  args?: string[];
  /** 部署方自备 schema catalog 路径;配置后 runner 对探针启用 --brep 权威拓扑。 */
  schemaCatalog?: string;
  /** stdout 字节上限(几何 JSON 可能很大);默认 512 MiB。 */
  maxOutputBytes?: number;
}

export interface ParasolidProbeBrepSummary {
  complete: boolean;
  bodies: number;
  regions: number;
  shells: number;
  faces: number;
  loops: number;
  halfEdges: number;
  edges: number;
  vertices: number;
  points: number;
  curves: number;
  surfaces: number;
  surfaceKinds: Record<string, number>;
  boundingBox?: { min: number[]; max: number[] };
  diagnostics: number;
  topologyValid: boolean;
  eulerCharacteristic: number;
}

/** 单个面的三角网格(face 级近似逐条标注,来自 geometry.rs 的诚实导出)。 */
export interface ParasolidGeometryFace {
  id: number;
  body?: number | null;
  surfaceKind: string;
  positions: number[];
  indices: number[];
  approximations: string[];
}

export interface ParasolidGeometrySkippedFace {
  id: number;
  surfaceKind: string;
  reason: string;
}

export interface ParasolidGeometryStats {
  facesTotal: number;
  facesPublished: number;
  facesSkipped: number;
  vertices: number;
  triangles: number;
}

export interface ParasolidGeometryExport {
  faces: ParasolidGeometryFace[];
  losses: string[];
  approximations: string[];
  skipped: ParasolidGeometrySkippedFace[];
  stats: ParasolidGeometryStats;
  budgetExceeded: boolean;
}

export interface ParasolidProbeReport {
  tool: string;
  version: string;
  sourceFormat: "x_t" | "x_b";
  mode: "census" | "schema-aware";
  fileSize: number;
  schemaKey: string;
  modellerVersion: string;
  note?: string;
  catalog?: { schemaId: string; modellerVersion: string; definitionCount: number };
  census?: { recordCount: number; nodeTypeCounts: Record<string, number> };
  brep?: ParasolidProbeBrepSummary;
  geometry?: ParasolidGeometryExport;
}

export interface ParasolidProbeInput {
  filePath: string;
  /** 追加 --brep(要求 schema 来源);false 时仅 census。 */
  brep?: boolean;
  /** 追加 --geometry(隐含 brep 摘要);返回 faces + losses。 */
  geometry?: boolean;
}

export type ParasolidProbeRunner = (input: ParasolidProbeInput) => Promise<ParasolidProbeReport>;

const PROBE_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

/** 既有二进制目录惯例位置(apps/api/dist/ps-schema-probe/)探测;不存在即 undefined。 */
export function defaultParasolidProbeCommand(): string | undefined {
  const executable = process.platform === "win32" ? "ps-schema-probe.exe" : "ps-schema-probe";
  const bundled = path.join(projectRoot, "apps", "api", "dist", "ps-schema-probe", executable);
  return existsSync(bundled) ? bundled : undefined;
}

export function createParasolidProbeRunner(config: ParasolidProbeConfig): ParasolidProbeRunner {
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return async ({ filePath, brep, geometry }: ParasolidProbeInput): Promise<ParasolidProbeReport> => {
    const args = [
      ...config.args ?? [],
      "--file", filePath,
      ...(config.schemaCatalog ? ["--schema-catalog", config.schemaCatalog] : []),
      ...(brep ? ["--brep"] : []),
      ...(geometry ? ["--geometry"] : []),
      "--json",
    ];
    return await new Promise<ParasolidProbeReport>((resolve, reject) => {
      const child = spawn(config.command, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.stdout.destroy();
        child.stderr.destroy();
        callback();
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish(() => reject(new Error(`ps-schema-probe 执行超时（${Math.ceil(PROBE_TIMEOUT_MS / 1_000)} 秒）`)));
      }, PROBE_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > maxOutputBytes) {
          child.kill();
          finish(() => reject(new Error(
            `ps-schema-probe stdout 超过字节上限（>${maxOutputBytes}）；几何预算应下调`,
          )));
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
      });
      child.on("error", (error) => finish(() => reject(error)));
      child.on("exit", (code) => {
        if (code !== 0) {
          finish(() => reject(new Error(`ps-schema-probe 退出码 ${String(code)}：${stderr.trim() || "无错误输出"}`)));
          return;
        }
        let report: ParasolidProbeReport;
        try {
          report = JSON.parse(stdout) as ParasolidProbeReport;
        } catch {
          finish(() => reject(new Error(`ps-schema-probe 输出不是合法 JSON：${stdout.slice(0, 200)}`)));
          return;
        }
        if (report.geometry && !Array.isArray(report.geometry.faces)) {
          finish(() => reject(new Error("ps-schema-probe geometry.faces 不是数组")));
          return;
        }
        finish(() => resolve(report));
      });
    });
  };
}
