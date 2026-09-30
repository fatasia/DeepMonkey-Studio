import {createHash} from "node:crypto";
const hash=value=>createHash("sha256").update(value).digest("hex");
export function compareBloomTextures(fixture,plans,web,native){
  for(const host of [web,native])if(!host?.passed||host.errors?.length||host.frames?.length!==fixture.cases.length*2
    ||typeof host.sourceHash!=="string"||host.sourceHash.length!==64)throw Error("Bloom actual host/matrix failed");
  const comparisons=[],differences=[];
  for(const plan of plans)for(let round=0;round<2;round++){
    const w=web.frames.find(f=>f.id===plan.id&&f.round===round),n=native.frames.find(f=>f.id===plan.id&&f.round===round);
    if(!w||!n||w.inputHash!==plan.inputHash||n.inputHash!==plan.inputHash||w.width!==fixture.width||w.height!==fixture.height
      ||n.width!==fixture.width||n.height!==fixture.height||n.blurredWidth!==fixture.width/2||n.blurredHeight!==fixture.height/2
      ||w.levels!==fixture.web.maxLevels||w.passCount!==fixture.web.maxLevels*4)throw Error("Frozen Bloom source/profile changed");
    for(const [profile,actual,expected] of [["web-HDR",w.pixels,plan.web],["native-blurred",n.blurred,plan.native.blurred],["native-display",n.display,plan.native.display]]){
      if(actual.length!==expected.length)throw Error("Bloom full pixel matrix is incomplete");
      let maxAbsoluteError=0,maxRelativeError=0;
      for(let i=0;i<actual.length;i++){
        const delta=Math.abs(actual[i]-expected[i]);
        if(!Number.isFinite(actual[i])||delta>fixture.absoluteTolerance+Math.abs(expected[i])*fixture.relativeTolerance)
          throw Error(`Bloom independent texture oracle failed ${plan.id}/${profile}/round${round}/lane${i}: actual=${actual[i]} expected=${expected[i]}`);
        if(i%4===3&&actual[i]!==expected[i])throw Error("Bloom actual alpha changed");
        maxAbsoluteError=Math.max(maxAbsoluteError,delta);maxRelativeError=Math.max(maxRelativeError,delta/Math.max(.01,Math.abs(expected[i])));
      }
      comparisons.push({id:plan.id,round,profile,pixels:actual.length/4,maxAbsoluteError,maxRelativeError});
    }
    for(const [host,keys] of [[web,["rgbaHash"]],[native,["blurredHash","displayHash"]]]){
      const current=host.frames.find(f=>f.id===plan.id&&f.round===round),first=host.frames.find(f=>f.id===plan.id&&f.round===0);
      if(keys.some(key=>typeof current[key]!=="string"||current[key].length!==64||current[key]!==first[key]))throw Error("Bloom actual two draws unstable");
    }
    // Profile differences are observations, not equality gates. Compare display to display, never display to linear HDR.
    const displayWeb=w.pixels.map((value,i)=>i%4===3?value:linearDisplay(value));
    const delta=n.display.map((value,i)=>i%4===3?0:Math.abs(value-displayWeb[i]));
    differences.push({id:plan.id,round,domain:"display-ACES-sRGB",maxAbsolute:Math.max(...delta),meanAbsolute:delta.reduce((a,b)=>a+b,0)/(delta.length/4*3)});
  }
  return {passed:true,stable:true,comparisons,differences,pixelsCompared:comparisons.reduce((n,r)=>n+r.pixels,0),
    scope:"actual-production-Bloom-textures-per-legal-profile",excluded:["cross-algorithm pixel equality","author-Rec709-Bloom","volumetric Fog","whole-scene visual quality","frame performance"]};
}
function linearDisplay(value){const a=Math.max(0,Math.min(1,value*(2.51*value+.03)/(value*(2.43*value+.59)+.14)));
  return a<=.0031308?a*12.92:1.055*Math.pow(a,1/2.4)-.055;}
export function bloomFixtureHash(text){return hash(text);}
