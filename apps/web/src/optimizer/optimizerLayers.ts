import type {Document,Node} from "@gltf-transform/core";
import {optimizerIO} from "./modelOptimizerIO";
import {readDocument,statistics,type ModelFileStatistics} from "./modelOptimizer";

export interface OptimizerLayer {id:number;stableId?:string;name:string;depth:number;parentId?:number;hidden:boolean;ownHidden?:boolean;deleted:boolean;mesh:boolean}
export type OptimizerLayerEdit = {id:number;action:"rename";name:string}|{id:number;action:"hidden";hidden:boolean}|{id:number;action:"delete"};
export interface OptimizerLayerResult {binary:Uint8Array<ArrayBuffer>;layers:OptimizerLayer[];statistics:ModelFileStatistics}
interface VisibilityMetadata {id:string;hidden?:boolean;parent?:string;scene?:number}
const visibilityKey="studioOptimizerLayer";
function metadata(node:Node):VisibilityMetadata|undefined{
  const value=node.getExtras()[visibilityKey];
  return value&&typeof value==="object"&&"id" in value&&typeof value.id==="string"?value as VisibilityMetadata:undefined;
}

/** 每次从未修改的输入重放；节点索引属于输入文档，不依赖 Three.js 临时 UUID。 */
export function editOptimizerDocument(document:Document,edits:readonly OptimizerLayerEdit[]):OptimizerLayer[] {
  const root=document.getRoot(),nodes=root.listNodes(),ids=new Map(nodes.map((node,id)=>[node,id]));
  const deleted=new Set<Node>(),hidden=new Map<Node,boolean>();
  const stableIds=new Map<string,Node>();
  for(const [index,node] of nodes.entries()){
    const saved=metadata(node)??{id:`layer-${index}`};
    node.setExtras({...node.getExtras(),[visibilityKey]:saved});stableIds.set(saved.id,node);
  }
  // 导出的隐藏节点仍保留几何和原始父级；重新打开可恢复，而不是只能单向删除。
  for(const node of nodes){
    const saved=metadata(node)!;if(!saved.hidden)continue;hidden.set(node,true);
    if(saved.parent){const parent=stableIds.get(saved.parent);if(parent&&parent!==node)parent.addChild(node);}
    else if(saved.scene!==undefined)root.listScenes()[saved.scene]?.addChild(node);
  }
  for(const edit of edits){
    const node=nodes[edit.id];if(!node)throw new Error("图层已不存在，请重新载入模型");
    if(edit.action==="rename"){
      const name=edit.name.trim();if(!name||name.length>120)throw new Error("图层名称需为 1–120 个字符");
      node.setName(name);
    }else if(edit.action==="hidden")hidden.set(node,edit.hidden);
    else node.traverse(child=>deleted.add(child));
  }
  const layers:OptimizerLayer[]=[];
  const seen=new Set<Node>();
  function visit(node:Node,depth:number,parentId?:number,inheritedHidden=false,inheritedDeleted=false){
    if(seen.has(node))return;seen.add(node);
    const id=ids.get(node)!;
    const isHidden=inheritedHidden||hidden.get(node)===true,isDeleted=inheritedDeleted||deleted.has(node);
    layers.push({id,stableId:metadata(node)!.id,name:node.getName()||`图层 ${id+1}`,depth,...(parentId===undefined?{}:{parentId}),hidden:isHidden,ownHidden:hidden.get(node)===true,deleted:isDeleted,mesh:Boolean(node.getMesh())});
    for(const child of node.listChildren())visit(child,depth+1,id,isHidden,isDeleted);
  }
  for(const scene of root.listScenes())for(const node of scene.listChildren())visit(node,0);
  for(const node of nodes)if(!seen.has(node))visit(node,0);
  // 隐藏从活动场景图分离，保留节点本身供文件内存储；下次重放可显示。
  for(const [node,isHidden] of hidden){
    const saved=metadata(node)!;
    if(!isHidden){node.setExtras({...node.getExtras(),[visibilityKey]:{id:saved.id}});continue;}
    if(deleted.has(node))continue;
    for(const parent of node.listParents())if(parent.propertyType==="Node"||parent.propertyType==="Scene"){
      node.setExtras({...node.getExtras(),[visibilityKey]:{id:saved.id,hidden:true,...(parent.propertyType==="Node"?{parent:metadata(parent as Node)!.id}:{scene:root.listScenes().indexOf(parent as never)})}});
      (parent as Node).removeChild(node);
    }
  }
  // dispose 会同时清除动画、蒙皮和父级引用；共享 mesh/material 仍保留给其他实例。
  for(const node of deleted)node.dispose();
  return layers;
}

export async function editOptimizerFile(file:File,edits:readonly OptimizerLayerEdit[]):Promise<OptimizerLayerResult>{
  const io=await optimizerIO(),document=await readDocument(io,file);
  const layers=editOptimizerDocument(document,edits);
  const binary=await io.writeBinary(document) as Uint8Array<ArrayBuffer>;
  return {binary,layers,statistics:statistics(document,binary.byteLength)};
}
