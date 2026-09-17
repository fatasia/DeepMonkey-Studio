import { describe, expect, it } from "vitest";
import { compileChartSpec, validateChartIR, type ChartIR } from "@bim-studio/deep-engine";
import { cartesian } from "./dashboardChartFrameGeometry";
import { renderChartFrame, chartFrame, initialChartState } from "./dashboardChartFrame";
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

/** 与 Native from_ir 对拍的最小 IR：类目 x + 显式 [0,10] 线性 y，两行数据。 */
function zoomedIr(zooms: ChartIR["dataZoom"], actions: ChartIR["actions"], scale: "linear" | "log" = "linear", rows: ChartIR["datasets"][number]["rows"] = [["A",1],["B",2]]) {
  const compiled = compileChartSpec({schemaVersion:1,id:"zoomed",datasets:[{id:"data",dimensions:["x","y"],rows}],
    axes:[{id:"x",channel:"x",scale:"category"},{id:"y",channel:"y",scale, ...(scale==="linear"?{min:0,max:10}:{})}],
    dataZoom:zooms,actions,
    series:[{id:"s",label:"S",type:"line",datasetId:"data",x:"x",y:"y",xAxisId:"x",yAxisId:"y"}]});
  if (!compiled.ok || !compiled.ir) throw new Error(JSON.stringify(compiled.diagnostics));
  return compiled.ir;
}
it("applies the initial dataZoom window like Native InteractionState::from_ir (deterministic parity)", () => {
  expect(validateChartIR(zoomedIr([{id:"zoom",axisId:"x",start:10,end:90,mode:"slider"}],[{type:"dataZoom",axisId:"x",start:20,end:80}])).ok).toBe(true);
  // Native 顺序：先 $.dataZoom 后 $.actions，同轴 latest-wins → 最终窗口 (0.2,0.8)，
  // 类目行带 first=0.4/span=1.2：x = px+(row+0.5-first)/span*pw（Native x_projector 同式）。
  const latestWins = zoomedIr([{id:"zoom",axisId:"x",start:10,end:90,mode:"slider"}],[{type:"dataZoom",axisId:"x",start:20,end:80}]);
  const banded = cartesian(latestWins,latestWins.series[0]!,latestWins.datasets[0]!,[0,0,100,100],initialChartState(latestWins).zoomWindows)!;
  expect(banded.points[0]![0]).toBeCloseTo(100/12,9);
  expect(banded.points[1]![0]).toBeCloseTo(100*11/12,9);
  expect(banded.points.map(point=>point[1])).toEqual([90,80]); // y 无窗口：域 [0,10] 不变
  expect(banded.band).toBeCloseTo(100/2/0.6,9); // Native band: pw/count/(end-start)
  // 纯 dataZoom 条目 (0.1,0.9)：first=0.2/span=1.6 → x = 18.75 / 81.25。
  const entryOnly = zoomedIr([{id:"zoom",axisId:"x",start:10,end:90,mode:"slider"}],[]);
  const entry = cartesian(entryOnly,entryOnly.series[0]!,entryOnly.datasets[0]!,[0,0,100,100],initialChartState(entryOnly).zoomWindows)!;
  expect(entry.points[0]![0]).toBeCloseTo(18.75,9);
  expect(entry.points[1]![0]).toBeCloseTo(81.25,9);
  // 数值轴窗口走 Native zoom_domain 插值 lo*(1-t)+hi*t：y 域 [0,10]×(0.25,0.75) → [2.5,7.5]。
  const numeric = zoomedIr([],[{type:"dataZoom",axisId:"y",start:25,end:75}]);
  const yZoomed = cartesian(numeric,numeric.series[0]!,numeric.datasets[0]!,[0,0,100,100],initialChartState(numeric).zoomWindows)!;
  expect(yZoomed.points[0]![1]).toBeCloseTo(130,9);
  expect(yZoomed.points[1]![1]).toBeCloseTo(110,9);
  // 对数轴在 log10 空间插值：域 [1,100]×(0.25,0.75) → [10^0.5,10^1.5]，中值 10 映射到正程中点。
  const log = zoomedIr([],[{type:"dataZoom",axisId:"y",start:25,end:75}],"log",[["A",1],["B",10],["C",100]]);
  const logZoomed = cartesian(log,log.series[0]!,log.datasets[0]!,[0,0,100,100],initialChartState(log).zoomWindows)!;
  expect(logZoomed.points[1]![1]).toBeCloseTo(50,9);
});
it("keeps runtime-only initial actions out of static pixels and registers them as deferred", async () => {
  const base = zoomedIr([{id:"zoom",axisId:"x",start:10,end:90,mode:"slider"}],[]);
  const actions = [
    {type:"highlight",seriesId:"s",dataIndex:null},
    {type:"downplay",seriesId:"s",dataIndex:1},
    {type:"select",seriesId:"s",dataIndex:0},
    {type:"unselect",seriesId:"s",dataIndex:0}] as ChartIR["actions"];
  const stated = {...base,actions};
  const state = initialChartState(stated);
  expect(state.zoomWindows).toEqual([["x",.1,.9]]);
  expect(state.deferredActions).toEqual(actions.map((action,index)=>({path:`$.actions[${index}]`,type:action.type,
    reason:"runtime-only emphasis/selection outline; static frame pixels match Native render_chart_with_windows"})));
  // 静态像素与无 actions 完全一致（Native render_chart_with_windows 同样不消费强调/选中）。
  expect(renderChartFrame(stated,480,320)).toEqual(renderChartFrame(base,480,320));
  const candidate={node:{id:"state",revision:0,frame:[0,0,480,320],clip:null,zOrder:0,visible:true,hitId:null,deep2d:null,chart:"chart",chartSim:null},
    chart:{ir:stated,dataRevision:0},deep2d:null,effectiveClip:[0,0,480,320]} as const;
  const content = await chartFrame(candidate,new AbortController().signal);
  expect(content.displayList.commands).toEqual(renderChartFrame(stated,480,320,undefined,state.zoomWindows).commands);
});
it("fails closed on unsupported or out-of-range initial actions before any pixels", async () => {
  const base = zoomedIr([],[]);
  const candidateFor=(ir:ChartIR)=>({node:{id:"state",revision:0,frame:[0,0,480,320],clip:null,zOrder:0,visible:true,hitId:null,deep2d:null,chart:"chart",chartSim:null},
    chart:{ir,dataRevision:0},deep2d:null,effectiveClip:[0,0,480,320]} as const);
  const cases: Array<[ChartIR,RegExp]> = [
    [{...base,actions:[{type:"setCursor"} as unknown as ChartIR["actions"][number]]},/unsupported action type/],
    [{...base,actions:[{type:"select",seriesId:"ghost",dataIndex:null}]},/unknown series/],
    [{...base,actions:[{type:"highlight",seriesId:"s",dataIndex:5}]},/data index out of range/],
    [{...base,actions:[{type:"dataZoom",axisId:"ghost",start:10,end:90}]},/unknown zoom axis/],
    [{...base,dataZoom:[{id:"zoom",axisId:"x",start:80,end:20,mode:"inside"}]},/0 <= start < end <= 100/],
    [{...base,dataZoom:[{id:"zoom",axisId:"x",start:0,end:110,mode:"inside"}]},/0 <= start < end <= 100/],
  ];
  for (const [ir,pattern] of cases) {
    expect(()=>initialChartState(ir)).toThrow(pattern);
    await expect(chartFrame(candidateFor(ir),new AbortController().signal)).rejects.toThrow(pattern);
  }
});
