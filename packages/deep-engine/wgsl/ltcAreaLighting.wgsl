// C3 矩形/带纹理面积光(LTC)GPU 单源。绑定声明留宿主模板(web: FORWARD_PLUS_PBR
// 模板 group3/binding13 storage + binding14/15 cookie 纹理;native 不走运行时通路)。
// 常量与 TS 打包端(areaLights.ts/ltc.ts)逐字互钉,漂移由
// ltcAreaLightingWgslChecksum.test.ts 与 lighting_math_wgsl.rs 双半夹具同时抓红。
//
// 数学出处(公开领域,自实现):Heitz/Hanika/d'Eon/Dachsbacher, "Real-Time
// Polygonal-Light Shading with Linearly Transformed Cosines", JCGT/SIGGRAPH 2016。
// 漫反射 = 未变换矩形的 atan2 向量形式因子;高光 = invM(LUT) 变换矩形角点 +
// **同一 atan2 内核** × 拟合幅值(无 π 常数:拟合目标 ∫GGX·cos dω 不含 π,幅值闭式
// 最小二乘已吸收尺度;交付再加 π = 恒定 −68% 系统性欠亮,MC 对拍实测定案)。
// 内核定案过程与包络质量证据见 docs/reports/I级-C3-矩形带纹理面积光LTC-20260929.md(§数学)。

const DEEP_AREA_LIGHT_MAX: u32 = 64u;
const DEEP_AREA_LIGHT_STRIDE: u32 = 6u;
const DEEP_AREA_LIGHT_LUT_SIZE: u32 = 64u;
const DEEP_AREA_LIGHT_LUT_VEC4S: u32 = 8192u;
const DEEP_AREA_LIGHT_LUT_BASE: u32 = DEEP_AREA_LIGHT_MAX * DEEP_AREA_LIGHT_STRIDE;
const DEEP_AREA_LIGHT_ROUGHNESS_FLOOR: f32 = 0.045;
const DEEP_AREA_LIGHT_FLAG_TWO_SIDED: u32 = 1u;
const DEEP_AREA_LIGHT_FLAG_TEXTURE: u32 = 2u;
const DEEP_AREA_LIGHT_PI: f32 = 3.141592653589793;

// 唯一交付内核:球面多边形余弦形式因子(单位顶点、有序环;拟合端 ltc.ts rectFormFactor
// 同式同值)。作用于未变换矩形 = 漫反射精确形式因子;作用于 invM 变换矩形 = LTC 高光。
fn deepAreaPolygonFormFactor(v0: vec3f, v1: vec3f, v2: vec3f, v3: vec3f) -> f32 {
  var total = 0.0;
  let corners = array<vec3f, 4>(v0, v1, v2, v3);
  for (var index = 0u; index < 4u; index++) {
    let current = corners[index];
    let next = corners[(index + 1u) % 4u];
    let crossed = cross(current, next);
    let magnitude = length(crossed);
    if (magnitude < 0.0000001) { continue; }
    let cosine = clamp(dot(current, next), -1.0, 1.0);
    total += crossed.z * (atan2(magnitude, 1.0 + cosine) / magnitude);
  }
  return total;
}

fn deepAreaSafeNormalize(value: vec3f, fallback: vec3f) -> vec3f {
  let lengthSquared = dot(value, value);
  return select(fallback, value * inverseSqrt(max(lengthSquared, 0.00000001)), lengthSquared > 0.00000001);
}

// LUT 采样:texel 8 f32 = invM row0(3)+pad + row1(3)+amplitude(.w);row2 ≡ (0,0,1)。
// x=cosθ 列、y=感知粗糙度行(域 [0.045,1] 与拟合端同映射),双线性(与 CPU sampleLtcLut 同式:
// x 向先混左右两列,再 y 向混上下两行;末行/末列钳位取最后 texel,不越界)。
fn deepAreaLtcTransform(cosTheta: f32, roughness: f32) -> array<vec2f, 8> {
  let lookup = clamp(vec2f(cosTheta,
    (clamp(roughness, DEEP_AREA_LIGHT_ROUGHNESS_FLOOR, 1.0) - DEEP_AREA_LIGHT_ROUGHNESS_FLOOR)
      / (1.0 - DEEP_AREA_LIGHT_ROUGHNESS_FLOOR)), vec2f(0.0), vec2f(1.0)) * f32(DEEP_AREA_LIGHT_LUT_SIZE - 1u);
  let base = floor(lookup);
  let fraction = lookup - base;
  let column = u32(base.x);
  let row = u32(base.y) * DEEP_AREA_LIGHT_LUT_SIZE;
  let columnNext = min(column + 1u, DEEP_AREA_LIGHT_LUT_SIZE - 1u);
  let rowNext = min(row + DEEP_AREA_LIGHT_LUT_SIZE, DEEP_AREA_LIGHT_LUT_SIZE * (DEEP_AREA_LIGHT_LUT_SIZE - 1u));
  // texel 直取(WGSL 无函数类型值,不能写 let 闭包——真机 Tint 编译抓红后定案为内联)。
  // 每 texel 两个 vec4:vec4[2t]=(row0.xyz, invM[1][1]≡0),vec4[2t+1]=(row1.y, row1.z, 0, amplitude)
  // (打包序 packTexel:floats[0..2]=row0,[3]=invM[3]=row1.x,[4..5]=row1.yz,[7]=amplitude)。
  // B2 MegaLights M1 真机对拍(2026-10-04)抓出的潜在缺陷修复:原实现 row1 取
  // blended[3..5]——[4][5] 是 vec4 越界读(恒 0),row1=(0,0,0),GPU 面积光高光的
  // 副切向缩放 r 自 C3 起即为死。现 row1 从第 2 个 vec4 的 xyz 双线性。
  let texelA = deepAreaLightData[DEEP_AREA_LIGHT_LUT_BASE + (row + column) * 2u];
  let texelB = deepAreaLightData[DEEP_AREA_LIGHT_LUT_BASE + (row + columnNext) * 2u];
  let texelC = deepAreaLightData[DEEP_AREA_LIGHT_LUT_BASE + (rowNext + column) * 2u];
  let texelD = deepAreaLightData[DEEP_AREA_LIGHT_LUT_BASE + (rowNext + columnNext) * 2u];
  let top = mix(texelA, texelB, vec4f(fraction.x));
  let bottom = mix(texelC, texelD, vec4f(fraction.x));
  let blended = mix(top, bottom, vec4f(fraction.y));
  let texelA2 = deepAreaLightData[DEEP_AREA_LIGHT_LUT_BASE + (row + column) * 2u + 1u];
  let texelB2 = deepAreaLightData[DEEP_AREA_LIGHT_LUT_BASE + (row + columnNext) * 2u + 1u];
  let texelC2 = deepAreaLightData[DEEP_AREA_LIGHT_LUT_BASE + (rowNext + column) * 2u + 1u];
  let texelD2 = deepAreaLightData[DEEP_AREA_LIGHT_LUT_BASE + (rowNext + columnNext) * 2u + 1u];
  let top2 = mix(texelA2, texelB2, vec4f(fraction.x));
  let bottom2 = mix(texelC2, texelD2, vec4f(fraction.x));
  let blended2 = mix(top2, bottom2, vec4f(fraction.y));
  // 行语义与 CPU sampleLtcLut 逐字同构:row0 = floats[0..2] = vec4[2t].xyz;
  // row1 = floats[4..6] = vec4[2t+1].xyz;amplitude = floats[7] = vec4[2t+1].w。
  var matrixRows = array<vec2f, 8>();
  for (var component = 0u; component < 3u; component++) {
    matrixRows[component] = vec2f(0.0, blended[component]);
  }
  for (var component = 0u; component < 3u; component++) {
    matrixRows[3u + component] = vec2f(0.0, blended2[component]);
  }
  matrixRows[6] = vec2f(0.0, blended2.w);
  matrixRows[7] = vec2f(0.0, 0.0);
  return matrixRows;
}

// 单盏面光贡献。cookie 由宿主按 deepAreaLightCookieUv 采样后传入(缺省 vec3(1))。
// 返回线性 HDR(漫反射+高光),未含阴影/遮挡。
fn deepAreaLightContribution(base: u32, positionView: vec3f, normalView: vec3f, view: vec3f,
  baseColor: vec3f, metallic: f32, roughness: f32, dielectric: f32, cookie: vec3f) -> vec3f {
  let positionRange = deepAreaLightData[base];
  let normalDecay = deepAreaLightData[base + 1u];
  let upFlags = deepAreaLightData[base + 2u];
  let extentsScale = deepAreaLightData[base + 3u];
  let uvWindow = deepAreaLightData[base + 4u];
  let radiance = deepAreaLightData[base + 5u].xyz;
  let flags = u32(upFlags.w);
  let lightNormal = deepAreaSafeNormalize(normalDecay.xyz, vec3f(0.0, 0.0, 1.0));
  let lightUp = deepAreaSafeNormalize(upFlags.xyz, vec3f(0.0, 1.0, 0.0));
  let toSurface = positionView - positionRange.xyz;
  let facing = dot(toSurface, lightNormal);
  if ((flags & DEEP_AREA_LIGHT_FLAG_TWO_SIDED) == 0u && facing < 0.0) { return vec3f(0.0); }
  if (positionRange.w > 0.0 && length(toSurface) > positionRange.w) { return vec3f(0.0); }
  // 着色法线切向系,x 轴 = 视线的切平面投影(与拟合帧同方位角;经典 LTC 交付口径)。
  let surfaceNormal = deepAreaSafeNormalize(normalView, vec3f(0.0, 0.0, 1.0));
  let viewDirection = deepAreaSafeNormalize(view, surfaceNormal);
  let viewDot = dot(viewDirection, surfaceNormal);
  let viewTangent = select(
    deepAreaSafeNormalize(cross(vec3f(0.0, 1.0, 0.0), surfaceNormal), vec3f(1.0, 0.0, 0.0)),
    deepAreaSafeNormalize(viewDirection - surfaceNormal * viewDot, vec3f(1.0, 0.0, 0.0)),
    viewDot < 0.9999);
  let bitangent = cross(surfaceNormal, viewTangent);
  let lightBitangent = cross(lightNormal, lightUp);
  let corners = array<vec3f, 4>(
    positionRange.xyz + lightUp * extentsScale.x + lightBitangent * extentsScale.y,
    positionRange.xyz - lightUp * extentsScale.x + lightBitangent * extentsScale.y,
    positionRange.xyz - lightUp * extentsScale.x - lightBitangent * extentsScale.y,
    positionRange.xyz + lightUp * extentsScale.x - lightBitangent * extentsScale.y);
  var local0 = vec3f(0.0);
  var local1 = vec3f(0.0);
  var local2 = vec3f(0.0);
  var local3 = vec3f(0.0);
  var centroid = vec3f(0.0);
  for (var index = 0u; index < 4u; index++) {
    let direction = deepAreaSafeNormalize(corners[index] - positionView, surfaceNormal);
    let local = vec3f(dot(direction, viewTangent), dot(direction, bitangent), dot(direction, surfaceNormal));
    if (index == 0u) { local0 = local; } else if (index == 1u) { local1 = local; }
    else if (index == 2u) { local2 = local; } else { local3 = local; }
    centroid += direction;
  }
  // 漫反射:精确向量形式因子(未变换),单面背面由绕序符号+前置 facing 兜底清零。
  let diffuseFactor = deepAreaPolygonFormFactor(local0, local1, local2, local3);
  let diffuseSigned = select(diffuseFactor, abs(diffuseFactor), (flags & DEEP_AREA_LIGHT_FLAG_TWO_SIDED) != 0u);
  let diffuse = max(baseColor, vec3f(0.0)) * (1.0 - metallic) * radiance * max(diffuseSigned, 0.0)
    / DEEP_AREA_LIGHT_PI * cookie;
  // 高光:invM 变换矩形 + 同一 atan2 内核 + 拟合幅值(无 /π,见文件头定案)+ Schlick(光心方向余弦)。
  // 边积分符号语义与 CPU 一致:单面钳非负(背面零),双面取模(两侧同亮)。
  let cosTheta = clamp(dot(surfaceNormal, deepAreaSafeNormalize(view, surfaceNormal)), 0.0, 1.0);
  let lut = deepAreaLtcTransform(cosTheta, roughness);
  let row0 = vec3f(lut[0].y, lut[1].y, lut[2].y);
  let row1 = vec3f(lut[3].y, lut[4].y, lut[5].y);
  let amplitude = lut[6].y;
  // B2 MegaLights M1 真机对拍(2026-10-04)交付缺陷修复:mat3x3f(...) 是**列构造**,
  // 原写法把行向量当列 → 交付矩阵 ≠ CPU ltc.ts(inverseMatrixFromRows)的数学矩阵
  // [[p,0,q],[0,r,0],[0,0,1]](高光逐灯偏差 0.6×~1.5×,能量比 0.35;且任何奇异/降秩
  // 变体都会把 mapped 角点压到过原点平面 → 多边形形式因子恒 0,高光整项消失)。
  // 数学矩阵按列展开:col0 = (p,0,0), col1 = (0,r,0), col2 = (q,0,1)。
  let transform = mat3x3f(vec3f(row0.x, 0.0, 0.0), vec3f(0.0, row1.y, 0.0), vec3f(row0.z, 0.0, 1.0));
  let mapped0 = deepAreaSafeNormalize(transform * local0, surfaceNormal);
  let mapped1 = deepAreaSafeNormalize(transform * local1, surfaceNormal);
  let mapped2 = deepAreaSafeNormalize(transform * local2, surfaceNormal);
  let mapped3 = deepAreaSafeNormalize(transform * local3, surfaceNormal);
  let specularFactor = deepAreaPolygonFormFactor(mapped0, mapped1, mapped2, mapped3);
  let centroidDirection = deepAreaSafeNormalize(centroid, surfaceNormal);
  let dominant = clamp(dot(surfaceNormal, centroidDirection), 0.0, 1.0);
  let f0 = mix(vec3f(dielectric), max(baseColor, vec3f(0.0)), metallic);
  let fresnel = f0 + (vec3f(1.0) - f0) * pow(1.0 - dominant, 5.0);
  let signedFactor = select(max(specularFactor, 0.0), abs(specularFactor), (flags & DEEP_AREA_LIGHT_FLAG_TWO_SIDED) != 0u);
  let specular = fresnel * (signedFactor * amplitude) * radiance * cookie;
  return diffuse + specular;
}

// 光斑 UV:切平面投影到 [0,1]²,再过每灯窗口(uvScale/uvOffset;默认恒等)。
fn deepAreaLightCookieUv(base: u32, positionView: vec3f) -> vec2f {
  let positionRange = deepAreaLightData[base];
  let normalDecay = deepAreaLightData[base + 1u];
  let upFlags = deepAreaLightData[base + 2u];
  let extentsScale = deepAreaLightData[base + 3u];
  let uvWindow = deepAreaLightData[base + 4u];
  let lightNormal = deepAreaSafeNormalize(normalDecay.xyz, vec3f(0.0, 0.0, 1.0));
  let lightUp = deepAreaSafeNormalize(upFlags.xyz, vec3f(0.0, 1.0, 0.0));
  let lightBitangent = cross(lightNormal, lightUp);
  let toSurface = positionView - positionRange.xyz;
  let u = dot(toSurface, lightUp) / (2.0 * extentsScale.x) + 0.5;
  let v = dot(toSurface, lightBitangent) / (2.0 * extentsScale.y) + 0.5;
  return vec2f(uvWindow.x, uvWindow.y) * vec2f(u, v) + vec2f(uvWindow.z, uvWindow.w);
}
