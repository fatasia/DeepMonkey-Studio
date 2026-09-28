use wasm_bindgen::prelude::*;

use crate::{VIEWER_SESSIONS, app_startup, events};

/// Query a physics-owned render instance after the last committed fixed step.
/// The promise rejects for stale handles and unknown or non-dynamic instances.
#[wasm_bindgen]
pub fn viewer_physics_pose(handle: u32, instance_id: String) -> Result<js_sys::Promise, JsValue> {
    let proxy = VIEWER_SESSIONS
        .with(|sessions| sessions.borrow().get(&handle).cloned())
        .ok_or_else(|| JsValue::from_str("scene viewer handle is not active"))?;
    if instance_id.is_empty() || instance_id.len() > 512 {
        return Err(JsValue::from_str("physics instance id is invalid"));
    }
    Ok(js_sys::Promise::new(&mut move |resolve, reject| {
        let resolve = resolve.clone();
        let reject = reject.clone();
        let request_id =
            app_startup::register_wasm_physics_pose_request(move |result| match result {
                Ok(value) => {
                    let _ = resolve.call1(&JsValue::UNDEFINED, &JsValue::from_str(&value));
                }
                Err(error) => {
                    let _ = reject.call1(&JsValue::UNDEFINED, &JsValue::from_str(&error));
                }
            });
        if proxy
            .send_event(events::GpuEvent::WasmPhysicsPoseQuery {
                request_id,
                instance_id: instance_id.clone(),
            })
            .is_err()
        {
            app_startup::resolve_wasm_physics_pose_request(
                request_id,
                Err("scene viewer event loop is closed".into()),
            );
        }
    }))
}
