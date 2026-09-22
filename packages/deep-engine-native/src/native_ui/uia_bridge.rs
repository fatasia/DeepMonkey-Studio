//! P1-16: Windows UI Automation bridge contract.
//!
//! The platform-neutral portion owns the semantics-to-UIA mapping and the
//! fail-closed tree rules. The Windows COM provider and HWND lifecycle live in
//! sibling modules so the public contract stays easy to audit.
//!
//! The provider uses `ProviderOptions_ServerSideProvider`, so UIA calls can
//! arrive from client threads while provider state remains behind a lock. No
//! callback sends to the window or joins a thread, so nothing blocks the main
//! thread. `attach` must run on the window's owning thread and is enforced
//! fail-closed.

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
/// list; everything else maps by role (role None -> Custom).
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
#[path = "uia_bridge_windows.rs"]
mod os;

#[cfg(windows)]
pub use os::UiaBridge;

#[cfg(test)]
#[path = "uia_bridge_tests.rs"]
mod uia_bridge_tests;
