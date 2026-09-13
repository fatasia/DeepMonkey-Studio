import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import * as THREE from "three";
import {restoreDeviceSignalEffects,updateViewerDeviceSignals,disposeViewerDeviceSignals,applyViewerDeviceSignal} from "./viewerDeviceSignals";
import * as overlays from "./sceneOverlayVisuals";
import { createDeviceSignalFixture, deviceSignalCanvasDocument } from "./deviceSignalFixture";

const base={outline:false,glow:false,xray:false,scanline:false,heatmap:false,dissolve:0,edgeLight:false,color:"#336699",intensity:0.8};
describe("runtime alarm effect ownership",()=>{
  it("restores authored appearance when the active alarm clears",()=>{
    const applied={...base,outline:true,glow:true,color:"#ff0000",intensity:1.2};
    expect(restoreDeviceSignalEffects(base,applied,applied)).toEqual(base);
  });
  it("does not overwrite author changes made during an active alarm",()=>{
    const applied={...base,outline:true,glow:true,color:"#ff0000",intensity:1.2};
    const current={...applied,color:"#ffaa00",intensity:2,xray:true};
    expect(restoreDeviceSignalEffects(base,applied,current)).toEqual({...base,color:"#ffaa00",intensity:2,xray:true});
  });
});

describe("runtime alarm projection invalidation",()=>{
  beforeEach(()=>{
    vi.stubGlobal("document",deviceSignalCanvasDocument());
    vi.stubGlobal("getComputedStyle",()=>({getPropertyValue:()=>"#ff0000"}));
  });
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
  it("skips static projection and preserves following for camera, viewport and parent changes",()=>{
    const fixture=createDeviceSignalFixture(2);
    const project=vi.spyOn(overlays,"updateAnnotationVisualPresentation");
    const update=()=>updateViewerDeviceSignals(fixture.owner,fixture.camera,1280,800);
    update(); expect(project).toHaveBeenCalledTimes(2);
    update(); expect(project).toHaveBeenCalledTimes(2);
    fixture.entries[0]!.target.position.x+=1; update(); expect(project).toHaveBeenCalledTimes(3);
    fixture.parent.position.y+=2; update(); expect(project).toHaveBeenCalledTimes(5);
    expect(fixture.entries[0]!.visual.position.y).toBe(2.5);
    fixture.camera.position.x+=2; update(); expect(project).toHaveBeenCalledTimes(7);
    fixture.camera.fov=65; fixture.camera.updateProjectionMatrix(); update(); expect(project).toHaveBeenCalledTimes(9);
    fixture.camera.zoom=2;fixture.camera.updateProjectionMatrix();update();expect(project).toHaveBeenCalledTimes(11);
    updateViewerDeviceSignals(fixture.owner,fixture.camera,980,800);expect(project).toHaveBeenCalledTimes(13);
    disposeViewerDeviceSignals(fixture.owner);
  });
  it("invalidates replaced semantic visuals and releases detached targets even on static frames",()=>{
    const fixture=createDeviceSignalFixture();
    const update=()=>updateViewerDeviceSignals(fixture.owner,fixture.camera,1280,800);
    update();
    const original=fixture.entries[0]!.visual;
    applyViewerDeviceSignal(fixture.owner,{modelId:"device-0",target:fixture.entries[0]!.target,scene:fixture.scene,container:{} as HTMLElement,value:{state:"alarm",acknowledged:true},getEffects:()=>base,setEffects(){}});
    const replacement=fixture.scene.children.at(-1) as THREE.Group;
    const project=vi.spyOn(overlays,"updateAnnotationVisualPresentation");
    update();expect(project).toHaveBeenCalledOnce();expect(original.parent).toBeNull();
    fixture.entries[0]!.target.removeFromParent();update();expect(replacement.parent).toBeNull();
    disposeViewerDeviceSignals(fixture.owner);
  });
  it("produces the same label transform and projected bounds as an uncached animated update",()=>{
    const fixture=createDeviceSignalFixture();
    const entry=fixture.entries[0]!;
    for(let frame=0;frame<10;frame+=1) {
      fixture.parent.rotation.y=frame/20;fixture.camera.position.x=frame/4;
      updateViewerDeviceSignals(fixture.owner,fixture.camera,1280,800);
      const position=entry.visual.position.clone();
      const sprite=entry.visual.children[2] as THREE.Sprite;
      const scale=sprite.scale.clone(),opacity=sprite.material.opacity;
      entry.visual.position.copy(entry.target.localToWorld(entry.anchor.clone()));
      overlays.updateAnnotationVisualPresentation(`runtime-alarm:${entry.id}`,entry.visual,fixture.camera,1280,800,false);
      expect(entry.visual.position.toArray()).toEqual(position.toArray());expect(sprite.scale.toArray()).toEqual(scale.toArray());expect(sprite.material.opacity).toBe(opacity);
    }
    disposeViewerDeviceSignals(fixture.owner);
  });
});
