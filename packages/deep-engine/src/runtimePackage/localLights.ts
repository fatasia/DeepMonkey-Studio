import { array, fields, record, requireValue } from "./primitives.js";
import { validateLightIes } from "./lightProfiles.js";
export function validateLocalLights(value: unknown, path: string, shadows = false, pointShadows = false): void {
  const lights = array(value, path, 16);
  requireValue(lights.length > 0, path, "Local-light list must not be empty.");
  let shadowCount = 0;
  let pointCount = 0;
  for (const [lightIndex, value] of lights.entries()) {
    const light = record(value, path);
    fields(light, ["kind","position","direction","radiance","range","decay","innerCos","outerCos"], shadows ? ["castShadow","ies","groundRadiance","shadowSoftness"] : ["ies","groundRadiance","shadowSoftness"], path);
    requireValue(light.castShadow === undefined || typeof light.castShadow === "boolean",path,"Invalid shadow flag.");
    if (light.ies !== undefined) validateLightIes(light.ies, `${path}[${lightIndex}].ies`);
    const vector = (value: unknown, min: number, max: number): number[] => {
      const v = array(value,path,3);
      requireValue(v.length === 3 && v.every(c => typeof c === "number" && Number.isFinite(c) && c >= min && c <= max),path,"Invalid local-light vector.");
      return v as number[];
    };
    vector(light.position,-1e6,1e6); vector(light.radiance,0,256);
    requireValue(light.kind === "hemisphere" ? light.groundRadiance !== undefined : light.groundRadiance === undefined,path,"Ground radiance requires a hemisphere light.");
    if (light.groundRadiance !== undefined) vector(light.groundRadiance,0,256);
    requireValue(light.ies === undefined || light.kind === "spot",path,"IES requires a spot light.");
    const direction=vector(light.direction,-1,1);
    const scalar=(v:unknown,min:number,max:number):v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
    requireValue(light.shadowSoftness === undefined || (light.kind === "spot" && scalar(light.shadowSoftness,0,1)),path,"Invalid spot shadow softness.");
    requireValue(["directional","point","spot","hemisphere"].includes(String(light.kind))
      && Math.abs(direction.reduce((sum,v)=>sum+v*v,0)-1)<.0001
      && scalar(light.range,0,1e6) && scalar(light.decay,0,4) && scalar(light.outerCos,-1,1)
      && scalar(light.innerCos,light.outerCos,1),path,"Invalid local-light profile.");
    if (light.castShadow) {
      if (light.kind === "point") pointCount++; else shadowCount++;
      requireValue(((pointShadows && light.kind === "point") || (light.kind === "spot" && (light.outerCos as number) > .001 && (light.outerCos as number) < .999999))
        && (light.range === 0 || (light.range as number) > .0001),path,"Unsupported shadow cone or range.");
    }
  }
  requireValue(!shadows || (shadowCount+pointCount > 0 && shadowCount <= 4 && pointCount <= 1
    && (pointShadows ? pointCount === 1 : pointCount === 0)),path,"Local shadow budget exceeded or empty.");
}
