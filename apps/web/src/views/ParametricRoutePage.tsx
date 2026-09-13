import { lazy, Suspense } from "react";
import { LoaderCircle } from "lucide-react";
import type { ProjectRecord } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

const ParametricModelWorkbench = lazy(() => import("../parametric/ParametricModelWorkbench"));

interface ParametricRoutePageProps {
  locale: AppLocale;
  project: ProjectRecord;
  onBack: () => void;
  onSaved: () => Promise<void>;
}

/** 参数化建模路由只拥有页面壳与项目资源返回流程。 */
export function ParametricRoutePage({ locale, project, onBack, onSaved }: ParametricRoutePageProps) {
  return (
    <Suspense
      fallback={
        <div className="optimizer-loading">
          <LoaderCircle className="spin" size={25} /> {tr(locale, "正在加载参数化建模", "Loading parametric modeling")}
        </div>
      }
    >
      <main className="parametric-page-shell">
        <header className="parametric-page-header">
          <button type="button" onClick={onBack}>
            {tr(locale, "返回资源", "Back to assets")}
          </button>
          <div>
            <span>{tr(locale, "项目资源", "Project assets")} · {project.name}</span>
            <h1>{tr(locale, "参数化生成", "Parametric generation")}</h1>
          </div>
        </header>
        <ParametricModelWorkbench
          embedded
          projectId={project.id}
          locale={locale}
          dataConnections={project.dataConnections ?? []}
          datasets={project.datasets ?? []}
          onClose={onBack}
          onSaved={onSaved}
        />
      </main>
    </Suspense>
  );
}
