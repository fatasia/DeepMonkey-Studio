import {supportedExtensions} from "@bim-studio/contracts";
export function optimizerInputFormats(hasProject:boolean,available:readonly string[]=[]):string[]{
  const formats=new Set<string>(["glb","gltf"]);
  if(hasProject)for(const format of available)if(supportedExtensions.includes(format as typeof supportedExtensions[number]))formats.add(format);
  return [...formats];
}
