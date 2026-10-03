import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import type { SceneFireCurveKey } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { FIRE_CURVE_MAX_KEYS, FIRE_CURVE_PRESETS } from "../viewer/modelFireParticles";

interface ParticleCurveEditorProps {
  locale: AppLocale;
  label: [string, string];
  /** 值域上限，下限恒为 0。 */
  maximum: number;
  /** 已解析的曲线（作者曲线或缺省曲线）。 */
  keys: readonly SceneFireCurveKey[];
  /** 当前是否为作者自定义（决定"恢复默认"可用）。 */
  custom: boolean;
  disabled: boolean;
  onChange: (keys: SceneFireCurveKey[] | undefined) => void;
}

const WIDTH = 200;
const HEIGHT = 56;
const PAD = 6;
const MIN_GAP = 0.01;
const PRESETS: readonly { id: string; zh: string; en: string }[] = [
  { id: "constant", zh: "恒定", en: "Flat" },
  { id: "fadeOut", zh: "渐出", en: "Fade out" },
  { id: "fadeIn", zh: "渐入", en: "Fade in" },
  { id: "peak", zh: "峰值", en: "Peak" },
];

/** 生命周期曲线编辑：拖拽/方向键调点，点击空白加点，双击或 Delete 删点；拖拽中只改草稿，松开才提交。 */
export function ParticleCurveEditor({ locale, label, maximum, keys, custom, disabled, onChange }: ParticleCurveEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<SceneFireCurveKey[] | undefined>();
  const [active, setActive] = useState(0);
  const shown = draft ?? keys;
  const toX = (time: number) => PAD + time * (WIDTH - PAD * 2);
  const toY = (value: number) => HEIGHT - PAD - (Math.min(value, maximum) / maximum) * (HEIGHT - PAD * 2);
  const path = shown.map((key, index) => `${index ? "L" : "M"}${toX(key.time).toFixed(1)} ${toY(key.value).toFixed(1)}`).join(" ");
  const areaPath = `${path} L${toX(shown[shown.length - 1]!.time).toFixed(1)} ${HEIGHT - PAD} L${toX(shown[0]!.time).toFixed(1)} ${HEIGHT - PAD} Z`;

  const fromPointer = (event: { clientX: number; clientY: number }): SceneFireCurveKey => {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const py = ((event.clientY - rect.top) / rect.height) * HEIGHT;
    return {
      time: clamp((px - PAD) / (WIDTH - PAD * 2), 0, 1),
      value: clamp(((HEIGHT - PAD - py) / (HEIGHT - PAD * 2)) * maximum, 0, maximum),
    };
  };

  const moveKey = (source: readonly SceneFireCurveKey[], index: number, next: SceneFireCurveKey): SceneFireCurveKey[] => {
    const result = source.map((key) => ({ ...key }));
    const lower = index === 0 ? 0 : source[index - 1]!.time + MIN_GAP;
    const upper = index === source.length - 1 ? 1 : source[index + 1]!.time - MIN_GAP;
    // 端点时间锁定在 0/1，保证曲线覆盖整个生命周期。
    const time = index === 0 ? 0 : index === source.length - 1 ? 1 : clamp(next.time, lower, upper);
    result[index] = { time, value: round(next.value) };
    return result;
  };

  const onHandleDown = (index: number) => (event: PointerEvent<SVGCircleElement>) => {
    if (disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setActive(index);
    setDraft(keys.map((key) => ({ ...key })));
  };
  const onHandleMove = (index: number) => (event: PointerEvent<SVGCircleElement>) => {
    if (!draft || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    setDraft(moveKey(draft, index, fromPointer(event)));
  };
  const onHandleUp = (event: PointerEvent<SVGCircleElement>) => {
    if (!draft) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onChange(draft.map((key) => ({ time: round(key.time), value: key.value })));
    setDraft(undefined);
  };
  const onHandleKey = (index: number) => (event: KeyboardEvent<SVGCircleElement>) => {
    if (disabled) return;
    const step = maximum / 20;
    const current = keys[index]!;
    let next: SceneFireCurveKey | undefined;
    if (event.key === "ArrowUp") next = { time: current.time, value: current.value + step };
    else if (event.key === "ArrowDown") next = { time: current.time, value: current.value - step };
    else if (event.key === "ArrowRight") next = { time: current.time + 0.02, value: current.value };
    else if (event.key === "ArrowLeft") next = { time: current.time - 0.02, value: current.value };
    else if ((event.key === "Delete" || event.key === "Backspace") && keys.length > 2 && index > 0 && index < keys.length - 1) {
      event.preventDefault();
      onChange(keys.filter((_, i) => i !== index).map((key) => ({ ...key })));
      setActive(Math.max(0, index - 1));
      return;
    }
    if (!next) return;
    event.preventDefault();
    onChange(moveKey(keys, index, next));
  };
  // 双击空白处加点，避免单击误触。
  const onBackgroundDoubleClick = (event: MouseEvent<SVGSVGElement>) => {
    if (disabled || keys.length >= FIRE_CURVE_MAX_KEYS) return;
    const point = fromPointer(event);
    if (keys.some((key) => Math.abs(key.time - point.time) < MIN_GAP * 2)) return;
    const next = [...keys.map((key) => ({ ...key })), { time: round(point.time), value: round(point.value) }].sort((a, b) => a.time - b.time);
    setActive(next.findIndex((key) => key.time === round(point.time)));
    onChange(next);
  };
  const onHandleDoubleClick = (index: number) => (event: MouseEvent<SVGCircleElement>) => {
    event.stopPropagation();
    if (disabled || keys.length <= 2 || index === 0 || index === keys.length - 1) return;
    onChange(keys.filter((_, i) => i !== index).map((key) => ({ ...key })));
    setActive(Math.max(0, index - 1));
  };

  const focus = shown[Math.min(active, shown.length - 1)]!;
  return (
    <div className={`fire-curve${disabled ? " is-disabled" : ""}`}>
      <div className="fire-curve-head">
        <span>{tr(locale, ...label)}</span>
        <output title={tr(locale, "当前关键帧：寿命 / 数值", "Active keyframe: lifetime / value")}>
          {Math.round(focus.time * 100)}% · {focus.value.toFixed(2)}
        </output>
      </div>
      <svg
        ref={svgRef}
        className="fire-curve-plot"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="group"
        aria-label={tr(locale, `${label[0]}生命周期曲线`, `${label[1]} over lifetime curve`)}
        onDoubleClick={onBackgroundDoubleClick}
      >
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line key={fraction} className="fire-curve-grid" x1={PAD} x2={WIDTH - PAD} y1={toY(maximum * fraction)} y2={toY(maximum * fraction)} />
        ))}
        <path className="fire-curve-area" d={areaPath} />
        <path className="fire-curve-line" d={path} />
        {shown.map((key, index) => (
          <circle
            key={index}
            className={`fire-curve-handle${index === active ? " is-active" : ""}`}
            cx={toX(key.time)}
            cy={toY(key.value)}
            r={index === active ? 4.5 : 3.5}
            tabIndex={disabled ? -1 : 0}
            role="slider"
            aria-label={tr(locale, `${label[0]}关键帧 ${index + 1}`, `${label[1]} keyframe ${index + 1}`)}
            aria-valuemin={0}
            aria-valuemax={maximum}
            aria-valuenow={Number(key.value.toFixed(2))}
            aria-valuetext={`${Math.round(key.time * 100)}% · ${key.value.toFixed(2)}`}
            onFocus={() => setActive(index)}
            onPointerDown={onHandleDown(index)}
            onPointerMove={onHandleMove(index)}
            onPointerUp={onHandleUp}
            onKeyDown={onHandleKey(index)}
            onDoubleClick={onHandleDoubleClick(index)}
          />
        ))}
      </svg>
      <div className="fire-curve-presets" role="group" aria-label={tr(locale, "曲线预设", "Curve presets")}>
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(scalePreset(FIRE_CURVE_PRESETS[preset.id]!, maximum))}
          >
            {tr(locale, preset.zh, preset.en)}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled || !custom}
          title={custom ? undefined : tr(locale, "已是默认曲线", "Already the default curve")}
          onClick={() => onChange(undefined)}
        >
          {tr(locale, "默认", "Default")}
        </button>
      </div>
    </div>
  );
}

/** 预设值域为 0..1（size 即 0×..1× 倍率），按通道上限钳制。 */
function scalePreset(keys: readonly SceneFireCurveKey[], maximum: number): SceneFireCurveKey[] {
  return keys.map((key) => ({ time: key.time, value: Math.min(maximum, key.value) }));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
