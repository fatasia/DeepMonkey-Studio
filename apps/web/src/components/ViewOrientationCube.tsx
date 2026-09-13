import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Focus, Maximize2, Sparkles } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import type { StandardView } from "../viewer/ViewerEngine";

export interface ViewOrientationCubeProps {
  locale: AppLocale;
  /** Camera azimuth in degrees (0 = front, 90 = right side). */
  azimuthDeg: number;
  /** Camera elevation in degrees (0 = horizontal, 90 = top-down). */
  elevationDeg: number;
  activeView?: StandardView | null;
  hasSelection: boolean;
  onStandardView: (view: StandardView) => void;
  onFitAll: () => void;
  onFitSelected: () => void;
  onOptimizeView: () => void;
}

const FACES: Array<{ view: StandardView; label: string; en: string; transform: string; normal: readonly [number, number, number] }> = [
  { view: "front", label: "前", en: "Front", transform: "translateZ(24px)", normal: [0, 0, 1] },
  { view: "back", label: "后", en: "Back", transform: "rotateY(180deg) translateZ(24px)", normal: [0, 0, -1] },
  { view: "right", label: "右", en: "Right", transform: "rotateY(90deg) translateZ(24px)", normal: [1, 0, 0] },
  { view: "left", label: "左", en: "Left", transform: "rotateY(-90deg) translateZ(24px)", normal: [-1, 0, 0] },
  { view: "top", label: "顶", en: "Top", transform: "rotateX(90deg) translateZ(24px)", normal: [0, -1, 0] },
  { view: "bottom", label: "底", en: "Bottom", transform: "rotateX(-90deg) translateZ(24px)", normal: [0, 1, 0] },
];

export function ViewOrientationCube(props: ViewOrientationCubeProps) {
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef({ active: false, lastX: 0, lastY: 0, distance: 0 });
  const releaseRef = useRef({ rotX: 0, rotY: 0, onStandardView: props.onStandardView });
  const rotX = -props.elevationDeg + drag.x;
  const rotY = -props.azimuthDeg + drag.y;
  const facingView = props.activeView ?? nearestCubeFace(rotX, rotY).view;
  releaseRef.current = { rotX, rotY, onStandardView: props.onStandardView };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const state = dragRef.current;
      if (!state.active) return;
      const dx = event.clientX - state.lastX;
      const dy = event.clientY - state.lastY;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      state.distance += Math.abs(dx) + Math.abs(dy);
      setDrag((current) => ({ x: clamp180(current.x - dy * 0.6), y: current.y + dx * 0.6 }));
    };
    const onEnd = () => {
      const state = dragRef.current;
      dragRef.current.active = false;
      setDragging(false);
      if (state.active && state.distance > 3) {
        const release = releaseRef.current;
        const face = nearestCubeFace(release.rotX, release.rotY);
        setDrag({ x: 0, y: 0 });
        release.onStandardView(face.view);
      }
      window.setTimeout(() => { dragRef.current.distance = 0; }, 0);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { active: true, lastX: event.clientX, lastY: event.clientY, distance: 0 };
    setDragging(true);
  };
  const onFaceClick = (view: StandardView) => {
    if (dragRef.current.distance > 3) return;
    setDrag({ x: 0, y: 0 });
    props.onStandardView(view);
  };

  return (
    <div
      className="view-orientation-cube"
      role="group"
      aria-label={tr(props.locale, "视角魔方", "View orientation cube")}
      title={tr(props.locale, "拖动旋转魔方，点击面切换视角，双击复位", "Drag the cube to rotate; click a face to snap; double-click to reset")}
    >
      <div
        className={`cube-viewport${dragging ? " dragging" : ""}`}
        onPointerDown={onPointerDown}
        onDoubleClick={() => setDrag({ x: 0, y: 0 })}
      >
        <div className="cube-inner" style={{ transform: `rotateX(${rotX}deg) rotateY(${rotY}deg)` }}>
          {FACES.map((face) => (
            <button
              key={face.view}
              type="button"
              className={`cube-face ${facingView === face.view ? "active" : ""}`}
              style={{ transform: face.transform }}
              title={tr(props.locale, face.label, face.en)}
              aria-label={tr(props.locale, face.label, face.en)}
              onClick={() => onFaceClick(face.view)}
            >
              {tr(props.locale, face.label, face.en)}
            </button>
          ))}
        </div>
      </div>
      <div className="cube-actions">
        <button type="button" title={tr(props.locale, "优化视角", "Optimize view")} aria-label={tr(props.locale, "优化视角", "Optimize view")} onClick={props.onOptimizeView}>
          <Sparkles size={12} strokeWidth={2} />
        </button>
        <button type="button" title={props.hasSelection ? tr(props.locale, "适应选中模型", "Fit selected") : tr(props.locale, "请先选择模型", "Select a model first")} aria-label={tr(props.locale, "适应选中模型", "Fit selected")} disabled={!props.hasSelection} onClick={props.onFitSelected}>
          <Focus size={12} strokeWidth={2} />
        </button>
        <button type="button" title={tr(props.locale, "适应整个场景", "Fit entire scene")} aria-label={tr(props.locale, "适应整个场景", "Fit entire scene")} onClick={props.onFitAll}>
          <Maximize2 size={12} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

function clamp180(deg: number): number {
  return Math.max(-180, Math.min(180, deg));
}

export function nearestCubeFace(rotXDeg: number, rotYDeg: number): { view: StandardView; label: string; en: string } {
  const x = rotXDeg * Math.PI / 180;
  const y = rotYDeg * Math.PI / 180;
  const cosX = Math.cos(x);
  const sinX = Math.sin(x);
  const cosY = Math.cos(y);
  const sinY = Math.sin(y);
  let best = FACES[0]!;
  let bestDepth = -2;
  for (const face of FACES) {
    const [nx, ny, nz] = face.normal;
    const depth = ny * sinX + (nz * cosY - nx * sinY) * cosX;
    if (depth > bestDepth) {
      best = face;
      bestDepth = depth;
    }
  }
  return best;
}
