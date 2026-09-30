export function compareFogProfiles(fixture,plans,web,native){
  const profiles=[...fixture.profiles,...fixture.nativeOnly];
  if(!web?.passed||!native?.passed||web.errors?.length||native.errors?.length
    ||web.frames?.length!==fixture.profiles.length*2||native.frames?.length!==profiles.length*fixture.nativeEyeY.length*2)
    throw Error("Actual Fog host/matrix failed");
  if(web.inputHash!==plans.inputHash||native.inputHash!==plans.inputHash)throw Error("Actual Fog fixed HDR identity differs");
  if([web,native].some(h=>typeof h.sourceHash!=="string"||h.sourceHash.length!==64))throw Error("Actual Fog shader identity absent");
  const comparisons=[];
  function compare(id,round,profile,actual,expected){
    if(actual.length!==expected.length)throw Error("Fog full pixel matrix is incomplete");let maxAbsoluteError=0;
    for(let i=0;i<actual.length;i++){
      const delta=Math.abs(actual[i]-expected[i]);
      if(!Number.isFinite(actual[i])||delta>fixture.absoluteTolerance+Math.abs(expected[i])*fixture.relativeTolerance)
        throw Error(`Fog CPU profile failed ${id}/${profile}/round${round}/lane${i}: actual=${actual[i]} expected=${expected[i]}`);
      if(profile!=="web-scatter"&&i%4===3&&actual[i]!==expected[i])throw Error("Fog actual alpha changed");
      maxAbsoluteError=Math.max(maxAbsoluteError,delta);
    }
    comparisons.push({id,round,profile,pixels:actual.length/4,maxAbsoluteError});
  }
  for(const p of fixture.profiles)for(let round=0;round<2;round++){
    const actual=web.frames.find(x=>x.id===p.id&&x.round===round),expected=plans.web.find(x=>x.id===p.id),first=web.frames.find(x=>x.id===p.id&&x.round===0);
    if(!actual||actual.width!==fixture.width||actual.height!==fixture.height||actual.inputHash!==plans.inputHash)throw Error("Frozen Web Fog profile changed");
    compare(p.id,round,"web-scatter",actual.scatter,expected.scatter);compare(p.id,round,"web-HDR",actual.composite,expected.composite);
    if([actual.rgbaHash,actual.scatterHash].some(h=>typeof h!=="string"||h.length!==64)||actual.rgbaHash!==first.rgbaHash||actual.scatterHash!==first.scatterHash)throw Error("Actual Web Fog two draws unstable");
  }
  for(const p of profiles)for(const eyeY of fixture.nativeEyeY)for(let round=0;round<2;round++){
    const actual=native.frames.find(x=>x.id===p.id&&x.eyeY===eyeY&&x.round===round),expected=plans.native.find(x=>x.id===p.id&&x.eyeY===eyeY),first=native.frames.find(x=>x.id===p.id&&x.eyeY===eyeY&&x.round===0);
    if(!actual||actual.width!==fixture.width||actual.height!==fixture.height||actual.inputHash!==plans.inputHash)throw Error("Frozen Native Fog profile changed");
    const frame=actual.frame,close=(v,w)=>Number.isFinite(v)&&Math.abs(v-w)<1e-6;
    if(frame.length!==149||!frame.every(row=>row.length===4&&row.every(Number.isFinite))
      ||!close(frame[8][1],eyeY)||!close(frame[3][1],-fixture.focal*eyeY)||!close(frame[0][0],fixture.focal/(fixture.width/fixture.height))
      ||!close(frame[1][1],fixture.focal)||frame[2][3]!==-1||!close(frame[143][0],fixture.near)||!close(frame[143][1],fixture.far)
      ||!close(frame[12][3],p.density)||fixture.color.some((v,i)=>!close(frame[12][i],v))||fixture.light.some((v,i)=>!close(frame[11][i],v))
      ||frame[143][2]!== (p.exponential?0:1)||(!p.exponential&&(frame[148][0]!==p.steps||!close(frame[148][1],p.height)||!close(frame[148][2],p.g))))
      throw Error("Actual Native Fog authored frame/profile differs");
    const rawDepth=p.sky?1:Math.fround(fixture.far/(fixture.far-fixture.near)-fixture.near*fixture.far/((fixture.far-fixture.near)*fixture.geometryDepth));
    if(!close(actual.rawDepth,rawDepth))throw Error("Actual Native Fog fixed depth differs");
    compare(p.id,round,`native-display-eye${eyeY}`,actual.pixels,expected.pixels);
    if(typeof actual.rgbaHash!=="string"||actual.rgbaHash.length!==64||actual.rgbaHash!==first.rgbaHash)throw Error("Actual Native Fog two draws unstable");
  }
  const heightChanged=native.frames.filter(x=>x.id==="volume-base"&&x.round===0).map(x=>x.rgbaHash);
  if(fixture.nativeEyeY.length>1&&heightChanged[0]===heightChanged[1])throw Error("Native actual world height did not affect Fog");
  return {passed:true,stable:true,comparisons,pixelsCompared:comparisons.reduce((n,r)=>n+r.pixels,0),
    scope:"actual-legal-Fog-profiles-world-vs-view-height-HG-and-full-output",
    cpuReferences:{web:"existing volumetricFogPassCpu execution mirror plus half-store composite",native:"independent world-ray/output profile oracle"},
    excluded:["cross-profile equality","world-eye-height Web API","Native authored linear mode","RT Fog","whole-scene visual quality","frame performance"]};
}
