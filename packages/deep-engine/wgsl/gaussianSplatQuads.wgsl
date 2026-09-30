// I 级 C1 3DGS 实景扫描——instanced quad splatting 最小渲染路径(WGSL 单源)。
// ABI:group0 binding0 uniform(SplatFrameParams,176B,列主序)+ binding1
// storage array<vec4f>(64B/粒 records,布局与 CPU 解码产物逐字一致,直传)。
// 排序在 CPU 完成(far→near instance 序),本文件只做 EWA 协方差投影与
// 高斯片元;深度测试 on / 深度写入 off,premultiplied alpha 混合。
// 真机渲染未测量:本切片在无 GPU 会话环境产出,语法未经 naga/Dawn 实编译。

struct SplatFrameParams {
  viewMatrix : mat4x4f,
  viewProjection : mat4x4f,
  // xyz = 世界系相机位置,w = padding。
  cameraPosition : vec4f,
  // xy = 视口像素,zw = 焦距像素(fx, fy)。
  viewportFocal : vec4f,
  // x = splatCount, y = alphaCutoff, z = covariancePadPx², w = padding。
  controls : vec4f,
}

@group(0) @binding(0) var<uniform> frame : SplatFrameParams;
@group(0) @binding(1) var<storage, read> splats : array<vec4f>;

// 与 CPU 端 SPLAT_RECORD_FLOAT_STRIDE=16(4×vec4f)互钉。
const RECORD_VEC4_STRIDE = 4u;
const TAU_OVER_SQUARED_EXTENT = 2.0; // quad 半径 2σ ⇒ exp(-2·d²)

struct SplatVertexOutput {
  @builtin(position) position : vec4f,
  // premultiplied rgb + a。
  @location(0) colorAlpha : vec4f,
  // quad 内坐标,单位 σ,范围 [-2,2]²。
  @location(1) quadOffset : vec2f,
}

fn quaternionToMatrix3(q : vec4f) -> mat3x3f {
  let nq = normalize(q);
  let x = nq.x;
  let y = nq.y;
  let z = nq.z;
  let w = nq.w;
  // 列主序,标准 xyzw 旋转矩阵(与 canonical 3DGS 光栅化器同构)。
  return mat3x3f(
    vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y)),
    vec3f(2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x)),
    vec3f(2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y)),
  );
}

@vertex
fn vsMain(
  @builtin(vertex_index) cornerIndex : u32,
  @builtin(instance_index) instanceIndex : u32,
) -> SplatVertexOutput {
  let base = instanceIndex * RECORD_VEC4_STRIDE;
  let positionOpacity = splats[base];
  let scale = splats[base + 1u].xyz;
  let rotation = splats[base + 2u];
  let colorAlpha = splats[base + 3u];

  // var 而非 let:WGSL 值类型数组禁止运行期下标,var(内存)允许。
  var corners = array<vec2f, 4>(
    vec2f(-2.0, -2.0), vec2f(2.0, -2.0), vec2f(2.0, 2.0), vec2f(-2.0, 2.0));
  let corner = corners[cornerIndex];

  let worldPosition = positionOpacity.xyz;
  let viewPosition = frame.viewMatrix * vec4f(worldPosition, 1.0);
  let clip = frame.viewProjection * vec4f(worldPosition, 1.0);

  // 近平面守卫:中心在近平面之后(或恰在)时透视 Jacobian 发散,
  // 塌缩为退化顶点丢弃该粒(canonical 3DGS 同为 t.z>ε 才投影)。
  var output : SplatVertexOutput;
  if (viewPosition.z >= -0.1) {
    output.position = vec4f(0.0, 0.0, 2.0, 1.0); // z=w → 裁剪域外
    output.colorAlpha = vec4f(0.0);
    output.quadOffset = vec2f(0.0);
    return output;
  }

  // Σ = M·Mᵀ,M = R·S(R 为旋转,S 为对角尺度)。
  let r = quaternionToMatrix3(rotation);
  let m = mat3x3f(r[0] * scale.x, r[1] * scale.y, r[2] * scale.z);

  // 透视 Jacobian J(列主序),t = 视空间位置。
  let t = viewPosition.xyz;
  let invZ = 1.0 / t.z;
  let invZ2 = invZ * invZ;
  let fx = frame.viewportFocal.z;
  let fy = frame.viewportFocal.w;
  let jacobian = mat3x3f(
    vec3f(fx * invZ, 0.0, 0.0),
    vec3f(0.0, fy * invZ, 0.0),
    vec3f(-fx * t.x * invZ2, -fy * t.y * invZ2, 0.0),
  );

  // 视空间旋转 W3(view 矩阵左上 3×3,列主序)。
  let viewRotation = mat3x3f(frame.viewMatrix[0].xyz, frame.viewMatrix[1].xyz, frame.viewMatrix[2].xyz);
  // V = J·W·M ⇒ Σ2d = V·Vᵀ(2×2)。
  let v = jacobian * viewRotation * m;
  let sigma11 = dot(v[0].xy, v[0].xy);
  let sigma12 = dot(v[0].xy, v[1].xy);
  let sigma22 = dot(v[1].xy, v[1].xy);

  // 低通补偿(canonical 0.3 px²)后取特征分解。
  let a = sigma11 + frame.controls.z;
  let c = sigma22 + frame.controls.z;
  let b = sigma12;
  let mid = 0.5 * (a + c);
  let determinant = a * c - b * b;
  let root = sqrt(max(mid * mid - determinant, 0.0));
  let lambdaMajor = mid + root;
  let lambdaMinor = max(mid - root, 0.1);

  // 对称 2×2 的主轴方向;b≈0 时退化为轴对齐。
  var axisMajor = vec2f(1.0, 0.0);
  var axisMinor = vec2f(0.0, 1.0);
  if (abs(b) > 1e-9) {
    axisMajor = normalize(vec2f(lambdaMajor - c, b));
    axisMinor = vec2f(-axisMajor.y, axisMajor.x);
  } else if (a < c) {
    axisMajor = vec2f(0.0, 1.0);
    axisMinor = vec2f(1.0, 0.0);
  }

  let halfViewport = 0.5 * frame.viewportFocal.xy;
  let centerNdc = clip.xy / clip.w;
  let offsetPixels =
    axisMajor * sqrt(lambdaMajor) * corner.x + axisMinor * sqrt(lambdaMinor) * corner.y;
  let positionNdc = centerNdc + offsetPixels / halfViewport;

  output.position = vec4f(positionNdc * clip.w, clip.z, clip.w);
  output.colorAlpha = colorAlpha;
  output.quadOffset = corner;
  return output;
}

@fragment
fn fsMain(input : SplatVertexOutput) -> @location(0) vec4f {
  let squaredDistance = dot(input.quadOffset, input.quadOffset);
  let alpha = input.colorAlpha.a * exp(-TAU_OVER_SQUARED_EXTENT * squaredDistance);
  if (alpha < frame.controls.y) {
    discard;
  }
  // premultiplied alpha:blend(one, one-minus-src-alpha),depth write off。
  return vec4f(input.colorAlpha.rgb * alpha, alpha);
}
