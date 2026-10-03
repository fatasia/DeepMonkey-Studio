import { resolveHdrDisplayPolicy, type HdrDisplayPolicy, type HdrDisplayProbe, type HdrDisplayRequest } from "./hdrDisplayOutput.js";

export interface HdrDisplayCanvasCapability {
  readonly policy: HdrDisplayPolicy;
  readonly probe?: HdrDisplayProbe;
  readonly canvasProbePerformed: boolean;
}
/** Probe a separate canvas; never reconfigure a visible surface while negotiating support. */
export async function probeHdrDisplayCanvas(device: GPUDevice, canvas: HTMLCanvasElement,
  request?: HdrDisplayRequest): Promise<HdrDisplayCanvasCapability> {
  if (request?.enabled !== true) return Object.freeze({ policy: resolveHdrDisplayPolicy(undefined, request), canvasProbePerformed: false });
  // Encoded recording sinks are not the extended-linear browser compositor.
  if (request.strategy !== undefined && request.strategy !== "extended-linear") {
    return Object.freeze({ policy: resolveHdrDisplayPolicy(undefined, request), canvasProbePerformed: false });
  }
  // 浏览器探测代码:ownerDocument 是合法 DOM API;apps/api(Node 无 DOM lib)会把它
  // 传递编译进,这里用局部结构化声明避免拉全局 DOM lib(会撞 node ReadableStream 类型)。
  const host = (canvas as HTMLCanvasElement & { ownerDocument?: { defaultView?: { matchMedia(query: string): { matches: boolean } } } }).ownerDocument?.defaultView;
  let range: HdrDisplayProbe["displayDynamicRange"] = "unknown";
  try { range = host?.matchMedia("(dynamic-range: high)").matches ? "high"
    : host?.matchMedia("(dynamic-range: standard)").matches ? "standard" : "unknown"; } catch { /* unknown retains SDR */ }
  let probe: HdrDisplayProbe = { webgpuAvailable: true, displayDynamicRange: range,
    canvasToneMappingExtended: false, canvasFormatRgba16float: false };
  if (range !== "high") return Object.freeze({ policy: resolveHdrDisplayPolicy(probe, request), probe: Object.freeze(probe), canvasProbePerformed: false });
  // 启动链保证:探测从此处到 finally 的每一次宿主/GPU 触碰都不得向调用方抛出
  // (DeviceSession.open 直接 await 本函数,逃逸异常会让整次启动失败而不是回 SDR)。
  // 任何异常都让能力字段保持 false,resolveHdrDisplayPolicy 给出显式 SDR 原因码。
  let context: GPUCanvasContext | null | undefined;
  let scopePushed = false;
  try {
    const temporary = (canvas as HTMLCanvasElement & { ownerDocument?: { createElement(tag: string): HTMLCanvasElement } }).ownerDocument?.createElement("canvas");
    if (temporary) {
      const sized = temporary as HTMLCanvasElement & { width: number; height: number };
      sized.width = sized.height = 1;
      context = sized.getContext("webgpu");
      device.pushErrorScope("validation"); scopePushed = true;
      if (context) {
        context.configure({ device, format: "rgba16float", alphaMode: "opaque", toneMapping: { mode: "extended" },
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
        const actual = context.getConfiguration();
        probe = { ...probe, canvasFormatRgba16float: actual?.format === "rgba16float",
          canvasToneMappingExtended: actual?.toneMapping?.mode === "extended" };
      }
    }
  } catch { /* false capability fields retain an explicit SDR reason */ }
  finally {
    try {
      const error = scopePushed ? await device.popErrorScope() : null;
      if (error) probe = { ...probe, canvasFormatRgba16float: false };
    } catch { /* 校验作用域读不到 = 无法确认无异步校验错误,按 fail-closed 视为能力未确认 */ probe = { ...probe, canvasFormatRgba16float: false }; }
    finally { try { context?.unconfigure(); } catch { /* 仅临时画布,吞掉回收异常 */ } }
  }
  // Physical presentation never automatically chooses an encoded PQ fallback.
  const policy = resolveHdrDisplayPolicy(probe, { ...request, strategy: "extended-linear" });
  return Object.freeze({ policy, probe: Object.freeze(probe), canvasProbePerformed: true });
}
