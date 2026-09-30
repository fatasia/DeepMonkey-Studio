# C8 Native 几何粗糙度生产消费

复用已有canonical几何粗糙度，使Native普通/RT材质使用未扰动法线的屏幕导数；不改变帧ABI、材质贴图和`.045`底限。

## 现状核查

1. src/assets/tests及未跟踪文件已查：Native普通与RT仅clamp材质roughness，canonical `deepGeometryRoughness`已在正式组合shader中，但未被消费；Web正式shade及directDisplay已消费。
2. 类型：Native Frame.view是VP，PlayerView为已有perspective相机；FrameObservation已有实际normal MRT（RGB world normal、alpha effective roughness）。无须新增worldToView字段或新附件。
3. 依赖：现有wgpu、serde_json、pollster与readback helper足够；不新增依赖或LUT资源。
4. 消费：frame_data_with_camera从PlayerView.basis写VP行，rowW含forward；shadow_camera已从同帧恢复up/forward。普通与RT各有oriented_normal和mapped_normal，必须以未扰动oriented_normal计算geometryrough。
5. 测试：gpu_lod_views_tests已有pitch poles、focal、near/far的真实帧测试；j3_normal_attachments已有正式FrameObservation附件，原golden平面85点应保持原rough。本叶复用正式helper，补smooth-normal曲面等效平面与贴图控制。
6. 规格：读C8 S5/S8/S9、Native local/DFG规格与root锁。合法backend导数差异不在此逐像素追踪；本门验证Native消费与相机语义，生产及Cargo/GPU由root负责。

**已有（不重建）**：canonical数学、VP、法线/TBN、实际MRT和绘制/readback。**真实缺口**：Native未使用geometryrough，直接乘VP会带入projection/aspect/jitter缩放。

## 预注册

恢复forward=normalize(VP rowW.xyz)，right=normalize(rowX.xyz-forward*dot(rowX.xyz,forward))，up=normalize(cross(right,forward))，view normal=(dot(right,g),dot(up,g),-dot(forward,g))。rowX减去forward分量兼容projection jitter；rowY只作独立CPU一致性控制。范围仅当前Native perspective PlayerView，无正交/任意非刚性camera扩展。

CPU使用真实frame_data_with_camera与PlayerView.basis作独立oracle：yaw/pitch（含两pole）、translatedtarget、宽高比、focal、near/far、显式投影jitter；basis及view-normal误差≤2e-6。raw VP处理必须在非单位projection条件下违反该门，作为有价值负例。

GPU两fresh设备，128²实际normal附件。已知平面z0、方形[-1.4,1.4]²，顶点normal=normalize((.8*x,.8*y,1))；相机axis eye(0,0,4)、默认focal、rough=.08。等长四角法线的透视插值解析可计算，两三角形延拓出同一法线场。采用内部矩形像素[24,104)²（6400点）避开轮廓；每点expected几何导数取该像素所在2×2quad所有合法行/列差分的min/max，alpha须在`.08+expected`区间±2/255，且至少1000点alpha高于`.08+1/255`。此区间接受WGSL默认fine/coarse选择，阈值不随实测改。

同geometry的flat-normal控制alpha须为`.08`±1/255；smooth开启constant normal map后alpha附件逐字相同、真实RGB法线至少1000内部点改变。HDR读回必须全部有限、至少1000内部点有任意RGB>.03，正常和capture默认路径一致；normal MRT只作可选观测，不新增pipeline。旧证据开始前删除，完整两fresh通过才生成成功收据，记录实际packet/package/生产shader身份。

不认证RT硬件、跨backend导数逐像素相等或Studio画质。生产rough为min(1,clamp(material*MR.g,.045,1)+canonical geometryrough)，保留所有材质旗标/贴图/曝光/直射/IBL语义。

上述预注册在任何GPU运行前冻结，实测未改阈值/相机/粗糙度。

root首轮CPU：真实相机basis比较通过，fixture被正式合同拒绝（smooth normal与固定X tangent不正交）。GPU前改为每顶点将X投影到N的正交平面后归一，w=1；smooth/map两份使用相同tangent。保留正式validate_packet，几何/法线场、相机、rough与所有门不变。日志 `test-output/interrupted-0930/c8-native-geometry-cpu.log`。

## 实际结果

root修后CPU fixture过滤器 `native_geometry_fixture_preserves_unperturbed_smooth_normals` 实际1PASS，日志 `test-output/interrupted-0930/c8-native-geometry-fixture-after.log`；前述basis过滤器实际1PASS。C8线路只写叶和审核，不运行Cargo/GPU。

root执行实际GPU过滤器 `c8_actual_native_geometry_roughness`（`--ignored --nocapture`），1PASS/8.16s，日志 `test-output/interrupted-0930/c8-native-geometry-gpu.log`。两fresh、12真实生产帧通过，normal capture对默认HDR逐字无影响，所有附件有限、两设备结果逐字稳定。

| 实际128²附件 | 内部点数 | rough正贡献 | RGB法线变化 | 最大区间误差 | HDR有效覆盖 |
|---|---:|---:|---:|---:|---:|
| smooth | 6400 | 6400 | 独立解析法线通过 | .00203481281455889 | 6400 |
| flat | 6400 | 0 | 独立+Z法线通过 | .00156862745098039 | 6400 |
| mapped | 6400 | 6400 | 相对smooth改变6400点，alpha逐字相同 | .00203481281455889 | 6160 |

误差门保持smooth/map `2/255`、flat `1/255`。证据 `test-output/interrupted-0930/c8-native-geometry-roughness/evidence.json`，正式组合shader SHA `761fae5294c3a33fb7ba32b0674fcc545e9cd5e57d933ca454f7022f5e211618`，收据同时记录装载包文件SHA与真实变更packet JSON SHA。RT硬件、Web/Native导数逐像素相等和Studio视觉仍不在此门认证范围。

复现：`cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --test gpu_shader_material_draw c8_actual_native_geometry_roughness -- --ignored --nocapture`。GPU资源排队与释放由root管理。
