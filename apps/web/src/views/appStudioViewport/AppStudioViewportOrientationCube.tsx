import { useEffect, useRef, useState } from "react";
import type { CameraState } from "@bim-studio/contracts";
import { ViewOrientationCube } from "../../components/ViewOrientationCube";
import "../../components/ViewOrientationCube.css";
import type { AppStudioController } from "../AppStudioShell";

// source-size 拆分(2026-10-04):自 AppStudioViewport.tsx 按职责抽出,代码逐行同源;语义零变化。

function getCubeOrientation(camera?: CameraState): { azimuthDeg: number; elevationDeg: number } {
  if (!camera) return { azimuthDeg: 0, elevationDeg: 25 };
  const dx = camera.position.x - camera.target.x;
  const dy = camera.position.y - camera.target.y;
  const dz = camera.position.z - camera.target.z;
  const horizontalDistance = Math.hypot(dx, dz);
  if (horizontalDistance + Math.abs(dy) < 0.0001) return { azimuthDeg: 0, elevationDeg: 25 };
  return {
    azimuthDeg: Math.atan2(dx, dz) * 180 / Math.PI,
    elevationDeg: Math.atan2(dy, horizontalDistance) * 180 / Math.PI,
  };
}

interface EngineViewOrientationCubeProps {
  readonly engine: NonNullable<AppStudioController["engine"]>;
  readonly locale: Parameters<typeof ViewOrientationCube>[0]["locale"];
  readonly hasSelection: boolean;
  readonly onStandardView: Parameters<typeof ViewOrientationCube>[0]["onStandardView"];
  readonly onFitAll: () => void;
  readonly onFitSelected: () => void;
  readonly onOptimizeView: () => void;
}

/** Keeps high-frequency orientation updates inside the tiny viewport control. */
export function EngineViewOrientationCube(props: EngineViewOrientationCubeProps) {
  const [camera, setCamera] = useState<CameraState>(() => props.engine.getCameraState());
  const innerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const initial = props.engine.getCameraState();
    setCamera(initial);
    let settleTimer: number | undefined;
    const unsubscribe = props.engine.subscribeCameraChange((next) => {
      const nextOrientation = getCubeOrientation(next);
      // The cube's visual rotation is compositor-only. Updating the element
      // directly keeps it attached to every camera frame without committing
      // the React tree on every pointer sample; React catches up once after the
      // gesture so face semantics and accessibility state stay authoritative.
      if (innerRef.current) innerRef.current.style.transform = `rotateX(${-nextOrientation.elevationDeg}deg) rotateY(${-nextOrientation.azimuthDeg}deg)`;
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        settleTimer = undefined;
        setCamera(next);
      }, 80);
    });
    return () => {
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
      unsubscribe();
    };
  }, [props.engine]);
  const orientation = getCubeOrientation(camera);
  return <ViewOrientationCube locale={props.locale} azimuthDeg={orientation.azimuthDeg}
    elevationDeg={orientation.elevationDeg} hasSelection={props.hasSelection}
    innerRef={innerRef}
    onStandardView={props.onStandardView} onFitAll={props.onFitAll}
    onFitSelected={props.onFitSelected} onOptimizeView={props.onOptimizeView} />;
}
