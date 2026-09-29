/// <reference types="@webgpu/types" />
// C2 基准 probe 着色 WGSL(探针内部消费,非引擎表面):视空间白墙全屏两腿——
// 逐灯腿(每像素扫全部灯,经典 forward 基线)与集群腿(光心剔除输出列表)。
// BRDF/衰减与 clusterLightingPbrWgsl.deepClusterPointContribution 同式(decay=2 恒定),
// 簇索引与 deepClusterIndex 同式;CPU 镜像在 clusterLightCullingProbeScene.ts 逐式对拍。

/** 与 clusterAbiWgsl.ts v2 逐字同构(80B)。 */
export const PROBE_SHADING_WGSL = /* wgsl */ `
struct ClusterParamsAbi {
  grid0: vec4<u32>,
  grid1: vec4<u32>,
  limits: vec4<u32>,
  projection: vec4<f32>,
  area: vec4<u32>,
};
struct ClusterHeaderAbi { offset: u32, count: u32 };
struct ShadeUniform { envRadiance: f32, unused: u32, viewport: vec2<u32> };

@group(0) @binding(0) var<storage, read> shadeParams: ClusterParamsAbi;
@group(0) @binding(1) var<storage, read> shadeLights: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> shadeHeaders: array<ClusterHeaderAbi>;
@group(0) @binding(3) var<storage, read> shadeIndices: array<u32>;
@group(0) @binding(4) var<uniform> shadeUniform: ShadeUniform;

fn probeRangeAttenuation(distanceSquared: f32, range: f32) -> f32 {
  let falloff = 1.0 / max(pow(max(sqrt(distanceSquared), 0.00000001), 2.0), 0.01);
  if (range == 0.0) { return falloff; }
  if (distanceSquared >= range * range) { return 0.0; }
  let ratioSquared = distanceSquared / max(range * range, 0.0001);
  let window = max(1.0 - ratioSquared * ratioSquared, 0.0);
  return window * window / max(distanceSquared, 0.01);
}

fn probeSafeNormalize(value: vec3f, fallback: vec3f) -> vec3f {
  let lengthSquared = dot(value, value);
  return select(fallback, value * inverseSqrt(max(lengthSquared, 0.00000001)), lengthSquared > 0.00000001);
}

fn probeBrdf(baseColor: vec3f, normal: vec3f, view: vec3f, surfaceToLight: vec3f, radiance: vec3f) -> vec3f {
  let nDotL = clamp(dot(normal, surfaceToLight), 0.0, 1.0);
  if (nDotL <= 0.0) { return vec3f(0.0); }
  let halfVector = probeSafeNormalize(view + surfaceToLight, normal);
  let nDotV = clamp(dot(normal, view), 0.0001, 1.0);
  let nDotH = clamp(dot(normal, halfVector), 0.0, 1.0);
  let vDotH = clamp(dot(view, halfVector), 0.0, 1.0);
  let f0 = vec3f(0.04);
  let fresnel = f0 * (1.0 - exp2((-5.55473 * vDotH - 6.98316) * vDotH)) + exp2((-5.55473 * vDotH - 6.98316) * vDotH);
  let roughness = 1.0; let alpha = roughness * roughness; let alpha2 = alpha * alpha;
  let denominator = nDotH * nDotH * (alpha2 - 1.0) + 1.0;
  let distribution = alpha2 / max(3.141592653589793 * denominator * denominator, 0.000001);
  let gv = nDotL * sqrt(alpha2 + (1.0 - alpha2) * nDotV * nDotV);
  let gl = nDotV * sqrt(alpha2 + (1.0 - alpha2) * nDotL * nDotL);
  let visibility = 0.5 / max(gv + gl, 0.000001);
  let diffuse = baseColor / 3.141592653589793;
  return (diffuse + distribution * visibility * fresnel) * radiance * nDotL;
}

fn probePointShade(lightIndex: u32, positionView: vec3f, normal: vec3f, view: vec3f) -> vec3f {
  let light = shadeLights[lightIndex];
  let toLight = light.xyz - positionView;
  let distanceSquared = dot(toLight, toLight);
  let attenuation = probeRangeAttenuation(distanceSquared, light.w);
  if (attenuation <= 0.0) { return vec3f(0.0); }
  let radiance = 2.0 * attenuation; // intensity 2 折入辐射度(clusterPacking 同口径,无额外面片项)。
  // 暖/冷交替色 × intensity 2(seededLights 合同:index 偶=暖 1,0.82,0.6;奇=冷 0.55,0.75,1)。
  var color = vec3f(0.55, 0.75, 1.0);
  if (lightIndex % 2u == 0u) { color = vec3f(1.0, 0.82, 0.6); }
  let surfaceToLight = probeSafeNormalize(toLight, normal);
  return probeBrdf(vec3f(1.0), normal, view, surfaceToLight, color * radiance);
}

fn probeSurface(fragCoord: vec2f) -> vec3f {
  let viewport = vec2f(shadeUniform.viewport);
  let depth = 8.0;
  let ndc = (fragCoord / viewport) * 2.0 - vec2f(1.0);
  let tanHalfFovY = shadeParams.projection.z;
  let tanHalfFovX = tanHalfFovY * shadeParams.projection.w;
  // 片元 y 向下,视空间 +Y 朝上:与 clusterIndexFor 的 tile 约定一致。
  return vec3f(ndc.x * tanHalfFovX * depth, -ndc.y * tanHalfFovY * depth, -depth);
}

fn clusterIndexFor(fragCoord: vec2f, depth: f32) -> u32 {
  let clusterCount = shadeParams.limits.y;
  let viewport = shadeParams.grid0.xy;
  if (!(fragCoord.x >= 0.0 && fragCoord.y >= 0.0 && fragCoord.x < f32(viewport.x) && fragCoord.y < f32(viewport.y)
    && depth >= shadeParams.projection.x && depth <= shadeParams.projection.y)) { return clusterCount; }
  let tileX = min(shadeParams.grid1.x - 1u, u32(floor(fragCoord.x)) / shadeParams.grid0.z);
  let tileY = min(shadeParams.grid1.y - 1u, u32(floor(fragCoord.y)) / shadeParams.grid0.w);
  let normalizedDepth = log(depth / shadeParams.projection.x) / log(shadeParams.projection.y / shadeParams.projection.x);
  let slice = min(shadeParams.grid1.z - 1u, u32(floor(normalizedDepth * f32(shadeParams.grid1.z))));
  return slice * shadeParams.grid1.x * shadeParams.grid1.y + tileY * shadeParams.grid1.x + tileX;
}

@vertex fn probeVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[index], 0.0, 1.0);
}

fn shadePerLightAt(fragCoord: vec2f) -> vec3f {
  let positionView = probeSurface(fragCoord);
  let normal = vec3f(0.0, 0.0, 1.0);
  let view = probeSafeNormalize(-positionView, normal);
  var sum = vec3f(0.0);
  for (var lightIndex = 0u; lightIndex < shadeParams.grid1.w; lightIndex++) {
    sum += probePointShade(lightIndex, positionView, normal, view);
  }
  return vec3f(shadeUniform.envRadiance) + sum;
}

@fragment fn shadePerLight(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  return vec4f(shadePerLightAt(frag.xy), 1.0);
}

fn shadeClusteredAt(fragCoord: vec2f) -> vec3f {
  let positionView = probeSurface(fragCoord);
  let normal = vec3f(0.0, 0.0, 1.0);
  let view = probeSafeNormalize(-positionView, normal);
  var sum = vec3f(0.0);
  let cluster = clusterIndexFor(fragCoord, -positionView.z);
  if (cluster < shadeParams.limits.y) {
    let header = shadeHeaders[cluster];
    let count = min(header.count, shadeParams.limits.x);
    for (var slot = 0u; slot < count; slot++) {
      sum += probePointShade(shadeIndices[header.offset + slot], positionView, normal, view);
    }
  }
  return vec3f(shadeUniform.envRadiance) + sum;
}

@fragment fn shadeClustered(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  return vec4f(shadeClusteredAt(frag.xy), 1.0);
}

fn reinhard(color: vec3f) -> vec3f { return color / (vec3f(1.0) + color); }

@fragment fn displayPerLight(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  return vec4f(reinhard(shadePerLightAt(frag.xy)), 1.0);
}

@fragment fn displayClustered(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  return vec4f(reinhard(shadeClusteredAt(frag.xy)), 1.0);
}

`;
