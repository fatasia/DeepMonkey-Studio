import { useState } from "react";
import ParametricModelWorkbench from "../parametric/ParametricModelWorkbench";

/** 使用真实建模内核的视觉验收入口；保存仍走正常项目鉴权，不替换运行逻辑。 */
export default function ParametricVisualQa() {
  const [open, setOpen] = useState(true);
  const pageMode = new URLSearchParams(window.location.search).get("page") === "1";

  if (pageMode) {
    return <main className="parametric-page-shell">
      <header className="parametric-page-header">
        <button type="button">返回资源</button>
        <div>
          <span>项目资源 · 参数化视觉验收</span>
          <h1>参数化生成</h1>
        </div>
      </header>
      <ParametricModelWorkbench embedded projectId="parametric-visual-qa" locale="zh-CN" onClose={() => undefined} onSaved={() => undefined} />
    </main>;
  }

  return <main className="app-shell">
    <button type="button" onClick={() => setOpen(true)}>打开建模</button>
    {open && <ParametricModelWorkbench projectId="parametric-visual-qa" locale="zh-CN" onClose={() => setOpen(false)} onSaved={() => undefined} />}
  </main>;
}
