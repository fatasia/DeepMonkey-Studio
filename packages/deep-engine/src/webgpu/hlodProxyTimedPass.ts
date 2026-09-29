/**
 * B4/HLOD 逐 pass 计时的 pass 身份(F1 单一清单的**暂缓登记**,不另立第二套)。
 *
 * 为什么本切片不直接追加(现状核查发现,2026-09-29):`PBR_TIMED_PASS_IDS` 的文件头
 * 合同是「清单必须与 pbrFramePlanExecutor.MAPPED_EXECUTORS 的键集合一致」,且
 * `pbrFramePlanExecutor.test.ts` 以集合相等钉死;而 hlod-proxy 尚无对应的帧图 pass
 * (代理 overlay 目前走 opaque 通路;帧图/渲染器是其他智能体在途域)。先追加再等
 * pass 落地会让清单违反自身合同、并打红计划构建期对拍测试。
 *
 * 因此登记以**原子 diff**暂存,由把代理 overlay 拆为独立 GPU pass 的切片一并落地
 * (三个文件一起改,缺一即红,这是设计而非缺陷):
 *  1. pbrTimedPassIds.ts:清单末尾("present" 之后)追加 "hlod-proxy"(仅追加,禁止
 *     重排/修改既有 id);
 *  2. rendererCapabilitySelfCheck.ts:capability 行 cluster-lod 增加
 *     `passIds: passes("hlod-")`(J4:新计时 pass 必须登记能力;该声明不镜像 contracts);
 *  3. pbrFramePlanExecutor.ts:帧图声明 hlod-proxy pass + MAPPED_EXECUTORS 记
 *     executor(第 1 步的等价性前提),渲染侧用 GpuTimer.beginPasses 括夹该 id。
 * 本模块先行钉住 pass 身份与阶段键,落地后 `hlodProxyTimedPassRegistration().registered`
 * 翻转,telemetry 阶段 `gpu-pass:hlod-proxy` 即被 ENGINE_TIMING_STAGES 单源接受。
 */

import { isPbrPassTimingStage, pbrPassTimingStage, PBR_TIMED_PASS_IDS } from "./pbrTimedPassIds.js";

/** HLOD 代理 overlay 绘制 pass 的 F1 身份(暂缓登记到 PBR_TIMED_PASS_IDS 末尾)。 */
export const HLOD_PROXY_TIMED_PASS_ID = "hlod-proxy";
/** 对应遥测阶段键(EnginePerformanceTelemetry 的 gpu-pass: 前缀族)。 */
export const HLOD_PROXY_TIMING_STAGE = pbrPassTimingStage(HLOD_PROXY_TIMED_PASS_ID);
/** 声明该 pass 的 J4 能力行 id(rendererCapabilitySelfCheck 的 cluster-lod 行)。 */
export const HLOD_PROXY_CAPABILITY_ID = "cluster-lod";

export interface HlodProxyTimedPassRegistration {
  /** pass id 已进入 PBR_TIMED_PASS_IDS 单源清单(当前 false,见文件头原子 diff)。 */
  readonly registered: boolean;
  /** 阶段键当前是否被 isPbrPassTimingStage 接受(未登记前 telemetry 会拒绝该阶段)。 */
  readonly stageAccepted: boolean;
}

/** 从实际清单面派生登记状态(不缓存;登记落地后立即翻转为 true/true)。 */
export function hlodProxyTimedPassRegistration(): HlodProxyTimedPassRegistration {
  const registered = (PBR_TIMED_PASS_IDS as readonly string[]).includes(HLOD_PROXY_TIMED_PASS_ID);
  return { registered, stageAccepted: isPbrPassTimingStage(HLOD_PROXY_TIMING_STAGE) };
}
