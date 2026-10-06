import { describe, expect, it } from "vitest";
import { prepareStudioDeepSwitchCandidate, type StudioDeepBridgeSwitchHost,
  type StudioDeepSwitchCandidateFrame } from "./studioDeepWebGpuBridgeSwitchCandidate";

/**
 * 回归:create 里预启动的 authorRenderPacket 编译任务是浮动 promise,只有靠后的
 * `await packetTask` 消费它。若 create 在到达该 await 前因环境准备失败/取消退出,
 * 稍后才拒绝的 packetTask 曾以 unhandled rejection 直透为页面错误
 * ("Renderer preparation cancelled" / "扩展外观需要模型适配：baseColorMapUrl")。
 * 修复 = 创建即挂空 catch;本测试在真实候选事务里复现两条拒绝路径。
 */
function makeHost(options: { authorRenderPacket: (signal: AbortSignal) => Promise<unknown> }): StudioDeepBridgeSwitchHost {
  return {
    viewer: { scene: {} },
    options: { authorRenderPacket: options.authorRenderPacket },
    loadModule: async () => ({}),
    viewReader: {},
    hdrDisplayRequest: undefined,
    generation: 1,
    qualityProfile: null,
    independentPacketPath: false,
    pendingDeformationPacket: undefined,
    projectionBridge: undefined,
    advancedMaterialsRequested: false,
    advancedMaterialsActive: false,
    alphaToCoverageRequested: false,
    alphaToCoverageActive: false,
    a2cMaskFallbackRequested: false,
    a2cMaskFallbackActive: false,
    recoveryCandidateFailure: undefined,
    projectionRoot: () => ({}) as StudioDeepBridgeSwitchHost["projectionRoot"] extends () => infer R ? R : never,
  } as unknown as StudioDeepBridgeSwitchHost;
}

function makeFrame(): StudioDeepSwitchCandidateFrame {
  return { environment: undefined, shadowMapSize: 1024, frameCaptureSession: undefined, candidateObserver: undefined };
}

describe("prepareStudioDeepSwitchCandidate floating packet task", () => {
  it("编译错误晚于 create 失败落地时不再泄漏 unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const host = makeHost({ authorRenderPacket: async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      throw new Error("对象 m1 的扩展外观需要模型适配：baseColorMapUrl");
    } });
    // 空场景使 create 在环境准备处同步失败,早于 packetTask 的拒绝。
    const controller = new AbortController();
    const result = await prepareStudioDeepSwitchCandidate(host, {} as HTMLCanvasElement,
      controller.signal, 1, undefined, 5_000, makeFrame());
    await new Promise(resolve => setTimeout(resolve, 60));
    process.off("unhandledRejection", onUnhandled);
    expect(result.status).toBe("failed");
    expect(unhandled).toEqual([]);
  });

  it("取消传播的 Renderer preparation cancelled 拒绝同样被观察", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const controller = new AbortController();
    const host = makeHost({ authorRenderPacket: (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason ?? new DOMException("Renderer preparation cancelled", "AbortError")), { once: true });
    }) });
    const result = await prepareStudioDeepSwitchCandidate(host, {} as HTMLCanvasElement,
      controller.signal, 1, undefined, 5_000, makeFrame());
    await new Promise(resolve => setTimeout(resolve, 60));
    process.off("unhandledRejection", onUnhandled);
    // 环境准备先失败,候选 failed;内层控制器随后以 "Renderer preparation cancelled" 中止
    // 在飞的编译任务,该拒绝必须已被预挂 catch 观察。
    expect(result.status).toBe("failed");
    expect(unhandled).toEqual([]);
  });
});
