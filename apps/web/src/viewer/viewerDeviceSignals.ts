import * as THREE from "three";
import { resolveDeviceSignal, type SceneModelEffectsState } from "@bim-studio/contracts";
import { createAnnotationVisual, disposeViewerObject, updateAnnotationVisualPresentation } from "./sceneOverlayVisuals";
import { deviceSignalPresentation } from "../deviceSignalPresentation";

interface SignalVisual {
  target:THREE.Object3D;
  visual:THREE.Group;
  anchor:THREE.Vector3;
  signature:string;
  baseEffects:SceneModelEffectsState;
  appliedEffects:SceneModelEffectsState;
  targetMatrix:THREE.Matrix4;
  cameraVersion:number;
}
const runtimes = new WeakMap<object,Map<string,SignalVisual>>();
interface SignalFrameState {
  camera:THREE.PerspectiveCamera;
  world:THREE.Matrix4;
  projection:THREE.Matrix4;
  fov:number;
  width:number;
  height:number;
  version:number;
}
const frameStates = new WeakMap<object,SignalFrameState>();

/** 复用既有辉光/轮廓和标注管线；运行告警不进入作者标注集合。 */
export function applyViewerDeviceSignal(owner:object, options:{
  modelId:string;target:THREE.Object3D;scene:THREE.Scene;container:HTMLElement;value:unknown;
  getEffects:()=>SceneModelEffectsState;setEffects:(effects:SceneModelEffectsState)=>void;
}):boolean {
  const signal=resolveDeviceSignal(options.value);
  const entries=runtimes.get(owner)??new Map<string,SignalVisual>();
  runtimes.set(owner,entries);
  const previous=entries.get(options.modelId);
  if (!signal.active) {
    if(previous) {
      const current=options.getEffects();
      options.setEffects(restoreDeviceSignalEffects(previous.baseEffects,previous.appliedEffects,current));
      previous.visual.removeFromParent();disposeViewerObject(previous.visual);entries.delete(options.modelId);
    }
    return true;
  }
  const locale=document.documentElement.lang.startsWith("en")?"en-US":"zh-CN";
  const presentation=deviceSignalPresentation(signal,locale);
  const colorValue=getComputedStyle(options.container).getPropertyValue(`--${presentation.token}`).trim();
  const color=`#${new THREE.Color(colorValue||options.getEffects().color).getHexString()}`;
  const signature=JSON.stringify([signal,color]);
  if(previous?.target===options.target && previous.signature===signature)return true;
  if(previous) {previous.visual.removeFromParent();disposeViewerObject(previous.visual);}
  const baseEffects=previous?.baseEffects??options.getEffects();
  const appliedEffects={...options.getEffects(),outline:true,glow:true,color,intensity:signal.acknowledged?0.6:1.2};
  options.setEffects(appliedEffects);
  const box=new THREE.Box3().setFromObject(options.target);
  const center=box.getCenter(new THREE.Vector3());center.y=box.max.y;
  const anchor=options.target.worldToLocal(center.clone());
  const acknowledgement=signal.acknowledged?(locale==="zh-CN"?"已确认":"Acknowledged"):(locale==="zh-CN"?"未确认":"Unacknowledged");
  const visual=createAnnotationVisual({id:`runtime-alarm:${options.modelId}`,name:`${presentation.icon} ${presentation.label} · ${acknowledgement}`,
    description:signal.message??options.target.name,position:{x:center.x,y:center.y,z:center.z},color,visible:true,locked:true},false);
  visual.userData.effectHelper=true;
  options.scene.add(visual);
  entries.set(options.modelId,{target:options.target,visual,anchor,signature,baseEffects,appliedEffects,targetMatrix:new THREE.Matrix4(),cameraVersion:-1});
  return true;
}

/** 仅还原告警仍拥有的字段；告警期间作者另改的效果不能被旧快照覆盖。 */
export function restoreDeviceSignalEffects(base:SceneModelEffectsState,applied:SceneModelEffectsState,current:SceneModelEffectsState):SceneModelEffectsState {
  const next={...current};
  if(current.outline===applied.outline)next.outline=base.outline;
  if(current.glow===applied.glow)next.glow=base.glow;
  if(current.color===applied.color)next.color=base.color;
  if(current.intensity===applied.intensity)next.intensity=base.intensity;
  return next;
}

export function updateViewerDeviceSignals(owner:object,camera:THREE.PerspectiveCamera,width:number,height:number):void {
  const entries=runtimes.get(owner);
  if(!entries?.size)return;
  camera.updateWorldMatrix(true,false);
  let frame=frameStates.get(owner);
  let cameraChanged=false;
  if(!frame) {
    frame={camera,world:camera.matrixWorld.clone(),projection:camera.projectionMatrix.clone(),fov:camera.fov,width,height,version:0};
    frameStates.set(owner,frame);
  } else if(frame.camera!==camera || frame.width!==width || frame.height!==height || frame.fov!==camera.fov
    || !frame.world.equals(camera.matrixWorld) || !frame.projection.equals(camera.projectionMatrix)) {
    frame.camera=camera;frame.width=width;frame.height=height;frame.fov=camera.fov;
    frame.world.copy(camera.matrixWorld);frame.projection.copy(camera.projectionMatrix);frame.version+=1;
    cameraChanged=true;
  }
  if(cameraChanged) {
    // 相机全帧运动时使用原更新路径，不写入必定失效的逐对象矩阵缓存。
    for(const [id,entry] of entries) {
      if(!entry.target.parent) {entry.visual.removeFromParent();disposeViewerObject(entry.visual);entries.delete(id);continue;}
      entry.visual.position.copy(entry.target.localToWorld(entry.anchor.clone()));
      updateAnnotationVisualPresentation(`runtime-alarm:${id}`,entry.visual,camera,width,height,false);
    }
    return;
  }
  for(const [id,entry] of entries) {
    if(!entry.target.parent) {entry.visual.removeFromParent();disposeViewerObject(entry.visual);entries.delete(id);continue;}
    // 仍更新祖先矩阵以跟随动画/父级变换；稳态只比较矩阵，不重复投影、字号与材质赋值。
    entry.target.updateWorldMatrix(true,false);
    if(entry.cameraVersion===frame.version && entry.targetMatrix.equals(entry.target.matrixWorld))continue;
    entry.visual.position.copy(entry.anchor).applyMatrix4(entry.target.matrixWorld);
    updateAnnotationVisualPresentation(`runtime-alarm:${id}`,entry.visual,camera,width,height,false);
    entry.targetMatrix.copy(entry.target.matrixWorld);entry.cameraVersion=frame.version;
  }
}

export function disposeViewerDeviceSignals(owner:object):void {
  for(const entry of runtimes.get(owner)?.values()??[]) {entry.visual.removeFromParent();disposeViewerObject(entry.visual);}
  runtimes.delete(owner);
  frameStates.delete(owner);
}
