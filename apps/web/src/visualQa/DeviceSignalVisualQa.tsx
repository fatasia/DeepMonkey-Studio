import { useEffect,useMemo,useRef,useState } from "react";
import * as THREE from "three";
import { resolveDeviceSignal,type TopologyDocument } from "@bim-studio/contracts";
import { DeviceSignalView } from "../components/DeviceSignalView";
import { TopologyEditorPanel } from "../components/TopologyEditorPanel";
import { createTopologyRuntimeSnapshot } from "../topologyRuntime";
import { ViewerEngine } from "../viewer/ViewerEngine";
import "./deviceSignalVisualQa.css";

const topology:TopologyDocument={id:"signal-qa",name:"循环泵 · 同源拓扑",nodes:[{id:"pump",kind:"pump",x:120,y:120,properties:{label:"循环泵 P-101",dataBinding:{productType:"dataset",productId:"signal-sample",field:"signal"},scada:{tag:"P101",unit:"bar",highAlarm:6,alarmSeverity:"critical"}}}],edges:[]};

/** 同一条可见测试遥测进入真实组件/拓扑适配器/Viewer，不连接项目数据或自动保存。 */
export default function DeviceSignalVisualQa(){
  const host=useRef<HTMLDivElement>(null),engine=useRef<ViewerEngine|undefined>(undefined);
  const [ready,setReady]=useState(false),[error,setError]=useState("");
  const [state,setState]=useState<"normal"|"warning"|"alarm"|"offline">("normal");
  const [acknowledged,setAcknowledged]=useState(false),[generation,setGeneration]=useState(1);
  const [glow,setGlow]=useState(false),[located,setLocated]=useState(0);
  const source=useMemo(()=>({state,value:state==="alarm"?8:state==="warning"?6:4.2,unit:"bar",alarm:{id:`qa-${generation}`,active:state==="alarm"||state==="warning",severity:state==="alarm"?"critical":"warning",acknowledged,message:state==="alarm"?"出口压力高高":state==="warning"?"出口压力预警":""}}),[state,acknowledged,generation]);
  const signal=resolveDeviceSignal(source);
  const runtime=createTopologyRuntimeSnapshot(topology.nodes,{fields:[],rows:[{signal:source}]});
  useEffect(()=>{
    let disposed=false;let viewer:ViewerEngine|undefined;
    if(!host.current)return;
    void ViewerEngine.create(host.current,"webgl").then(created=>{
      if(disposed){created.dispose();return;}viewer=created;engine.current=created;created.setReadOnly(true);
      const color=getComputedStyle(host.current!).getPropertyValue("--text-muted").trim();
      created.createPrimitive("pump","循环泵 P-101","cylinder",`#${new THREE.Color(color).getHexString()}`,new THREE.Vector3(0,1,0));
      created.setModelTransform("pump",{scale:[1.5,2,1.5]});
      created.setCameraPose({position:[6,5,8],target:[0,1,0],near:0.1,far:100,fov:45});
      setReady(true);
    }).catch(reason=>setError(String(reason)));
    return()=>{disposed=true;engine.current=undefined;viewer?.dispose();};
  },[]);
  useEffect(()=>{
    if(!ready||!engine.current)return;
    engine.current.applySceneDataMessage({source:"qa",key:"signal",value:source,target:{modelId:"pump"},action:"alarm",timestamp:new Date().toISOString()});
    setGlow(engine.current.getModelEffects("pump").glow);
  },[ready,source]);
  function locate(){engine.current?.applySceneDataMessage({source:"qa",key:"focus",value:true,target:{modelId:"pump"},action:"focus",timestamp:new Date().toISOString()});setLocated(value=>value+1);}
  return <main className="device-signal-qa">
    <header><strong>同源设备状态验证</strong><div role="toolbar" aria-label="模拟遥测">{(["normal","warning","alarm","offline"] as const).map((value,index)=><button key={value} aria-pressed={state===value} onClick={()=>{setState(value);setAcknowledged(false);setGeneration(v=>v+1);}}>{["正常","预警","严重告警","离线"][index]}</button>)}<button disabled={!signal.active||signal.acknowledged} onClick={()=>setAcknowledged(true)}>确认本次告警</button></div></header>
    <section className="device-signal-qa__viewer"><div ref={host} className="device-signal-qa__host" />{!ready&&<p role="status">{error||"三维加载中…"}</p>}<output aria-label="三维告警效果">{glow?"告警辉光已启用":"原有外观已恢复"}</output><output aria-label="定位次数">{located}</output></section>
    <section className="device-signal-qa__state"><DeviceSignalView title="循环泵 P-101" locale="zh-CN" signal={signal} onLocate={locate} onAcknowledge={()=>setAcknowledged(true)} /></section>
    <section className="device-signal-qa__topology"><TopologyEditorPanel locale="zh-CN" document={topology} runtimeStates={runtime} onChange={()=>{}} onAcknowledgeAlarm={()=>setAcknowledged(true)} /></section>
  </main>;
}
