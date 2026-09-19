use deep_engine_native::{
    chart::ChartEpoch,
    contract::RenderPacket,
    deep2d::{Deep2dRuntimeContent, prepare_runtime_content},
    fog::FogSettings,
    ibl::{PreparedIblEnvironment, builtin_default_environment},
    runtime_package::{
        LoadedRuntimePackage, RuntimeMaterialShaderBinding, RuntimeResourceIndexEntry,
        runtime_content_sha256,
    },
    shader_package::DeepShaderPackageV2,
};
#[path = "player_content_chart_entry.rs"]
mod chart_entry;
#[cfg(test)]
#[path = "player_content_chart_package_tests.rs"]
mod chart_package_tests;
#[path = "player_chart_sim.rs"]
pub mod chart_sim;
#[cfg(test)]
#[path = "player_content_dashboard_tests.rs"]
mod dashboard_tests;
#[path = "player_resource_domain.rs"]
mod resource_domain;

/// 保留作者数据用于设备恢复；IBL 来自已验证的包入口，而非渲染器隐式替换。
pub struct PlayerContent {
    authored_view: Option<deep_engine_native::player_view::PlayerView>,
    authored_camera: Option<deep_engine_native::runtime_camera::RuntimeSceneCamera>,
    coordinate_frame: Option<deep_engine_native::runtime_coordinates::SceneLocalCoordinateFrame>,
    resource_domain: String,
    pub pending_lkg: Option<crate::runtime_lkg::Pending>,
    pub pending_x_lkg: Option<crate::runtime_lkg::Pending>,
    #[cfg(windows)]
    pub x_template: Option<std::sync::Arc<deep_engine_native::compat_x::XDynamicContent>>,
    pub pending_asset_lkg: Option<deep_engine_native::asset_package::recovery::Pending>,
    pub startup_notice: Option<String>,
    packet: RenderPacket,
    scene_content_key: u64,
    pub deep2d: Option<Deep2dRuntimeContent>,
    pub chart: Option<deep_engine_native::chart::ChartRuntime>,
    pub chart_text_scale: f64,
    pub dashboard: Option<deep_engine_native::dashboard_runtime::DashboardRuntime>,
    pub dashboard_started: Option<std::time::Instant>,
    pub epoch: ChartEpoch,
    pub chart_sim: Option<chart_sim::ChartSimHost>,
    pub environment: PreparedIblEnvironment,
    pub background: Option<[f64; 3]>,
    pub lighting: Option<deep_engine_native::scene_lighting::DirectionalLighting>,
    /// v7 作者雾（exp2）；渲染器装配时经 `for_content` 替换宿主雾档。
    pub fog: Option<FogSettings>,
    pub shader_packages: Vec<DeepShaderPackageV2>,
    pub material_bindings: Vec<RuntimeMaterialShaderBinding>,
    /// v7 动态场景通道。先随包进入 PlayerContent，供宿主 replay/交互层消费；
    /// 不在加载阶段把动画误降级成静态几何。
    #[allow(dead_code)]
    pub dynamic_runtime: Option<deep_engine_native::runtime_package::DynamicSceneRuntime>,
    runtime_package: Option<RuntimePackageSnapshot>,
}

#[cfg(test)]
#[path = "player_content_camera_tests.rs"]
mod camera_tests;

#[cfg(test)]
#[path = "player_content_dynamic_tests.rs"]
mod dynamic_tests;

/// One deterministic dynamic playback step: the sampled TRS channels were
/// applied to the packet instances and the canonical frame string is the
/// cross-end determinism contract shared with the Web consumer.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicPlaybackStep {
    pub time_ms: u64,
    pub canonical: String,
    pub replay_revisions: Vec<u64>,
    pub changed_instances: usize,
}

#[derive(Clone, Debug)]
pub struct RuntimePackageSnapshot {
    pub package_id: String,
    pub package_version: String,
    pub package_hash: String,
    pub resource_index: Vec<RuntimeResourceIndexEntry>,
}

impl RuntimePackageSnapshot {
    pub fn from_loaded(package: &LoadedRuntimePackage) -> Self {
        Self {
            package_id: package.package_id.clone(),
            package_version: package.package_version.clone(),
            package_hash: package.package_hash.clone(),
            resource_index: package.resource_index.clone(),
        }
    }
}

impl PlayerContent {
    pub fn from_chart(source: deep_engine_native::chart::ChartIR) -> Result<Self, String> {
        let chart = deep_engine_native::chart::ChartRuntime::new(source, 640.0, 360.0)?;
        let packet = RenderPacket {
            schema: deep_engine_native::contract::CONTRACT_SCHEMA.into(),
            version: 1,
            geometries: Vec::new(),
            materials: Vec::new(),
            instances: Vec::new(),
            textures: Vec::new(),
        };
        let mut rasterizer = deep_engine_native::platform_text::TextRasterizer::new();
        let list = deep_engine_native::chart::presentation::present_chart(
            &chart,
            &mut rasterizer,
            0,
            [0.0, 0.0],
            None,
        )?;
        let deep2d = Deep2dRuntimeContent::DisplayList(list);
        let document = ChartEpoch::document_revision(&chart.source().id, "chart"); // 无包来源以 chart id 为文档标识
        let mut content = Self::from_packet(packet, Some(deep2d));
        content.chart = Some(chart);
        content.epoch = ChartEpoch::for_document(document);
        Ok(content)
    }
    pub fn from_packet(packet: RenderPacket, deep2d: Option<Deep2dRuntimeContent>) -> Self {
        let scene_content_key = crate::player_shader_plan::scene_content_key(&packet);
        Self {
            resource_domain: "packet:default".into(),
            authored_view: None,
            authored_camera: None,
            coordinate_frame: None,
            packet,
            pending_lkg: None,
            pending_x_lkg: None,
            #[cfg(windows)]
            x_template: None,
            pending_asset_lkg: None,
            startup_notice: None,
            scene_content_key,
            deep2d,
            chart: None,
            chart_text_scale: 1.0,
            dashboard: None,
            dashboard_started: None,
            epoch: ChartEpoch::initial(),
            chart_sim: None,
            environment: builtin_default_environment(),
            background: None,
            lighting: None,
            fog: None,
            shader_packages: Vec::new(),
            material_bindings: Vec::new(),
            dynamic_runtime: None,
            runtime_package: None,
        }
    }

    pub fn from_package(package: LoadedRuntimePackage) -> Result<Self, String> {
        let runtime_package = Some(RuntimePackageSnapshot::from_loaded(&package));
        let scene_content_key =
            crate::player_shader_plan::scene_content_key(&package.render_packet);
        let LoadedRuntimePackage {
            camera,
            package_id,
            package_hash,
            render_packet,
            deep2d,
            chart: chart_source,
            chart_sim: chart_sim_fixture,
            dashboard,
            environment,
            background,
            lighting,
            fog,
            shader_packages,
            material_bindings,
            dynamic_runtime,
            ..
        } = package;
        // 图表包：ChartIR 经包校验后重建运行时；展示列表由图表呈现，与静态 deep2d 入口互斥。
        let entry = chart_entry::assemble(chart_source, chart_sim_fixture, deep2d)?;
        let dashboard = dashboard
            .map(deep_engine_native::dashboard_runtime::DashboardRuntime::new)
            .transpose()?;
        let deep2d = dashboard
            .as_ref()
            .map(|runtime| runtime.content().clone())
            .or(entry.deep2d);
        let content = Self {
            authored_view: camera
                .as_ref()
                .map(deep_engine_native::player_view::PlayerView::from_camera)
                .transpose()?,
            coordinate_frame: camera
                .as_ref()
                .and_then(|camera| camera.coordinate_frame.clone()),
            authored_camera: camera.clone(),
            resource_domain: resource_domain::memory(&package_id),
            pending_lkg: None,
            pending_x_lkg: None,
            #[cfg(windows)]
            x_template: None,
            pending_asset_lkg: None,
            startup_notice: None,
            packet: render_packet,
            scene_content_key,
            deep2d,
            chart: entry.chart,
            chart_text_scale: 1.0,
            dashboard,
            dashboard_started: None,
            // 换包重建即新 epoch:文档标识取包 id + 包哈希。
            epoch: ChartEpoch::for_document(ChartEpoch::document_revision(
                &package_id,
                &package_hash,
            )),
            chart_sim: entry.chart_sim,
            environment,
            background,
            lighting,
            fog,
            shader_packages,
            material_bindings,
            dynamic_runtime,
            runtime_package,
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

    pub fn initial_view(&self) -> deep_engine_native::player_view::PlayerView {
        self.authored_view.unwrap_or_default()
    }

    pub fn view_after_reload(
        &self,
        previous: &Self,
        current: deep_engine_native::player_view::PlayerView,
    ) -> deep_engine_native::player_view::PlayerView {
        if self.coordinate_frame == previous.coordinate_frame {
            return if self.authored_view == previous.authored_view {
                current
            } else {
                self.initial_view()
            };
        }
        if !self.same_authored_world_camera(previous) || current.clipping != [0.0; 4] {
            return self.initial_view();
        }
        // Preserve orbit orientation/distance, moving only its local anchor between frames.
        let translated = previous
            .local_to_world(current.target.map(f64::from))
            .and_then(|world| self.world_to_local(world));
        match translated {
            Ok(target) => deep_engine_native::player_view::PlayerView {
                target: target.map(|v| v as f32),
                ..current
            },
            Err(_) => self.initial_view(),
        }
    }

    pub fn coordinate_frame(
        &self,
    ) -> Option<&deep_engine_native::runtime_coordinates::SceneLocalCoordinateFrame> {
        self.coordinate_frame.as_ref()
    }

    pub fn local_to_world(&self, position: [f64; 3]) -> Result<[f64; 3], String> {
        deep_engine_native::runtime_coordinates::local_to_world(position, self.coordinate_origin())
    }

    pub fn world_to_local(&self, position: [f64; 3]) -> Result<[f64; 3], String> {
        deep_engine_native::runtime_coordinates::world_to_local(position, self.coordinate_origin())
    }

    fn coordinate_origin(&self) -> [f64; 3] {
        self.coordinate_frame()
            .map(|frame| frame.origin_array())
            .unwrap_or([0.0; 3])
    }

    fn same_authored_world_camera(&self, previous: &Self) -> bool {
        let (Some(next), Some(old)) = (&self.authored_camera, &previous.authored_camera) else {
            return false;
        };
        if next.vertical_fov_degrees != old.vertical_fov_degrees
            || next.near != old.near
            || next.far != old.far
        {
            return false;
        }
        for (next_local, old_local) in [(next.position, old.position), (next.target, old.target)] {
            let (Ok(next_world), Ok(old_world)) = (
                self.local_to_world(next_local),
                previous.local_to_world(old_local),
            ) else {
                return false;
            };
            if (0..3).any(|i| {
                (next_world[i] - old_world[i]).abs()
                    > deep_engine_native::runtime_coordinates::MAX_ROUND_TRIP_ERROR
            }) {
                return false;
            }
        }
        true
    }

    pub fn scene_content_key(&self) -> u64 {
        self.scene_content_key
    }

    /// Authored animation duration in milliseconds, when the package carries
    /// the dynamic runtime channel.
    pub fn dynamic_runtime_duration_ms(&self) -> Option<u64> {
        self.dynamic_runtime
            .as_ref()?
            .animation
            .as_ref()
            .map(|animation| animation.duration_ms)
    }

    /// Samples one deterministic playback step from the dynamic runtime and
    /// applies the TRS result to the render packet instances it targets. The
    /// replay clock is clamped by `sample_animation`; the returned canonical
    /// string is the byte-exact cross-end frame contract.
    pub fn apply_dynamic_playback_step(&mut self, time_ms: u64) -> Result<DynamicPlaybackStep, String> {
        let Some(runtime) = self.dynamic_runtime.as_ref() else {
            return Err("content has no dynamic runtime channel; real playback requires one".into());
        };
        let time_ms = time_ms.min(runtime.animation.as_ref().map(|a| a.duration_ms).unwrap_or(0));
        let samples = runtime.sample_animation(time_ms);
        let replay_revisions: Vec<u64> = runtime
            .replay_events_at(time_ms)
            .iter()
            .map(|event| event.revision)
            .collect();
        let canonical =
            deep_engine_native::runtime_package::canonical_dynamic_frame(time_ms, &samples, &replay_revisions);
        let changed_instances = apply_dynamic_transforms(&mut self.packet, &samples)?;
        self.scene_content_key = crate::player_shader_plan::scene_content_key(&self.packet);
        Ok(DynamicPlaybackStep { time_ms, canonical, replay_revisions, changed_instances })
    }

    pub fn runtime_package(&self) -> Option<&RuntimePackageSnapshot> {
        self.runtime_package.as_ref()
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub fn mutate_packet_for_test(&mut self, update: impl FnOnce(&mut RenderPacket)) {
        update(&mut self.packet);
        self.scene_content_key = crate::player_shader_plan::scene_content_key(&self.packet);
    }
}

/// Composed TRS state for one dynamic animation target node.
#[derive(Clone, Copy, Default)]
struct DynamicNodeTransform {
    translation: Option<[f64; 3]>,
    rotation: Option<[f64; 4]>,
    scale: Option<[f64; 3]>,
}

/// Maps sampled TRS channels onto packet instances and overwrites their
/// transforms with `T * R * S` (column-major, translation at [12..15]), the
/// same convention `compileSceneRenderPacket` and three.js use. Instance ids
/// follow the published binding rules: primitive nodes are their own instance
/// id, model nodes own every `model-<content-hash>/<instance>` id.
fn apply_dynamic_transforms(
    packet: &mut RenderPacket,
    samples: &[deep_engine_native::runtime_package::DynamicAnimationSample],
) -> Result<usize, String> {
    use std::collections::BTreeMap;
    let mut nodes: BTreeMap<&str, DynamicNodeTransform> = BTreeMap::new();
    for sample in samples {
        let node = nodes.entry(sample.target_id.as_str()).or_default();
        match sample.property.as_str() {
            "translation" => node.translation = Some([sample.value[0], sample.value[1], sample.value[2]]),
            "rotation" => node.rotation = Some([sample.value[3], sample.value[4], sample.value[5], sample.value[6]]),
            "scale" => node.scale = Some([sample.value[0], sample.value[1], sample.value[2]]),
            other => return Err(format!("dynamic playback cannot consume transform property {other:?}")),
        }
    }
    let mut changed = 0usize;
    for (target_id, node) in &nodes {
        let prefix = format!(
            "model-{}/",
            runtime_content_sha256(&serde_json::Value::String((*target_id).to_owned()))
        );
        let transform = dynamic_trs_matrix(node);
        for instance in &mut packet.instances {
            if instance.id != *target_id && !instance.id.starts_with(&prefix) {
                continue;
            }
            instance.transform = transform;
            changed += 1;
        }
    }
    Ok(changed)
}

fn dynamic_trs_matrix(node: &DynamicNodeTransform) -> [f32; 16] {
    let [tx, ty, tz] = node.translation.unwrap_or([0.0; 3]);
    let [qx, qy, qz, qw] = node.rotation.unwrap_or([0.0, 0.0, 0.0, 1.0]);
    let [sx, sy, sz] = node.scale.unwrap_or([1.0; 3]);
    let (xx, yy, zz, xy, xz, yz, wx, wy, wz) = (
        qx * qx, qy * qy, qz * qz,
        qx * qy, qx * qz, qy * qz,
        qw * qx, qw * qy, qw * qz,
    );
    // Column-major T * R * S: scale applies along each rotation column.
    [
        ((1.0 - 2.0 * (yy + zz)) * sx) as f32,
        ((2.0 * (xy + wz)) * sx) as f32,
        ((2.0 * (xz - wy)) * sx) as f32,
        0.0,
        ((2.0 * (xy - wz)) * sy) as f32,
        ((1.0 - 2.0 * (xx + zz)) * sy) as f32,
        ((2.0 * (yz + wx)) * sy) as f32,
        0.0,
        ((2.0 * (xz + wy)) * sz) as f32,
        ((2.0 * (yz - wx)) * sz) as f32,
        ((1.0 - 2.0 * (xx + yy)) * sz) as f32,
        0.0,
        tx as f32,
        ty as f32,
        tz as f32,
        1.0,
    ]
}
