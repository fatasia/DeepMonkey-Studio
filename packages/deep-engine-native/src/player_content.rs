use deep_engine_native::{
    chart::ChartEpoch,
    contract::RenderPacket,
    deep2d::{Deep2dRuntimeContent, prepare_runtime_content},
    ibl::{PreparedIblEnvironment, builtin_default_environment},
    runtime_package::{
        LoadedRuntimePackage, RuntimeMaterialShaderBinding, RuntimeResourceIndexEntry,
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
#[path = "player_resource_domain.rs"]
mod resource_domain;

/// 保留作者数据用于设备恢复；IBL 来自已验证的包入口，而非渲染器隐式替换。
pub struct PlayerContent {
    authored_view: Option<deep_engine_native::player_view::PlayerView>,
    authored_camera: Option<deep_engine_native::runtime_camera::RuntimeSceneCamera>,
    coordinate_frame: Option<deep_engine_native::runtime_coordinates::SceneLocalCoordinateFrame>,
    resource_domain: String,
    pub pending_lkg: Option<crate::runtime_lkg::Pending>,
    pub pending_asset_lkg: Option<deep_engine_native::asset_package::recovery::Pending>,
    pub startup_notice: Option<String>,
    packet: RenderPacket,
    scene_content_key: u64,
    pub deep2d: Option<Deep2dRuntimeContent>,
    pub chart: Option<deep_engine_native::chart::ChartRuntime>,
    pub epoch: ChartEpoch,
    pub chart_sim: Option<chart_sim::ChartSimHost>,
    pub environment: PreparedIblEnvironment,
    pub shader_packages: Vec<DeepShaderPackageV2>,
    pub material_bindings: Vec<RuntimeMaterialShaderBinding>,
    runtime_package: Option<RuntimePackageSnapshot>,
}

#[cfg(test)]
mod camera_tests {
    use super::*;
    fn content() -> PlayerContent {
        PlayerContent::from_package(
            deep_engine_native::runtime_package::parse_and_validate_runtime_package(
                include_bytes!("../tests/fixtures/runtime-package-camera-v3.json"),
            )
            .unwrap(),
        )
        .unwrap()
    }
    #[test]
    fn camera_reload_preserves_user_view_unless_authored_camera_changes() {
        let old = content();
        let mut next = content();
        let mut user = old.initial_view();
        user.yaw += 0.3;
        assert_eq!(next.view_after_reload(&old, user), user);
        next.authored_view.as_mut().unwrap().pitch += 0.2;
        assert_eq!(next.view_after_reload(&old, user), next.initial_view());
        next.authored_view = None;
        assert_eq!(next.view_after_reload(&old, user), Default::default());
        assert!((old.initial_view().eye()[0] - 12.0).abs() < 0.00001);
    }

    #[test]
    fn typescript_v5_package_validates_hashes_and_restores_world_camera() {
        let package = deep_engine_native::runtime_package::parse_and_validate_runtime_package(
            include_bytes!("../tests/fixtures/runtime-package-camera-v3-coordinates.json"),
        )
        .unwrap();
        let camera = package.camera.as_ref().unwrap();
        assert_eq!(camera.schema_version, 2);
        assert_eq!(
            camera.coordinate_frame.as_ref().unwrap().origin_array(),
            [1e9, -1e9, 1e9]
        );
        assert_eq!(camera.position, [12.0, 8.0, 16.0]);
        let content = PlayerContent::from_package(package).unwrap();
        assert_eq!(
            content.local_to_world([12.0, 8.0, 16.0]).unwrap(),
            [1e9 + 12.0, -1e9 + 8.0, 1e9 + 16.0]
        );
        assert_eq!(content.world_to_local([1e9, -1e9, 1e9]).unwrap(), [0.0; 3]);
        assert_eq!(content.initial_view().target, [0.0; 3]);
        assert!(content.runtime_package().is_some());
    }

    fn shifted_content(shift: f64) -> PlayerContent {
        let mut package = deep_engine_native::runtime_package::parse_and_validate_runtime_package(
            include_bytes!("../tests/fixtures/runtime-package-camera-v3.json"),
        )
        .unwrap();
        let frame = serde_json::from_value(serde_json::json!({"schemaVersion":1,
            "profile":{"id":"scene-local-coordinates-v1","unit":"scene-unit","originGrid":1000,
                "maxRoundTripError":0.000001,"maxFloat32CoordinateError":0.001},
            "origin":{"x":1e9+shift,"y":1e9,"z":1e9}}))
        .unwrap();
        let camera = package.camera.as_mut().unwrap();
        camera.schema_version = 2;
        camera.coordinate_frame = Some(frame);
        camera.position[0] -= shift;
        camera.target[0] -= shift;
        for instance in &mut package.render_packet.instances {
            instance.transform[12] -= shift as f32;
        }
        PlayerContent::from_package(package).unwrap()
    }

    #[test]
    fn frame_reload_preserves_orbit_and_world_target_with_stable_object_ids() {
        let old = shifted_content(0.0);
        let next = shifted_content(1000.0);
        let mut user = old.initial_view();
        user.yaw += 0.3;
        user.pitch += 0.1;
        user.target = [0.125, -2.25, 10.5];
        user.distance *= 2.0;
        let moved = next.view_after_reload(&old, user);
        assert_eq!(moved.target, [-999.875, -2.25, 10.5]);
        assert_eq!(moved.yaw, user.yaw);
        assert_eq!(moved.pitch, user.pitch);
        assert_eq!(moved.distance, user.distance);
        assert_eq!(
            next.local_to_world(moved.target.map(f64::from)).unwrap(),
            old.local_to_world(user.target.map(f64::from)).unwrap()
        );
        for (before, after) in old.packet().instances.iter().zip(&next.packet().instances) {
            assert_eq!(before.id, after.id);
            let before_world = old
                .local_to_world([
                    before.transform[12] as f64,
                    before.transform[13] as f64,
                    before.transform[14] as f64,
                ])
                .unwrap();
            let after_world = next
                .local_to_world([
                    after.transform[12] as f64,
                    after.transform[13] as f64,
                    after.transform[14] as f64,
                ])
                .unwrap();
            for axis in 0..3 {
                assert!(
                    (before_world[axis] - after_world[axis]).abs()
                        <= deep_engine_native::runtime_coordinates::MAX_FLOAT32_COORDINATE_ERROR
                );
            }
        }
        assert_eq!(old.view_after_reload(&next, moved), user);
    }

    #[test]
    fn frame_reload_resets_changed_camera_and_unrepresentable_or_clipped_user_view() {
        let old = shifted_content(0.0);
        let mut next = shifted_content(1_000_000.0);
        let mut user = old.initial_view();
        user.target[0] = 0.01;
        assert_eq!(next.view_after_reload(&old, user), next.initial_view());
        user.target = [0.0; 3];
        user.clipping = [0.0, 1.0, 0.0, 2.0];
        assert_eq!(next.view_after_reload(&old, user), next.initial_view());
        user.clipping = [0.0; 4];
        next.authored_camera.as_mut().unwrap().position[1] += 1.0;
        assert_eq!(next.view_after_reload(&old, user), next.initial_view());
    }
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
            pending_asset_lkg: None,
            startup_notice: None,
            scene_content_key,
            deep2d,
            chart: None,
            epoch: ChartEpoch::initial(),
            chart_sim: None,
            environment: builtin_default_environment(),
            shader_packages: Vec::new(),
            material_bindings: Vec::new(),
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
            environment,
            shader_packages,
            material_bindings,
            ..
        } = package;
        // 图表包：ChartIR 经包校验后重建运行时；展示列表由图表呈现，与静态 deep2d 入口互斥。
        let entry = chart_entry::assemble(chart_source, chart_sim_fixture, deep2d)?;
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
            pending_asset_lkg: None,
            startup_notice: None,
            packet: render_packet,
            scene_content_key,
            deep2d: entry.deep2d,
            chart: entry.chart,
            // 换包重建即新 epoch:文档标识取包 id + 包哈希。
            epoch: ChartEpoch::for_document(ChartEpoch::document_revision(
                &package_id,
                &package_hash,
            )),
            chart_sim: entry.chart_sim,
            environment,
            shader_packages,
            material_bindings,
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
