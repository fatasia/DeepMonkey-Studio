export function compareAuthorFog(plan,web,native) {
  let maxCpuError=0,maxCrossError=0,pointsCompared=0;
  for(const host of [web,native]) {
    if(!host?.passed||host.packageHash!==plan.packageHash||host.packetHash!==plan.packetHash||host.errors?.length
      ||host.width!==plan.width||host.height!==plan.height||host.frames.length!==16)throw Error("Actual author fog host identity/matrix failed");
  }
  for(const camera of plan.cameras)for(const scenario of plan.profile.scenarios)for(let round=0;round<2;round++) {
    const frames=[web,native].map(host=>host.frames.find(f=>f.cameraId===camera.id&&f.scenario===scenario.id&&f.round===round));
    if(frames.some(f=>!f||f.samples.length!==camera.points.length||f.vp.length!==16||!f.vp.every(Number.isFinite)))
      throw Error("Actual author fog camera/scenario missing");
    if(frames.some(f=>f.vp.some((v,i)=>Math.abs(v-camera.expectedVP[i])>1e-5)))throw Error("Actual author fog camera VP differs from frozen camera");
    for(const [i,point] of camera.points.entries()) {
      const expected=point.expected[scenario.id];
      for(const frame of frames) {
        const sample=frame.samples[i];
        if(sample.pixel!==point.pixel||sample.instanceId!==point.instanceId||sample.hdr.length!==4||sample.hdr[3]!==1)
          throw Error("Actual author fog original mask/alpha changed");
        for(let c=0;c<3;c++) {
          const error=Math.abs(sample.hdr[c]-expected[c]);
          if(!Number.isFinite(error)||error>plan.profile.cpuAbsoluteTolerance)throw Error(`Fog CPU oracle failed ${camera.id}/${scenario.id}/${point.pixel}`);
          maxCpuError=Math.max(maxCpuError,error);
        }
      }
      for(let c=0;c<3;c++) {
        const error=Math.abs(frames[0].samples[i].hdr[c]-frames[1].samples[i].hdr[c]);
        if(error>plan.profile.crossHostAbsoluteTolerance)throw Error(`Fog cross-host HDR differs ${camera.id}/${scenario.id}/${point.pixel}`);
        maxCrossError=Math.max(maxCrossError,error);
      }
      pointsCompared++;
    }
    for(const host of [web,native]) {
      const frame=host.frames.find(f=>f.cameraId===camera.id&&f.scenario===scenario.id&&f.round===round);
      const first=host.frames.find(f=>f.cameraId===camera.id&&f.scenario===scenario.id&&f.round===0);
      if(frame.rgbaHash!==first.rgbaHash)throw Error("Author fog two draws were unstable");
      if(scenario.id==="material-opt-out") {
        const control=host.frames.find(f=>f.cameraId===camera.id&&f.scenario==="control"&&f.round===round);
        if(frame.rgbaHash!==control.rgbaHash)throw Error("Material fog=false changed full HDR from control");
      }
    }
  }
  return {passed:true,stable:true,pointsCompared,maxCpuError,maxCrossError,
    scope:"actual-two-camera-unlit-authored-exp2-HDR-and-material-opt-out",
    excluded:["behind-camera depth","lit BRDF parity","linear/volumetric fog modes","Bloom profiles","RT rendering","product frame performance"]};
}
