use std::sync::{Arc, Mutex};

use bevy::{
    prelude::*,
    render::{extract_resource::ExtractResource, renderer::RenderAdapterInfo},
};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuIdentity {
    pub name: String,
    pub vendor: u32,
    pub device: u32,
    pub device_type: String,
    pub driver: String,
    pub driver_info: String,
    pub backend: String,
}

#[derive(Clone, Resource, ExtractResource)]
pub struct GpuInfo(pub Arc<Mutex<Option<GpuIdentity>>>);

impl Default for GpuInfo {
    fn default() -> Self { Self(Arc::new(Mutex::new(None))) }
}

pub fn capture_gpu_info(adapter: Res<RenderAdapterInfo>, capture: Res<GpuInfo>) {
    let mut value = capture.0.lock().expect("GPU identity lock poisoned");
    if value.is_none() {
        *value = Some(GpuIdentity { name: adapter.name.clone(), vendor: adapter.vendor,
            device: adapter.device, device_type: format!("{:?}", adapter.device_type),
            driver: adapter.driver.clone(), driver_info: adapter.driver_info.clone(),
            backend: format!("{:?}", adapter.backend) });
    }
}

