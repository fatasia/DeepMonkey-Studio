import { useEffect, useState } from "react";
import { Camera, Footprints, Orbit, Plus, Save, ShieldCheck, Trash2, UserRound, X } from "lucide-react";
import type { CameraConstraintsState, CameraState, CameraViewState, NavigationSettingsState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

type NavigationMode = CameraState["mode"];

interface Props {
  locale: AppLocale;
  mode: NavigationMode;
  modelCount: number;
  avatarVisible: boolean;
  constraints: CameraConstraintsState;
  navigation: NavigationSettingsState;
  views: CameraViewState[];
  defaultViewId: string | undefined;
  onClose: () => void;
  onModeChange: (mode: NavigationMode) => void;
  onAvatarVisibleChange: (visible: boolean) => void;
  onConstraintsChange: (patch: Partial<CameraConstraintsState>) => void;
  onNavigationChange: (patch: Partial<NavigationSettingsState>) => void;
  onResetNavigation: () => void;
  onAddView: () => void;
  onApplyView: (view: CameraViewState) => void;
  onRenameView: (id: string, name: string) => void;
  onReplaceView: (id: string) => void;
  onRemoveView: (id: string) => void;
  onDefaultViewChange: (id: string) => void;
}

const MODES: Array<{ mode: NavigationMode; icon: typeof Orbit; zh: string; en: string; zhHint: string; enHint: string }> = [
  { mode: "orbit", icon: Orbit, zh: "轨道浏览", en: "Orbit", zhHint: "选取、编辑与环绕观察", enHint: "Select, edit and orbit" },
  { mode: "firstPerson", icon: Footprints, zh: "第一人称", en: "First person", zhHint: "贴地行走与碰撞检查", enHint: "Ground walk and collision" },
  { mode: "thirdPerson", icon: UserRound, zh: "第三人称", en: "Third person", zhHint: "自由飞行与空间巡检", enHint: "Free flight and inspection" }
];

export function CameraNavigationPanel(props: Props) {
  const activeMode = MODES.find((item) => item.mode === props.mode) ?? MODES[0]!;
  const collisionReady = props.constraints.collisionEnabled && props.modelCount > 0;
  return <section className="camera-views-panel camera-navigation-panel" aria-label={tr(props.locale, "相机与漫游", "Camera and navigation")}>
    <header>
      <div><strong>{tr(props.locale, "相机与漫游", "Camera & navigation")}</strong><small>{tr(props.locale, "切换模式时保留各自视角，配置随场景保存", "Each mode remembers its view; settings are saved with the scene")}</small></div>
      <button aria-label={tr(props.locale, "关闭", "Close")} onClick={props.onClose}><X size={14} /></button>
    </header>

    <div className="navigation-mode-grid" role="group" aria-label={tr(props.locale, "漫游模式", "Navigation mode")}>
      {MODES.map((item) => {
        const Icon = item.icon;
        return <button key={item.mode} className={props.mode === item.mode ? "active" : ""} aria-pressed={props.mode === item.mode} onClick={() => props.onModeChange(item.mode)}>
          <Icon size={17} />
          <span><strong>{tr(props.locale, item.zh, item.en)}</strong><small>{tr(props.locale, item.zhHint, item.enHint)}</small></span>
        </button>;
      })}
    </div>

    <div className={`navigation-readiness ${collisionReady ? "ready" : props.constraints.collisionEnabled ? "empty" : "warning"}`}>
      <ShieldCheck size={16} />
      <span>
        <strong>{collisionReady ? tr(props.locale, "防穿模已就绪", "Collision protection ready") : props.constraints.collisionEnabled ? tr(props.locale, "等待场景对象", "Waiting for scene objects") : tr(props.locale, "防穿模已关闭", "Collision protection is off")}</strong>
        <small>{collisionReady
          ? tr(props.locale, `${props.modelCount} 个可见对象参与相机阻挡`, `${props.modelCount} visible objects block the camera`)
          : props.constraints.collisionEnabled
            ? tr(props.locale, "导入或创建对象后自动参与检测", "Imported or created objects participate automatically")
            : tr(props.locale, "第一人称可能穿过墙体和设备", "First person may pass through walls and equipment")}</small>
      </span>
      <button className={props.constraints.collisionEnabled ? "active" : ""} onClick={() => props.onConstraintsChange({ collisionEnabled: !props.constraints.collisionEnabled })}>{props.constraints.collisionEnabled ? tr(props.locale, "已开启", "On") : tr(props.locale, "立即开启", "Enable")}</button>
    </div>

    <div className="navigation-active-summary">
      <div><span>{tr(props.locale, "当前模式", "Active mode")}</span><strong>{tr(props.locale, activeMode.zh, activeMode.en)}</strong></div>
      <p>{props.mode === "firstPerson"
        ? tr(props.locale, "双击画面捕获视角 · W A S D 移动 · Shift 加速 · 空格跳跃 · Esc 释放", "Double-click to capture · W A S D move · Shift sprint · Space jump · Esc release")
        : props.mode === "thirdPerson"
          ? tr(props.locale, "W A S D 移动 · Shift 加速 · Space 上升 · Ctrl 下降 · 鼠标旋转", "W A S D move · Shift boost · Space up · Ctrl down · Mouse to look")
          : tr(props.locale, "左键旋转 · 右键平移 · 滚轮缩放；编辑对象前保持轨道模式", "Left drag rotates · right drag pans · wheel zooms; stay in Orbit to edit")}</p>
      {props.mode === "thirdPerson" && <button className={props.avatarVisible ? "active" : ""} onClick={() => props.onAvatarVisibleChange(!props.avatarVisible)}>{props.avatarVisible ? tr(props.locale, "隐藏人物", "Hide avatar") : tr(props.locale, "显示人物", "Show avatar")}</button>}
    </div>

    <div className="navigation-motion-settings">
      <div className="camera-constraint-heading"><strong>{tr(props.locale, "移动手感", "Movement")}</strong><button onClick={props.onResetNavigation}>{tr(props.locale, "恢复默认", "Reset")}</button></div>
      <div className="navigation-setting-grid">
        <NumberField label={tr(props.locale, "行走速度", "Walk speed")} value={props.navigation.walkSpeed} min={0.1} max={50} step={0.5} suffix="m/s" onCommit={(walkSpeed) => props.onNavigationChange({ walkSpeed })} />
        <NumberField label={tr(props.locale, "飞行速度", "Fly speed")} value={props.navigation.flySpeed} min={0.1} max={100} step={0.5} suffix="m/s" onCommit={(flySpeed) => props.onNavigationChange({ flySpeed })} />
        <NumberField label={tr(props.locale, "加速倍率", "Sprint multiplier")} value={props.navigation.sprintMultiplier} min={1} max={6} step={0.25} suffix="×" onCommit={(sprintMultiplier) => props.onNavigationChange({ sprintMultiplier })} />
        <NumberField label={tr(props.locale, "视点高度", "Eye height")} value={props.navigation.eyeHeight} min={0.3} max={4} step={0.05} suffix="m" onCommit={(eyeHeight) => props.onNavigationChange({ eyeHeight })} />
        <NumberField label={tr(props.locale, "重力", "Gravity")} value={props.navigation.gravity} min={0} max={80} step={0.5} suffix="m/s²" onCommit={(gravity) => props.onNavigationChange({ gravity })} />
        <NumberField label={tr(props.locale, "跳跃速度", "Jump speed")} value={props.navigation.jumpSpeed} min={0} max={30} step={0.5} suffix="m/s" onCommit={(jumpSpeed) => props.onNavigationChange({ jumpSpeed })} />
        <NumberField label={tr(props.locale, "台阶高度", "Step height")} value={props.navigation.stepHeight} min={0} max={1.2} step={0.05} suffix="m" onCommit={(stepHeight) => props.onNavigationChange({ stepHeight })} />
        <NumberField label={tr(props.locale, "最大坡度", "Maximum slope")} value={props.navigation.maxSlopeAngle} min={0} max={89} step={1} suffix="°" onCommit={(maxSlopeAngle) => props.onNavigationChange({ maxSlopeAngle })} />
      </div>
    </div>

    <details className="camera-advanced-settings">
      <summary><span>{tr(props.locale, "相机与碰撞高级参数", "Advanced camera & collision")}</span><small>near / far / radius</small></summary>
      <div className="camera-constraint-settings">
        <div className="camera-constraint-grid">
          <NumberField label={tr(props.locale, "最近距离", "Minimum distance")} value={props.constraints.minDistance} min={0.01} step={0.1} onCommit={(minDistance) => props.onConstraintsChange({ minDistance })} />
          <NumberField label={tr(props.locale, "最远距离", "Maximum distance")} value={props.constraints.maxDistance} min={0.02} step={10} onCommit={(maxDistance) => props.onConstraintsChange({ maxDistance })} />
          <NumberField label={tr(props.locale, "垂直最小角", "Minimum angle")} value={props.constraints.minPolarAngle} min={0} max={179} step={1} suffix="°" onCommit={(minPolarAngle) => props.onConstraintsChange({ minPolarAngle })} />
          <NumberField label={tr(props.locale, "垂直最大角", "Maximum angle")} value={props.constraints.maxPolarAngle} min={0.1} max={180} step={1} suffix="°" onCommit={(maxPolarAngle) => props.onConstraintsChange({ maxPolarAngle })} />
          <NumberField label={tr(props.locale, "近裁剪面", "Near clipping")} value={props.constraints.nearClip} min={0.001} step={0.01} onCommit={(nearClip) => props.onConstraintsChange({ nearClip })} />
          <NumberField label={tr(props.locale, "远裁剪面", "Far clipping")} value={props.constraints.farClip} min={0.1} step={100} onCommit={(farClip) => props.onConstraintsChange({ farClip })} />
          <NumberField label={tr(props.locale, "碰撞半径", "Collision radius")} value={props.constraints.collisionRadius} min={0.02} step={0.05} suffix="m" disabled={!props.constraints.collisionEnabled} onCommit={(collisionRadius) => props.onConstraintsChange({ collisionRadius })} />
        </div>
        <p>{tr(props.locale, "裁剪面控制可见深度；碰撞半径越大，镜头与墙体、设备保持的安全距离越大。", "Clipping controls visible depth; a larger collision radius keeps the camera farther from walls and equipment.")}</p>
      </div>
    </details>

    <div className="camera-view-section-heading"><span><strong>{tr(props.locale, "场景视角", "Scene views")}</strong><small>{tr(props.locale, "用于一键定位和进入场景的默认视角", "One-click locations and default scene entry")}</small></span><button onClick={props.onAddView}><Plus size={13} />{tr(props.locale, "保存当前", "Save current")}</button></div>
    <div className="camera-view-list">
      {props.views.map((view) => <article key={view.id} className={view.id === props.defaultViewId ? "default" : ""}>
        <div className="camera-view-main"><button title={tr(props.locale, "切换到此视角", "Go to this view")} onClick={() => props.onApplyView(view)}><Camera size={14} /></button><input aria-label={tr(props.locale, "视角名称", "View name")} value={view.name} onChange={(event) => props.onRenameView(view.id, event.target.value)} onBlur={(event) => props.onRenameView(view.id, event.target.value)} /></div>
        <button className={view.id === props.defaultViewId ? "active" : ""} title={tr(props.locale, "设为进入场景的默认视角", "Set as default scene entry")} onClick={() => props.onDefaultViewChange(view.id)}>{tr(props.locale, "默认", "Default")}</button>
        <button title={tr(props.locale, "用当前相机覆盖", "Replace with current camera")} onClick={() => props.onReplaceView(view.id)}><Save size={13} /></button>
        <button title={tr(props.locale, "删除视角", "Delete view")} onClick={() => props.onRemoveView(view.id)}><Trash2 size={13} /></button>
      </article>)}
      {props.views.length === 0 && <p>{tr(props.locale, "移动相机后保存第一个常用视角。", "Move the camera, then save your first useful view.")}</p>}
    </div>
  </section>;
}

function NumberField({ label, value, min, max, step, suffix, disabled, onCommit }: { label: string; value: number; min?: number; max?: number; step?: number; suffix?: string; disabled?: boolean; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  function commit() {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) return setDraft(String(value));
    const bounded = Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, parsed));
    setDraft(String(bounded));
    onCommit(bounded);
  }
  return <label><span>{label}</span><div><input type="number" value={draft} min={min} max={max} step={step} disabled={disabled} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setDraft(String(value)); event.currentTarget.blur(); } }} />{suffix && <i>{suffix}</i>}</div></label>;
}
