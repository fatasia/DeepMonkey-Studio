use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::{
    chart::ChartIR,
    contract::{ContractSummary, RenderPacket},
    deep2d::Deep2dRuntimeContent,
    ibl::PreparedIblEnvironment,
    shader_package::DeepShaderPackageV2,
};

pub(super) fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimeContentHash {
    pub algorithm: String,
    pub value: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeResourceKind {
    RenderPacket,
    Deep2dRuntime,
    IblEnvironment,
    ShaderPackage,
    SceneCamera,
    ChartRuntime,
    ChartSimRuntime,
    DashboardRuntime,
    ExperimentalX,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimeResourceIndexEntry {
    pub id: String,
    pub kind: RuntimeResourceKind,
    pub revision: u64,
    pub content_hash: RuntimeContentHash,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimeEntrypoints {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub experimental_x: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<String>,
    pub render_packet: String,
    #[serde(deserialize_with = "required_nullable")]
    pub deep2d: Option<String>,
    pub environment: String,
    pub shader_packages: Vec<String>,
    /// v4 起进入 chart 时代:键必须声明,chart 必须非空,chartSim 可空。
    #[serde(default)]
    pub chart: Option<String>,
    #[serde(default)]
    pub chart_sim: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dashboard: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct RuntimePackageEnvelope {
    pub schema: String,
    pub schema_version: u32,
    pub package_id: String,
    pub package_version: String,
    pub entrypoints: RuntimeEntrypoints,
    pub resources: Vec<RuntimeResourceIndexEntry>,
    pub payloads: BTreeMap<String, Value>,
    pub package_hash: RuntimeContentHash,
    #[serde(default)]
    pub material_bindings: Vec<RuntimeMaterialShaderBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimeMaterialShaderBinding {
    pub material_id: String,
    pub package_id: String,
    pub technique_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IblReferenceKind {
    BuiltinDefault,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct IblEnvironmentReferenceV1 {
    pub schema: String,
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    pub kind: IblReferenceKind,
}

#[derive(Debug)]
pub struct LoadedRuntimePackage {
    pub dashboard: Option<super::LoadedDashboard>,
    pub camera: Option<crate::runtime_camera::RuntimeSceneCamera>,
    pub package_id: String,
    pub package_version: String,
    pub package_hash: String,
    pub resource_index: Vec<RuntimeResourceIndexEntry>,
    pub render_packet: RenderPacket,
    pub render_summary: ContractSummary,
    pub deep2d: Option<Deep2dRuntimeContent>,
    pub chart: Option<ChartIR>,
    pub chart_sim: Option<crate::chart::simulation::ChartSimFixture>,
    pub environment: PreparedIblEnvironment,
    pub shader_packages: Vec<DeepShaderPackageV2>,
    pub material_bindings: Vec<RuntimeMaterialShaderBinding>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimePackageSummary {
    pub resources: usize,
    pub geometries: usize,
    pub materials: usize,
    pub instances: usize,
    pub textures: usize,
    pub triangles: usize,
    pub has_deep2d: bool,
    pub has_chart: bool,
    pub shader_packages: usize,
}

impl LoadedRuntimePackage {
    pub fn summary(&self) -> RuntimePackageSummary {
        RuntimePackageSummary {
            resources: self.resource_index.len(),
            geometries: self.render_summary.geometries,
            materials: self.render_summary.materials,
            instances: self.render_summary.instances,
            textures: self.render_summary.textures,
            triangles: self.render_summary.triangles,
            has_deep2d: self.deep2d.is_some(),
            has_chart: self.chart.is_some(),
            shader_packages: self.shader_packages.len(),
        }
    }
}
