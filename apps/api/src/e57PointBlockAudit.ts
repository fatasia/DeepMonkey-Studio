import {createReadStream} from "node:fs";
import {lstat,readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";

const columns=["sourceIndex","x","y","z","redRaw","greenRaw","blueRaw","intensityRaw","colorValid","intensityValid","coordinateInvalidState"];
function check(condition:unknown,message:string):asserts condition {if(!condition)throw new Error(`E57 中间产物无效：${message}`);}
export async function hashE57File(file:string,signal?:AbortSignal){
  const digest=createHash("sha256");let bytes=0;
  for await(const chunk of createReadStream(file)){signal?.throwIfAborted();digest.update(chunk);bytes+=chunk.length;check(bytes<=1024**3,"文件预算");}
  return {sha256:digest.digest("hex"),bytes};
}

/** 资格中间产物审计；不是产品 PointCloudManifest，也不授予 ready。 */
export async function auditE57PointBlocks(directory:string,signal?:AbortSignal){
  const metadata=path.join(directory,"manifest.json"),file=path.join(directory,"points.ndjson");
  for(const [target,budget] of [[metadata,4*1024**2],[file,1024**3]] as const){
    const info=await lstat(target);check(info.isFile()&&!info.isSymbolicLink()&&info.size<=budget,"文件类型或预算");
  }
  const manifest=JSON.parse(await readFile(metadata,"utf8"));
  check(manifest.schemaVersion===2&&manifest.coordinateSpace==="world-meters"&&manifest.poseApplied===true&&manifest.crs===null,"坐标合同");
  check(typeof manifest.sourceGuid==="string"&&typeof manifest.coordinateMetadata==="string"&&manifest.coordinateMetadata.length<=65536,"源坐标元数据");
  check(manifest.pointFile==="points.ndjson"&&JSON.stringify(manifest.pointColumns)===JSON.stringify(columns),"点列合同");
  check(Array.isArray(manifest.scans)&&manifest.scans.length<=4096,"scan 数量");
  const counts:number[]=[],scans:Array<{points:number}>=manifest.scans;
  for(const [index,scan] of scans.entries()){
    const record=scan as typeof scan&{index:unknown;pose:{rotationWxyz:unknown;translationMeters:unknown};sourceGuid:unknown;name:unknown;colorLimits:unknown;intensityLimits:unknown};
    check(record.index===index&&Number.isSafeInteger(scan.points)&&scan.points>=0,"scan 身份");counts.push(0);
    check(typeof record.sourceGuid==="string"&&typeof record.name==="string","scan 源身份");
    const finiteArray=(value:unknown,size:number):value is number[]=>Array.isArray(value)&&value.length===size&&value.every(item=>typeof item==="number"&&Number.isFinite(item));
    const pose=record.pose;check(pose&&finiteArray(pose.rotationWxyz,4)&&finiteArray(pose.translationMeters,3),"scan 姿态");
    check(Math.abs(pose.rotationWxyz.reduce((sum,value)=>sum+value*value,0)-1)<=1e-10,"scan 单位四元数");
    const range=(value:unknown)=>finiteArray(value,2)&&value[0]!<=value[1]!;
    check(Array.isArray(record.colorLimits)&&record.colorLimits.length===3&&record.colorLimits.every(range)&&range(record.intensityLimits),"属性范围");
  }
  let total=0,valid=0,invalid=0,bytes=0,blocks=0,carry="",previousScan=-1;
  const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity],digest=createHash("sha256");
  const consume=(line:string)=>{
    check(line.length<=2*1024**2,"单块预算");const block=JSON.parse(line);
    check(Number.isSafeInteger(block.scan)&&block.scan>=previousScan&&block.scan>=0&&block.scan<scans.length,"scan 顺序");previousScan=block.scan;
    check(Array.isArray(block.points)&&block.points.length>0&&block.points.length<=4096,"点块预算");blocks++;
    for(const point of block.points){
      check(Array.isArray(point)&&point.length===11&&point[0]===counts[block.scan],"源点序号");counts[block.scan]!++;total++;
      check([0,1,2].includes(point[10]),"坐标无效状态");
      if(point[10]===0){
        check(point.slice(1,4).every((value:unknown)=>typeof value==="number"&&Number.isFinite(value)),"有限世界坐标");valid++;
        for(let axis=0;axis<3;axis++){low[axis]=Math.min(low[axis]!,point[axis+1]);high[axis]=Math.max(high[axis]!,point[axis+1]);}
      }else{check(point.slice(1,4).every((value:unknown)=>value===null),"无效点不得伪造坐标");invalid++;}
      check(point.slice(4,7).every((value:unknown)=>value===null||(typeof value==="number"&&Number.isInteger(value)&&value>=0&&value<=65535)),"原始 RGB");
      check(typeof point[8]==="boolean"&&typeof point[9]==="boolean","属性有效性");
      if(point[8])check(point.slice(4,7).every((value:unknown)=>value!==null),"有效 RGB 缺失");
      check(point[9]?typeof point[7]==="number"&&Number.isFinite(point[7]):point[7]===null,"强度有效性");
      check(total<=100_000_000,"点数预算");
    }
  };
  for await(const chunk of createReadStream(file)){
    signal?.throwIfAborted();digest.update(chunk);bytes+=chunk.length;check(bytes<=1024**3,"点文件预算");
    carry+=chunk.toString("utf8");let end:number;
    while((end=carry.indexOf("\n"))>=0){consume(carry.slice(0,end));carry=carry.slice(end+1);}
    check(carry.length<=2*1024**2,"未结束块预算");
  }
  check(carry==="","截断点块");check(scans.every((scan,index)=>scan.points===counts[index]),"scan 点数");
  check(manifest.points===total&&manifest.validPoints===valid&&manifest.invalidPoints===invalid,"点数回执");
  check(JSON.stringify(manifest.worldBounds)===JSON.stringify(valid?[low,high]:null),"世界包围盒");
  return {manifest,blocks,points:total,validPoints:valid,invalidPoints:invalid,pointFile:{sha256:digest.digest("hex"),bytes},manifestFile:await hashE57File(metadata,signal)};
}
