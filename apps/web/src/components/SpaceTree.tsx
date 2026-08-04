import { useMemo, useState } from "react";
import { Building2, ChevronDown, ChevronRight, DoorOpen, Eye, EyeOff, LocateFixed } from "lucide-react";
import type { BimSpaceRecord } from "../viewer/ViewerEngine";

interface SpaceTreeProps {
  spaces: BimSpaceRecord[];
  onFocus: (space: BimSpaceRecord) => void;
  isVisible: (space: BimSpaceRecord) => boolean;
  onVisibilityChange: (space: BimSpaceRecord, visible: boolean) => void;
  onBatchVisibilityChange: (spaces: BimSpaceRecord[], visible: boolean) => void;
}

export function SpaceTree({ spaces, onFocus, isVisible, onVisibilityChange, onBatchVisibilityChange }: SpaceTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const models = useMemo(() => groupSpaces(spaces), [spaces]);

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (spaces.length === 0) {
    return <div className="space-empty"><DoorOpen size={25} /><strong>没有空间数据</strong><span>原生 RVT 的房间/MEP Space 或 IFCSPACE 会显示在这里</span></div>;
  }

  return <div className="space-tree">
    {models.map((model) => {
      const modelKey = `model:${model.modelId}`;
      const modelOpen = expanded.has(modelKey);
      const modelSpaces = model.levels.flatMap((level) => level.spaces);
      const modelVisible = modelSpaces.length > 0 && modelSpaces.every(isVisible);
      return <section key={model.modelId}>
        <div className="space-group-row"><button className="space-group" onClick={() => toggle(modelKey)}>{modelOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Building2 size={13} /><strong>{model.modelName}</strong><small>{model.count}</small></button><button className="space-eye" title={modelVisible ? "隐藏全部空间" : "显示全部空间"} onClick={() => onBatchVisibilityChange(modelSpaces, !modelVisible)}>{modelVisible ? <Eye size={13} /> : <EyeOff size={13} />}</button></div>
        {modelOpen && model.levels.map((level) => {
          const levelKey = `${modelKey}:level:${level.name}`;
          const levelOpen = expanded.has(levelKey);
          const levelVisible = level.spaces.length > 0 && level.spaces.every(isVisible);
          return <div className="space-level" key={levelKey}>
            <div className="space-level-row"><button onClick={() => toggle(levelKey)}>{levelOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<span>{level.name}</span><small>{level.spaces.length}</small></button><button className="space-eye" title={levelVisible ? "隐藏本层空间" : "显示本层空间"} onClick={() => onBatchVisibilityChange(level.spaces, !levelVisible)}>{levelVisible ? <Eye size={12} /> : <EyeOff size={12} />}</button></div>
            {levelOpen && <div className="space-room-list">{level.spaces.map((space) => {
              const visible = isVisible(space);
              return <div className={visible ? "visible" : ""} key={space.id}>
                <button className="space-room-main" onClick={() => onFocus(space)}><DoorOpen size={12} /><span><strong>{space.number ? `${space.number} ${space.name}` : space.name}</strong><small>{space.areaSquareMetres === undefined ? space.kind : `${space.areaSquareMetres.toFixed(2)} m²`}</small></span><LocateFixed size={12} /></button>
                <button className="space-eye" title={visible ? "隐藏空间体" : "显示空间体"} onClick={() => onVisibilityChange(space, !visible)}>{visible ? <Eye size={12} /> : <EyeOff size={12} />}</button>
              </div>;
            })}</div>}
          </div>;
        })}
      </section>;
    })}
  </div>;
}

function groupSpaces(spaces: BimSpaceRecord[]) {
  const models = new Map<string, { modelId: string; modelName: string; levels: Map<string, BimSpaceRecord[]> }>();
  for (const space of spaces) {
    const model = models.get(space.modelId) ?? { modelId: space.modelId, modelName: space.modelName, levels: new Map() };
    const levelSpaces = model.levels.get(space.level) ?? [];
    levelSpaces.push(space);
    model.levels.set(space.level, levelSpaces);
    models.set(space.modelId, model);
  }
  return [...models.values()].map((model) => ({
    modelId: model.modelId,
    modelName: model.modelName,
    count: [...model.levels.values()].reduce((total, items) => total + items.length, 0),
    levels: [...model.levels.entries()].map(([name, levelSpaces]) => ({ name, spaces: levelSpaces }))
  }));
}
