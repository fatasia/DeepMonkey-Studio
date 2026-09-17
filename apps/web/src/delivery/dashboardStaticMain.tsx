import { createRoot } from "react-dom/client";
import { loadDashboardWebPackage, mountDashboardWebResources } from "./dashboardWebPackageLoader";
import "../styles/base.css";
import "./dashboard-static.css";

const root = createRoot(document.getElementById("root")!);
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
root.render(<main className="dashboard-static-state" role="status"><p>正在校验离线发布包…</p></main>);
const controller = new AbortController();
window.addEventListener("pagehide",()=>controller.abort(),{once:true});
async function start() {
  const base = new URL("./",window.location.href);
  const loaded = await loadDashboardWebPackage(base,AbortSignal.any([controller.signal,AbortSignal.timeout(60_000)]));
  const mounted = await mountDashboardWebResources(loaded.manifest,loaded.resources);
  if (controller.signal.aborted) {mounted.dispose();return;}
  window.addEventListener("pagehide",mounted.dispose,{once:true});
  const {DashboardStaticRoot}=await import("./DashboardStaticRoot");
  root.render(<DashboardStaticRoot manifest={loaded.manifest} application={mounted.application}/>);
}
void start().catch(error=>root.render(<main className="dashboard-static-state" role="alert"><h1>无法打开离线发布包</h1>
  <p>{error instanceof Error ? error.message : "请重新部署完整目录"}</p><button onClick={()=>location.reload()}>重新校验</button></main>));
