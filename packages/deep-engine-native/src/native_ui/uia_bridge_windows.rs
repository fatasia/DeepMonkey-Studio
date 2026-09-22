//! Windows-only UIA COM provider and HWND attachment boundary.

#[path = "uia_bridge_windows/host.rs"]
mod host;
#[path = "uia_bridge_windows/provider.rs"]
mod provider;

pub use host::UiaBridge;
pub(super) use provider::{BridgeShared, node_provider, root_id};
