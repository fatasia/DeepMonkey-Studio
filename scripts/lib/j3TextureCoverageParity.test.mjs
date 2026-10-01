import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {validateTextureCoverageHost,requireStableTextureFresh,compareTextureCoveragePair,compareTextureCoverageMasks,requireTextureCoverageNativeRun,
  directMultiscatteringEnergy,dfg185DirectAt,predictMrDirectMultiscatteringDelta} from "./j3TextureCoverageParity.mjs";

// J3 Gate D CPU 侧判定器测试:纯合成 85 点/2 相机/7 配置矩阵,不触 GPU。
// 覆盖:证据/输入身份负例、RGB 严格 0.002 门、HDR alpha/coverage 逐点判据、
// MR 线性 roughness 门(1/255+1e-5)与 zero-metal 贡献下限、严格 UV1 25/19 稳定域
// 与两相机 4-texel 覆盖形状、跨端配对(mask 真实轮廓 1px 允许 / 内部失配拒绝)、
// 消费语义 roughness 字段门、直射多散射 DFG 归因模型(对照 interrupted-0930 实测)。
const hex=c=>String(c).repeat(64);
const sha=v=>createHash("sha256").update(v).digest("hex");
const BACKGROUND=[.012,.02,.035];
const SCENARIOS=["base-uv0","base-uv1","emissive-uv1","mr-linear","mr-zero-metal","mask","blend"];
const BASE=[.5,.4,.3];
function buildWorld(options={}){
  const o={maskAcceptAll:false,metalFlat:false,dropPoint:false,...options};
  const pkg=i=>"a"+String(i).padStart(63,"0");
  const point=(i,base)=>{const texel=i%4,maskCoverage=o.maskAcceptAll?true:i%2===0;return {pixel:base+i*7,byScenario:{
    "base-uv0":{texel,stable:true,expectedCoverage:true,expected:BASE,roughness:.9},
    // 严格 UV1 稳定域:轴向相机 25、斜视相机 19;两相机 stable 子集均覆盖全部 4 texel。
    "base-uv1":{texel,stable:i<(base===300?25:19),expectedCoverage:true,expected:BASE,roughness:.9},
    "emissive-uv1":{texel,stable:true,expectedCoverage:true,expected:[.6,.45,.3],roughness:.9},
    "mr-linear":{texel,stable:true,expectedCoverage:true,expected:o.metalFlat?[.1,.08,.06]:[.2,.15,.1],roughness:.81},
    "mr-zero-metal":{texel,stable:true,expectedCoverage:true,expected:[.1,.08,.06],roughness:.81},
    mask:{texel,stable:true,expectedCoverage:maskCoverage,expected:maskCoverage?BASE:BACKGROUND,roughness:.9},
    blend:{texel,stable:true,expectedCoverage:true,expected:[.55,.5,.45],roughness:.9}}};};
  const cameras=[{id:"axis",expectedVP:Array.from({length:16},(_,k)=>.1+k),points:Array.from({length:45},(_,i)=>point(i,300))},
    {id:"oblique",expectedVP:Array.from({length:16},(_,k)=>.2+k),points:Array.from({length:40},(_,i)=>point(i,900))}];
  if(o.dropPoint)cameras[0].points.pop();
  const scenarios=SCENARIOS.map((id,i)=>({id,packageHash:pkg(i+1),packetHash:pkg(i+11)}));
  const plan={schema:"j3-texture-coverage-plan-v1",sourcePackageHash:hex("1"),sourcePacketHash:hex("2"),width:128,height:128,cameras,scenarios,
    fixture:{schema:"j3-texture-coverage-v1",background:BACKGROUND,hdrTolerance:.002,minimumStablePerCamera:12,minimumStableTotal:32,minimumMetalContributions:16}};
  const frames=family=>{const out=[];for(const s of scenarios)for(const camera of cameras)for(let round=0;round<2;round++){
    const coverage=Array(128*128).fill(0);
    // 实心前景方块:内部点(如 pixel 8385)距真实轮廓 >1px,用于区分 1px 允许与 2px 失配。
    for(let y=40;y<90;y++)for(let x=40;x<90;x++)coverage[y*128+x]=1;
    const samples=camera.points.map(p=>{const e=p.byScenario[s.id];coverage[p.pixel]=Number(e.expectedCoverage);
      return {pixel:p.pixel,hdr:[...e.expected,1],roughness:e.roughness};});
    out.push({scenario:s.id,cameraId:camera.id,round,packageHash:s.packageHash,packetHash:s.packetHash,fullHash:hex("a"),normalHash:hex("b"),
      vp:camera.expectedVP.slice(),frame:Array.from({length:96},(_,k)=>k+1),coveragePixels:2,
      finalAttachment:family==="web"?(s.id==="blend"?"weighted-oit-composited-hdr":"opaque-hdr"):"resolved-native-forward-hdr",coverage,samples});}return out;};
  const nativeSource="native mesh";
  const native={schema:"j3-texture-coverage-host-v1",family:"native",passed:true,errors:[],inputHash:hex("c"),profileHash:hex("d"),
    sourcePackageHash:hex("1"),sourcePacketHash:hex("2"),sourceHash:sha(nativeSource),source:nativeSource,sourceAssembly:{factory:"native_mesh_wgsl::native_mesh_shader_source"},
    runs:[{freshInstance:0,frames:frames("native")},{freshInstance:1,frames:frames("native")}]};
  const web=fresh=>({schema:"j3-texture-coverage-host-v1",family:"web",passed:true,errors:[],freshInstance:fresh,inputHash:hex("c"),profileHash:hex("d"),
    sourcePackageHash:hex("1"),sourcePacketHash:hex("2"),sourceHash:hex("e"),modules:[{hash:hex("e"),count:2}],
    compileRecords:[{label:"material/gate-d-base",failed:false}],frames:frames("web")});
  return {plan,native,web0:web(0),web1:web(1),receipt:{inputHash:hex("c"),profileHash:hex("d"),webSourceHash:hex("e")}};
}
test("host identity accepts 85-point plan with strict UV1 25/19 stable domain and 4-texel per-camera coverage",()=>{
  const {plan,native,web0,web1,receipt}=buildWorld();
  assert.deepEqual(plan.cameras.map(c=>c.points.length),[45,40]);
  assert.equal(plan.cameras.reduce((n,c)=>n+c.points.length,0),85);
  for(const camera of plan.cameras){
    const stable=camera.points.filter(p=>p.byScenario["base-uv1"].stable);
    assert.equal(stable.length,camera.id==="axis"?25:19);
    assert.equal(new Set(stable.map(p=>p.byScenario["base-uv1"].texel)).size,4);
  }
  const nativeSummaries=validateTextureCoverageHost(plan,native,receipt);
  const webSummaries=[...validateTextureCoverageHost(plan,web0,receipt),...validateTextureCoverageHost(plan,web1,receipt)];
  for(const summary of [...nativeSummaries,...webSummaries]){
    assert.equal(summary.stablePoints>0,true);assert.equal(summary.acceptedMask>0&&summary.rejectedMask>0,true);
    assert.equal(summary.maxOracleError<=.002,true);assert.equal(summary.metalContributions>=16,true);
  }
  assert.deepEqual(nativeSummaries.map(v=>v.freshInstance),[0,1]);
  requireStableTextureFresh(web0,web1);
});
test("stale evidence input identity, wrong input hash and wrong profile hash must FAIL",()=>{
  const {plan,native,web0,receipt}=buildWorld();
  const staleHost={...structuredClone(web0),inputHash:hex("9")};
  assert.throws(()=>validateTextureCoverageHost(plan,staleHost,receipt),/execution\/input identity failed/);
  assert.throws(()=>validateTextureCoverageHost(plan,native,{...receipt,inputHash:hex("f")}),/execution\/input identity failed/);
  assert.throws(()=>validateTextureCoverageHost(plan,web0,{...receipt,profileHash:hex("f")}),/execution\/input identity failed/);
});
test("RGB oracle is strictly 0.002: 0.0019 passes, 0.0021 fails; alpha and per-point coverage controls hold",()=>{
  const {plan,native,web0,receipt}=buildWorld();
  const pass=structuredClone(web0),fail=structuredClone(web0);
  for(const host of [pass,fail]){
    const frame=host.frames.find(v=>v.scenario==="base-uv0"&&v.round===0);
    frame.samples[0].hdr[0]=.5+(host===pass?.0019:.0021);
  }
  validateTextureCoverageHost(plan,pass,receipt);
  assert.throws(()=>validateTextureCoverageHost(plan,fail,receipt),/oracle drift/);
  const alpha=structuredClone(web0);alpha.frames[0].samples[0].hdr[3]=.5;
  assert.throws(()=>validateTextureCoverageHost(plan,alpha,receipt),/Actual resolved HDR alpha changed/);
  const maskReject=structuredClone(web0),visible=structuredClone(web0);
  const rejectFrame=maskReject.frames.find(v=>v.scenario==="mask"&&v.cameraId==="oblique"&&v.round===0);
  const sample=rejectFrame.samples.map((s,i)=>({s,i})).find(v=>v.s.hdr[0]===BACKGROUND[0]);
  rejectFrame.coverage[sample.s.pixel]=1;
  assert.throws(()=>validateTextureCoverageHost(plan,maskReject,receipt),/Actual stable alpha coverage differs/);
  const acceptFrame=visible.frames.find(v=>v.scenario==="mask"&&v.cameraId==="axis"&&v.round===0);
  const accepted=acceptFrame.samples.map((s,i)=>({s,i})).find(v=>v.s.hdr[0]===BASE[0]);
  acceptFrame.samples[accepted.i].hdr=[...BACKGROUND,1];
  assert.throws(()=>validateTextureCoverageHost(plan,visible,receipt),/Visible texture contribution absent/);
});
test("MR linear roughness gate is 1/255+1e-5 and flat metal responses fail the 16-contribution minimum",()=>{
  const {plan,native,web0,receipt}=buildWorld();
  const pass=structuredClone(native),fail=structuredClone(native);
  for(const host of [pass,fail]){
    const frame=host.runs[0].frames.find(v=>v.scenario==="mr-linear"&&v.round===0);
    frame.samples[0].roughness=.81+(host===pass?.0039:.004);
  }
  validateTextureCoverageHost(plan,pass,receipt);
  assert.throws(()=>validateTextureCoverageHost(plan,fail,receipt),/MR G not linear/);
  const flat=buildWorld({metalFlat:true});
  assert.throws(()=>validateTextureCoverageHost(flat.plan,flat.native,flat.receipt),/positive\/negative controls absent/);
});
test("repeated draw, dual fresh, web OIT final attachment and 28-frame matrix integrity are enforced",()=>{
  const {plan,native,web0,web1,receipt}=buildWorld();
  const unstable=structuredClone(native);
  unstable.runs[0].frames.find(v=>v.round===1).fullHash=hex("9");
  assert.throws(()=>validateTextureCoverageHost(plan,unstable,receipt),/Repeated formal draw unstable/);
  const driftedFresh=structuredClone(web1);
  driftedFresh.frames[3].fullHash=hex("9");
  assert.throws(()=>requireStableTextureFresh(web0,driftedFresh),/Fresh texture draw unstable/);
  const wrongAttachment=structuredClone(web0);
  wrongAttachment.frames.find(v=>v.scenario==="blend").finalAttachment="opaque-hdr";
  assert.throws(()=>validateTextureCoverageHost(plan,wrongAttachment,receipt),/Web final alpha HDR attachment wrong/);
  const shortNative=structuredClone(native);shortNative.runs[1].frames.pop();
  assert.throws(()=>validateTextureCoverageHost(plan,shortNative,receipt),/fresh matrix incomplete/);
  const shortWeb=structuredClone(web0);shortWeb.frames.pop();
  assert.throws(()=>validateTextureCoverageHost(plan,shortWeb,receipt),/fresh matrix incomplete/);
  assert.throws(()=>validateTextureCoverageHost(buildWorld({dropPoint:true}).plan,web0,receipt),/Unknown texture plan/);
});
test("mask accept/reject and metal negative controls must not vanish",()=>{
  const all=buildWorld({maskAcceptAll:true});
  assert.throws(()=>validateTextureCoverageHost(all.plan,all.native,all.receipt),/positive\/negative controls absent/);
});
test("cross-host pair: stable HDR gate, 1px real-boundary allowance, 2px interior mismatch, stable minimum",()=>{
  const {plan,native,web0}=buildWorld();
  const pair=compareTextureCoveragePair(plan,native.runs[0],web0);
  assert.equal(pair.boundaryMismatches,0);assert.equal(pair.maxHdrError,0);
  assert.equal(pair.stablePoints>=32*7*2,true);
  const drift=structuredClone(web0);
  drift.frames[0].samples[0].hdr[0]+=.01;
  assert.throws(()=>compareTextureCoveragePair(plan,native.runs[0],drift),/Paired texture HDR drift/);
  const interior=structuredClone(web0);
  interior.frames[0].coverage[8385]=0;
  assert.throws(()=>compareTextureCoveragePair(plan,native.runs[0],interior),/exceeds both real 1px boundaries/);
  const boundary=structuredClone(web0);
  boundary.frames[0].coverage[5185]=0;
  const allowed=compareTextureCoveragePair(plan,native.runs[0],boundary);
  assert.equal(allowed.boundaryMismatches,1);
  const huge={...structuredClone(plan),fixture:{...plan.fixture,minimumStableTotal:1e6}};
  assert.throws(()=>compareTextureCoveragePair(huge,native.runs[0],web0),/Paired stable texture subset missing/);
  assert.throws(()=>compareTextureCoverageMasks(Array(4).fill(1),Array(4).fill(1),2,3),/Coverage extent\/value drift/);
});
test("native runner gate accepts only the named passing texture GPU test",()=>{
  const ok="\nrunning 1 test\ntest j3_actual_texture_uv_coverage ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; finished in 1.00s\n";
  requireTextureCoverageNativeRun(ok,0);
  requireTextureCoverageNativeRun("\ntest deep_engine_native::j3_actual_texture_uv_coverage ... ok\ntest result: ok. 1 passed; 0 failed;\n",0);
  assert.throws(()=>requireTextureCoverageNativeRun(ok,1),/did not execute successfully/);
  assert.throws(()=>requireTextureCoverageNativeRun("\ntest j2_b5_actual_probe_gi ... ok\ntest result: ok. 1 passed; 0 failed;\n",0),/did not execute successfully/);
  assert.throws(()=>requireTextureCoverageNativeRun("\ntest j3_actual_texture_uv_coverage ... FAILED\ntest result: FAILED. 1 failed;\n",0),/did not execute successfully/);
});
test("web consumed roughness field must track the shade-consumed MR G within the 8-bit gate; native samples stay backward compatible",()=>{
  const {plan,native,web0,receipt}=buildWorld();
  const withConsumed=structuredClone(web0);
  for(const frame of withConsumed.frames)for(const sample of frame.samples){
    sample.consumedRoughness=Math.min(1,Math.max(.06,sample.roughness));
  }
  validateTextureCoverageHost(plan,withConsumed,receipt);
  const diverged=structuredClone(withConsumed);
  diverged.frames.find(v=>v.scenario==="mr-linear"&&v.round===0).samples[0].consumedRoughness=.81+.02;
  assert.throws(()=>validateTextureCoverageHost(plan,diverged,receipt),/consumed roughness diverges/);
  validateTextureCoverageHost(plan,structuredClone(native),receipt);
});
test("dfg185 lookup and multiscattering energy mirror the shared WGSL at hand-computed reference points",()=>{
  const source=readFileSync(new URL("../../packages/deep-engine/src/webgpu/directDfgLut185.ts",import.meta.url),"utf8");
  const match=source.match(/DIRECT_DFG_185_WGSL_ARRAY\s*=\s*"((?:[^"\\]|\\.)*)"/);
  const lut=[...match[1].matchAll(/vec2f\(([-0-9.e+]+),\s*([-0-9.e+]+)\)/g)].map(v=>[Number(v[1]),Number(v[2])]);
  assert.equal(lut.length,256);
  assert.deepEqual(lut[15*16+12],[0.5830078125,0.00010627508163452148]);
  // 行内插值:rough=0.790588(nv=1, 行 15, i=12→13, fu=0.149412)—— Web shade 实际查到的 DFG。
  // 手算参考:0.5830078125*0.85058824+0.4970703125*0.14941176 = 0.5701677390;
  //           y = 0.00010627508*0.85058824+0.00009584427*0.14941176 = 0.0001047166。
  const web=dfg185DirectAt(lut,0.9*224/255,1);
  assert.ok(Math.abs(web[0]-0.5701677390)<1e-8&&Math.abs(web[1]-0.0001047166)<1e-8,`dfg185 interp ${web}`);
  // 能量核手算参考:texel3(metal=0.8*240/255,f0=[0.61224,0.53694,0.46165])。
  const f0=[0.6122352941176471,0.5369411764705883,0.46164705882352944];
  const native=directMultiscatteringEnergy(f0[0],[0.75,0.0625],[0.75,0.0625]);
  assert.ok(Math.abs(native-0.0061717)<2e-6,`native energy ${native}`);
  const webEnergy=directMultiscatteringEnergy(f0[0],web,web);
  assert.ok(Math.abs(webEnergy-0.0160709)<2e-5,`web energy ${webEnergy}`);
});
test("attribution model reproduces the interrupted-0930 mr-linear observed deltas within f16 quantization noise",()=>{
  const fixture=JSON.parse(readFileSync(new URL("../../packages/deep-engine/fixtures/j3-texture-coverage-v1.json",import.meta.url),"utf8"));
  // 实测(interrupted-0930/texture-coverage,两 fresh 的 web-0 web-1 与 native.runs[0] 逐点一致):
  // texel3 稳定点 nH=[0.28955,0.20166,0.12915] wH=[0.3042,0.20947,0.13269];
  // texel2 稳定点 nH=[0.43042,0.30151,0.19421] wH=[0.43311,0.30273,0.19482]。
  const observed={2:[0.00269,0.00122,0.00061],3:[0.01465,0.00781,0.00354]};
  for(const texel of [2,3]){
    const predicted=predictMrDirectMultiscatteringDelta(fixture,texel,0.9*fixture.mrBytes[texel*4+1]/255);
    for(let k=0;k<3;k++){
      assert.ok(predicted[k]>0,`texel${texel} ch${k} must predict web-brighter, got ${predicted[k]}`);
      assert.ok(Math.abs(predicted[k]-observed[texel][k])<=0.0003,
        `texel${texel} ch${k} predicted ${predicted[k].toFixed(6)} vs observed ${observed[texel][k]}`);
    }
  }
});
test("pair drift on mr-linear reports multiscattering attribution; off-prediction drift stays unexplained",()=>{
  const {plan,native,web0}=buildWorld();
  const fixture=JSON.parse(readFileSync(new URL("../../packages/deep-engine/fixtures/j3-texture-coverage-v1.json",import.meta.url),"utf8"));
  plan.fixture={...plan.fixture,...fixture};
  const point3=plan.cameras[0].points[3];
  assert.equal(point3.byScenario["mr-linear"].texel,3);
  const predicted=predictMrDirectMultiscatteringDelta(plan.fixture,3,point3.byScenario["mr-linear"].roughness);
  const attributed=structuredClone(web0);
  attributed.frames.find(v=>v.scenario==="mr-linear"&&v.cameraId==="axis"&&v.round===0).samples[3].hdr[0]+=predicted[0];
  assert.throws(()=>compareTextureCoveragePair(plan,native.runs[0],attributed),/drift .*attributed: direct-multiscattering DFG divergence/);
  const unknown=structuredClone(web0);
  unknown.frames.find(v=>v.scenario==="mr-linear"&&v.cameraId==="axis"&&v.round===0).samples[3].hdr[0]+=predicted[0]+0.01;
  assert.throws(()=>compareTextureCoveragePair(plan,native.runs[0],unknown),/unexplained: multiscattering attribution residual/);
  const silent=structuredClone(web0);
  silent.frames.find(v=>v.scenario==="base-uv0"&&v.cameraId==="axis"&&v.round===0).samples[3].hdr[0]+=0.01;
  let message="";
  try{compareTextureCoveragePair(plan,native.runs[0],silent);}catch(e){message=String(e.message);}
  assert.match(message,/Paired texture HDR drift/);
  assert.doesNotMatch(message,/multiscattering/);
});
