import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
const sha=value=>createHash("sha256").update(value).digest("hex"),hash=v=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const requireCondition=(v,m)=>{if(!v)throw Error(m);};
// J3 Gate D mr-linear 归因模型(2026-10-01 CPU 重算,修正规格"深夜归因更新"的通道错位假设):
// ① Web probe roughness 一直读的是 normal 附件 alpha(非 HDR alpha),两端 8bit 读回逐点相等
//    (texel3=202/255,texel2=173/255),"输入一致"排除在 roughness 维度成立;
// ② 真实差异面是直射多散射 DFG 来源:Web shade 用 deepDirectDfg185(Three r185 LUT,
//    随 roughness/nv 变化),Native native_direct_multiscattering 采样 brdf_lut
//    (harness 冻结常量 [0.75,0.0625])。两者共享同一 deepDirectMultiscatteringEnergy 能量核,
//    差异随 metal(f0)与 roughness(lost 项)增长 —— 恰好只在 mr-linear(metal≠0)的高
//    roughness texel 2/3 上超差(mr-zero-metal f0=0.04 差异可忽略,base 系 UNLIT 不走直射核,
//    规格里"base-uv1 过门排除直射数学差"的排除本身无效)。数值对拍:
//    texel3 预测 Δ=[0.01485,0.00774,0.00355] vs 实测 [0.01465,0.00781,0.00354],
//    texel2 预测 R=0.002687 vs 实测 0.00269,逐通道 ≤1.5%(f16 量化噪声内)。
// 以下纯函数逐式镜像 shared WGSL,只用于失败归因,不改变门判据。
let DFG185;
function dfg185Lut(){
  if(DFG185)return DFG185;
  const source=readFileSync(new URL("../../packages/deep-engine/src/webgpu/directDfgLut185.ts",import.meta.url),"utf8");
  const match=source.match(/DIRECT_DFG_185_WGSL_ARRAY\s*=\s*"((?:[^"\\]|\\.)*)"/);
  requireCondition(match,"directDfgLut185 source table not found");
  DFG185=[...match[1].matchAll(/vec2f\(([-0-9.e+]+),\s*([-0-9.e+]+)\)/g)].map(v=>[Number(v[1]),Number(v[2])]);
  requireCondition(DFG185.length===256,"directDfgLut185 table must hold 256 entries");
  return DFG185;
}
/** 逐式镜像 brdfDirectMultiscatteringWgsl 的 deepDirectMultiscatteringEnergy(单通道标量版)。 */
export function directMultiscatteringEnergy(f0,dfgView,dfgLight){
  const singleView=f0*dfgView[0]+dfgView[1],singleLight=f0*dfgLight[0]+dfgLight[1];
  const lostView=1-(dfgView[0]+dfgView[1]),lostLight=1-(dfgLight[0]+dfgLight[1]);
  const averageFresnel=f0+(1-f0)*0.047619;
  const multiple=singleView*singleLight*averageFresnel/(1-lostView*lostLight*averageFresnel+0.000001);
  return multiple*(lostView*lostLight);
}
/** 逐式镜像 pbrDirectMultiscatteringWgsl 的 deepDirectDfg185 双线性查表(行=nv,列=roughness)。 */
export function dfg185DirectAt(lut,roughness,dotNv){
  const u=roughness*16-0.5,v=dotNv*16-0.5,fu0=Math.floor(u),fv0=Math.floor(v);
  const i0=Math.min(Math.max(fu0,0),15),j0=Math.min(Math.max(fv0,0),15);
  const i1=Math.min(Math.max(fu0+1,0),15),j1=Math.min(Math.max(fv0+1,0),15);
  const fu=Math.min(Math.max(u-fu0,0),1),fv=Math.min(Math.max(v-fv0,0),1);
  const at=(j,i)=>lut[j*16+i],a00=at(j0,i0),a10=at(j0,i1),a01=at(j1,i0),a11=at(j1,i1);
  return [0,1].map(k=>a00[k]*(1-fu)*(1-fv)+a10[k]*fu*(1-fv)+a01[k]*(1-fu)*fv+a11[k]*fu*fv);
}
/**
 * mr- 场景稳定点跨端 HDR 差的直射多散射归因预测(正=Web 更亮)。前向近似 nv=nl=1
 * (轴向相机 nv≥0.97 落同一 LUT 行,斜视相机残差 ≪ hdrTolerance);f0=mix(0.04,baseFactor,
 * metallic×mrB/255);单散射 BRDF 两端同源,差值只来自 DFG 来源。假设:harness 冻结黑环境
 * (无 IBL)、无阴影、exposure=1 —— 与 j3 fixture 一致。
 */
export function predictMrDirectMultiscatteringDelta(fixture,texel,roughness){
  const base=fixture.baseFactor,radiance=fixture.radiance,metal=fixture.metallic*(fixture.mrBytes[texel*4+2]/255);
  const f0=[0,1,2].map(k=>0.04+(base[k]-0.04)*metal);
  const web=dfg185DirectAt(dfg185Lut(),roughness,1),native=fixture.dfg;
  return [0,1,2].map(k=>(directMultiscatteringEnergy(f0[k],web,web)-directMultiscatteringEnergy(f0[k],native,native))*radiance[k]);
}
function mrAttributionSuffix(plan,scenario,point,error){
  if(!scenario.startsWith("mr-"))return"";
  const expected=point?.byScenario?.[scenario];
  if(!expected||!Number.isFinite(expected.roughness))return"";
  let predicted;
  try{predicted=predictMrDirectMultiscatteringDelta(plan.fixture,expected.texel,expected.roughness);}
  catch{return" [multiscattering attribution unavailable: dfg185 source unreadable]";}
  const residual=error-Math.max(...predicted.map(v=>Math.abs(v)));
  return residual<=plan.fixture.hdrTolerance
    ?` [attributed: direct-multiscattering DFG divergence (web deepDirectDfg185 vs native brdfLut constant ${JSON.stringify(plan.fixture.dfg)}) predicts ${predicted.map(v=>+v.toFixed(5))}, residual ${residual.toFixed(5)} <= hdrTolerance]`
    :` [unexplained: multiscattering attribution residual ${residual.toFixed(5)} > hdrTolerance ${plan.fixture.hdrTolerance}]`;
}
export function requireTextureCoverageNativeRun(log,code){
  requireCondition(code===0&&/test\s+(?:\S*::)?j3_actual_texture_uv_coverage\s+\.\.\.\s+ok(?:\r?\n|$)/m.test(log)
    &&/test result: ok\. [1-9]\d* passed; 0 failed;/m.test(log),"Named Native texture GPU test did not execute successfully");
}
function normalizeHost(host){return host.family==="native"?host.runs.map(r=>({...host,...r,runs:undefined})):host;}
export function validateTextureCoverageHost(plan,host,{inputHash,profileHash,webSourceHash}){
  requireCondition(plan.schema==="j3-texture-coverage-plan-v1"&&plan.scenarios.length===7&&plan.cameras.length===2
    &&plan.cameras.reduce((n,c)=>n+c.points.length,0)===85&&plan.fixture.hdrTolerance===.002,"Unknown texture plan");
  requireCondition(host.schema==="j3-texture-coverage-host-v1"&&["native","web"].includes(host.family)&&host.passed===true
    &&host.errors?.length===0&&host.inputHash===inputHash&&host.profileHash===profileHash,"Texture host execution/input identity failed");
  requireCondition(host.sourcePackageHash===plan.sourcePackageHash&&host.sourcePacketHash===plan.sourcePacketHash&&hash(host.sourceHash),"Original85 source identity failed");
  if(host.family==="native")requireCondition(host.runs?.length===2&&sha(host.source)===host.sourceHash
    &&host.sourceAssembly?.factory==="native_mesh_wgsl::native_mesh_shader_source","Native formal source identity failed");
  else requireCondition(host.sourceHash===webSourceHash&&host.modules?.some(m=>m.hash===webSourceHash&&m.count>0)
    &&host.compileRecords?.some(r=>r.label.includes("material/")&&!r.failed),"Web actual textured module identity failed");
  const runs=host.family==="native"?normalizeHost(host):[host],summaries=[];
  for(const run of runs){
    requireCondition(Number.isInteger(run.freshInstance)&&run.freshInstance>=0&&run.freshInstance<=1&&run.frames?.length===28,"Texture fresh matrix incomplete");
    const keys=new Set(),stats={stablePoints:0,positivePoints:0,acceptedMask:0,rejectedMask:0,maxOracleError:0,maxRoughnessError:0,metalContributions:0};
    for(const s of plan.scenarios)for(const camera of plan.cameras)for(let round=0;round<2;round++){
      const matches=run.frames.filter(frame=>frame.scenario===s.id&&frame.cameraId===camera.id&&frame.round===round),frame=matches[0];
      requireCondition(matches.length===1,"Texture missing/duplicate matrix frame");keys.add(`${s.id}/${camera.id}/${round}`);
      requireCondition(frame.packageHash===s.packageHash&&frame.packetHash===s.packetHash&&hash(frame.fullHash)&&frame.coveragePixels>0
        &&frame.vp?.length===16&&frame.vp.every((v,k)=>Number.isFinite(v)&&Math.abs(v-camera.expectedVP[k])<=1e-5),"Texture package/camera/frame identity failed");
      requireCondition(frame.frame?.length>=76&&frame.frame.every(Number.isFinite),"Texture actual uniform receipt absent");
      requireCondition(frame.coverage?.length===plan.width*plan.height&&frame.coverage.every(v=>v===0||v===1)&&frame.coverage.filter(v=>v===1).length>100,"Texture coverage empty/invalid");
      requireCondition(frame.samples?.length===camera.points.length,"Original85 samples missing");
      if(run.family==="web")requireCondition(frame.finalAttachment===(s.id==="blend"?"weighted-oit-composited-hdr":"opaque-hdr"),"Web final alpha HDR attachment wrong");
      else requireCondition(frame.finalAttachment==="resolved-native-forward-hdr","Native final HDR attachment wrong");
      if(s.id.startsWith("mr-"))requireCondition(hash(frame.normalHash),"Actual MR normal MRT missing");
      const first=run.frames.find(v=>v.scenario===s.id&&v.cameraId===camera.id&&v.round===0);
      requireCondition(frame.fullHash===first.fullHash&&frame.normalHash===first.normalHash,"Repeated formal draw unstable");
      for(let i=0;i<camera.points.length;i++){
        const point=camera.points[i],a=frame.samples[i],expected=point.byScenario[s.id];
        requireCondition(a.pixel===point.pixel&&a.hdr?.length===4&&a.hdr.every(Number.isFinite)&&Number.isFinite(a.roughness),"Texture samples nonfinite/reordered");
        if(!expected.stable)continue;stats.stablePoints++;
        requireCondition(a.hdr[3]===1,"Actual resolved HDR alpha changed");
        requireCondition(frame.coverage[a.pixel]===Number(expected.expectedCoverage),"Actual stable alpha coverage differs");
        if(expected.expectedCoverage){
          requireCondition(a.hdr.slice(0,3).some((v,k)=>Math.abs(v-plan.fixture.background[k])>.008),"Visible texture contribution absent");stats.positivePoints++;
          if(s.id==="mask")stats.acceptedMask++;
        }else stats.rejectedMask++;
        if(expected.expected){
          const error=Math.max(...a.hdr.slice(0,3).map((v,k)=>Math.abs(v-expected.expected[k])));
          requireCondition(error<=plan.fixture.hdrTolerance,`Texture sRGB/UV/alpha oracle drift ${run.family}/${s.id}/${camera.id}/${a.pixel}: ${error}`);
          stats.maxOracleError=Math.max(stats.maxOracleError,error);
        }
        if(s.id.startsWith("mr-")){
          const error=Math.abs(a.roughness-expected.roughness);requireCondition(error<=1/255+.00001,"Actual MR G not linear/UV drift");stats.maxRoughnessError=Math.max(stats.maxRoughnessError,error);
          // 通道语义修正(2026-10-01):Web 样本另带 shade 消费形式 consumedRoughness(下限 0.06,
          // 镜像 lab consumedShadingRoughness);Native 的 roughness 字段本身就是消费语义
          // (fragment_normal_capture: min(1,clamp(raw,0.045,1)+geometry))。冻结 fixture 上
          // consumed==raw(下限不咬合、几何项 0)—— 显式断言,防止未来 fixture/下限变化让
          // "输入一致"排除依据再度悄然失效。历史 web/native 样本无该字段,向后兼容跳过。
          if(typeof a.consumedRoughness==="number"){
            const consumedError=Math.abs(a.consumedRoughness-Math.min(1,Math.max(.06,expected.roughness)));
            requireCondition(consumedError<=1/255+.00001,"Actual consumed roughness diverges from shade-consumed MR G beyond 8-bit LSB");
            stats.maxRoughnessError=Math.max(stats.maxRoughnessError,consumedError);
          }
          if(s.id==="mr-linear"){
            const zero=run.frames.find(v=>v.scenario==="mr-zero-metal"&&v.cameraId===camera.id&&v.round===round).samples[i];
            if(a.hdr.slice(0,3).some((v,k)=>Math.abs(v-zero.hdr[k])>.002))stats.metalContributions++;
          }
        }
      }
    }
    requireCondition(keys.size===28&&stats.acceptedMask>0&&stats.rejectedMask>0&&stats.metalContributions>=plan.fixture.minimumMetalContributions,"Texture matrix positive/negative controls absent");
    summaries.push({freshInstance:run.freshInstance,...stats});
  }
  if(runs.length===2){requireCondition(runs[0].freshInstance===0&&runs[1].freshInstance===1,"Native fresh identities duplicated");requireStableTextureFresh(runs[0],runs[1]);}
  return summaries;
}
export function requireStableTextureFresh(a,b){
  requireCondition(a.frames.length===28&&b.frames.length===28,"Fresh texture matrix incomplete");
  for(const f of a.frames){const matches=b.frames.filter(v=>v.scenario===f.scenario&&v.cameraId===f.cameraId&&v.round===f.round);
    requireCondition(matches.length===1&&f.fullHash===matches[0].fullHash&&f.normalHash===matches[0].normalHash,"Fresh texture draw unstable");}
}
function boundary(mask,width,height){
  const result=new Set();for(let y=0;y<height;y++)for(let x=0;x<width;x++){const p=y*width+x;
    if([[x-1,y],[x+1,y],[x,y-1],[x,y+1]].some(([nx,ny])=>nx>=0&&ny>=0&&nx<width&&ny<height&&mask[ny*width+nx]!==mask[p]))result.add(p);}
  return result;
}
export function compareTextureCoverageMasks(a,b,width,height){
  requireCondition(a.length===width*height&&b.length===a.length&&[...a,...b].every(v=>v===0||v===1),"Coverage extent/value drift");
  const ba=boundary(a,width,height),bb=boundary(b,width,height);let mismatches=0;
  const near=(p,set)=>{const x=p%width,y=Math.floor(p/width);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=x+dx,yy=y+dy;if(xx>=0&&yy>=0&&xx<width&&yy<height&&set.has(yy*width+xx))return true;}return false;};
  for(let p=0;p<a.length;p++)if(a[p]!==b[p]){mismatches++;requireCondition(near(p,ba)&&near(p,bb),"Coverage mismatch exceeds both real 1px boundaries");}
  return mismatches;
}
export function compareTextureCoveragePair(plan,native,web){
  let stablePoints=0,maxHdrError=0,boundaryMismatches=0;
  for(const n of native.frames){const camera=plan.cameras.find(c=>c.id===n.cameraId),w=web.frames.find(f=>f.scenario===n.scenario&&f.cameraId===n.cameraId&&f.round===n.round);
    requireCondition(!!camera&&!!w,"Paired texture frame absent");boundaryMismatches+=compareTextureCoverageMasks(n.coverage,w.coverage,plan.width,plan.height);
    for(let i=0;i<camera.points.length;i++)if(camera.points[i].byScenario[n.scenario].stable){
      const error=Math.max(...n.samples[i].hdr.slice(0,3).map((v,k)=>Math.abs(v-w.samples[i].hdr[k])));
      requireCondition(Number.isFinite(error)&&error<=plan.fixture.hdrTolerance,`Paired texture HDR drift ${n.scenario}/${n.cameraId}/${n.samples[i].pixel}: ${error}${mrAttributionSuffix(plan,n.scenario,camera.points[i],error)}`);
      stablePoints++;maxHdrError=Math.max(maxHdrError,error);
    }
  }
  requireCondition(stablePoints>=plan.fixture.minimumStableTotal*plan.scenarios.length*2,"Paired stable texture subset missing");
  return {stablePoints,maxHdrError,boundaryMismatches};
}
