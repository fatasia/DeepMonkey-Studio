use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Accessibility as uia;
use windows::Win32::UI::WindowsAndMessaging as wm;

use crate::native_ui::accessibility::SemanticsTree;
use crate::native_ui::uia_bridge::{UiaBridgeError, validate_semantics};

use super::{BridgeShared, node_provider, root_id};

const EVENT_THROTTLE: Duration = Duration::from_millis(100);
const PROVIDER_PROP: windows::core::PCWSTR = windows::core::w!("DeepEngineUiaProvider");

/// Lives in a window property while the bridge is attached: the subclass
/// proc reads it on WM_GETOBJECT and the previous proc is chained after.
struct WndProcPayload {
    prev_proc: wm::WNDPROC,
    provider: uia::IRawElementProviderSimple,
}

fn set_payload(hwnd: HWND, payload: *mut WndProcPayload) -> Result<(), UiaBridgeError> {
    unsafe { wm::SetPropW(hwnd, PROVIDER_PROP, Some(HANDLE(payload.cast()))) }
        .map_err(|_| UiaBridgeError::SubclassFailed)
}

fn take_payload(hwnd: HWND) -> Option<Box<WndProcPayload>> {
    let handle = unsafe { wm::RemovePropW(hwnd, PROVIDER_PROP) }.ok()?;
    if handle.0.is_null() {
        return None;
    }
    // SAFETY: the pointer was created by Box::into_raw in `attach` and every
    // other accessor treats it as borrowed only.
    unsafe { Some(Box::from_raw(handle.0 as *mut WndProcPayload)) }
}

unsafe extern "system" fn bridge_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let handle = unsafe { wm::GetPropW(hwnd, PROVIDER_PROP) };
    if handle.0.is_null() {
        return unsafe { wm::DefWindowProcW(hwnd, msg, wparam, lparam) };
    }
    let payload = handle.0 as *const WndProcPayload;
    if msg == wm::WM_GETOBJECT {
        // UIA probes the root object and client object; other object ids stay
        // on the window's original procedure.
        let object_id = lparam.0 as u32;
        let is_root_query = object_id == uia::UiaRootObjectId as u32;
        let is_client_query = object_id == 0xFFFF_FFFCu32;
        if is_root_query || is_client_query {
            // SAFETY: payload is a valid Box allocation owned by the prop.
            let provider = unsafe { (*payload).provider.clone() };
            return unsafe { uia::UiaReturnRawElementProvider(hwnd, wparam, lparam, &provider) };
        }
    }
    // Copy the chained proc out first: WM_DESTROY drops the payload.
    let prev = unsafe { (*payload).prev_proc };
    if msg == wm::WM_DESTROY {
        take_payload(hwnd);
    }
    unsafe { wm::CallWindowProcW(prev, hwnd, msg, wparam, lparam) }
}

fn bridge_proc_ptr() -> isize {
    bridge_wndproc as *const () as isize
}

struct ActiveBridge {
    hwnd: HWND,
    prev_proc: isize,
    shared: Arc<BridgeShared>,
}

/// Handle owning one UIA bridge attachment. Single-window product: one
/// instance per HWND; `attach` refuses a second bridge on the same hwnd.
pub struct UiaBridge {
    active: Option<ActiveBridge>,
}

impl UiaBridge {
    /// Subclasses `hwnd` (must run on the owning thread) so UIA clients'
    /// WM_GETOBJECT resolves to the semantics tree's root provider.
    pub fn attach(hwnd_value: isize, semantics: SemanticsTree) -> Result<Self, UiaBridgeError> {
        validate_semantics(&semantics)?;
        let hwnd = HWND(hwnd_value as *mut _);
        // Subclassing from a foreign thread breaks the message-loop ownership
        // model, so fail closed.
        if unsafe { wm::GetWindowThreadProcessId(hwnd, None) }
            != unsafe { windows_sys::Win32::System::Threading::GetCurrentThreadId() }
        {
            return Err(UiaBridgeError::WindowThreadMismatch);
        }
        let existing = unsafe { wm::GetPropW(hwnd, PROVIDER_PROP) };
        if !existing.0.is_null() {
            return Err(UiaBridgeError::AlreadyAttached);
        }
        let shared = Arc::new(BridgeShared {
            hwnd: hwnd_value,
            semantics: RwLock::new(semantics),
            last_event: Mutex::new(None),
        });
        let provider: uia::IRawElementProviderSimple =
            node_provider(&shared, root_id(&shared)?).into_interface();
        let payload = Box::into_raw(Box::new(WndProcPayload {
            prev_proc: None,
            provider,
        }));
        set_payload(hwnd, payload)?;
        let prev = unsafe { wm::SetWindowLongPtrW(hwnd, wm::GWLP_WNDPROC, bridge_proc_ptr()) };
        if prev == 0 {
            take_payload(hwnd);
            return Err(UiaBridgeError::SubclassFailed);
        }
        // SAFETY: payload is live until the prop is removed (detach /
        // WM_DESTROY); nothing else frees it.
        unsafe {
            (*payload).prev_proc = Some(core::mem::transmute::<
                isize,
                unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT,
            >(prev));
        }
        Ok(Self {
            active: Some(ActiveBridge {
                hwnd,
                prev_proc: prev,
                shared,
            }),
        })
    }

    /// Swap the semantics tree and notify UIA with a structure-changed event.
    /// Stale per-node providers fail closed.
    pub fn replace_semantics(&self, semantics: SemanticsTree) -> Result<(), UiaBridgeError> {
        validate_semantics(&semantics)?;
        let active = self.active.as_ref().ok_or(UiaBridgeError::NotAttached)?;
        let root_id = {
            let mut tree = active
                .shared
                .semantics
                .write()
                .map_err(|_| UiaBridgeError::LockPoisoned)?;
            *tree = semantics;
            tree.root_id.clone()
        };
        self.raise(active, root_id, uia::UIA_StructureChangedEventId)
    }

    /// Notify UIA that node properties changed without a structural change.
    pub fn raise_property_changed(&self) -> Result<(), UiaBridgeError> {
        let active = self.active.as_ref().ok_or(UiaBridgeError::NotAttached)?;
        let root_id = root_id(&active.shared)?;
        self.raise(active, root_id, uia::UIA_AutomationPropertyChangedEventId)
    }

    pub fn is_attached(&self) -> bool {
        self.active.is_some()
    }

    /// Idempotent: a second call (or Drop after WM_DESTROY cleanup) is a no-op.
    pub fn detach(&mut self) -> Result<(), UiaBridgeError> {
        let Some(active) = self.active.take() else {
            return Ok(());
        };
        // Restore the proc only while it is still ours; if the window was
        // destroyed the subclass is already gone.
        let ours =
            unsafe { wm::GetWindowLongPtrW(active.hwnd, wm::GWLP_WNDPROC) } == bridge_proc_ptr();
        if ours {
            unsafe { wm::SetWindowLongPtrW(active.hwnd, wm::GWLP_WNDPROC, active.prev_proc) };
        }
        take_payload(active.hwnd);
        Ok(())
    }

    fn raise(
        &self,
        active: &ActiveBridge,
        root_id: String,
        event: uia::UIA_EVENT_ID,
    ) -> Result<(), UiaBridgeError> {
        {
            let mut last = active
                .shared
                .last_event
                .lock()
                .map_err(|_| UiaBridgeError::LockPoisoned)?;
            if last.is_some_and(|at| at.elapsed() < EVENT_THROTTLE) {
                return Ok(());
            }
            *last = Some(Instant::now());
        }
        let provider: uia::IRawElementProviderSimple =
            node_provider(&active.shared, root_id).into_interface();
        // Raise after releasing the tree lock because UIA may re-enter
        // properties synchronously.
        unsafe { uia::UiaRaiseAutomationEvent(&provider, event) }
            .map_err(|error| UiaBridgeError::EventFailed(error.to_string()))
    }
}

impl Drop for UiaBridge {
    fn drop(&mut self) {
        let _ = self.detach();
    }
}
