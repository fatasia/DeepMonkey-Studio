import {useState} from "react";
import {ChevronRight,ChevronDown,Eye,EyeOff,Pencil,Trash2,Undo2,Redo2,Layers} from "lucide-react";
import {translate as tr,type AppLocale} from "../i18n";
import type {OptimizerLayer,OptimizerLayerEdit} from "../optimizer/optimizerLayers";
import { WindowedSceneRows } from "./WindowedSceneRows";
import "./OptimizerLayerTree.css";

export function OptimizerLayerTree({locale,layers,busy,onEdit,canUndo,canRedo,onUndo,onRedo,continuous,onContinuous}:{locale:AppLocale;layers:OptimizerLayer[];busy:boolean;onEdit:(edit:OptimizerLayerEdit)=>void;canUndo:boolean;canRedo:boolean;onUndo:()=>void;onRedo:()=>void;continuous?:boolean;onContinuous?:(enabled:boolean)=>void}){
  const [collapsed,setCollapsed]=useState<Set<number>>(new Set());
  const [renaming,setRenaming]=useState<number>();const [name,setName]=useState("");
  const byId=new Map(layers.map(layer=>[layer.id,layer]));
  const children=new Set(layers.flatMap(layer=>layer.parentId===undefined?[]:[layer.parentId]));
  const visible=layers.filter(layer=>{
    if(layer.deleted)return false;
    let parent=layer.parentId;
    while(parent!==undefined){if(collapsed.has(parent))return false;parent=byId.get(parent)?.parentId;}
    return true;
  });
  function rename(){if(renaming===undefined||!name.trim())return;onEdit({id:renaming,action:"rename",name});setRenaming(undefined);}
  return <section className="optimizer-layer-tree" aria-label={tr(locale,"模型图层","Model layers")}>
    <header><Layers size={15}/><strong>{tr(locale,"模型图层","Model layers")}</strong><span>{layers.filter(layer=>!layer.deleted).length}</span>
      <button title={tr(locale,"撤销图层修改","Undo layer edit")} aria-label={tr(locale,"撤销图层修改","Undo layer edit")} disabled={busy||!canUndo} onClick={onUndo}><Undo2 size={14}/></button>
      <button title={tr(locale,"重做图层修改","Redo layer edit")} aria-label={tr(locale,"重做图层修改","Redo layer edit")} disabled={busy||!canRedo} onClick={onRedo}><Redo2 size={14}/></button></header>
    {onContinuous&&<label className="optimizer-layer-continuous" title={tr(locale,"在当前工作区缓存模型，加快连续修改；闲置一分钟自动释放","Cache this model for repeated edits; released after one idle minute")}><input type="checkbox" checked={Boolean(continuous)} disabled={busy} onChange={event=>onContinuous(event.target.checked)}/>{tr(locale,"连续编辑加速","Accelerate layer edits")}</label>}
    <div role="tree" aria-label={tr(locale,"模型层级","Model hierarchy")} aria-busy={busy}>
      <WindowedSceneRows enabled={Boolean(continuous)} rowHeight={34} rows={visible.map(layer=>({key:String(layer.id),keepMounted:renaming===layer.id,render:()=><div key={layer.id} role="treeitem" aria-level={layer.depth+1} aria-expanded={children.has(layer.id)?!collapsed.has(layer.id):undefined} className={`optimizer-layer-row${layer.hidden?" is-hidden":""}`} style={{paddingLeft:8+Math.min(layer.depth,6)*12}}>
        <button className="optimizer-layer-row__expand" disabled={!children.has(layer.id)} aria-label={collapsed.has(layer.id)?tr(locale,"展开图层","Expand layer"):tr(locale,"收起图层","Collapse layer")} onClick={()=>setCollapsed(current=>{const next=new Set(current);if(next.has(layer.id))next.delete(layer.id);else next.add(layer.id);return next;})}>{children.has(layer.id)?collapsed.has(layer.id)?<ChevronRight size={13}/>:<ChevronDown size={13}/>:null}</button>
        {renaming===layer.id?<input autoFocus aria-label={tr(locale,"图层名称","Layer name")} value={name} maxLength={120} onChange={event=>setName(event.target.value)} onBlur={rename} onKeyDown={event=>{if(event.key==="Enter")rename();if(event.key==="Escape")setRenaming(undefined);}}/>:<span className="optimizer-layer-row__name" title={layer.name} onDoubleClick={()=>{setName(layer.name);setRenaming(layer.id);}}>{layer.name}</span>}
        <button disabled={busy} aria-label={`${tr(locale,"重命名","Rename")} ${layer.name}`} title={tr(locale,"重命名","Rename")} onClick={()=>{setName(layer.name);setRenaming(layer.id);}}><Pencil size={13}/></button>
        <button disabled={busy||(layer.parentId!==undefined&&byId.get(layer.parentId)?.hidden)} aria-label={`${layer.hidden?tr(locale,"显示","Show"):tr(locale,"隐藏","Hide")} ${layer.name}`} title={layer.hidden?tr(locale,"显示图层","Show layer"):tr(locale,"隐藏图层","Hide layer")} onClick={()=>onEdit({id:layer.id,action:"hidden",hidden:!layer.hidden})}>{layer.hidden?<EyeOff size={14}/>:<Eye size={14}/>}</button>
        <button disabled={busy} aria-label={`${tr(locale,"删除","Delete")} ${layer.name}`} title={tr(locale,"删除图层及子图层","Delete layer and children")} onClick={()=>onEdit({id:layer.id,action:"delete"})}><Trash2 size={13}/></button>
      </div>}))}/>
      {!visible.length&&<p>{tr(locale,"模型已清空，可撤销恢复","Model is empty; undo to restore")}</p>}
    </div>
  </section>;
}
