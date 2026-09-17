//! P1-16: Windows UI Automation bridge. Publishes the semantics tree
//! (`accessibility.rs`) to the OS through a server-side UIA provider so
//! Narrator / Accessibility Insights can read the native window's chart
//! structure. Read-only for now: no control patterns yet, so assistive
//! actions keep flowing through `map_action_to_event`'s shared event
//! vocabulary until the app wires them onto providers.
//!
//! Threading: the provider opts into `ProviderOptions_UseComThreading`, so
//! UIA calls provider methods directly on arbitrary MTA client threads. All
//! provider state therefore lives behind `Arc<BridgeShared>` (RwLock tree);
//! no callback ever sends to the window or joins a thread, so nothing blocks
//! the main thread. `attach` must run on the window's owning thread (it
//! subclasses the wndproc for `WM_GETOBJECT`) and is enforced fail-closed.

use std::fmt;

use super::accessibility::SemanticsTree;
use super::retained_ui::RetainedUiRole;

/// UIA control types this bridge reports (ids = `UIA_CONTROLTYPE_ID` values).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiaControlType {
    Custom,
    ListItem,
    Image,
    Button,
    Text,
    Pane,
    Group,
}

impl UiaControlType {
    /// Raw `UIA_CONTROLTYPE_ID` clients see in `CurrentControlType`.
    pub fn id(self) -> i32 {
        match self {
            Self::Button => 50000,
            Self::Image => 50006,
            Self::ListItem => 50007,
            Self::Text => 50020,
            Self::Custom => 50025,
            Self::Group => 50026,
            Self::Pane => 50033,
        }
    }
}

/// Legend entries built by `chart_a11y::legend_item_id` carry a `legend:` id
/// prefix and read as list items so the legend announces as a navigable
/// list; everything else maps by role (role None → Custom).
pub fn control_type_for(role: RetainedUiRole, node_id: &str) -> UiaControlType {
    if node_id.starts_with("legend:") {
        return UiaControlType::ListItem;
    }
    match role {
        RetainedUiRole::None => UiaControlType::Custom,
        RetainedUiRole::Text => UiaControlType::Text,
        RetainedUiRole::Img => UiaControlType::Image,
        RetainedUiRole::Button => UiaControlType::Button,
        RetainedUiRole::Region => UiaControlType::Group,
        RetainedUiRole::Application => UiaControlType::Pane,
    }
}

/// The fragment navigation directions UIA queries (`NavigateDirection`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiaNavigateDirection {
    Parent,
    NextSibling,
    PreviousSibling,
    FirstChild,
    LastChild,
}

/// Fail-closed tree navigation: unknown nodes and dangling child/parent ids
/// resolve to `None` instead of guessing a neighbor. `AccessibilityNode`
/// carries no parent pointer, so parents are resolved from the children
/// lists (the retained-UI validator rejects duplicate ids).
pub fn navigate_from(
    tree: &SemanticsTree,
    node_id: &str,
    direction: UiaNavigateDirection,
) -> Option<String> {
    let node = tree.node(node_id)?;
    let existing = |id: &str| tree.node(id).map(|_| id.to_owned());
    match direction {
        UiaNavigateDirection::Parent => parent_of(tree, node_id).and_then(existing),
        UiaNavigateDirection::FirstChild => node.children.first().and_then(|id| existing(id)),
        UiaNavigateDirection::LastChild => node.children.last().and_then(|id| existing(id)),
        UiaNavigateDirection::NextSibling | UiaNavigateDirection::PreviousSibling => {
            let parent = parent_of(tree, node_id)?;
            let parent_node = tree.node(parent)?;
            let position = parent_node.children.iter().position(|id| id == node_id)?;
            let neighbor = match direction {
                UiaNavigateDirection::NextSibling => parent_node.children.get(position + 1),
                _ => position
                    .checked_sub(1)
                    .and_then(|index| parent_node.children.get(index)),
            };
            neighbor.and_then(|id| existing(id))
        }
    }
}

fn parent_of<'a>(tree: &'a SemanticsTree, node_id: &str) -> Option<&'a str> {
    tree.nodes
        .iter()
        .find(|node| node.children.iter().any(|child| child == node_id))
        .map(|node| node.id.as_str())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UiaBridgeError {
    EmptyTree,
    RootMissing,
    CyclicTree,
    NotAttached,
    AlreadyAttached,
    WindowThreadMismatch,
    SubclassFailed,
    LockPoisoned,
    EventFailed(String),
}

impl fmt::Display for UiaBridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyTree => write!(f, "semantics tree has no nodes"),
            Self::RootMissing => write!(f, "semantics tree root id is missing"),
            Self::CyclicTree => write!(f, "semantics tree walk exceeded the node budget (cycle)"),
            Self::NotAttached => write!(f, "UIA bridge is not attached to a window"),
            Self::AlreadyAttached => write!(f, "window already carries a UIA bridge provider"),
            Self::WindowThreadMismatch => {
                write!(
                    f,
                    "attach must be called on the thread that owns the window"
                )
            }
            Self::SubclassFailed => write!(f, "subclassing the window proc failed"),
            Self::LockPoisoned => write!(f, "semantics lock poisoned; refusing to serve UIA"),
            Self::EventFailed(detail) => {
                write!(
                    f,
                    "raising the UIA event failed (is COM initialized on this thread?): {detail}"
                )
            }
        }
    }
}
impl std::error::Error for UiaBridgeError {}

/// Attach/replace-time validation: non-empty, root present, and the DFS walk
/// terminates within the node budget (a cycle would otherwise hang the UIA
/// client's tree walk against the provider).
pub fn validate_semantics(tree: &SemanticsTree) -> Result<(), UiaBridgeError> {
    if tree.nodes.is_empty() {
        return Err(UiaBridgeError::EmptyTree);
    }
    if tree.node(&tree.root_id).is_none() {
        return Err(UiaBridgeError::RootMissing);
    }
    let budget = tree.nodes.len();
    let mut visited = 0usize;
    let mut stack = vec![tree.root_id.clone()];
    while let Some(id) = stack.pop() {
        let Some(node) = tree.node(&id) else { continue };
        visited += 1;
        if visited > budget {
            return Err(UiaBridgeError::CyclicTree);
        }
        for child in node.children.iter().rev() {
            stack.push(child.clone());
        }
    }
    Ok(())
}

#[cfg(windows)]
mod os {
    use std::panic::{AssertUnwindSafe, catch_unwind};
    use std::sync::{Arc, Mutex, RwLock};
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::{
        E_NOTIMPL, E_UNEXPECTED, HANDLE, HWND, LPARAM, LRESULT, VARIANT_BOOL, VARIANT_TRUE, WPARAM,
    };
    use windows::Win32::System::Com::SAFEARRAY;
    use windows::Win32::System::Ole::{
        SafeArrayCreateVector, SafeArrayDestroy, SafeArrayPutElement,
    };
    use windows::Win32::System::Variant::{
        VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_BOOL, VT_BSTR, VT_I4,
    };
    use windows::Win32::UI::Accessibility as uia;
    use windows::Win32::UI::WindowsAndMessaging as wm;
    use windows::core::{BSTR, ComObject, ComObjectInner, Error as ComError, implement};

    use super::{
        UiaBridgeError, UiaNavigateDirection, control_type_for, navigate_from, validate_semantics,
    };
    use crate::native_ui::accessibility::{AccessibilityNode, SemanticsTree};
    use crate::native_ui::retained_ui::RetainedUiRole;

    const EVENT_THROTTLE: Duration = Duration::from_millis(100);
    /// UIA_E_ELEMENTNOTAVAILABLE — fail-closed reply for stale nodes whose
    /// tree was swapped out from under them.
    const UIA_E_ELEMENTNOTAVAILABLE: i32 = 0x8004_0201u32 as i32;

    struct BridgeShared {
        hwnd: isize,
        semantics: RwLock<SemanticsTree>,
        last_event: Mutex<Option<Instant>>,
    }

    /// One provider object for any tree node; the root doubles as the
    /// fragment root. Nodes whose id vanished from a swapped-in tree answer
    /// UIA_E_ELEMENTNOTAVAILABLE instead of fabricating data.
    #[implement(
        uia::IRawElementProviderSimple,
        uia::IRawElementProviderFragment,
        uia::IRawElementProviderFragmentRoot
    )]
    struct NodeProvider {
        shared: Arc<BridgeShared>,
        node_id: String,
    }

    fn node_provider(shared: &Arc<BridgeShared>, node_id: String) -> ComObject<NodeProvider> {
        NodeProvider {
            shared: shared.clone(),
            node_id,
        }
        .into_object()
    }

    /// COM 边界护栏:UIA 回调里的 panic 会穿越 extern "system" 直接 abort 进程,
    /// 因此每个回调体都收进 catch_unwind,失败路径回一个失败 HRESULT。
    fn guard<T>(op: impl FnOnce() -> ComResult<T>) -> ComResult<T> {
        catch_unwind(AssertUnwindSafe(op))
            .unwrap_or_else(|_| Err(ComError::from_hresult(E_UNEXPECTED)))
    }

    type ComResult<T> = windows::core::Result<T>;

    fn not_available() -> ComError {
        ComError::from_hresult(windows::core::HRESULT(UIA_E_ELEMENTNOTAVAILABLE))
    }

    impl BridgeShared {
        /// Root id snapshot for property answers that must be root-only.
        /// Reads through poison rather than failing: this feeds a property
        /// reply, and a poisoned lock here would wedge the UIA core's probe.
        fn root_id_snapshot(&self) -> String {
            match self.semantics.read() {
                Ok(tree) => tree.root_id.clone(),
                Err(poisoned) => poisoned.into_inner().root_id.clone(),
            }
        }
    }

    fn read_tree(
        shared: &BridgeShared,
    ) -> ComResult<std::sync::RwLockReadGuard<'_, SemanticsTree>> {
        shared.semantics.read().map_err(|_| not_available())
    }

    impl uia::IRawElementProviderSimple_Impl for NodeProvider_Impl {
        fn ProviderOptions(&self) -> ComResult<uia::ProviderOptions> {
            // Server-side provider owned by this process. UseComThreading is
            // deliberately NOT set: in-process clients then serve provider
            // calls through the owning thread like every mainstream UIA
            // app does; the tree stays behind a lock so MTA callers (e.g.
            // property cache warming) are safe regardless.
            Ok(uia::ProviderOptions_ServerSideProvider)
        }

        fn GetPatternProvider(
            &self,
            _patternid: uia::UIA_PATTERN_ID,
        ) -> ComResult<windows::core::IUnknown> {
            // No patterns wired yet: S_OK + NULL retval (Err(Error::empty())
            // returns S_OK without writing the out param — the AccessKit-
            // proven convention for "nothing here").
            Err(ComError::empty())
        }

        fn GetPropertyValue(&self, propertyid: uia::UIA_PROPERTY_ID) -> ComResult<VARIANT> {
            guard(|| {
                let node = self.snapshot()?;
                Ok(match propertyid {
                    uia::UIA_NamePropertyId => {
                        node.name.as_deref().map(variant_bstr).unwrap_or_default()
                    }
                    uia::UIA_ControlTypePropertyId => {
                        variant_i4(control_type_for(node.role, &node.id).id())
                    }
                    uia::UIA_ValueValuePropertyId => {
                        node.value.as_deref().map(variant_bstr).unwrap_or_default()
                    }
                    uia::UIA_FrameworkIdPropertyId => variant_bstr("DeepEngine"),
                    uia::UIA_IsControlElementPropertyId | uia::UIA_IsContentElementPropertyId => {
                        variant_bool(true)
                    }
                    uia::UIA_IsKeyboardFocusablePropertyId => {
                        variant_bool(node.role == RetainedUiRole::Button)
                    }
                    uia::UIA_ProcessIdPropertyId => variant_i4(std::process::id() as i32),
                    // UIA core pins a WM_GETOBJECT provider to its HWND through
                    // this property; without it the element collapses to the
                    // default window proxy and the tree is invisible.
                    uia::UIA_NativeWindowHandlePropertyId => {
                        if node.id == self.shared.root_id_snapshot() {
                            variant_i4(self.shared.hwnd as i32)
                        } else {
                            VARIANT::default()
                        }
                    }
                    _ => VARIANT::default(),
                })
            })
        }

        fn HostRawElementProvider(&self) -> ComResult<uia::IRawElementProviderSimple> {
            // Plain Win32 window: no host HWND provider to delegate to.
            Err(ComError::empty())
        }
    }

    impl uia::IRawElementProviderFragment_Impl for NodeProvider_Impl {
        fn Navigate(
            &self,
            direction: uia::NavigateDirection,
        ) -> ComResult<uia::IRawElementProviderFragment> {
            guard(|| {
                let next = {
                    let tree = read_tree(&self.shared)?;
                    navigate_from(&tree, &self.node_id, map_direction(direction))
                };
                let Some(next) = next else {
                    return Err(ComError::empty());
                };
                Ok(node_provider(&self.shared, next).into_interface())
            })
        }

        fn GetRuntimeId(&self) -> ComResult<*mut SAFEARRAY> {
            guard(|| {
                self.snapshot()?;
                let runtime_id = runtime_id_for(&self.node_id);
                safe_array_i32(&[uia::UiaAppendRuntimeId as i32, runtime_id])
            })
        }

        fn BoundingRectangle(&self) -> ComResult<uia::UiaRect> {
            // Layout geometry is not wired into the semantics tree yet; a
            // zero rect reports "no bounds" instead of a wrong rectangle.
            guard(|| Ok(uia::UiaRect::default()))
        }

        fn GetEmbeddedFragmentRoots(&self) -> ComResult<*mut SAFEARRAY> {
            guard(|| Err(ComError::empty()))
        }

        fn SetFocus(&self) -> ComResult<()> {
            // Focus routing needs the app-side action vocabulary; until then
            // report unsupported instead of lying about a focus change.
            guard(|| Err(ComError::from_hresult(E_NOTIMPL)))
        }

        fn FragmentRoot(&self) -> ComResult<uia::IRawElementProviderFragmentRoot> {
            guard(|| {
                let root_id = {
                    let tree = read_tree(&self.shared)?;
                    tree.root_id.clone()
                };
                Ok(node_provider(&self.shared, root_id).into_interface())
            })
        }
    }

    impl uia::IRawElementProviderFragmentRoot_Impl for NodeProvider_Impl {
        fn ElementProviderFromPoint(
            &self,
            _x: f64,
            _y: f64,
        ) -> ComResult<uia::IRawElementProviderFragment> {
            // No hit-test geometry in the semantics tree: let UIA fall back
            // to window-level defaults rather than claim a wrong element.
            guard(|| Err(ComError::empty()))
        }

        fn GetFocus(&self) -> ComResult<uia::IRawElementProviderFragment> {
            // NULL + S_OK: UIA falls back to the OS focus on the HWND.
            guard(|| Err(ComError::empty()))
        }
    }

    impl NodeProvider {
        /// Snapshot of this node, fail-closed once its id is gone.
        fn snapshot(&self) -> ComResult<AccessibilityNode> {
            let tree = read_tree(&self.shared)?;
            tree.node(&self.node_id).cloned().ok_or_else(not_available)
        }
    }

    fn map_direction(direction: uia::NavigateDirection) -> UiaNavigateDirection {
        if direction == uia::NavigateDirection_Parent {
            UiaNavigateDirection::Parent
        } else if direction == uia::NavigateDirection_NextSibling {
            UiaNavigateDirection::NextSibling
        } else if direction == uia::NavigateDirection_PreviousSibling {
            UiaNavigateDirection::PreviousSibling
        } else if direction == uia::NavigateDirection_FirstChild {
            UiaNavigateDirection::FirstChild
        } else {
            UiaNavigateDirection::LastChild
        }
    }

    /// Deterministic per-node runtime id (stable across provider instances so
    /// clients can diff trees without phantom churn).
    fn runtime_id_for(node_id: &str) -> i32 {
        let mut hash: u32 = 0x811c_9dc5;
        for byte in node_id.as_bytes() {
            hash ^= u32::from(*byte);
            hash = hash.wrapping_mul(0x0100_0193);
        }
        (hash | 1) as i32
    }

    fn safe_array_i32(values: &[i32]) -> ComResult<*mut SAFEARRAY> {
        let array = unsafe { SafeArrayCreateVector(VT_I4, 0, values.len() as u32) };
        if array.is_null() {
            return Err(ComError::from_hresult(E_UNEXPECTED));
        }
        for (index, value) in values.iter().enumerate() {
            let position = index as i32;
            let write =
                unsafe { SafeArrayPutElement(array, &position, value as *const i32 as *const _) };
            if let Err(error) = write {
                let _ = unsafe { SafeArrayDestroy(array) };
                return Err(error);
            }
        }
        Ok(array)
    }

    fn variant_bstr(value: &str) -> VARIANT {
        VARIANT {
            Anonymous: VARIANT_0 {
                Anonymous: std::mem::ManuallyDrop::new(VARIANT_0_0 {
                    vt: VT_BSTR,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: VARIANT_0_0_0 {
                        bstrVal: std::mem::ManuallyDrop::new(BSTR::from(value)),
                    },
                }),
            },
        }
    }

    fn variant_i4(value: i32) -> VARIANT {
        VARIANT {
            Anonymous: VARIANT_0 {
                Anonymous: std::mem::ManuallyDrop::new(VARIANT_0_0 {
                    vt: VT_I4,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: VARIANT_0_0_0 { lVal: value },
                }),
            },
        }
    }

    fn variant_bool(value: bool) -> VARIANT {
        VARIANT {
            Anonymous: VARIANT_0 {
                Anonymous: std::mem::ManuallyDrop::new(VARIANT_0_0 {
                    vt: VT_BOOL,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: VARIANT_0_0_0 {
                        boolVal: if value { VARIANT_TRUE } else { VARIANT_BOOL(0) },
                    },
                }),
            },
        }
    }

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
        // SAFETY: the pointer was created by Box::into_raw in `attach` and
        // every other accessor treats it as borrowed only.
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
            // UIA 根发现:核心先用 UiaRootObjectId(-25) 探测、再用
            // OBJID_CLIENT(-4) 取 provider。只有这两个对象 id 属于我们,
            // 其余(原生控件 id 等)必须交还默认 proc。
            let object_id = lparam.0 as u32;
            let is_root_query = object_id == uia::UiaRootObjectId as u32;
            let is_client_query = object_id == 0xFFFF_FFFCu32;
            if is_root_query || is_client_query {
                // SAFETY: payload is a valid Box allocation owned by the prop.
                let provider = unsafe { (*payload).provider.clone() };
                return unsafe {
                    uia::UiaReturnRawElementProvider(hwnd, wparam, lparam, &provider)
                };
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
            // Fail closed: subclassing from a foreign thread corrupts the
            // message-loop ownership model.
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
            let root_id = {
                let tree = shared
                    .semantics
                    .read()
                    .map_err(|_| UiaBridgeError::LockPoisoned)?;
                tree.root_id.clone()
            };
            let provider: uia::IRawElementProviderSimple =
                node_provider(&shared, root_id).into_interface();
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

        /// Swap the semantics tree (package change) and notify UIA with a
        /// structure-changed event. Stale per-node providers fail closed.
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

        /// Notify UIA that node properties changed (focus/value updates the
        /// app wants surfaced without a structural change).
        pub fn raise_property_changed(&self) -> Result<(), UiaBridgeError> {
            let active = self.active.as_ref().ok_or(UiaBridgeError::NotAttached)?;
            let root_id = {
                let tree = active
                    .shared
                    .semantics
                    .read()
                    .map_err(|_| UiaBridgeError::LockPoisoned)?;
                tree.root_id.clone()
            };
            self.raise(active, root_id, uia::UIA_AutomationPropertyChangedEventId)
        }

        pub fn is_attached(&self) -> bool {
            self.active.is_some()
        }

        /// Idempotent: a second call (or Drop after a WM_DESTROY cleanup) is
        /// a no-op and still reports success.
        pub fn detach(&mut self) -> Result<(), UiaBridgeError> {
            let Some(active) = self.active.take() else {
                return Ok(());
            };
            // Restore the proc only while it is still ours; if the window was
            // destroyed the subclass is already gone.
            let ours = unsafe { wm::GetWindowLongPtrW(active.hwnd, wm::GWLP_WNDPROC) }
                == bridge_proc_ptr();
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
            // Requires COM initialization on the calling thread; surfaces as
            // an error, never a panic. Events are raised after the tree lock
            // is released — UIA may re-enter properties synchronously.
            unsafe { uia::UiaRaiseAutomationEvent(&provider, event) }
                .map_err(|error| UiaBridgeError::EventFailed(error.to_string()))
        }
    }

    impl Drop for UiaBridge {
        fn drop(&mut self) {
            let _ = self.detach();
        }
    }
}

#[cfg(windows)]
pub use os::UiaBridge;

#[cfg(test)]
#[path = "uia_bridge_tests.rs"]
mod uia_bridge_tests;
