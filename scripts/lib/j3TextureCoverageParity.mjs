import {createHash} from "node:crypto";
const sha=value=>createHash("sha256").update(value).digest("hex"),hash=v=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const requireCondition=(v,m)=>{if(!v)throw Error(m);};
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
      requireCondition(Number.isFinite(error)&&error<=plan.fixture.hdrTolerance,`Paired texture HDR drift ${n.scenario}/${n.cameraId}/${n.samples[i].pixel}: ${error}`);
      stablePoints++;maxHdrError=Math.max(maxHdrError,error);
    }
  }
  requireCondition(stablePoints>=plan.fixture.minimumStableTotal*plan.scenarios.length*2,"Paired stable texture subset missing");
  return {stablePoints,maxHdrError,boundaryMismatches};
}
