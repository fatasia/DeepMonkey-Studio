import { Copy, Eye, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import type { CameraKeyframe, ModelKeyframe, Vector3Value } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { DeferredNumberInput } from "./AppFormControls";

export type TimelineFrame = (CameraKeyframe & { kind: "camera" }) | (ModelKeyframe & { kind: "model" });

interface Props {
  locale: AppLocale;
  frame: TimelineFrame;
  frameRate: number;
  snapToFrames: boolean;
  duration: number;
  modelName?: string;
  onTimeChange: (time: number) => void;
  onUpdate: (frame: TimelineFrame) => void;
  onPreview: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  recording?: boolean;
  onCaptureCamera?: (() => void) | undefined;
}

export function SceneTimelineFrameInspector(props: Props) {
  const { frame, locale } = props;
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { if (panel.current) panel.current.scrollTop = 0; }, [frame.id]);
  const step = props.snapToFrames ? 1 / props.frameRate : 0.05;
  return <aside ref={panel} className="timeline-frame-inspector" aria-label={tr(locale, "关键帧属性", "Keyframe properties")}>
    <header>
      <span><strong>{frame.kind === "camera" ? tr(locale, "相机关键帧", "Camera keyframe") : props.modelName ?? tr(locale, "对象关键帧", "Object keyframe")}</strong><small>{props.snapToFrames ? `F${Math.round(frame.time * props.frameRate)}` : `${frame.time.toFixed(2)}s`}</small></span>
      <button type="button" title={tr(locale, "预览此帧", "Preview this frame")} onClick={props.onPreview}><Eye size={13} /></button>
    </header>
    <div className="timeline-frame-fields">
      <label className="timeline-frame-time"><span>{tr(locale, "时间", "Time")}</span><DeferredNumberInput min={0} max={props.duration} step={step} value={roundParameter(frame.time)} onCommit={time => props.onTimeChange(roundParameter(time))} /><i>s</i></label>
      <label className="timeline-frame-select"><span>{tr(locale, "到下一帧", "To next frame")}</span><select aria-label={tr(locale, "到下一帧的过渡方式", "Transition to next frame")} value={frame.transition ?? "default"} onChange={event => {
        const { transition: _, ...base } = frame;
        props.onUpdate(event.target.value === "default" ? base : { ...base, transition: event.target.value as NonNullable<TimelineFrame["transition"]> });
      }}>
        <option value="default">{tr(locale, "跟随轨道", "Track default")}</option>
        <option value="linear">{tr(locale, "线性", "Linear")}</option>
        <option value="smooth">{tr(locale, "平滑缓入缓出", "Ease in-out")}</option>
        <option value="ease-in">{tr(locale, "缓入", "Ease in")}</option>
        <option value="ease-out">{tr(locale, "缓出", "Ease out")}</option>
        <option value="step">{tr(locale, "保持后切换", "Hold then cut")}</option>
      </select></label>
      {frame.kind === "camera" ? <>
        {props.onCaptureCamera && <button type="button" onClick={props.onCaptureCamera}>{tr(locale, "更新为当前视角", "Capture current view")}</button>}
        {props.recording && <small role="status">{tr(locale, "调整场景相机会自动更新此帧", "Camera adjustments update this frame")}</small>}
        <VectorFields label={tr(locale, "相机位置", "Camera position")} value={frame.camera.position} onChange={(position) => props.onUpdate({ ...frame, camera: { ...frame.camera, position } })} />
        <VectorFields label={tr(locale, "观察目标", "Look target")} value={frame.camera.target} onChange={(target) => props.onUpdate({ ...frame, camera: { ...frame.camera, target } })} />
        <label className="timeline-frame-select"><span>{tr(locale, "镜头模式", "Camera mode")}</span><select value={frame.camera.mode} onChange={(event) => props.onUpdate({ ...frame, camera: { ...frame.camera, mode: event.target.value as typeof frame.camera.mode } })}>
          <option value="orbit">{tr(locale, "轨道镜头", "Orbit")}</option>
          <option value="firstPerson">{tr(locale, "第一人称", "First person")}</option>
          <option value="thirdPerson">{tr(locale, "第三人称", "Third person")}</option>
        </select></label>
      </> : <>
        <VectorFields label={tr(locale, "位置", "Position")} value={frame.transform.position} onChange={(position) => props.onUpdate({ ...frame, transform: { ...frame.transform, position } })} />
        <VectorFields label={tr(locale, "旋转", "Rotation")} value={frame.transform.rotation} onChange={(rotation) => props.onUpdate({ ...frame, transform: { ...frame.transform, rotation } })} />
        <VectorFields label={tr(locale, "缩放", "Scale")} value={frame.transform.scale} onChange={(scale) => props.onUpdate({ ...frame, transform: { ...frame.transform, scale } })} />
        <label className="timeline-frame-select"><span>{tr(locale, "可见性", "Visibility")}</span><select aria-label={tr(locale, "此帧起的对象可见性", "Object visibility from this frame")} value={frame.visibility === undefined ? "inherit" : frame.visibility ? "visible" : "hidden"} onChange={(event) => {
          const { visibility: _, ...base } = frame;
          props.onUpdate(event.target.value === "inherit" ? base : { ...base, visibility: event.target.value === "visible" });
        }}>
          <option value="inherit">{tr(locale, "跟随上一帧", "Inherit previous")}</option>
          <option value="visible">{tr(locale, "可见", "Visible")}</option>
          <option value="hidden">{tr(locale, "隐藏", "Hidden")}</option>
        </select></label>
        {frame.animation && <div className="timeline-frame-animation">
          <label><span>{tr(locale, "动画片段", "Animation clip")}</span><input value={frame.animation.clipId ?? ""} placeholder={tr(locale, "默认片段", "Default clip")} onChange={(event) => props.onUpdate({ ...frame, animation: event.target.value ? { ...frame.animation!, clipId: event.target.value } : { time: frame.animation!.time } })} /></label>
          <label><span>{tr(locale, "片段时间", "Clip time")}</span><DeferredNumberInput min={0} step={0.05} value={roundParameter(frame.animation.time)} onCommit={(time) => props.onUpdate({ ...frame, animation: { ...frame.animation!, time: roundParameter(time) } })} /></label>
        </div>}
      </>}
    </div>
    <footer>
      <button type="button" onClick={props.onDuplicate}><Copy size={13} />{tr(locale, "复制帧", "Duplicate")}</button>
      <button type="button" className="danger" onClick={props.onDelete}><Trash2 size={13} />{tr(locale, "删除帧", "Delete")}</button>
    </footer>
  </aside>;
}

function VectorFields({ label, value, onChange }: { label: string; value: Vector3Value; onChange: (value: Vector3Value) => void }) {
  return <fieldset className="timeline-frame-vector"><legend>{label}</legend>{(["x", "y", "z"] as const).map((axis) => <label key={axis}><i>{axis.toUpperCase()}</i><DeferredNumberInput step={0.1} value={roundParameter(value[axis])} onCommit={(next) => onChange({ ...value, [axis]: roundParameter(next) })} /></label>)}</fieldset>;
}

function roundParameter(value: number) { return Number(value.toFixed(4)); }
