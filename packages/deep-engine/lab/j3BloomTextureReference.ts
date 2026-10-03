import {decodeFloat16Bits,encodeFloat16Bits} from "./temporalAaProbe.js";

export interface BloomTextureImage {width:number;height:number;pixels:Float32Array}
export interface BloomTextureFixture {
  schema:string;width:number;height:number;cases:readonly string[];
  web:{threshold:number;softKnee:number;intensity:number;maxLevels:number};
  native:{threshold:number;softKnee:number;intensity:number;radius:number};
  absoluteTolerance:number;relativeTolerance:number;
}
const half=(value:number)=>decodeFloat16Bits(encodeFloat16Bits(value));
export function bloomTextureBits(source:BloomTextureImage):Uint16Array {return Uint16Array.from(source.pixels,encodeFloat16Bits);}
export function bloomTextureInput(id:string,width:number,height:number):BloomTextureImage {
  return image(width,height,(x,y)=>{
    const alpha=[0,.25,.5,1][x%4]!;
    let rgb:number[];
    switch(id){
      case "uniform":rgb=[4,2,1];break;
      case "center-spot":rgb=x>=width/2-2&&x<width/2+2&&y>=height/2-2&&y<height/2+2?[16,8,4]:[0,0,0];break;
      case "edge-spot":rgb=x<4&&y<4?[16,8,4]:[0,0,0];break;
      case "gradient":rgb=[x/(width-1)*4,y/(height-1)*2,(x+y)/(width+height-2)];break;
      case "signed-checker":rgb=(x+y)%2===0?[4,-2,1]:[-4,2,-1];break;
      case "threshold-stripes":rgb=x%4===0?[.75,.5,.25]:x%4===1?[1,1,.5]:x%4===2?[1.25,1,.75]:[1.5,1.25,1];break;
      default:throw Error("Unknown frozen Bloom input");
    }
    return [...rgb,alpha];
  });
}
function image(width:number,height:number,pixel:(x:number,y:number)=>readonly number[],roundStore=true):BloomTextureImage {
  const pixels=new Float32Array(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)pixels.set(pixel(x,y).map(v=>roundStore?half(v):v),(y*width+x)*4);
  return {width,height,pixels};
}
function load(source:BloomTextureImage,x:number,y:number):number[]{
  const at=(Math.max(0,Math.min(source.height-1,y))*source.width+Math.max(0,Math.min(source.width-1,x)))*4;
  return Array.from(source.pixels.slice(at,at+4));
}
function linear(source:BloomTextureImage,u:number,v:number):number[]{
  const x=u*source.width-.5,y=v*source.height-.5,ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy;
  const a=load(source,ix,iy),b=load(source,ix+1,iy),c=load(source,ix,iy+1),d=load(source,ix+1,iy+1);
  return a.map((value,k)=>(value*(1-fx)+b[k]!*fx)*(1-fy)+(c[k]!*(1-fx)+d[k]!*fx)*fy);
}
function extract(rgb:readonly number[],threshold:number,softKnee:number,native:boolean):number[]{
  const color=rgb.map(v=>Math.max(v,0)),brightness=Math.max(...color),knee=native?Math.max(threshold*softKnee,.00001):threshold*softKnee;
  const t=Math.max(0,Math.min(2*knee,brightness-threshold+knee));
  const soft=knee>0?t*t/(4*knee+(native?.00001:0)):0;
  const factor=Math.max(brightness-threshold,soft)/Math.max(brightness,.00001);
  return color.map(v=>v*factor);
}
function box(source:BloomTextureImage,x:number,y:number):number[]{
  const a=load(source,x*2,y*2),b=load(source,x*2+1,y*2),c=load(source,x*2,y*2+1),d=load(source,x*2+1,y*2+1);
  return a.map((value,k)=>(value+b[k]!+c[k]!+d[k]!)*.25);
}
/** Independent full texture reference; every intermediate store is rounded to rgba16float. */
export function webBloomTextureReference(source:BloomTextureImage,options:BloomTextureFixture["web"]):BloomTextureImage {
  const levels:BloomTextureImage[]=[];
  let previous=source;
  for(let index=0;index<options.maxLevels;index++){
    const input=previous,width=Math.max(1,Math.ceil(input.width/2)),height=Math.max(1,Math.ceil(input.height/2));
    previous=image(width,height,(x,y)=>{
      const rgb=box(input,x,y).slice(0,3);return [...(index===0?extract(rgb,options.threshold,options.softKnee,false):rgb),1];
    });
    levels.push(previous);if(width===1&&height===1)break;
  }
  const blurred=levels.map(level=>{
    const blur=(input:BloomTextureImage,horizontal:boolean)=>image(input.width,input.height,(x,y)=>{
      const rgb=[0,0,0];for(let tap=-2;tap<=2;tap++){
        const pixel=load(input,x+(horizontal?tap:0),y+(horizontal?0:tap)),weight=[.0625,.25,.375,.25,.0625][tap+2]!;
        for(let k=0;k<3;k++)rgb[k]!+=pixel[k]!*weight;
      }return [...rgb,1];
    });
    return blur(blur(level,true),false);
  });
  let combined=blurred.at(-1)!;
  for(let index=blurred.length-2;index>=0;index--){
    const high=blurred[index]!,low=combined;
    combined=image(high.width,high.height,(x,y)=>{
      const a=load(high,x,y),b=linear(low,(x+.5)/high.width,(y+.5)/high.height);return [0,1,2].map(k=>(a[k]!+b[k]!)*.5).concat(1);
    });
  }
  return image(source.width,source.height,(x,y)=>{
    const original=load(source,x,y),glow=linear(combined,(x+.5)/source.width,(y+.5)/source.height);
    return original.slice(0,3).map((v,k)=>v+glow[k]!*options.intensity).concat(original[3]!);
  });
}
export function nativeBloomTextureReference(source:BloomTextureImage,options:BloomTextureFixture["native"],roundComposite=true):{
  blurred:BloomTextureImage;display:BloomTextureImage;linearComposite:BloomTextureImage
}{
  const width=Math.max(1,Math.ceil(source.width/2)),height=Math.max(1,Math.ceil(source.height/2));
  const prefilter=image(width,height,(x,y)=>{
    const rgb=[0,0,0];for(const dx of [-.25,.25])for(const dy of [-.25,.25]){
      const sample=linear(source,(x+.5)/width+dx/source.width,(y+.5)/height+dy/source.height);
      for(let k=0;k<3;k++)rgb[k]!+=Math.max(sample[k]!,0)*.25;
    }return [...extract(rgb,options.threshold,options.softKnee,true),1];
  });
  const blur=(input:BloomTextureImage,horizontal:boolean)=>image(width,height,(x,y)=>{
    const rgb=[0,0,0];for(const [offset,weight] of [[0,.227027],[1.384615,.316216],[-1.384615,.316216],[3.230769,.070270],[-3.230769,.070270]]){
      const du=horizontal?offset!*options.radius/width:0,dv=horizontal?0:offset!*options.radius/height;
      const p=linear(input,(x+.5)/width+du,(y+.5)/height+dv);
      for(let k=0;k<3;k++)rgb[k]!+=Math.max(p[k]!,0)*weight!;
    }return [...rgb,1];
  });
  const blurred=blur(blur(prefilter,true),false);
  // Native composite is not an intermediate texture store. Round only the real display target.
  const compositeAt=(x:number,y:number)=>{
    const original=load(source,x,y),glow=linear(blurred,(x+.5)/source.width,(y+.5)/source.height);
    return original.slice(0,3).map((v,k)=>v+glow[k]!*options.intensity).concat(original[3]!);
  };
  const display=image(source.width,source.height,(x,y)=>{
    const hdr=compositeAt(x,y);return hdr.slice(0,3).map(v=>{
      const a=Math.max(0,Math.min(1,v*(2.51*v+.03)/(v*(2.43*v+.59)+.14)));
      return a<=.0031308?a*12.92:1.055*Math.pow(a,1/2.4)-.055;
    }).concat(hdr[3]!);
  });
  return {blurred,display,linearComposite:image(source.width,source.height,compositeAt,roundComposite)};
}
