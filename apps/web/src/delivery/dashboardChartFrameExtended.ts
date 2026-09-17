import type { ChartIR, ChartSeries, ChartDataset, ChartAxis, ChartValue } from "@bim-studio/deep-engine";
import { arc, numeric, clamp, type Rect, type Point, type ChartZoomWindow } from "./dashboardChartFrameGeometry";
import { ChartPaths } from "./dashboardChartFramePaths";
function bands(keys: ChartValue[], axis: ChartAxis | undefined, range: Point, windows: readonly ChartZoomWindow[] = []): Point[] | undefined {
  if (!keys.length) return undefined;
  let centers: number[], step: number, lo: number, hi: number;
  if (!axis || axis.scale === "category") { centers=keys.map((_,i)=>i+.5); step=1; lo=0; hi=keys.length; }
  else {
    const transform = (value: unknown) => { const n=numeric(value); return n===undefined || axis.scale==="log" && n<=0 ? undefined : axis.scale==="log" ? Math.log10(n) : n; };
    const converted=keys.map(transform); if (converted.some(value=>value===undefined)) return undefined;
    centers=converted as number[];
    const ordered=[...new Set(centers)].sort((a,b)=>a-b); step=Infinity;
    for(let i=1;i<ordered.length;i++) if(ordered[i]!>ordered[i-1]!) step=Math.min(step,ordered[i]!-ordered[i-1]!);
    if(!Number.isFinite(step)) step=1;
    const min=axis.min===null ? ordered[0]!-step*.5 : transform(axis.min);
    const max=axis.max===null ? ordered[ordered.length-1]!+step*.5 : transform(axis.max);
    if(min===undefined||max===undefined) return undefined; lo=min;hi=max;
  }
  // Native render_heatmap::bands 同式：窗口对基域做 lo*(1-start)+hi*start 插值后失效即失败。
  const window = windows.find(([id]) => id === axis?.id);
  if (window) { const nl=lo*(1-window[1])+hi*window[1], nh=lo*(1-window[2])+hi*window[2]; lo=nl; hi=nh; }
  if(!Number.isFinite(lo)||!Number.isFinite(hi)||hi<=lo) return undefined;
  const map=(value:number)=>range[0]+(value-lo)/(hi-lo)*(range[1]-range[0]);
  return centers.map(center=>{const a=map(center-step*.5),b=map(center+step*.5);return [Math.min(a,b),Math.abs(b-a)];});
}
export function heatmap(paths:ChartPaths,ir:ChartIR,series:Extract<ChartSeries,{type:"heatmap"}>,dataset:ChartDataset,plot:Rect,windows:readonly ChartZoomWindow[]=[]){
  const xi=dataset.dimensions.indexOf(series.x),yi=dataset.dimensions.indexOf(series.y),vi=dataset.dimensions.indexOf(series.value);
  if(xi<0||yi<0||vi<0) return;
  const xs:ChartValue[]=[],ys:ChartValue[]=[],cells:{x:number;y:number;value:number;index:number}[]=[];
  const slot=(keys:ChartValue[],key:ChartValue)=>{let i=keys.indexOf(key);if(i<0){i=keys.length;keys.push(key);}return i;};
  dataset.rows.forEach((row,index)=>{const value=numeric(row[vi]),x=row[xi],y=row[yi];if(value===undefined||x===undefined||y===undefined)return;
    cells.push({x:slot(xs,x),y:slot(ys,y),value,index});});
  if(!cells.length)return;
  let min=Infinity,max=-Infinity;for(const cell of cells){min=Math.min(min,cell.value);max=Math.max(max,cell.value);}
  const [x,y,w,h]=plot,xa=ir.axes.find(axis=>axis.id===series.xAxisId),ya=ir.axes.find(axis=>axis.id===series.yAxisId);
  const xb=bands(xs,xa,[x,x+w],windows),yb=bands(ys,ya,ya&&ya.scale!=="category"?[y+h,y]:[y,y+h],windows);if(!xb||!yb)return;
  for(const cell of cells){paths.dataIndex=cell.index;const t=max>min?(cell.value-min)/(max-min):.5;
    const [left,width]=xb[cell.x]!,[top,height]=yb[cell.y]!;
    paths.fill([[left,top],[left+width,top],[left+width,top+height],[left,top+height]],
      [.1+(.9-.1)*t,.2+(.2-.2)*t,.8+(.1-.8)*t,1]);}
}
export function gauge(paths:ChartPaths,series:Extract<ChartSeries,{type:"gauge"}>,dataset:ChartDataset,[px,py,pw,ph]:Rect) {
  const center:Point=[px+pw*.5,py+ph*.5],radius=Math.max(1,Math.min(pw,ph)*.5-8);
  paths.fill([...arc(center,radius,135,270,18),...arc(center,radius*.72,405,-270,18)],[.5,.7,1,1]);
  const column=dataset.dimensions.indexOf(series.value);if(column<0)return;
  const value=dataset.rows.map(row=>numeric(row[column])).find(value=>value!==undefined);if(value===undefined)return;
  const t=clamp((value-series.min)/(series.max-series.min),0,1),angle=(135+270*t)*(Math.PI/180);
  paths.stroke([center,[center[0]+.8*radius*Math.cos(angle),center[1]+.8*radius*Math.sin(angle)]],[1,1,1,1]);
}
