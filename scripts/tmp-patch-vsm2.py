import io

NL = chr(92) + "n"
p = "packages/deep-engine/src/webgpu/pbrDirectDisplayBodyWgsl.ts"
s = io.open(p, encoding="utf-8").read()
old = ("fn deepPrimaryShadow(world: vec3f, normal: vec3f, nDotL: f32, authorShadow: vec4f, pixel: vec2f, flags: f32) -> f32 {" + NL +
  "  // B1 Brief-VSM(AA-M1 联调修复):三环梯度必须在任何非一致分支(flags 随片元变化)之前预取," + NL +
  "  // 否则 fwidth 违反 uniform control flow;梯度以参数传给 deepVirtualShadow。" + NL +
  "  var grad0 = vec2f(0.0); var grad1 = vec2f(0.0); var grad2 = vec2f(0.0);" + NL +
  "  { let clip0 = deepCascade.matrices[0] * vec4f(world, 1.0); grad0 = fwidth(clip0.xy / max(clip0.w, 0.000001));" + NL +
  "    let clip1 = deepCascade.matrices[1] * vec4f(world, 1.0); grad1 = fwidth(clip1.xy / max(clip1.w, 0.000001));" + NL +
  "    let clip2 = deepCascade.matrices[2] * vec4f(world, 1.0); grad2 = fwidth(clip2.xy / max(clip2.w, 0.000001)); }" + NL +
  "  if (frame.background.w <= 0.0 || flag(flags, 16u)) { return 1.0; }")
new = ("fn deepPrimaryShadow(world: vec3f, normal: vec3f, nDotL: f32, authorShadow: vec4f, pixel: vec2f, flags: f32) -> f32 {" + NL +
  "  if (frame.background.w <= 0.0 || flag(flags, 16u)) { return 1.0; }")
assert s.count(old) == 1, "prefetch block not found"
s = s.replace(old, new)
old2 = "if (deepCascade.params2.x > 0.5) { return deepVirtualShadow(world, normal, nDotL, pixel, grad0, grad1, grad2); }"
new2 = "if (deepCascade.params2.x > 0.5) { return deepVirtualShadow(world, normal, nDotL, pixel); }"
assert s.count(old2) == 1
s = s.replace(old2, new2)
io.open(p, "w", encoding="utf-8", newline=NL.replace("\\", "")).write(s)
print("dispatch restored to 4-arg, prefetch removed")

p2 = "packages/deep-engine/src/webgpu/virtualShadowSampling.ts"
s2 = io.open(p2, encoding="utf-8").read()
old3 = """fn deepVirtualShadow(world: vec3f, normal: vec3f, nDotL: f32, pixel: vec2f,
  grad0: vec2f, grad1: vec2f, grad2: vec2f) -> f32 {
  // 环梯度由调用方在一致控制流内预取后传入(fwidth 合法性:调用链在进入本函数前
  // 不能穿越非一致分支;环回退链本身是发散控制流,禁止在链内取导数)。
  let rings = deepVsmRingCount();
  let slopeBias = 1.0 - clamp(nDotL, 0.0, 1.0);"""
new3 = """fn deepVirtualShadow(world: vec3f, normal: vec3f, nDotL: f32, pixel: vec2f) -> f32 {
  // AA-M1 联调(2026-10-04):片元调用链存在非一致分支(材质采样结果/flags),fwidth
  // 无法在函数内合法取得(整链非一致)。mip 选择退化为常数 0 + 既有 miss→mip+1 回退链
  // (结果仍正确,远距离环多取几级页查找;梯度化 mip 选择待片元入口统一预取后恢复,
  // 见 docs/specs/antialiasing-master-plan-20261003.md AA-M1 落地记录)。
  let rings = deepVsmRingCount();
  let slopeBias = 1.0 - clamp(nDotL, 0.0, 1.0);"""
assert s2.count(old3) == 1, "signature block not found"
s2 = s2.replace(old3, new3)
old4 = """  let pixelsPerVirtualTexel = max(max(px.x, px.y), 0.000001) * deepCascade.texelWorld0.w;
  let desired = clamp(u32(ceil(log2(pixelsPerVirtualTexel))), 0u, deepVsmTopMip());"""
new4 = """  let desired = 0u;"""
assert s2.count(old4) == 1, "desired-mip block not found"
s2 = s2.replace(old4, new4)
io.open(p2, "w", encoding="utf-8", newline="\n").write(s2)
print("library made derivative-free")

p3 = "packages/deep-engine/src/webgpu/virtualShadowSampling.test.ts"
s3 = io.open(p3, encoding="utf-8").read()
old5 = 'expect(gate).toContain("if (deepCascade.params2.x > 0.5) { return deepVirtualShadow(world, normal, nDotL, pixel, grad0, grad1, grad2); }");'
new5 = 'expect(gate).toContain("if (deepCascade.params2.x > 0.5) { return deepVirtualShadow(world, normal, nDotL, pixel); }");'
assert s3.count(old5) == 1, "test call pin not found"
s3 = s3.replace(old5, new5)
io.open(p3, "w", encoding="utf-8", newline="\n").write(s3)
print("test call pin restored")
