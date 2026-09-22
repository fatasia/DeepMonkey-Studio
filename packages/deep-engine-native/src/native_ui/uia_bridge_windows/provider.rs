use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use windows::Win32::Foundation::{E_NOTIMPL, E_UNEXPECTED, VARIANT_BOOL, VARIANT_TRUE};
use windows::Win32::System::Com::SAFEARRAY;
use windows::Win32::System::Ole::{SafeArrayCreateVector, SafeArrayDestroy, SafeArrayPutElement};
use windows::Win32::System::Variant::{
    VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_BOOL, VT_BSTR, VT_I4,
};
use windows::Win32::UI::Accessibility as uia;
use windows::core::{BSTR, ComObject, ComObjectInner, Error as ComError, implement};

use crate::native_ui::accessibility::{AccessibilityNode, SemanticsTree};
use crate::native_ui::retained_ui::RetainedUiRole;
use crate::native_ui::uia_bridge::{
    UiaBridgeError, UiaNavigateDirection, control_type_for, navigate_from,
};

const UIA_E_ELEMENTNOTAVAILABLE: i32 = 0x8004_0201u32 as i32;

pub(crate) struct BridgeShared {
    pub(crate) hwnd: isize,
    pub(crate) semantics: RwLock<SemanticsTree>,
    pub(crate) last_event: Mutex<Option<Instant>>,
}

/// One provider object for any tree node; the root doubles as the fragment
/// root. Nodes whose id vanished from a swapped-in tree answer
/// UIA_E_ELEMENTNOTAVAILABLE instead of fabricating data.
#[implement(
    uia::IRawElementProviderSimple,
    uia::IRawElementProviderFragment,
    uia::IRawElementProviderFragmentRoot
)]
pub(crate) struct NodeProvider {
    shared: Arc<BridgeShared>,
    node_id: String,
}

pub(crate) fn node_provider(
    shared: &Arc<BridgeShared>,
    node_id: String,
) -> ComObject<NodeProvider> {
    NodeProvider {
        shared: shared.clone(),
        node_id,
    }
    .into_object()
}

/// COM boundary guard: a panic in an `extern "system"` UIA callback would
/// abort the process, so callback failures become a failed HRESULT.
fn guard<T>(op: impl FnOnce() -> ComResult<T>) -> ComResult<T> {
    catch_unwind(AssertUnwindSafe(op)).unwrap_or_else(|_| Err(ComError::from_hresult(E_UNEXPECTED)))
}

type ComResult<T> = windows::core::Result<T>;

fn not_available() -> ComError {
    ComError::from_hresult(windows::core::HRESULT(UIA_E_ELEMENTNOTAVAILABLE))
}

impl BridgeShared {
    /// Root id snapshot for property answers that must be root-only.
    /// Reads through poison because a property probe must not wedge UIA.
    fn root_id_snapshot(&self) -> String {
        match self.semantics.read() {
            Ok(tree) => tree.root_id.clone(),
            Err(poisoned) => poisoned.into_inner().root_id.clone(),
        }
    }
}

pub(crate) fn root_id(shared: &BridgeShared) -> Result<String, UiaBridgeError> {
    shared
        .semantics
        .read()
        .map(|tree| tree.root_id.clone())
        .map_err(|_| UiaBridgeError::LockPoisoned)
}

fn read_tree(shared: &BridgeShared) -> ComResult<std::sync::RwLockReadGuard<'_, SemanticsTree>> {
    shared.semantics.read().map_err(|_| not_available())
}

impl uia::IRawElementProviderSimple_Impl for NodeProvider_Impl {
    fn ProviderOptions(&self) -> ComResult<uia::ProviderOptions> {
        // The provider is owned by this process. The tree is behind a lock so
        // MTA clients remain safe without opting into UseComThreading.
        Ok(uia::ProviderOptions_ServerSideProvider)
    }

    fn GetPatternProvider(
        &self,
        _patternid: uia::UIA_PATTERN_ID,
    ) -> ComResult<windows::core::IUnknown> {
        // No patterns wired yet: S_OK + NULL retval.
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
                // UIA pins the WM_GETOBJECT provider to the HWND through this
                // property; otherwise the element collapses to the proxy.
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
        // Layout geometry is not wired into the semantics tree yet; a zero
        // rect reports "no bounds" instead of a wrong rectangle.
        guard(|| Ok(uia::UiaRect::default()))
    }

    fn GetEmbeddedFragmentRoots(&self) -> ComResult<*mut SAFEARRAY> {
        guard(|| Err(ComError::empty()))
    }

    fn SetFocus(&self) -> ComResult<()> {
        // Focus routing needs the app-side action vocabulary.
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
        // No hit-test geometry in the semantics tree.
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

/// Deterministic per-node runtime id, stable across provider instances.
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
