use deep_engine_native::{
    contract::RenderPacket,
    deep2d::{Deep2dRuntimeContent, prepare_runtime_content},
    ibl::{PreparedIblEnvironment, builtin_default_environment},
    runtime_package::{LoadedRuntimePackage, RuntimeMaterialShaderBinding},
    shader_package::DeepShaderPackageV2,
};

/// 保留作者数据用于设备恢复；IBL 来自已验证的包入口，而非渲染器隐式替换。
pub struct PlayerContent {
    packet: RenderPacket,
    scene_content_key: u64,
    pub deep2d: Option<Deep2dRuntimeContent>,
    pub environment: PreparedIblEnvironment,
    pub shader_packages: Vec<DeepShaderPackageV2>,
    pub material_bindings: Vec<RuntimeMaterialShaderBinding>,
}

impl PlayerContent {
    pub fn from_packet(packet: RenderPacket, deep2d: Option<Deep2dRuntimeContent>) -> Self {
        let scene_content_key = crate::player_shader_plan::scene_content_key(&packet);
        Self {
            packet,
            scene_content_key,
            deep2d,
            environment: builtin_default_environment(),
            shader_packages: Vec::new(),
            material_bindings: Vec::new(),
        }
    }

    pub fn from_package(package: LoadedRuntimePackage) -> Result<Self, String> {
        let scene_content_key =
            crate::player_shader_plan::scene_content_key(&package.render_packet);
        let content = Self {
            packet: package.render_packet,
            scene_content_key,
            deep2d: package.deep2d,
            environment: package.environment,
            shader_packages: package.shader_packages,
            material_bindings: package.material_bindings,
        };
        // 包通过结构/哈希校验后，仍需在创建窗口前核对实际执行支持。
        crate::player_shader_plan::plan_shader_materials(
            &content.packet,
            &content.shader_packages,
            &content.material_bindings,
        )?;
        if let Some(deep2d) = &content.deep2d {
            prepare_runtime_content(deep2d)
                .map_err(|error| format!("runtime package Deep2d entry cannot execute: {error}"))?;
        }
        Ok(content)
    }

    pub fn packet(&self) -> &RenderPacket {
        &self.packet
    }

    pub fn scene_content_key(&self) -> u64 {
        self.scene_content_key
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub fn mutate_packet_for_test(&mut self, update: impl FnOnce(&mut RenderPacket)) {
        update(&mut self.packet);
        self.scene_content_key = crate::player_shader_plan::scene_content_key(&self.packet);
    }
}
