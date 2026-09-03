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

/** Compact category silhouette using the same native color as the inserted editable proxy. */
export function IndustrialPrefabThumbnail({ definition }: IndustrialPrefabThumbnailProps) {
  const Icon = ICONS[definition.kind] ?? PackageOpen;
  const color = industrialPrefabPrimitiveVisual(definition.kind).color;
  const variant = definition.id.split("-").at(-1)?.slice(0, 2).toUpperCase() ?? "3D";
  return (
    <span
      className="scene-prefab-thumbnail"
      data-kind={definition.kind}
      style={{ "--resource-accent": color } as CSSProperties}
      aria-hidden="true"
    >
      <Icon size={17} strokeWidth={1.8} />
      <i>{variant}</i>
    </span>
  );
}
