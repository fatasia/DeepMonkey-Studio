// Brief-GI M2 探针 SH 更新核(2026-10-04):天光可见度加权天空 + 静态 1 bounce 能量哨兵
// + 时域滤波 α。每 lane = 更新窗口内的一个探针,独立读写自己的 96B 记录行。
//
// CPU 权威镜像:gi/probeShUpdate.ts updateProbeShWithSdfGi(同式同序;真机 GPU 若 FMA
// 融合,差异走容差对拍,A3 布料先例口径)。f32 记录行布局与 probeClipmapSampling 的
// 96B IrradianceProbeRecord ABI 逐字对齐(vec4[6]/探针):
//   vec4[0] = (irradiance.rgb, validity)   —— 本核写(vec4[0].rgb 更新,validity 透传)
//   vec4[1] = (meanDistance, variance, occlusionFloor, 0) —— 本核只写 .z = c0
//   vec4[2] = (positionOffset.rgb, 0)      —— 宿主烘焙时写入,本核不动
//   vec4[3..5] = F5 words[12..23] RGB L1 SH 方向可见度 —— **本核绝不写**(F5 合同)。
//
// 确定性合同(与 sdfSkyVisibilityTrace.wgsl 同族):
// - 每 lane 只读自己的可见度切片与记录行:无跨 lane 通信、无 workgroup 内存、无原子,
//   同输入同 dispatch 逐位回放;
// - 方向循环固定步数(params.directionCount,无 early-break),分支与时序无关;
// - 埋入探针(validity==0)早退 = 记录原样透传(泄露哨兵,与 CPU 域一致:墙内探针
//   不被天光场复活);可见度由宿主合同保证 ∈[0,1]、天空辐射有限(烘焙/采样合同),
//   本核不产出也不传播 NaN。
//
// 时域滤波与白炉稳定性(CPU 域同款):out = prev + (target − prev)·α;稳态(prev ≡ target)
// 在任意 α 下逐位不动,滤波器自身不注入能量或闪烁。

struct ProbeUpdateParams {
  probeCount: u32,
  directionCount: u32,
  /** 本帧更新窗口的循环起点((已派发窗口数 × 预算) mod probeCount,宿主单源推进)。 */
  windowOffset: u32,
  /** 本帧更新窗口大小(min(ddgiUpdateBudget, probeCount),预算分摊的帧内切片)。 */
  windowCount: u32,
  /** 时域滤波系数 ∈(0,1](CPU resolveDeepGiTemporalAlpha 解析后下发)。 */
  alpha: f32,
  /** 静态 1 bounce 开关(0/1;缺省关)。 */
  bounceEnabled: u32,
  /** 96B 记录 ABI 的 vec4 步长(=6;漂移即 ABI 破坏,与打包侧互钉)。 */
  recordVec4Stride: u32,
  /** bounce 能量哨兵上限(×2.01 = ρ≤1 物理上界 ×2 +1% 余量,与 CPU 同值)。 */
  bounceEnergyLimit: f32,
  /** bounce 均匀反照率(rgb ∈[0,1];w 保留对齐)。 */
  bounceAlbedo: vec4f,
};

@group(0) @binding(0) var<uniform> params: ProbeUpdateParams;
// 每 (探针 × 方向) 天光可见度 ∈[0,1](sdfSkyVisibilityTrace.wgsl 的输出,下标
// = probe × directionCount + direction)。
@group(0) @binding(1) var<storage, read> visibilities: array<f32>;
// 每方向天空辐射(线性 RGB;xyz 有效、w 恒 0,宿主逐帧写)。
@group(0) @binding(2) var<storage, read> skyRadiance: array<vec4f>;
// 探针记录存储(vec4[6]/探针,96B IrradianceProbeRecord ABI)。
@group(0) @binding(3) var<storage, read_write> records: array<vec4f>;

@compute @workgroup_size(64)
fn sdfGiProbeUpdateMain(@builtin(global_invocation_id) gid: vec3u) {
  let slot = gid.x;
  if (slot >= params.windowCount) { return; }
  let probe = (params.windowOffset + slot) % params.probeCount;
  let base = probe * params.recordVec4Stride;
  let current = records[base];
  // 埋入探针:不更新,整行原样透传(泄露哨兵)。
  if (current.w == 0.0) { return; }
  let count = params.directionCount;
  let first = probe * count;
  // 目标场:可见度加权的方向天空均值(Σ vis·sky / N;顺序累加,与 CPU 同式同序)。
  var r = 0.0;
  var g = 0.0;
  var b = 0.0;
  var c0 = 0.0;
  for (var d = 0u; d < count; d = d + 1u) {
    let v = visibilities[first + d];
    c0 = c0 + v;
    let sky = skyRadiance[d].xyz;
    r = r + v * sky.x;
    g = g + v * sky.y;
    b = b + v * sky.z;
  }
  let n = f32(count);
  // `target` 是 WGSL 保留字,目标场命名 targetField(与 CPU 域的 target 语义同物)。
  let targetField = vec3f(r / n, g / n, b / n);
  var finalTarget = targetField;
  if (params.bounceEnabled == 1u) {
    let albedo = params.bounceAlbedo.xyz;
    let bounced = vec3f(targetField.x * (1.0 + albedo.x),
      targetField.y * (1.0 + albedo.y), targetField.z * (1.0 + albedo.z));
    // 能量哨兵:|bounced| ≤ |target|×limit 才放行;超限 fail-closed 回基线。
    if (length(bounced) <= length(targetField) * params.bounceEnergyLimit) {
      finalTarget = bounced;
    }
  }
  // 时域滤波:out = prev + (target − prev)·α(与 CPU 逐式一致)。
  let blended = current.xyz + (finalTarget - current.xyz) * params.alpha;
  records[base] = vec4f(blended, current.w);
  // occlusionFloor = 当前帧可见度均值 c0(未滤波,与 CPU probeSkyVisibilitySh 投影一致);
  // vec4[1].xy(meanDistance/variance)保持宿主烘焙初值,本核不动。
  records[base + 1u] = vec4f(records[base + 1u].xy, c0 / n, 0.0);
}
