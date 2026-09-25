use deep_engine_native::{
    author_grading::AuthorGrading,
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
#[path = "player_content_camera.rs"]
mod camera;
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
    authored_coordinate_origin: [f64; 3],
    coordinate_frame_revision: u64,
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
    pub dashboard_started: Option<web_time::Instant>,
    pub epoch: ChartEpoch,
    pub chart_sim: Option<chart_sim::ChartSimHost>,
    pub environment: PreparedIblEnvironment,
    pub background: Option<[f64; 3]>,
    pub lighting: Option<deep_engine_native::scene_lighting::DirectionalLighting>,
    /// v7 作者雾（exp2）；渲染器装配时经 `for_content` 替换宿主雾档。
    pub fog: Option<FogSettings>,
    /// v9 作者色彩分级（六通道）；非中性时由输出 pass 在固定 ACES 前消费。
    pub author_grading: Option<AuthorGrading>,
    pub shader_packages: Vec<DeepShaderPackageV2>,
    pub material_bindings: Vec<RuntimeMaterialShaderBinding>,
    /// v7 动态场景通道。先随包进入 PlayerContent，供宿主 replay/交互层消费；
    /// 不在加载阶段把动画误降级成静态几何。
    #[allow(dead_code)]
    pub dynamic_runtime: Option<deep_engine_native::runtime_package::DynamicSceneRuntime>,
    /// F3:环境携带的探针网格记录(网格头 + 探针);None = 无探针 GI。
    pub probe_grid_records: Option<Vec<deep_engine_native::probe_gi_abi::IrradianceProbeRecord>>,
    /// R11 动画状态机宿主：装载包时按持久活动态启动 clip、应用持久参数首条
    /// 转场；之后仅在参数更新时推进。无状态机场景为 `None`，零开销。
    animation_controller:
        Option<deep_engine_native::native_animation_controller::NativeAnimationControllerHost>,
    physics: Option<deep_engine_native::native_physics::NativePhysicsHost>,
    runtime_package: Option<RuntimePackageSnapshot>,
}

#[cfg(test)]
#[path = "player_content_camera_tests.rs"]
mod camera_tests;

#[cfg(test)]
#[path = "player_content_dynamic_tests.rs"]
mod dynamic_tests;

#[cfg(test)]
#[path = "player_content_controller_tests.rs"]
mod controller_tests;

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

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DynamicCameraFrame {
    pub position: [f32; 3],
    pub target: [f32; 3],
}

#[derive(Clone, Debug)]
pub struct RuntimePackageSnapshot {
    pub package_id: String,
    pub package_version: String,
    pub package_hash: String,
    pub resource_index: Vec<RuntimeResourceIndexEntry>,
}

pub struct DynamicCoordinateRebase {
    packet: RenderPacket,
    frame: deep_engine_native::runtime_coordinates::SceneLocalCoordinateFrame,
    pub view: deep_engine_native::player_view::PlayerView,
    delta: [f32; 3],
    revision: u64,
}

impl DynamicCoordinateRebase {
    pub fn delta(&self) -> [f32; 3] {
        self.delta
    }
}

pub struct DynamicCoordinateRollback {
    packet: RenderPacket,
    frame: Option<deep_engine_native::runtime_coordinates::SceneLocalCoordinateFrame>,
    revision: u64,
    delta: [f32; 3],
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
        let mut rasterizer = deep_engine_native::platform_text::runtime_text_rasterizer()?;
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
            authored_coordinate_origin: [0.0; 3],
            coordinate_frame_revision: 0,
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
            author_grading: None,
            shader_packages: Vec::new(),
            material_bindings: Vec::new(),
            probe_grid_records: None,
            dynamic_runtime: None,
            animation_controller: None,
            physics: None,
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
            author_grading,
            shader_packages,
            material_bindings,
            dynamic_runtime,
            probe_grid_records,
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
        // Build the complete physics graph before publishing PlayerContent.
        // Any missing render binding/collider/joint rejects the package atomically.
        let physics = dynamic_runtime
            .as_ref()
            .map(|runtime| {
                deep_engine_native::native_physics::NativePhysicsHost::from_runtime(
                    runtime,
                    &render_packet,
                )
            })
            .transpose()?
            .flatten();
        // R11 动画状态机宿主：装载即执行 Web SceneViewer 挂载序列（start 活动
        // clip → evaluate 持久参数首条转场）。失败原子拒绝整包，不伪造播放态。
        let mut animation_controller = dynamic_runtime
            .as_ref()
            .and_then(
                deep_engine_native::native_animation_controller::NativeAnimationControllerHost::from_runtime,
            );
        if let Some(host) = animation_controller.as_mut() {
            let runtime = dynamic_runtime
                .as_ref()
                .expect("controller host implies the dynamic runtime channel");
            host.start(runtime)?;
            host.evaluate(runtime)?;
        }
        // 产品可见的装载证据（窗口标题 startup notice），与物理链的启动回执同风格。
        let startup_notice = animation_controller.as_ref().map(|host| {
            format!(
                "animation controller ready: state {} ({} commands applied)",
                host.active_state_id(),
                host.commands().len()
            )
        });
        let authored_coordinate_origin = camera
            .as_ref()
            .and_then(|value| value.coordinate_frame.as_ref())
            .map(|frame| frame.origin_array())
            .unwrap_or([0.0; 3]);
        let content = Self {
            authored_view: camera
                .as_ref()
                .map(deep_engine_native::player_view::PlayerView::from_camera)
                .transpose()?,
            coordinate_frame: camera
                .as_ref()
                .and_then(|camera| camera.coordinate_frame.clone()),
            coordinate_frame_revision: 0,
            authored_coordinate_origin,
            authored_camera: camera.clone(),
            resource_domain: resource_domain::memory(&package_id),
            pending_lkg: None,
            pending_x_lkg: None,
            #[cfg(windows)]
            x_template: None,
            pending_asset_lkg: None,
            startup_notice,
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
            author_grading,
            shader_packages,
            material_bindings,
            dynamic_runtime,
            probe_grid_records,
            animation_controller,
            physics,
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

    pub fn coordinate_frame(
        &self,
    ) -> Option<&deep_engine_native::runtime_coordinates::SceneLocalCoordinateFrame> {
        self.coordinate_frame.as_ref()
    }

    pub fn coordinate_frame_revision(&self) -> u64 {
        self.coordinate_frame_revision
    }

    /// Origin of the runtime frame that f32-local state such as annotation
    /// points is expressed in right now; diverges from the authored origin
    /// after a dynamic coordinate rebase.
    pub fn runtime_coordinate_origin(&self) -> [f64; 3] {
        self.coordinate_origin()
    }

    /// Origin of the package-authored frame; annotation documents saved
    /// before frame-aware persistence (version 1) are interpreted in this
    /// frame.
    pub fn authored_coordinate_origin(&self) -> [f64; 3] {
        self.authored_coordinate_origin
    }

    pub fn dynamic_coordinate_rebase(
        &self,
        view: deep_engine_native::player_view::PlayerView,
    ) -> Result<Option<DynamicCoordinateRebase>, String> {
        let eye = view.eye();
        if eye.iter().all(|value| value.abs() <= 750.0) {
            return Ok(None);
        }
        let old_origin = self.coordinate_origin();
        let world_eye = self.local_to_world(eye.map(f64::from))?;
        let next_origin = world_eye.map(|value| (value / 1000.0).round() * 1000.0);
        if next_origin == old_origin {
            return Ok(None);
        }
        let delta: [f32; 3] = std::array::from_fn(|i| (old_origin[i] - next_origin[i]) as f32);
        if delta.iter().any(|value| !value.is_finite()) {
            return Err("native camera-relative rebase exceeds float32 range".into());
        }
        let mut packet = self.packet.clone();
        for instance in &mut packet.instances {
            for (axis, value) in delta.iter().enumerate() {
                instance.transform[12 + axis] += *value;
                if !instance.transform[12 + axis].is_finite() {
                    return Err("native camera-relative instance rebase overflow".into());
                }
            }
        }
        let mut next_view = view;
        for (axis, value) in delta.iter().enumerate() {
            next_view.target[axis] += *value;
        }
        let profile = self
            .coordinate_frame
            .as_ref()
            .map(|frame| frame.profile.clone())
            .unwrap_or(
                deep_engine_native::runtime_coordinates::SceneLocalCoordinateProfile {
                    id: "scene-local-coordinates-v1".into(),
                    unit: "scene-unit".into(),
                    origin_grid: 1000.0,
                    max_round_trip_error:
                        deep_engine_native::runtime_coordinates::MAX_ROUND_TRIP_ERROR,
                    max_float32_coordinate_error:
                        deep_engine_native::runtime_coordinates::MAX_FLOAT32_COORDINATE_ERROR,
                },
            );
        let frame = deep_engine_native::runtime_coordinates::SceneLocalCoordinateFrame {
            schema_version: 1,
            profile,
            origin: deep_engine_native::runtime_coordinates::SceneCoordinate {
                x: next_origin[0],
                y: next_origin[1],
                z: next_origin[2],
            },
        };
        frame.validate()?;
        Ok(Some(DynamicCoordinateRebase {
            packet,
            frame,
            view: next_view,
            delta,
            revision: self
                .coordinate_frame_revision
                .checked_add(1)
                .ok_or("native coordinate revision exhausted")?,
        }))
    }

    pub fn begin_dynamic_coordinate_rebase(
        &mut self,
        candidate: DynamicCoordinateRebase,
    ) -> DynamicCoordinateRollback {
        let rollback = DynamicCoordinateRollback {
            packet: std::mem::replace(&mut self.packet, candidate.packet),
            frame: self.coordinate_frame.replace(candidate.frame),
            revision: self.coordinate_frame_revision,
            delta: candidate.delta,
        };
        self.coordinate_frame_revision = candidate.revision;
        if let Some(physics) = self.physics.as_mut() {
            physics.rebase(candidate.delta);
        }
        rollback
    }

    pub fn rollback_dynamic_coordinate_rebase(&mut self, rollback: DynamicCoordinateRollback) {
        self.packet = rollback.packet;
        self.coordinate_frame = rollback.frame;
        self.coordinate_frame_revision = rollback.revision;
        if let Some(physics) = self.physics.as_mut() {
            physics.rebase(rollback.delta.map(|value| -value));
        }
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

    pub fn dynamic_runtime_playback(&self) -> Option<(u64, bool, bool)> {
        let animation = self.dynamic_runtime.as_ref()?.animation.as_ref()?;
        Some((animation.duration_ms, animation.autoplay, animation.r#loop))
    }

    pub fn physics_playing(&self) -> bool {
        self.physics
            .as_ref()
            .is_some_and(|physics| physics.is_playing())
    }

    /// R11 状态机宿主的只读视图（活动态 + 已应用的确定性命令轨迹）。
    /// 当前产品消费点：装载路径 startup notice 与测试对拍；实时宿主（交互层）
    /// 通过 `set_animation_controller_parameter` 驱动。
    #[allow(dead_code)]
    pub fn animation_controller(
        &self,
    ) -> Option<&deep_engine_native::native_animation_controller::NativeAnimationControllerHost>
    {
        self.animation_controller.as_ref()
    }

    /// 更新一个已声明参数并在同一调用内解析转场（与 Web 的 setParameter →
    /// evaluate 时序一致）。无宿主或未知参数返回 `Ok(false)`；转场失败向上
    /// 传播为 `Err`，不猜测。
    /// 合同事实：dynamic-runtime v2/v3 的转场触发词表只有布尔参数——interaction
    /// 通道动作（select/clear-selection/clip/set-visible）不含参数写边，故 Native
    /// 与 Web 一致，只做持久参数装载转场 + 本入口的显式参数驱动，不虚构交互触发。
    #[allow(dead_code)]
    pub fn set_animation_controller_parameter(
        &mut self,
        name: &str,
        value: bool,
    ) -> Result<bool, String> {
        let declared = match self.animation_controller.as_mut() {
            Some(host) => host.set_parameter(name, value),
            None => return Ok(false),
        };
        if !declared {
            return Ok(false);
        }
        // 构造不变式：宿主存在当且仅当 dynamic_runtime 携带 controller 通道；
        // 缺失即内容被外部破坏，显式失败而非猜测。
        let runtime = self
            .dynamic_runtime
            .as_ref()
            .ok_or("animation controller host has no dynamic runtime channel")?;
        self.animation_controller
            .as_mut()
            .expect("host checked above")
            .evaluate(runtime)
            .map(|_| true)
    }

    pub fn advance_physics(&mut self, delta_seconds: f64) -> Result<usize, String> {
        let Some(physics) = self.physics.as_mut() else {
            return Ok(0);
        };
        let mut candidate = self.packet.clone();
        let changed = physics.advance(delta_seconds, &mut candidate)?;
        if changed > 0 {
            self.packet = candidate;
            self.scene_content_key = crate::player_shader_plan::scene_content_key(&self.packet);
        }
        Ok(changed)
    }

    pub fn sample_dynamic_camera(&self, time_ms: u64) -> Option<DynamicCameraFrame> {
        let runtime = self.dynamic_runtime.as_ref()?;
        let samples = runtime.sample_animation(time_ms);
        let position = samples.iter().find(|sample| {
            sample.target_id == "scene.camera" && sample.property == "camera-position"
        })?;
        let target = samples.iter().find(|sample| {
            sample.target_id == "scene.camera" && sample.property == "camera-target"
        })?;
        let delta = self.authored_to_runtime_delta();
        Some(DynamicCameraFrame {
            position: std::array::from_fn(|index| {
                [
                    position.value[0] as f32,
                    position.value[1] as f32,
                    position.value[2] as f32,
                ][index]
                    + delta[index]
            }),
            target: std::array::from_fn(|index| {
                [
                    target.value[0] as f32,
                    target.value[1] as f32,
                    target.value[2] as f32,
                ][index]
                    + delta[index]
            }),
        })
    }

    /// Samples one deterministic playback step from the dynamic runtime and
    /// applies the TRS result to the render packet instances it targets. The
    /// replay clock is clamped by `sample_animation`; the returned canonical
    /// string is the byte-exact cross-end frame contract.
    pub fn apply_dynamic_playback_step(
        &mut self,
        time_ms: u64,
    ) -> Result<DynamicPlaybackStep, String> {
        let Some(runtime) = self.dynamic_runtime.as_ref() else {
            return Err(
                "content has no dynamic runtime channel; real playback requires one".into(),
            );
        };
        let time_ms = time_ms.min(
            runtime
                .animation
                .as_ref()
                .map(|a| a.duration_ms)
                .unwrap_or(0),
        );
        let samples = runtime.sample_animation(time_ms);
        let replay_revisions: Vec<u64> = runtime
            .replay_events_at(time_ms)
            .iter()
            .map(|event| event.revision)
            .collect();
        let canonical = deep_engine_native::runtime_package::canonical_dynamic_frame(
            time_ms,
            &samples,
            &replay_revisions,
        );
        let translation_delta = self.authored_to_runtime_delta();
        let changed_instances =
            apply_dynamic_transforms(&mut self.packet, &samples, translation_delta)?;
        self.scene_content_key = crate::player_shader_plan::scene_content_key(&self.packet);
        Ok(DynamicPlaybackStep {
            time_ms,
            canonical,
            replay_revisions,
            changed_instances,
        })
    }

    fn authored_to_runtime_delta(&self) -> [f32; 3] {
        let runtime = self.coordinate_origin();
        std::array::from_fn(|index| {
            (self.authored_coordinate_origin[index] - runtime[index]) as f32
        })
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
    translation_delta: [f32; 3],
) -> Result<usize, String> {
    use std::collections::BTreeMap;
    let mut nodes: BTreeMap<&str, DynamicNodeTransform> = BTreeMap::new();
    // B2-a object-visible：显式可见性关键帧（value[0]>0.5 为可见）。先采样，再在
    // 变换写入阶段对隐藏目标的实例写零矩阵——退化矩阵会被 GPU 光栅自然剔除，
    // 不扩实例 ABI；正式 per-instance 可见位仍待后续立项。
    let mut hidden: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    for sample in samples {
        let node = nodes.entry(sample.target_id.as_str()).or_default();
        match sample.property.as_str() {
            "translation" => {
                node.translation = Some([sample.value[0], sample.value[1], sample.value[2]])
            }
            "rotation" => {
                node.rotation = Some([
                    sample.value[3],
                    sample.value[4],
                    sample.value[5],
                    sample.value[6],
                ])
            }
            "scale" => node.scale = Some([sample.value[0], sample.value[1], sample.value[2]]),
            "object-visible" => {
                if sample.value[0] <= 0.5 {
                    hidden.insert(sample.target_id.as_str());
                } else {
                    hidden.remove(sample.target_id.as_str());
                }
            }
            "camera-position" | "camera-target" => continue,
            other => {
                return Err(format!(
                    "dynamic playback cannot consume transform property {other:?}"
                ));
            }
        }
    }
    let mut changed = 0usize;
    for (target_id, node) in &nodes {
        let prefix = format!(
            "model-{}/",
            runtime_content_sha256(&serde_json::Value::String((*target_id).to_owned()))
        );
        let hidden_target = hidden.contains(*target_id);
        let transform = if hidden_target {
            [0.0; 16]
        } else {
            let mut transform = dynamic_trs_matrix(node);
            for axis in 0..3 {
                transform[12 + axis] += translation_delta[axis];
            }
            transform
        };
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
        qx * qx,
        qy * qy,
        qz * qz,
        qx * qy,
        qx * qz,
        qy * qz,
        qw * qx,
        qw * qy,
        qw * qz,
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
