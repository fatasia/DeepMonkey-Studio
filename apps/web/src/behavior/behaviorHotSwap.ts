import type { SceneBehaviorManagerEntry } from "./SceneBehaviorManager";
import { translate as tr, type AppLocale } from "../i18n";

/**
 * H-C6-S1 编辑器接线:运行中热插应用(hot-swap apply)的 UI 状态机与文案。
 *
 * 核心在 SceneBehaviorHost.updateModule(旧 onStop → 新 initialize → 恢复形态;
 * 失败自动回滚;authorDebug/同 id/非运行态拒绝)。本模型只回答两个 UI 问题:
 * 1. 按钮此刻为什么不可用(fail-closed 原因要如实写进 tooltip,不吞语义);
 * 2. 点击后 pending 期间,如何从运行时诊断结算出 成功/回滚/失败 三态。
 */

export type BehaviorHotSwapPhase = "idle" | "pending" | "applied" | "rolled-back" | "failed";

/** 热插变体 id 前缀:核心合同拒绝同 id 热插,会话按原脚本 id 派生 `:hot{n}` 变体。 */
export const HOT_SWAP_VARIANT_PATTERN = /:hot\d+$/;

export function hotSwapVariantId(scriptId: string, sequence: number): string {
  return `${scriptId}:hot${sequence}`;
}

export function isHotSwapVariantModuleId(moduleId: string | undefined, scriptId: string): boolean {
  return typeof moduleId === "string" && moduleId.startsWith(`${scriptId}:hot`);
}

/**
 * 按钮禁用原因。返回 undefined = 可用。原因文案同时作为 tooltip(fail-closed 语义如实)。
 * - 作者调试会话:核心明确不支持(fail-closed),原因照抄合同语义;
 * - 当前脚本不在试运行中 / 会话不在运行或暂停态:没有可热插的宿主;
 * - 初始化中:等握手完成。
 */
export function hotSwapDisabledReason(
  entry: SceneBehaviorManagerEntry | undefined,
  debugging: boolean,
  hasDraftName: boolean,
  locale: AppLocale,
): string | undefined {
  if (debugging) return tr(locale,
    "作者调试会话不支持运行中热插（fail-closed）：调试运行的是脚本私有副本，请停止调试后用试运行重试",
    "Author debug sessions do not support hot swap (fail-closed): debugging runs a private copy; stop debugging and use a test run",
  );
  if (!hasDraftName) return tr(locale, "请先填写脚本名称", "Enter a script name first");
  if (!entry) return tr(locale, "当前脚本未在试运行中；请先试运行再热插应用", "This script is not in a test run; start a test run before hot swap");
  const { status } = entry.diagnostics;
  if (status === "initializing") return tr(locale, "行为初始化中，请稍候再热插应用", "The behavior is initializing; retry shortly");
  if (status !== "running" && status !== "paused") return tr(locale, "运行已结束或出错，无法热插；请重新试运行", "The run has ended or failed; start a new test run to hot swap");
  return undefined;
}

export interface BehaviorHotSwapOutcome {
  phase: Exclude<BehaviorHotSwapPhase, "idle" | "pending">;
  feedback: string;
}

const ROLLBACK_MARK = "热插失败已回滚";
const ROLLBACK_MARK_EN = "hot swap failed";

/**
 * pending → 终态结算。entry 为当前热插目标脚本的运行时诊断(undefined = 会话已结束)。
 * context.fromModuleId 是点击时的 moduleId:连续热插时上一轮成功后 moduleId 本就停在
 * 旧变体(:hot1)上,若不锚定"本次点击的起点",pending 首拍会用点击前的旧状态误报成功。
 * - initializing:仍在握手(新模块或回滚握手),保持 pending;
 * - running/paused 且 moduleId ≠ 起点、是本脚本热插变体:成功(场景状态保留);
 * - running/paused 且 lastError 带回滚标记:回滚(上一代脚本继续运行);
 * - 其余 running/paused:点击尚未传播到运行时诊断(面板 props 走 rAF 节拍,滞后于
 *   Host 同步 emit),保持 pending 等下一拍;
 * - error:失败且回滚失败,运行已停止;
 * - 其余(会话被重启/条目消失):结果未知,按失败如实呈现。
 */
export interface BehaviorHotSwapContext {
  scriptId: string;
  fromModuleId: string | undefined;
}

export function settleHotSwap(
  entry: SceneBehaviorManagerEntry | undefined,
  context: BehaviorHotSwapContext,
  locale: AppLocale,
): BehaviorHotSwapOutcome | undefined {
  if (!entry) {
    return {
      phase: "failed",
      feedback: tr(locale, "试运行已结束，热插结果未知；请查看日志或重新试运行", "The test run ended before the swap settled; check logs or start a new run"),
    };
  }
  const { status, lastError, moduleId } = entry.diagnostics;
  if (status === "initializing") return undefined;
  if (status === "error") {
    return {
      phase: "failed",
      feedback: tr(locale, "热插失败且回滚失败，运行已停止：", "Hot swap failed and rollback failed; the run stopped: ") + (lastError ?? ""),
    };
  }
  if (status === "running" || status === "paused") {
    // 回滚标记先于变体判定:二次热插失败时回滚的"旧模块"本身可能就是上一代变体
    // (moduleId 也带 :hot 前缀),lastError 标记才是回滚的可靠事实。
    if (lastError && (lastError.includes(ROLLBACK_MARK) || lastError.toLowerCase().includes(ROLLBACK_MARK_EN))) {
      return {
        phase: "rolled-back",
        feedback: tr(locale, "热插失败，已回滚原脚本继续运行：", "Hot swap failed; rolled back to the previous script: ")
          + lastError.replace(`${ROLLBACK_MARK}:`, "").trim(),
      };
    }
    if (moduleId !== context.fromModuleId && isHotSwapVariantModuleId(moduleId, context.scriptId)) {
      return {
        phase: "applied",
        feedback: tr(locale,
          "热插成功：行为已替换为新版本，场景状态与数据流保留",
          "Hot swap applied: behavior replaced; scene state and data flow are kept",
        ),
      };
    }
    // 面板 props 滞后于 Host 的同步诊断:尚未观察到本次热插的任何痕迹时不结算,
    // 避免把点击前的旧状态(含上一轮变体)误读成本轮结果。
    return undefined;
  }
  return {
    phase: "failed",
    feedback: tr(locale, "热插未能完成，运行状态未变更；请查看日志", "The swap did not complete and the run is unchanged; check logs"),
  };
}
