import { describe, expect, it } from "vitest";
import { compileChartSpec, validateChartIR, type ChartIR } from "@bim-studio/deep-engine";
import { cartesian } from "./dashboardChartFrameGeometry";
import { renderChartFrame, chartFrame } from "./dashboardChartFrame";
import referenceJson from "../../../../packages/deep-engine/fixtures/chart-web-geometry-reference-v1.json";
const reference = referenceJson as unknown as { cases: Array<{ name: string; ir: ChartIR; width: number; height: number; displayList: unknown }> };
// A four-edge identity-transformed rectangle clip path has the same intersection
// as Native clipRect. Assert its shape before normalizing the equivalent wire form.
function nativeClipSemantics(list: ReturnType<typeof renderChartFrame>) {
  const clips=new Set<string>();
  const commands=list.commands.map(command=>{
    if(!command.clipPathIds?.length)return command;
    expect(command.clipPathIds).toHaveLength(1);
    const id=command.clipPathIds[0]!,path=list.resources.find(resource=>resource.id===id);
    expect(path?.kind).toBe("path");if(path?.kind!=="path")throw new Error("Missing clip");
    const v=path.verbs as Array<{op:string;x:number;y:number}>;
    expect(v.map(verb=>verb.op)).toEqual(["move","line","line","line","close"]);
    const [a,b,c,d]=v; expect(b!.y).toBe(a!.y);expect(c!.x).toBe(b!.x);expect(d!.x).toBe(a!.x);expect(d!.y).toBe(c!.y);
    clips.add(id);const {clipPathIds:_,...rest}=command;
    return {...rest,clipRect:{x:a!.x,y:a!.y,width:b!.x-a!.x,height:d!.y-a!.y}};
  });
  return {...list,resources:list.resources.filter(resource=>!clips.has(resource.id)),commands};
}
function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key, value]) => value !== null && !(key === "atlases" && Array.isArray(value) && !value.length))
    .map(([key,value]) => [key,normalized(value)]));
  return value;
}
function equivalent(actual: unknown, expected: unknown, path = "$") {
  if (typeof expected === "number") { expect(typeof actual, path).toBe("number"); expect(Math.abs((actual as number)-expected),path).toBeLessThanOrEqual(1e-9 * Math.max(1,Math.abs(expected))); return; }
  if (Array.isArray(expected)) { expect(Array.isArray(actual),path).toBe(true); expect((actual as unknown[]).length,path).toBe(expected.length); expected.forEach((value,index)=>equivalent((actual as unknown[])[index],value,`${path}[${index}]`)); return; }
  if (expected && typeof expected === "object") {
    expect(Object.keys(actual as object).sort(),path).toEqual(Object.keys(expected).sort());
    for (const [key,value] of Object.entries(expected)) equivalent((actual as Record<string,unknown>)[key],value,`${path}.${key}`);
    return;
  }
  expect(actual,path).toEqual(expected);
}
describe("matches independent Native render_chart reference", () => {
  for (const item of reference.cases) it(item.name, () => {
    equivalent(normalized(nativeClipSemantics(renderChartFrame(item.ir,item.width,item.height))),normalized(item.displayList));
  });
});
it("rejects invalid series and cancellation instead of producing an empty substitute", () => {
  const ir = structuredClone(reference.cases[0]!.ir) as ChartIR;
  const unsupported = compileChartSpec({schemaVersion:1,id:"unsupported",datasets:[{id:"data",dimensions:["value"],rows:[[2]]}],series:[{id:"gauge",type:"gauge",datasetId:"data",label:"Gauge",name:"value",value:"value",min:0,max:10}]}).ir!;
  expect(()=>renderChartFrame({...unsupported,series:[{...unsupported.series[0]!,type:"future"}]} as unknown as ChartIR,200,200)).toThrow(/Invalid ChartIR/);
  const controller = new AbortController(); controller.abort();
  expect(()=>renderChartFrame(ir,200,200,controller.signal)).toThrow();
  expect(()=>renderChartFrame(ir,0,200)).toThrow(/canvas/);
});
it("wraps geometry with candidate data revision and local frame dimensions", async () => {
  const item = reference.cases[0]!;
  const candidate = {node:{id:"node",revision:1,frame:[45,60,item.width,item.height],clip:null,zOrder:0,visible:true,hitId:null,deep2d:null,chart:"chart",chartSim:null},
    chart:{ir:item.ir,dataRevision:7},deep2d:null,effectiveClip:[0,0,900,600]} as const;
  const content = await chartFrame(candidate,new AbortController().signal);
  expect(content).toMatchObject({schemaVersion:2,revision:7,composition:"z-ordered",atlases:[],quads:[],displayList:{revision:7,logicalWidth:item.width,logicalHeight:item.height}});
  equivalent(normalized(nativeClipSemantics({...content.displayList,revision:0})),normalized(item.displayList));
});

function barMapping(values: number[], bounds: {min?:number;max?:number;scale?:"linear"|"time"|"log"} = {}) {
  const compiled = compileChartSpec({schemaVersion:1,id:"bars",datasets:[{id:"data",dimensions:["x","y"],rows:values.map((value,index)=>[index,value])}],
    axes:[{id:"x",channel:"x",scale:"category"},{id:"y",channel:"y",scale:bounds.scale??"linear",...(bounds.min===undefined?{}:{min:bounds.min}),...(bounds.max===undefined?{}:{max:bounds.max})}],
    series:[{id:"bars",label:"Bars",type:"bar",datasetId:"data",x:"x",y:"y",xAxisId:"x",yAxisId:"y"}]});
  if (!compiled.ok || !compiled.ir) throw new Error(JSON.stringify(compiled.diagnostics));
  return cartesian(compiled.ir,compiled.ir.series[0]!,compiled.ir.datasets[0]!,[0,0,100,100]);
}
it("keeps positive and negative bars visible from an automatic zero baseline", () => {
  const positive = barMapping([7,9])!, negative = barMapping([-7,-9])!, mixed = barMapping([-4,6])!;
  expect(positive.baseline).toBe(100); expect(positive.points[0]![1]).toBeCloseTo(100-700/9); expect(positive.points[1]![1]).toBe(0);
  expect(negative.baseline).toBe(0); expect(negative.points[0]![1]).toBeCloseTo(700/9); expect(negative.points[1]![1]).toBe(100);
  expect(mixed.baseline).toBe(60); expect(mixed.points.map(point=>point[1])).toEqual([100,0]);
  expect(barMapping([7])!.points[0]![1]).toBe(0);
  expect(barMapping([])).toBeUndefined();
});
it("preserves each explicit domain bound and does not inject zero into logarithmic axes", () => {
  const explicit = barMapping([7,9],{min:7,max:9})!;
  expect(explicit.baseline).toBe(100); expect(explicit.points.map(point=>point[1])).toEqual([100,0]);
  const maxOnly = barMapping([7,9],{max:10})!;
  expect(maxOnly.points.map(point=>point[1])).toEqual([30,10]);
  const minOnly = barMapping([-7,-9],{min:-10})!;
  expect(minOnly.baseline).toBe(0); expect(minOnly.points.map(point=>point[1])).toEqual([70,90]);
  const logarithmic = barMapping([7,9],{scale:"log"})!;
  expect(logarithmic.points.map(point=>point[1])).toEqual([100,0]);
  expect(barMapping([7,9],{scale:"time"})!.points[0]![1]).toBeCloseTo(100-700/9);
});

it("shares numeric domains by axis identity across series and preserves separate axes", () => {
  const compiled = compileChartSpec({schemaVersion:1,id:"shared",datasets:[
    {id:"a",dimensions:["x","y"],rows:[[1,7],[2,9]]}, {id:"b",dimensions:["x","y"],rows:[[10,70],[20,90]]}],
    axes:[{id:"x",channel:"x",scale:"linear"},{id:"y",channel:"y",scale:"linear"},{id:"separate",channel:"y",scale:"linear"}],
    series:[{id:"a",label:"A",type:"line",datasetId:"a",x:"x",y:"y",xAxisId:"x",yAxisId:"y"},
      {id:"b",label:"B",type:"bar",datasetId:"b",x:"x",y:"y",xAxisId:"x",yAxisId:"y"},
      {id:"c",label:"C",type:"scatter",datasetId:"a",x:"x",y:"y",xAxisId:"x",yAxisId:"separate"}]});
  expect(compiled.ok).toBe(true); const ir=compiled.ir!;
  const first=cartesian(ir,ir.series[0]!,ir.datasets[0]!,[0,0,100,100])!;
  const second=cartesian(ir,ir.series[1]!,ir.datasets[1]!,[0,0,100,100])!;
  const separate=cartesian(ir,ir.series[2]!,ir.datasets[0]!,[0,0,100,100])!;
  expect(first.points[0]![0]).toBe(0); expect(first.points[1]![0]).toBeCloseTo(100/19);
  expect(second.points[0]![0]).toBeCloseTo(900/19); expect(second.points[1]![0]).toBe(100);
  expect(first.points[0]![1]).toBeCloseTo(100-700/90); expect(first.points[1]![1]).toBe(90);
  expect(second.points[0]![1]).toBeCloseTo(100-7000/90); expect(second.points[1]![1]).toBe(0);
  expect(separate.points.map(point=>point[1])).toEqual([100,0]);
  const reordered={...ir,series:[...ir.series].reverse()};
  expect(cartesian(reordered,ir.series[0]!,ir.datasets[0]!,[0,0,100,100])).toEqual(first);
});

it("rejects valid initial zoom and action state at the candidate adapter", async () => {
  const original=reference.cases[0]!.ir;
  const states: ChartIR[] = [
    {...original,dataZoom:[{id:"zoom",axisId:"axis.x",start:.25,end:.75,mode:"inside"}]},
    {...original,actions:[{type:"highlight",seriesId:"series.a",dataIndex:0}]},
  ];
  for (const ir of states) {
    expect(validateChartIR(ir).ok).toBe(true);
    const candidate={node:{id:"state",revision:0,frame:[0,0,480,320],clip:null,zOrder:0,visible:true,hitId:null,deep2d:null,chart:"chart",chartSim:null},
      chart:{ir,dataRevision:0},deep2d:null,effectiveClip:[0,0,480,320]} as const;
    await expect(chartFrame(candidate,new AbortController().signal)).rejects.toThrow(/initial dataZoom or actions/);
    expect(()=>renderChartFrame(ir,480,320)).not.toThrow();
  }
});
