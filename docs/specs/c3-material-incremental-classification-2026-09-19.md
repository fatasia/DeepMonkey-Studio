# C3 材质/纹理增量分类切片(2026-09-19)

状态:**真实生产接线完成并实测**——`MaterialUniformRefresh` 快路径已在
`stage_packet_with_environment` / `publish_render_packet_update` 全链路生效,
5000 材质场景单次 uv 更新 CPU 准备从 ~248.5ms 降至 ~27.4µs(证据见
`test-output/c3-material-fastpath-20260919-r1/evidence.json`)。

## 合同(切片一,保持)

- `renderer/material_resource_diff.rs`:
  - `Identical`
  - `UniformOnly { changed_indices }`
  - `Structural`
- 纹理槽位、normal-map feature、材质 id、材质数量变化全部归为 `Structural`,
  必须回退完整资源 staging;只有数值 uniform 变化进入 `UniformOnly` 候选。
- `prepare_material_uniform()` 纯函数:不解码纹理构造材质 uniform payload。

## ABI 事实(测试钉死,接线前提)

- native 材质 uniform(40 f32)**只含纹理变换块**(base/mr/ao/normal/emissive
  各 8 f32 + ao strength@23 + normal scale@31);base_color/metallic/roughness/
  alpha/emissive_factor/shading 打包在**实例缓冲词 24..36**
  (`scene_pack::pack_instance`),材质 uniform 分类对此不可见。
- 因此 `base_color/metallic` 变体不落本快路径:metallic-only 摄动的 prepared
  rows 全等 → `Identical` → 守卫回落全量路径(实例缓冲重建)。
- **同族漏洞封堵**:`instance_material_words_unchanged` 守卫拦截"实例词字段与
  uv 变换同帧变化"——否则只写 uniform 会静默丢掉实例词更新。

## 生产接线(本次)

- lib `pbr_texture::prepare_material_uniform_rows(packet)`:仅材质行 + 纹理索引
  解析,不解码纹理、不做全包校验;与 `prepare_pbr_resources().materials` 逐字段
  全等(测试断言);纹理引用解析失败返回 Err,由 stage 回落全量路径。
- stage(`scene_update_stage`):实例 diff 三分支重构。`Identical` 分支在
  几何/纹理 id+revision 全同 + 实例词全同 + `classify == UniformOnly` 时返回
  `MaterialUniformRefresh { rows, scene_content_key }`(rows 为 stage 侧生成的
  `(index, [f32; 40])` payload);TransformOnly 与材质分支互斥(transform 快路径
  的 materials 全等守卫不被材质变化穿透)。
- publish:`write_material_uniforms(rows)` 原位 `queue.write_buffer` →
  `set_scene_content_key` → `shadow_version.bump_scene()`(材质变化影响阴影
  呈现,保守失效)→ 遥测 `record_packet_prepare(0, write_ns)`。
- GPU 缓冲修复:接线时暴露 `Queue::write_buffer` 要求 **COPY_DST**——旧
  UNIFORM-only uniform 缓冲根本不可原位写(合同切片的隐藏缺陷);现 usage 为
  `UNIFORM | COPY_DST | COPY_SRC`(COPY_SRC 供读回验证)。
- 删除两个未接线脚手架(`material_contract_is_uniform_only` / `uniform_payload`),
  避免 classify+rows 路径之外的双源真相。

## 测试

- lib 429(+5)、bin 160(+4)全绿;基线 lib 424 / bin 156 保持。
- GPU 读回验证(真实适配器):写入后从显存逐字节断言 payload 落点、越界行被拒。
- Renderer 接线 GPU 测试(真实窗口,8 断言):refresh→publish→Noop→反向
  refresh→实例词守卫/transform 守卫/实例 Structural 三类回落全量→纹理引用缺失
  呈现错误。
- 既有 2 个材质分类测试保持;主会话未提交 shader 重构导致的
  bloom_contract(2)/cascaded_shadow(1) 文本合同漂移为既有红,与本切片无关。

## 实测(5000 材质带纹理 BIM 场景,`--smoke-telemetry-prepare-material`)

| 段(p50, 6 样本) | 全量路径(接线前) | 快路径(接线后) |
|---|---|---|
| packet_scene_update | 218.775 ms | 0(跳过整包 prepare) |
| packet_resource_upload | 29.702 ms | 0.0274 ms(单行 160B) |
| 单次材质更新合计 | ≈248.5 ms | ≈27.4 µs(≈9000x) |

- GPU submission scopes clean、0 validation error;6/6 帧呈现,无被拒 staging。
- 交叉校验:transform 摄动在新旧构建均为 scene_update=0(既有 transform-only
  快路径未回归,测量法可比)。

## 未关闭项

1. 实例词域(base_color/metallic/roughness/alpha/emissive_factor)的原位增量
   更新——需要实例词部分重打包切片(快路径守卫现回落全量,正确但不快);
2. 纹理 revision 变化的资源重用/重上传证据;
3. 材质快路径的 Web/Native 确定性和视觉回归;
4. 严格同摄动 A/B(接线前二进制不支持 uv 摄动;现基线的全量段工作量与摄动
   值无关,已如实记录)。

本切片宣称的性能收益以 evidence.json 的 6/6 实测样本为据,不再以合同准备
冒充生产路径。
