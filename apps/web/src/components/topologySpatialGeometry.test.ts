import { describe, expect, it } from "vitest";
import type { TopologyDocument } from "@bim-studio/contracts";
import { topologyConnectedIds, topologyConnectionPath, topologyZoneOutline, topologyZones } from "./topologySpatialGeometry";
import { topologyPlanPositionFromProjected, topologyProjectedPosition } from "./topologyEditorRuntime";

const document: TopologyDocument = { id:"line", name:"Line", nodes:[
  {id:"a",kind:"pump",x:120,y:120,properties:{zone:"冷却站"}},
  {id:"b",kind:"valve",x:460,y:120,properties:{zone:"冷却站"}},
  {id:"c",kind:"tank",x:680,y:400,properties:{zone:"储存区"}},
  {id:"d",kind:"meter",x:120,y:500,properties:{}},
], edges:[
  {id:"ab",sourceNodeId:"a",targetNodeId:"b",properties:{}},
  {id:"bc",sourceNodeId:"b",targetNodeId:"c",properties:{}},
  {id:"ca",sourceNodeId:"c",targetNodeId:"a",properties:{}},
] };
describe("topology spatial geometry", () => {
  it("round-trips plan positions and elevation without accumulating drag distortion", () => {
    for (const x of [-100,0,120,3000]) for (const y of [-400,0,160,2500]) for (const elevation of [-200,0,500]) {
      const projected = topologyProjectedPosition({x,y,properties:{elevation}},"2.5d");
      const plan = topologyPlanPositionFromProjected(projected,elevation,"2.5d");
      expect(plan.x).toBeCloseTo(x,8); expect(plan.y).toBeCloseTo(y,8);
    }
  });
  it("groups only explicitly assigned zones without mutating documents", () => {
    const before=JSON.stringify(document);
    expect(topologyZones(document.nodes).map(zone=>[zone.name,zone.nodes.length])).toEqual([["冷却站",2],["储存区",1]]);
    expect(topologyZoneOutline([])).toBe("");
    expect(topologyZoneOutline(document.nodes)).not.toMatch(/NaN|Infinity/);
    expect(JSON.stringify(document)).toBe(before);
  });
  it("follows directed relations, terminates on cycles, and excludes disconnected equipment", () => {
    expect([...topologyConnectedIds(document,"a","downstream")].sort()).toEqual(["a","b","c"]);
    expect([...topologyConnectedIds({...document,edges:document.edges.slice(0,2)},"b","upstream")].sort()).toEqual(["a","b"]);
    expect([...topologyConnectedIds({...document,edges:document.edges.slice(0,2)},"b","downstream")].sort()).toEqual(["b","c"]);
    expect(topologyConnectedIds(document,undefined,"all").size).toBe(0);
  });
  it("anchors both edge endpoints to the same device ports in either view", () => {
    const [source,target]=document.nodes;
    for (const mode of ["2d","2.5d"] as const) {
      const edge=topologyConnectionPath(source!,target!,mode);
      const a=topologyProjectedPosition(source!,mode),b=topologyProjectedPosition(target!,mode);
      expect(edge.path.startsWith(`M ${a.x+164} ${a.y+(mode==="2d"?38:60)}`)).toBe(true);
      expect(edge.path.endsWith(`${b.x} ${b.y+(mode==="2d"?38:60)}`)).toBe(true);
      expect(edge.path).not.toMatch(/NaN|Infinity/);
      const moved=topologyConnectionPath({...source!,x:source!.x+100},target!,mode);
      expect(moved.path).not.toBe(edge.path);
    }
  });
});
