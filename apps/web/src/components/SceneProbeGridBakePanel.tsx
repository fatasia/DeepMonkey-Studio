import { useState } from "react";
import { LoaderCircle, Scan } from "lucide-react";
import type { ProbeGridBakeGrid } from "@bim-studio/deep-engine";
import { translate as tr, type AppLocale } from "../i18n";
import type { ProbeGridBakePhase } from "../delivery/probeGridBakeRunner";

/** 烘焙动作的 UI 状态（由父级持有：烘焙执行在视口容器，不在面板内）。 */
export type ProbeGridBakeUiState =
  | { kind: "idle" }
  | { kind: "running"; phase: ProbeGridBakePhase }
  | { kind: "done"; probeCount: number; coveredCount: number; coverage: number }
  | { kind: "error"; message: string };

export interface SceneProbeGridBakePanelProps {
  locale: AppLocale;
  state: ProbeGridBakeUiState;
  onBake: (grid: ProbeGridBakeGrid) => void;
  disabled?: boolean;
}

/** 网格参数的客户端预检；真正的 fail-closed 校验仍由烘焙服务在请求 GPU 前执行。 */
export function validateProbeGridInputs(origin: [string, string, string], spacing: string,
  gridSize: [string, string, string]): string | undefined {
  const originValue = origin.map(value => Number(value));
  if (originValue.some(value => !Number.isFinite(value))) return "网格原点必须是三个有限数值";
  if (Math.abs(originValue[0]!) > 1e9 || Math.abs(originValue[1]!) > 1e9 || Math.abs(originValue[2]!) > 1e9) {
    return "网格原点超出范围（|·| ≤ 1e9）";
  }
  const spacingValue = Number(spacing);
  if (!Number.isFinite(spacingValue) || spacingValue <= 0 || spacingValue > 1_000_000) {
    return "探针间距必须是大于 0 的数值";
  }
  const sizeValue = gridSize.map(value => Math.round(Number(value)));
  if (sizeValue.some(value => !Number.isSafeInteger(value) || value < 2 || value > 64)) {
    return "网格数量每轴必须为 2..64 的整数";
  }
  return undefined;
}

const PHASE_LABEL: Record<ProbeGridBakePhase, [string, string]> = {
  "compile-scene": ["正在编译场景几何", "Compiling scene geometry"],
  "request-gpu": ["正在请求 WebGPU 设备", "Requesting WebGPU device"],
  capture: ["正在 GPU 捕获探针辐射", "Capturing probe radiance on GPU"],
  store: ["正在写入烘焙结果", "Storing bake result"],
};

/** GI 行下方的探针网格烘焙区块：参数输入 + 动作 + 进度/结果摘要。 */
export function SceneProbeGridBakePanel(props: SceneProbeGridBakePanelProps) {
  const { locale } = props;
  const [origin, setOrigin] = useState<[string, string, string]>(["0", "0", "0"]);
  const [spacing, setSpacing] = useState("4");
  const [gridSize, setGridSize] = useState<[string, string, string]>(["4", "4", "4"]);
  const [inputError, setInputError] = useState<string>();
  const running = props.state.kind === "running";
  const busy = running || props.disabled === true;

  function submit() {
    const error = validateProbeGridInputs(origin, spacing, gridSize);
    setInputError(error);
    if (error || running) return;
    props.onBake({
      origin: origin.map(value => Number(value)) as [number, number, number],
      spacing: Number(spacing),
      gridSize: gridSize.map(value => Math.round(Number(value))) as [number, number, number],
    });
  }

  return (
    <section className="environment-row probe-bake-panel" aria-label={tr(locale, "探针网格烘焙", "Probe grid baking")}>
      <span>{tr(locale, "GI 烘焙", "GI bake")}</span>
      <div className="probe-bake-fields">
        <label>
          {tr(locale, "原点", "Origin")}
          {origin.map((value, axis) => (
            <input key={axis} type="number" step="0.5" value={value} disabled={busy}
              aria-label={tr(locale, `网格原点${"XYZ"[axis]}`, `Grid origin ${"XYZ"[axis]}`)}
              onChange={(event) => setOrigin(current => current.map((item, index) =>
                index === axis ? event.target.value : item) as [string, string, string])} />
          ))}
        </label>
        <label>
          {tr(locale, "间距", "Spacing")}
          <input type="number" step="0.5" min="0.5" value={spacing} disabled={busy}
            aria-label={tr(locale, "探针间距（世界单位）", "Probe spacing (world units)")}
            onChange={(event) => setSpacing(event.target.value)} />
        </label>
        <label>
          {tr(locale, "数量", "Count")}
          {gridSize.map((value, axis) => (
            <input key={axis} type="number" step="1" min="2" max="64" value={value} disabled={busy}
              aria-label={tr(locale, `网格数量${"XYZ"[axis]}`, `Grid count ${"XYZ"[axis]}`)}
              onChange={(event) => setGridSize(current => current.map((item, index) =>
                index === axis ? event.target.value : item) as [string, string, string])} />
          ))}
        </label>
      </div>
      <button
        type="button"
        className={props.state.kind === "done" ? "active" : ""}
        disabled={busy}
        title={tr(locale, "对整个网格做一次 GPU 探针辐射捕获，结果随 Deep Native 打包发布",
          "Capture probe radiance for the whole grid on GPU; the result ships with Deep Native packaging")}
        onClick={submit}
      >
        {running ? <LoaderCircle className="spin" size={14} /> : <Scan size={14} />}
        {tr(locale, "烘焙探针网格", "Bake probe grid")}
      </button>
      {inputError && <small className="probe-bake-error" role="alert">{inputError}</small>}
      {props.state.kind === "running" && (
        <small className="probe-bake-status" role="status">{tr(locale, ...PHASE_LABEL[props.state.phase])}…</small>
      )}
      {props.state.kind === "done" && (
        <small className="probe-bake-status" role="status">
          {tr(locale, `探针 ${props.state.probeCount} · 覆盖 ${props.state.coveredCount}/${props.state.probeCount}（${Math.round(props.state.coverage * 100)}%）· Deep Native 打包将携带`,
            `${props.state.probeCount} probes · covered ${props.state.coveredCount}/${props.state.probeCount} (${Math.round(props.state.coverage * 100)}%) · carried by Deep Native packaging`)}
        </small>
      )}
      {props.state.kind === "error" && (
        <small className="probe-bake-error" role="alert">{props.state.message}</small>
      )}
    </section>
  );
}
