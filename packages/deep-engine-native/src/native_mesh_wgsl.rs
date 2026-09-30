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
        include_str!("../../deep-engine/wgsl/brdfDirectLighting.wgsl"),
        include_str!("../../deep-engine/wgsl/brdfDirectMultiscattering.wgsl"),
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
