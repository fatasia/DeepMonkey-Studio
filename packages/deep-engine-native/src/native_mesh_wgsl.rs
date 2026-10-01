//! The exact source used by production mesh modules and evidence identities.

pub fn native_mesh_shader_source() -> String {
    let mut source = concat!(
        include_str!("../assets/shaders/native_mesh_v1.wgsl"),
        "\n",
        include_str!("../assets/shaders/native_cascaded_shadow_v1.wgsl"),
        "\n",
        include_str!("../../deep-engine/wgsl/cascadedShadowMath.wgsl"),
        "\n",
        include_str!("../../deep-engine/wgsl/materialDielectric.wgsl"),
        // I-C23 分层混合核:与 Web 同一单源真文件(deepLayerBlend 函数库,
        // 纯函数、无入口,checksum 门与 TS 镜像共享)。
        include_str!("../../deep-engine/wgsl/materialLayerBlend.wgsl"),
        include_str!("../../deep-engine/wgsl/brdfDirectLighting.wgsl"),
        include_str!("../../deep-engine/wgsl/brdfDirectMultiscattering.wgsl"),
        // C8-S9 直射多散射 DFG r185 同源表(单一真源 packages/deep-engine/
        // src/webgpu/directDfgLut185.ts,Web pbrDirectMultiscatteringWgsl 消费
        // 同一常量)。文件本体是裸数组字面量 + deepDirectDfg185 采样函数,
        // 宿主在此补 var<private> 声明头(与 Web 模板的 `var<private> = ${数组};`
        // 拼接同构);checksum 门登记在 lighting_math_wgsl。
        concat!("var<private> DEEP_DIRECT_DFG_185 = ",
            include_str!("../../deep-engine/wgsl/directDfgLut185.wgsl"), "\n"),
        include_str!("../../deep-engine/wgsl/iesSampling.wgsl"),
        "\n",
    )
    .to_owned();
    source.push_str(&crate::probe_gi_wgsl::native_probe_sampling_wgsl());
    source
}

pub fn native_mesh_rt_shader_source() -> String {
    let mut source = String::from("enable wgpu_ray_query;\n");
    source.push_str(&native_mesh_shader_source());
    source.push('\n');
    source.push_str(include_str!(
        "../assets/shaders/native_mesh_rt_fragment_v1.wgsl"
    ));
    source
}
