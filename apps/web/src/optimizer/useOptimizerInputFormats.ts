import {useEffect,useState} from "react";
import type {ProjectRecord} from "@bim-studio/contracts";
import {api} from "../api";
import {optimizerInputFormats} from "./optimizerInputFormats";
export function useOptimizerInputFormats(project:ProjectRecord|undefined){
  const [available,setAvailable]=useState<string[]>([]);
  useEffect(()=>{let active=true;setAvailable([]);if(project)void api.getModelImportFormats(project.id).then(value=>{if(active)setAvailable(value);}).catch(()=>{});return()=>{active=false;};},[project?.id]);
  const formats=optimizerInputFormats(Boolean(project),available);
  return {formats,accept:formats.map(format=>`.${format}`).join(","),label:formats.map(format=>format.toUpperCase()).join(" / ")};
}
