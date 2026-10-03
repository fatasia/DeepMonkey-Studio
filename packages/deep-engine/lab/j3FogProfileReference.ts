import {volumetricFogPassCpu,validateVolumetricFogOptions} from "../src/fog/volumetricFogPassCpu.js";
import {decodeFloat16Bits,encodeFloat16Bits} from "./temporalAaProbe.js";
export interface FogProfile {id:string;density:number;height:number;g:number;steps:number;sky:boolean;exponential?:boolean}
export interface FogProfileFixture {
  schema:string;width:number;height:number;near:number;far:number;focal:number;geometryDepth:number;
  color:readonly [number,number,number];source:readonly [number,number,number];light:readonly [number,number,number];radiance:readonly [number,number,number];albedo:number;
  nativeEyeY:readonly number[];absoluteTolerance:number;relativeTolerance:number;profiles:readonly FogProfile[];nativeOnly:readonly FogProfile[];
}
export const halfFog=(v:number)=>decodeFloat16Bits(encodeFloat16Bits(v));
export function fogSourcePixels(f:FogProfileFixture){return Float32Array.from({length:f.width*f.height*4},(_,i)=>i%4===3?[0,.25,.5,1][Math.floor(i/4)%f.width%4]!:f.source[i%4]!);}
export function fogSourceBits(f:FogProfileFixture){return Uint16Array.from(fogSourcePixels(f),encodeFloat16Bits);}
export function fogWebOptions(f:FogProfileFixture,p:FogProfile){return {
  verticalFovRadians:2*Math.atan(1/f.focal),steps:p.steps,maxDistance:f.far,
  medium:{baseExtinction:p.density,scaleHeight:p.height,anisotropy:p.g,albedo:f.albedo},light:{direction:f.light,radiance:f.radiance}
};}
function bilinear(source:readonly number[]|Float32Array,width:number,height:number,u:number,v:number):number[]{
  const x=u*width-.5,y=v*height-.5,ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy;
  const lane=(x:number,y:number,k:number)=>source[(Math.max(0,Math.min(height-1,y))*width+Math.max(0,Math.min(width-1,x)))*4+k]!;
  return [0,1,2,3].map(k=>(lane(ix,iy,k)*(1-fx)+lane(ix+1,iy,k)*fx)*(1-fy)+(lane(ix,iy+1,k)*(1-fx)+lane(ix+1,iy+1,k)*fx)*fy);
}
/** Reuses the existing production CPU execution mirror; this is not a second independent march algorithm. */
export function fogWebReference(f:FogProfileFixture,p:FogProfile){
  const options=fogWebOptions(f,p);validateVolumetricFogOptions(options);
  return fogWebImageReference(f.width,f.height,fogSourcePixels(f),Array(f.width*f.height).fill(p.sky?0:f.geometryDepth),options);
}
/** The existing Web mirror/composite, with actual per-pixel scene sources. */
export function fogWebImageReference(width:number,height:number,source:readonly number[]|Float32Array,
  linearDepth:readonly number[],options:Parameters<typeof volumetricFogPassCpu>[1]){
  validateSceneImage(width,height,source,linearDepth,false);
  const mirror=volumetricFogPassCpu({width,height,depth:linearDepth},options);
  const scatter=Float32Array.from(mirror.scatter,halfFog),composite=new Float32Array(source.length);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const s=bilinear(scatter,mirror.width,mirror.height,(x+.5)/width,(y+.5)/height),at=(y*width+x)*4;
    for(let k=0;k<3;k++)composite[at+k]=halfFog(source[at+k]!*Math.max(0,Math.min(1,s[3]!))+Math.max(s[k]!,0));
    composite[at+3]=source[at+3]!;
  }
  return {scatter:Array.from(scatter),composite:Array.from(composite)};
}
function display(value:number){const a=Math.max(0,Math.min(1,value*(2.51*value+.03)/(value*(2.43*value+.59)+.14)));
  return halfFog(a<=.0031308?a*12.92:1.055*Math.pow(a,1/2.4)-.055);}
/** Independent Native output-profile oracle from actual frame inputs, not copied WGSL or a replacement GPU shader. */
export function fogNativeReference(f:FogProfileFixture,p:FogProfile,eyeY:number,frame:readonly number[][],depth:number){
  return fogNativeImageReference(f,p,eyeY,frame,Array(f.width*f.height).fill(depth),fogSourcePixels(f));
}
/** The same Native profile oracle, using actual scene HDR and per-pixel min-MSAA depth. */
export function fogNativeImageReference(f:Pick<FogProfileFixture,"width"|"height">,p:Pick<FogProfile,"exponential">,eyeY:number,frame:readonly number[][],
  depths:readonly number[],source:readonly number[]|Float32Array){
  validateSceneImage(f.width,f.height,source,depths,true);
  const projection=frame[143]!,near=projection[0]!,far=projection[1]!;
  const density=frame[12]![3]!,height=frame[148]![1]!,g=frame[148]![2]!,steps=Math.max(1,Math.min(64,Math.round(frame[148]![0]!)));
  const color=frame[12]!.slice(0,3),sun=frame[11]!.slice(0,3),sunLength=Math.hypot(...sun),pixels=[];
  const right=frame.slice(0,3).map(c=>c[0]!),up=frame.slice(0,3).map(c=>c[1]!),forward=frame.slice(0,3).map(c=>c[3]!);
  const length=Math.hypot(...forward);for(let k=0;k<3;k++)forward[k]!/=length;
  for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++){
    const depth=depths[y*f.width+x]!,distance=near*far/Math.max(far-depth*(far-near),.0001);
    let amount=1-Math.exp(-density*distance);
    if(!p.exponential){
      const ndcX=2*(x+.5)/f.width-1,ndcY=1-2*(y+.5)/f.height;
      const r2=right.reduce((n,v)=>n+v*v,0),u2=up.reduce((n,v)=>n+v*v,0);
      const ray=forward.map((v,k)=>v+ndcX*right[k]!/r2+ndcY*up[k]!/u2),rayLength=Math.hypot(...ray);
      for(let k=0;k<3;k++)ray[k]!/=rayLength;
      const cosine=ray.reduce((n,v,k)=>n+v*sun[k]!/sunLength,0),phase=Math.max(0,Math.min(4,(1-g*g)/Math.pow(Math.max(1+g*g-2*g*cosine,.01),1.5)));
      const rayDistance=distance/Math.max(ray.reduce((n,v,k)=>n+v*forward[k]!,0),.01),stepDistance=rayDistance/steps;
      let transmittance=1,integrated=0;
      for(let step=0;step<steps;step++){
        const worldHeight=eyeY+ray[1]!*(step+.5)*stepDistance,optical=density*Math.exp(-Math.max(worldHeight,0)/height)*stepDistance,t=Math.exp(-optical);
        integrated+=transmittance*(1-t)*phase;transmittance*=t;
      }
      amount=Math.max(0,Math.min(1,integrated));
    }
    const at=(y*f.width+x)*4;
    for(let k=0;k<3;k++)pixels.push(display(source[at+k]!*(1-amount)+color[k]!*amount));pixels.push(source[at+3]!);
  }
  return pixels;
}
function validateSceneImage(width:number,height:number,source:readonly number[]|Float32Array,depths:readonly number[],normalized:boolean){
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1
    ||source.length!==width*height*4||depths.length!==width*height)throw Error("Fog actual scene image dimensions differ");
  if(!Array.from(source).every(Number.isFinite)||!depths.every(v=>Number.isFinite(v)&&v>=0&&(!normalized||v<=1)))
    throw Error("Fog actual scene HDR or depth domain is invalid");
}
