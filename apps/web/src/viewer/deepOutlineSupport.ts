import { DEEP_INSTANCE_OUTLINE_CAPABILITY } from "@bim-studio/deep-engine";

/** Deep(WebGPU)是否具备对象级描边;能力声明缺失(旧引擎包)即 false,保持 fail-closed 回落 WebGL。 */
export function deepSupportsObjectOutline(): boolean {
  return (DEEP_INSTANCE_OUTLINE_CAPABILITY as { objectOutline?: boolean } | undefined)?.objectOutline === true;
}
