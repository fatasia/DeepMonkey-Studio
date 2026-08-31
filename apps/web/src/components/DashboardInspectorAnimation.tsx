import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { translate as tr } from "../i18n";
import { defaultDashboardAnimationLoop, resolveDashboardAnimationLoop } from "./dashboardAnimationPlayback";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

export function DashboardInspectorAnimation() {
  const { inspectorTab, locale, selectedNode, updateDataWidget } = useDashboardWorkspace();
  if (!selectedNode) return null;

  return (
    inspectorTab === "animation" &&
    selectedNode.kind === "data-widget" && (
      <section className="dashboard-inspector-section dashboard-data-widget-properties">
        <label>
          <span>{tr(locale, "进入动画", "Enter animation")}</span>
          <select
            value={selectedNode.widget.animation ?? "none"}
            onChange={(event) => {
              const animation = event.target.value as NonNullable<DashboardDataWidgetConfig["animation"]>;
              updateDataWidget({ animation, animationLoop: defaultDashboardAnimationLoop(animation) });
            }}
          >
            <option value="none">{tr(locale, "无", "None")}</option>
            <option value="fade">Fade</option>
            <option value="slide-up">Slide up</option>
            <option value="scale">Scale</option>
            <option value="pulse">Pulse</option>
          </select>
        </label>
        <label>
          <span>{tr(locale, "时长（秒）", "Duration (s)")}</span>
          <input
            type="number"
            min="0.1"
            step="0.1"
            value={selectedNode.widget.animationDuration ?? 0.6}
            onChange={(event) =>
              updateDataWidget({
                animationDuration: Math.max(0.1, Number(event.target.value)),
              })
            }
          />
        </label>
        <label>
          <span>{tr(locale, "延迟（秒）", "Delay (s)")}</span>
          <input
            type="number"
            min="0"
            step="0.1"
            value={selectedNode.widget.animationDelay ?? 0}
            onChange={(event) =>
              updateDataWidget({
                animationDelay: Math.max(0, Number(event.target.value)),
              })
            }
          />
        </label>
        <label className="dashboard-inspector-check-row">
          <input
            type="checkbox"
            checked={selectedNode.widget.animationAutoplay !== false}
            onChange={(event) => updateDataWidget({ animationAutoplay: event.target.checked })}
          />
          <span>{tr(locale, "进入预览时自动播放", "Autoplay in preview")}</span>
        </label>
        <label>
          <span>{tr(locale, "播放方式", "Playback")}</span>
          <select
            value={resolveDashboardAnimationLoop(selectedNode.widget) ? "loop" : "once"}
            onChange={(event) => updateDataWidget({ animationLoop: event.target.value === "loop" })}
          >
            <option value="once">{tr(locale, "播放一次", "Play once")}</option>
            <option value="loop">{tr(locale, "循环播放", "Loop")}</option>
          </select>
        </label>
        <small className="dashboard-inspector-hint">
          {tr(locale, "动画只在预览运行态播放；关闭自动播放后保持静态，可由脚本或交互接管。", "Animations run only in preview; disable autoplay to let scripts or interactions take control.")}
        </small>
      </section>
    )
  );
}
