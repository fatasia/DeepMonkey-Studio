import type { ScenePublicationCompatibilityReport } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import "../styles/scene-publication-failure.css";

const fieldNames: Record<string, readonly [string, string]> = {
  "$": ["运行环境", "Runtime"], camera: ["相机", "Camera"], cameraConstraints: ["相机约束", "Camera constraints"],
  environment: ["场景环境", "Environment"], lighting: ["光照", "Lighting"], postProcessing: ["后处理", "Post-processing"],
  weather: ["天气", "Weather"], animation: ["动画", "Animation"], physics: ["物理模拟", "Physics"],
  clipping: ["剖切", "Sectioning"], coordinateSystem: ["坐标系", "Coordinates"], dashboard: ["二维页面", "2D page"],
  navigationSettings: ["导航设置", "Navigation settings"],
};

export function ScenePublicationFailure({ message, report, sceneName, locale }: {
  message: string; report?: ScenePublicationCompatibilityReport; sceneName: string; locale: AppLocale;
}) {
  if (!report) return <p className="publication-submit-error" role="alert">{message}</p>;
  const issues = report.items.filter(item => item.status === "blocked" || item.status === "degraded"
    || (item.status === "webview-only" && report.target === "deep-native"));
  if (!issues.length) return <p className="publication-submit-error" role="alert">{message}</p>;
  return <section className="publication-failure" aria-label={tr(locale, "发布检查结果", "Publication checks")}>
    <p role="alert">{tr(locale, `有 ${issues.length} 项内容未通过发布检查。`, `${issues.length} items did not pass publication checks.`)}</p>
    <p>{tr(locale, "查看问题后修正并重试，或选择 Three WebView 交付。", "Review the issues, fix and retry, or choose Three WebView.")}</p>
    <details>
      <summary>{tr(locale, "查看全部问题", "Review all issues")}</summary>
      <ol>{issues.map((item, index) => {
        const label = fieldNames[item.path];
        return <li key={`${item.objectId}:${item.path}:${index}`}>
          <strong>{item.objectId === report.sceneId ? sceneName : item.objectId} · {label ? tr(locale, ...label) : item.path}</strong>
          <p>{item.reason}</p><p>{item.remediation}</p>
          <small>{item.objectId} · {item.path}</small>
        </li>;
      })}</ol>
    </details>
  </section>;
}
