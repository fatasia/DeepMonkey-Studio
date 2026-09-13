import { useEffect, useState } from "react";
import type { CSSProperties, ComponentType } from "react";
import type { IndustrialPrefabDefinition, IndustrialPrefabKind } from "@bim-studio/contracts";
import {
  Bot,
  Boxes,
  Camera,
  DoorOpen,
  Factory,
  KeyRound,
  Monitor,
  MoveHorizontal,
  Navigation,
  PackageOpen,
  Radio,
  Truck,
  UserRound,
  Warehouse,
  Zap,
} from "lucide-react";
import { industrialPrefabPrimitiveVisual } from "../prefabs/industrialPrefabInstance";
import { getPrefabThumbnail } from "../prefabs/thumbnail/prefabThumbnailRenderer";

interface IndustrialPrefabThumbnailProps {
  definition: IndustrialPrefabDefinition;
}

const ICONS: Record<IndustrialPrefabKind, ComponentType<{ size?: number; strokeWidth?: number }>> = {
  conveyor: MoveHorizontal,
  "robot-arm": Bot,
  person: UserRound,
  agv: Navigation,
  vehicle: Truck,
  "access-control": KeyRound,
  display: Monitor,
  fence: DoorOpen,
  machine: Factory,
  utility: Boxes,
  electrical: Zap,
  sensor: Radio,
  camera: Camera,
  storage: Warehouse,
};

/**
 * 工业预制体缩略图:首帧立即渲染既有图标骨架(零布局跳动),
 * 程序化 3D 小样在后台经共享离屏渲染器排队生成,就绪后淡入覆盖;
 * WebGL 不可用或渲染失败时永远回落图标。
 */
export function IndustrialPrefabThumbnail({ definition }: IndustrialPrefabThumbnailProps) {
  const Icon = ICONS[definition.kind] ?? PackageOpen;
  const color = industrialPrefabPrimitiveVisual(definition.kind).color;
  const variant = definition.id.split("-").at(-1)?.slice(0, 2).toUpperCase() ?? "3D";
  const [dataUrl, setDataUrl] = useState<string>();
  const [imageReady, setImageReady] = useState(false);

  useEffect(() => {
    let alive = true;
    setDataUrl(undefined);
    setImageReady(false);
    getPrefabThumbnail(definition)
      .then((url) => {
        if (alive) setDataUrl(url);
      })
      .catch(() => {
        // 队列已保证不 reject;双保险降级回图标。
        if (alive) setDataUrl(undefined);
      });
    return () => {
      alive = false;
    };
  }, [definition]);

  return (
    <span
      className="scene-prefab-thumbnail"
      data-kind={definition.kind}
      style={{ "--resource-accent": color } as CSSProperties}
      aria-hidden="true"
    >
      <Icon size={17} strokeWidth={1.8} />
      <i>{variant}</i>
      {dataUrl && (
        <img
          className={`prefab-thumbnail-image${imageReady ? " is-ready" : ""}`}
          src={dataUrl}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={() => setImageReady(true)}
          onError={() => setDataUrl(undefined)}
        />
      )}
    </span>
  );
}
