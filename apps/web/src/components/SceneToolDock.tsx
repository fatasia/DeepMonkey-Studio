import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Atom,
  Bot,
  Box,
  Braces,
  Camera,
  Cable,
  ChartSpline,
  ChevronDown,
  Eye,
  EyeOff,
  Film,
  Focus,
  Footprints,
  Info,
  Layers3,
  MapPin,
  MousePointer2,
  Move,
  Orbit,
  RotateCw,
  Route,
  Ruler,
  ScanLine,
  Scaling,
  Sun,
  UserRound,
} from "lucide-react";
import type { PrimitiveKind } from "@bim-studio/contracts";
import { primitiveKindLabel } from "../appPresentation";
import { translate as tr, type AppLocale } from "../i18n";
import { SCENE_SIMULATION_PANELS, type SceneSimulationPanelId } from "../simulation/sceneSimulationRegistry";
import type {
  NavigationMode,
  SelectionScope,
  TransformMode,
} from "../viewer/ViewerEngine";

type ToolMenu = "create" | "inspect" | "develop";

interface SceneToolDockProps {
  locale: AppLocale;
  navigationMode: NavigationMode;
  transformMode: TransformMode;
  /** 没有选中可编辑对象时不显示变换模式，避免工具看似可用但点击无效。 */
  hasSelection: boolean;
  selectionScope: SelectionScope;
  measureEnabled: boolean;
  annotationEnabled: boolean;
  clippingEnabled: boolean;
  explosionActive: boolean;
  avatarVisible: boolean;
  environmentOpen: boolean;
  animationOpen: boolean;
  behaviorOpen: boolean;
  cameraOpen: boolean;
  physicsOpen: boolean;
  xrOpen: boolean;
  simulationPanel: SceneSimulationPanelId | undefined;
  infoEnabled: boolean;
  onFitAll: () => void;
  onSelect: () => void;
  onTransformChange: (mode: TransformMode) => void;
  onSelectionScopeToggle: () => void;
  onMeasurementToggle: () => void;
  onPrimitivePlace: (kind: PrimitiveKind) => void;
  onAnnotationToggle: () => void;
  onClippingToggle: () => void;
  onExplosionToggle: () => void;
  onNavigationChange: (mode: NavigationMode) => void;
  onAvatarToggle: () => void;
  onInfoToggle: () => void;
  onEnvironmentToggle: () => void;
  onAnimationToggle: () => void;
  onBehaviorToggle: () => void;
  onCameraToggle: () => void;
  onPhysicsToggle: () => void;
  onXrToggle: () => void;
  onSimulationPanelChange: (panel: SceneSimulationPanelId) => void;
}

const PRIMITIVE_KINDS: readonly PrimitiveKind[] = [
  "box",
  "sphere",
  "cylinder",
  "cone",
  "torus",
  "plane",
  "capsule",
];

/**
 * 视口工具坞只常驻高频编辑动作，低频能力按任务分组展开。
 * 所有原有能力仍可达，但不会再用二十多个同权图标压迫主画布。
 */
export function SceneToolDock(props: SceneToolDockProps) {
  const [openMenu, setOpenMenu] = useState<ToolMenu>();
  const dockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function closeFromOutside(event: PointerEvent) {
      if (!dockRef.current?.contains(event.target as Node)) setOpenMenu(undefined);
    }

    function closeFromKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenMenu(undefined);
    }

    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, []);

  function run(action: () => void) {
    action();
    setOpenMenu(undefined);
  }

  return (
    <div
      ref={dockRef}
      className="tool-dock scene-tool-dock"
      role="toolbar"
      aria-label={tr(props.locale, "场景编辑工具", "Scene editing tools")}
    >
      <DockButton
        label={tr(props.locale, "适应全部", "Fit all")}
        icon={<Focus size={18} />}
        onClick={props.onFitAll}
      />

      <span className="scene-tool-separator" />
      <DockButton
        label={tr(props.locale, "选择", "Select")}
        icon={<MousePointer2 size={18} />}
        active={
          !props.hasSelection &&
          !props.measureEnabled &&
          !props.annotationEnabled &&
          props.navigationMode === "orbit"
        }
        onClick={props.onSelect}
      />
      <DockButton
        label={tr(props.locale, "移动", "Move")}
        icon={<Move size={18} />}
        active={props.hasSelection && props.transformMode === "translate"}
        disabled={!props.hasSelection}
        onClick={() => props.onTransformChange("translate")}
      />
      <DockButton
        label={tr(props.locale, "旋转", "Rotate")}
        icon={<RotateCw size={18} />}
        active={props.hasSelection && props.transformMode === "rotate"}
        disabled={!props.hasSelection}
        onClick={() => props.onTransformChange("rotate")}
      />
      <DockButton
        label={tr(props.locale, "缩放", "Scale")}
        icon={<Scaling size={18} />}
        active={props.hasSelection && props.transformMode === "scale"}
        disabled={!props.hasSelection}
        onClick={() => props.onTransformChange("scale")}
      />

      <span className="scene-tool-separator" />
      <DockButton
        label={tr(props.locale, "测量", "Measure")}
        icon={<Ruler size={18} />}
        active={props.measureEnabled}
        onClick={props.onMeasurementToggle}
      />
      <DockButton
        label={tr(props.locale, "标注", "Annotate")}
        icon={<MapPin size={18} />}
        active={props.annotationEnabled}
        onClick={props.onAnnotationToggle}
      />

      <TaskMenu
        id="create"
        label={tr(props.locale, "创建", "Create")}
        icon={<Box size={16} />}
        open={openMenu === "create"}
        onToggle={() => setOpenMenu((value) => (value === "create" ? undefined : "create"))}
      >
        <MenuHeading
          title={tr(props.locale, "插入基础元素", "Insert primitive")}
          hint={tr(props.locale, "选择后点击画布放置", "Choose, then place in viewport")}
        />
        <div className="scene-tool-primitive-grid">
          {PRIMITIVE_KINDS.map((kind) => (
            <MenuAction
              key={kind}
              label={primitiveKindLabel(kind, props.locale)}
              icon={<Box size={14} />}
              onClick={() => run(() => props.onPrimitivePlace(kind))}
            />
          ))}
        </div>
      </TaskMenu>

      <TaskMenu
        id="inspect"
        label={tr(props.locale, "查看与分析", "View & inspect")}
        icon={<Orbit size={16} />}
        open={openMenu === "inspect"}
        active={
          props.navigationMode !== "orbit" ||
          props.clippingEnabled ||
          props.explosionActive ||
          props.environmentOpen ||
          props.cameraOpen ||
          props.infoEnabled
        }
        onToggle={() => setOpenMenu((value) => (value === "inspect" ? undefined : "inspect"))}
      >
        <MenuHeading
          title={tr(props.locale, "浏览方式", "Navigation")}
          hint={tr(props.locale, "改变查看方式，不修改场景内容", "Changes the view, not scene content")}
        />
        <MenuAction
          label={tr(props.locale, "轨道浏览", "Orbit")}
          icon={<Orbit size={15} />}
          active={props.navigationMode === "orbit"}
          onClick={() => run(() => props.onNavigationChange("orbit"))}
        />
        <MenuAction
          label={tr(props.locale, "第一人称行走", "First-person walk")}
          icon={<Footprints size={15} />}
          active={props.navigationMode === "firstPerson"}
          onClick={() => run(() => props.onNavigationChange("firstPerson"))}
        />
        <MenuAction
          label={tr(props.locale, "第三人称巡检", "Third-person inspect")}
          icon={<UserRound size={15} />}
          active={props.navigationMode === "thirdPerson"}
          onClick={() => run(() => props.onNavigationChange("thirdPerson"))}
        />
        <MenuAction
          label={
            props.avatarVisible
              ? tr(props.locale, "隐藏巡检人物", "Hide avatar")
              : tr(props.locale, "显示巡检人物", "Show avatar")
          }
          icon={props.avatarVisible ? <Eye size={15} /> : <EyeOff size={15} />}
          active={props.avatarVisible}
          onClick={() => run(props.onAvatarToggle)}
        />

        <div className="scene-tool-menu-rule" />
        <MenuHeading
          title={tr(props.locale, "对象与场景分析", "Object and scene inspection")}
          hint={tr(props.locale, "按需开启工程分析工具", "Enable engineering tools as needed")}
        />
        <MenuAction
          label={
            props.selectionScope === "component"
              ? tr(props.locale, "构件级选择", "Component selection")
              : tr(props.locale, "模型级选择", "Model selection")
          }
          icon={<MousePointer2 size={15} />}
          active={props.selectionScope === "component"}
          onClick={() => run(props.onSelectionScopeToggle)}
        />
        <MenuAction
          label={tr(props.locale, "剖切模型", "Section model")}
          icon={<ScanLine size={15} />}
          active={props.clippingEnabled}
          onClick={() => run(props.onClippingToggle)}
        />
        <MenuAction
          label={tr(props.locale, "模型爆炸", "Explode model")}
          icon={<Layers3 size={15} />}
          active={props.explosionActive}
          onClick={() => run(props.onExplosionToggle)}
        />
        <MenuAction
          label={tr(props.locale, "场景信息", "Scene information")}
          icon={<Info size={15} />}
          active={props.infoEnabled}
          onClick={() => run(props.onInfoToggle)}
        />
        <MenuAction
          label={tr(props.locale, "环境与灯光", "Environment & lighting")}
          icon={<Sun size={15} />}
          active={props.environmentOpen}
          onClick={() => run(props.onEnvironmentToggle)}
        />
        <MenuAction
          label={tr(props.locale, "相机与漫游", "Camera & navigation")}
          icon={<Camera size={15} />}
          active={props.cameraOpen}
          onClick={() => run(props.onCameraToggle)}
        />
      </TaskMenu>

      <TaskMenu
        id="develop"
        label={tr(props.locale, "仿真与开发", "Simulate & develop")}
        icon={<Braces size={16} />}
        open={openMenu === "develop"}
        active={
          props.animationOpen ||
          props.behaviorOpen ||
          props.physicsOpen ||
          props.xrOpen ||
          Boolean(props.simulationPanel)
        }
        onToggle={() => setOpenMenu((value) => (value === "develop" ? undefined : "develop"))}
      >
        <MenuHeading
          title={tr(props.locale, "场景运行能力", "Scene runtime")}
          hint={tr(props.locale, "高级能力按需加载并随项目保存", "Advanced capabilities load on demand")}
        />
        <MenuAction
          label={tr(props.locale, "动画与时间线", "Animation & timeline")}
          icon={<Film size={15} />}
          active={props.animationOpen}
          onClick={() => run(props.onAnimationToggle)}
        />
        <MenuAction
          label={tr(props.locale, "行为脚本", "Behavior scripts")}
          icon={<Braces size={15} />}
          active={props.behaviorOpen}
          onClick={() => run(props.onBehaviorToggle)}
        />
        <MenuAction
          label={tr(props.locale, "物理系统", "Physics")}
          icon={<Atom size={15} />}
          active={props.physicsOpen}
          onClick={() => run(props.onPhysicsToggle)}
        />
        <MenuAction
          label={tr(props.locale, "AR / VR 体验", "AR / VR")}
          icon={<span className="scene-tool-xr">XR</span>}
          active={props.xrOpen}
          onClick={() => run(props.onXrToggle)}
        />
        <div className="scene-tool-menu-rule" />
        <MenuHeading
          title={tr(props.locale, "生产仿真插件", "Production simulation plugins")}
          hint={tr(props.locale, "留在三维视口内运行，结果统一进入 Study", "Run in the viewport; persist results as Studies")}
        />
        {SCENE_SIMULATION_PANELS.map((panel) => (
          <MenuAction
            key={panel.id}
            label={tr(props.locale, panel.label, panel.englishLabel)}
            icon={<SimulationIcon panel={panel.id} />}
            active={props.simulationPanel === panel.id}
            onClick={() => run(() => props.onSimulationPanelChange(panel.id))}
          />
        ))}
      </TaskMenu>
    </div>
  );
}

function SimulationIcon({ panel }: { panel: SceneSimulationPanelId }) {
  if (panel === "logistics") return <Route size={15} />;
  if (panel === "workcell") return <Bot size={15} />;
  if (panel === "commissioning") return <Cable size={15} />;
  return <ChartSpline size={15} />;
}

function DockButton({
  label,
  icon,
  active = false,
  disabled = false,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`scene-dock-button ${active ? "active" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

function TaskMenu({
  id,
  label,
  icon,
  open,
  active = false,
  onToggle,
  children,
}: {
  id: ToolMenu;
  label: string;
  icon: ReactNode;
  open: boolean;
  active?: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className={`scene-tool-task ${open ? "open" : ""}`}>
      <button
        type="button"
        className={`scene-tool-task-trigger ${active ? "active" : ""}`}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`scene-tool-menu-${id}`}
        onClick={onToggle}
      >
        {icon}
        <span>{label}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div id={`scene-tool-menu-${id}`} className="scene-tool-menu" role="menu">
          {children}
        </div>
      )}
    </div>
  );
}

function MenuHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <header className="scene-tool-menu-heading">
      <strong>{title}</strong>
      <small>{hint}</small>
    </header>
  );
}

function MenuAction({
  label,
  icon,
  active = false,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`scene-tool-menu-action ${active ? "active" : ""}`}
      onClick={onClick}
    >
      <span>{icon}</span>
      <strong>{label}</strong>
      {active && <i />}
    </button>
  );
}
