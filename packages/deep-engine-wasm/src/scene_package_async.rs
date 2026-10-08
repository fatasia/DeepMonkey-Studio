use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

use wasm_bindgen::prelude::*;

thread_local! {
    static PREPARED: RefCell<BTreeMap<u32, crate::runtime_package_startup::PreparedRuntimePackage>> = const { RefCell::new(BTreeMap::new()) };
    static NEXT: Cell<u32> = const { Cell::new(1) };
}

/// A timer is a browser task boundary. Promise.resolve alone would starve input.
async fn yield_task() {
    let promise = js_sys::Promise::new(&mut |resolve, _reject| {
        web_sys::window()
            .expect("scene preparation runs on the window")
            .set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, 0)
            .expect("browser task scheduling");
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}

/// Prepared candidates own their slot. Cancellation cannot overwrite another
/// request's package, unlike asynchronous writes to the legacy global slot.
#[wasm_bindgen]
pub async fn prepare_scene_package(
    bytes: Vec<u8>,
    expected_hash: Option<String>,
    signal: Option<web_sys::AbortSignal>,
) -> Result<u32, JsValue> {
    let package =
        deep_engine_native::runtime_package::parse_and_validate_runtime_package_owned_cooperative(
            bytes,
            expected_hash.as_deref(),
            || async {
                if signal.as_ref().is_some_and(web_sys::AbortSignal::aborted) {
                    return true;
                }
                yield_task().await;
                signal.as_ref().is_some_and(web_sys::AbortSignal::aborted)
            },
        )
        .await
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    yield_task().await;
    if signal.as_ref().is_some_and(web_sys::AbortSignal::aborted) {
        return Err(JsValue::from_str("scene package preparation cancelled"));
    }
    let prepared = crate::runtime_package_startup::prepare(package)
        .map_err(|error| JsValue::from_str(&error))?;
    let id = NEXT.with(|next| {
        let id = next.get();
        next.set(id.checked_add(1).unwrap_or(1));
        id
    });
    PREPARED.with(|slots| slots.borrow_mut().insert(id, prepared));
    Ok(id)
}

#[wasm_bindgen]
pub fn discard_prepared_scene_package(id: u32) {
    PREPARED.with(|slots| {
        slots.borrow_mut().remove(&id);
    });
}

fn take(id: u32) -> Result<crate::runtime_package_startup::PreparedRuntimePackage, JsValue> {
    PREPARED
        .with(|slots| slots.borrow_mut().remove(&id))
        .ok_or_else(|| JsValue::from_str("scene preparation was discarded or already consumed"))
}

#[wasm_bindgen]
pub fn start_prepared_scene_viewer(
    id: u32,
    canvas: Option<web_sys::HtmlCanvasElement>,
) -> Result<u32, JsValue> {
    let prepared = take(id)?;
    crate::SCENE_PACKAGE.with(|slot| *slot.borrow_mut() = Some(prepared));
    crate::start_scene_viewer(canvas)
}

#[wasm_bindgen]
pub fn update_prepared_scene_viewer(handle: u32, id: u32) -> Result<(), JsValue> {
    let prepared = take(id)?;
    let proxy = crate::VIEWER_SESSIONS
        .with(|sessions| sessions.borrow().get(&handle).cloned())
        .ok_or_else(|| JsValue::from_str("scene viewer handle is not active"))?;
    proxy
        .send_event(crate::events::GpuEvent::WasmScenePackage(Box::new(
            prepared,
        )))
        .map_err(|_| JsValue::from_str("scene viewer event loop is closed"))
}
