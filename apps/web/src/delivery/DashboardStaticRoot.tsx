import { useEffect, useState } from "react";
import type { ApplicationDocument, ProjectRecord } from "@bim-studio/contracts";
import { DashboardPlayback } from "../components/DashboardPlayback";
import { publishedInitialDashboardFilters } from "./publishedApplicationModel";
import { registerPreprocessor } from "echarts/core";
import type { DashboardWebPackage } from "./dashboardWebPackage";
import "../styles/platform-components.css";
import "../styles/dashboard-workspace.css";
import "../styles/dashboardWorkspacePolish.css";
import "./dashboard-static.css";

registerPreprocessor(option=>{ option.textStyle={...option.textStyle,fontFamily:"DashboardPackage"}; });

export function DashboardStaticRoot({manifest,application}:{manifest:DashboardWebPackage;application:ApplicationDocument}) {
  const [pageId,setPageId] = useState(manifest.entryPageId), [error,setError] = useState("");
  const [fullscreen,setFullscreen] = useState(Boolean(document.fullscreenElement));
  const page = application.pages.find(item=>item.id===pageId)!;
  const project = {id:application.metadata.projectId,name:application.metadata.name,description:"",models:[],assets:[],
    createdAt:application.metadata.createdAt,updatedAt:application.metadata.updatedAt} as ProjectRecord;
  useEffect(()=>{
    document.title=application.metadata.name;
    const update=()=>setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange",update); return ()=>document.removeEventListener("fullscreenchange",update);
  },[application.metadata.name]);
  async function toggleFullscreen() {
    setError("");
    try {if(document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen();}
    catch {setError("浏览器未允许全屏，请使用浏览器全屏菜单重试。");}
  }
  return <div className="dashboard-static-root">
    <DashboardPlayback readOnly locale="zh-CN" application={application} project={project} page={page} rendererBackend="webgl"
      metrics={{}} variables={{}} filters={publishedInitialDashboardFilters(application)} connected={false}
      readDependency={async()=>{throw new Error("静态包未包含脚本依赖");}} onSelectPage={setPageId}
      onClose={()=>undefined} onPublish={()=>undefined} onFilterChange={()=>undefined} onVariableChange={()=>undefined}
      onSelectionChange={()=>undefined} onObjectInteraction={()=>undefined} onNodeInteraction={()=>undefined}/>
    <div className="dashboard-static-tools">{application.pages.length > 1 && <select aria-label="页面" value={pageId}
      onChange={event=>setPageId(event.target.value)}>{application.pages.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>}
      <button type="button" onClick={()=>void toggleFullscreen()}>
      {fullscreen ? "退出全屏" : "全屏"}</button></div>
    {error && <p className="dashboard-static-error" role="alert">{error}</p>}
  </div>;
}
