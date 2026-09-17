//! P1-16 smoke (`--smoke-uia`): attaches a `UiaBridge` to a real Win32
//! window, then walks it from the CLIENT side with an in-process
//! `CUIAutomation` (MTA worker — the same topology as Narrator) and asserts
//! node count, names, and control types. 真实 Narrator 朗读验证属于后续人工
//! 步骤;WPF/WebView 内容不在范围内。

use std::sync::mpsc;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HINSTANCE, HWND};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED, CoCreateInstance,
    CoInitializeEx,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation, TreeScope_Subtree};
use windows::Win32::UI::WindowsAndMessaging as wm;
use windows::core::w;

use super::accessibility::{SemanticsTree, build_semantics_tree};
use super::chart_a11y::{
    LegendCommand, LegendItemSnapshot, LegendSnapshot, legend_item_id, legend_semantics_tree,
};
use super::retained_ui::{
    RETAINED_UI_SCHEMA_VERSION, RetainedUiA11y, RetainedUiAlign, RetainedUiContent,
    RetainedUiLayoutMode, RetainedUiNode, RetainedUiPointerEvents, RetainedUiRole, RetainedUiStyle,
    RetainedUiTree,
};
use super::uia_bridge::{UiaBridge, control_type_for};

/// Root pane + chart region + merged legend subtree (2 items) + status text.
const EXPECTED_NODE_COUNT: usize = 6;

fn smoke_semantics_tree() -> Result<SemanticsTree, String> {
    let items = vec![
        LegendItemSnapshot {
            id: legend_item_id(0, &LegendCommand::Toggle("series-a".into())),
            label: "Series A".into(),
            hidden: false,
            rect: [0.0, 0.0, 12.0, 12.0],
            command: LegendCommand::Toggle("series-a".into()),
        },
        LegendItemSnapshot {
            id: legend_item_id(0, &LegendCommand::Toggle("series-b".into())),
            label: "Series B".into(),
            hidden: true,
            rect: [12.0, 0.0, 12.0, 12.0],
            command: LegendCommand::Toggle("series-b".into()),
        },
    ];
    let legend = LegendSnapshot {
        page: 0,
        pages: 2,
        zoom_window: (0.0, 1.0),
        items,
    };
    // The legend subtree comes from the SAME producer the app uses — the
    // smoke validates the real semantics pipeline, not a bespoke fixture.
    let legend_tree =
        legend_semantics_tree(&legend).map_err(|error| format!("legend semantics: {error:?}"))?;

    let style = RetainedUiStyle {
        layout: RetainedUiLayoutMode::Absolute,
        x: 0.0,
        y: 0.0,
        width: 100.0,
        height: 100.0,
        min_width: None,
        max_width: None,
        min_height: None,
        max_height: None,
        padding: 0.0,
        gap: 0.0,
        grow: 0.0,
        align: RetainedUiAlign::Start,
        clip: false,
        visible: true,
        opacity: 1.0,
        pointer_events: RetainedUiPointerEvents::Auto,
        z_index: 0,
        background: None,
        foreground: [1.0; 4],
        border_color: None,
        border_width: 0.0,
        corner_radius: 0.0,
        font_id: None,
        font_size: 14.0,
    };
    let legend_root = legend_tree.root_id.clone();
    let root = RetainedUiNode {
        id: "root".into(),
        revision: 0,
        parent_id: None,
        children: vec!["chart-view".into(), "status".into(), legend_root],
        style: style.clone(),
        content: RetainedUiContent::Container,
        a11y: RetainedUiA11y {
            role: RetainedUiRole::Application,
            label: Some("Deep Engine".into()),
            value: None,
        },
    };
    let retained = RetainedUiTree {
        schema_version: RETAINED_UI_SCHEMA_VERSION,
        id: "uia-smoke".into(),
        revision: 1,
        width: 100.0,
        height: 100.0,
        root_id: "root".into(),
        nodes: vec![
            root,
            RetainedUiNode {
                id: "chart-view".into(),
                revision: 0,
                parent_id: Some("root".into()),
                children: Vec::new(),
                style: style.clone(),
                content: RetainedUiContent::Chart {
                    chart_spec_id: "uia-smoke-chart".into(),
                },
                a11y: RetainedUiA11y {
                    role: RetainedUiRole::None,
                    label: Some("电池产量趋势图".into()),
                    value: None,
                },
            },
            RetainedUiNode {
                id: "status".into(),
                revision: 0,
                parent_id: Some("root".into()),
                children: Vec::new(),
                style,
                content: RetainedUiContent::Text {
                    text: "就绪".into(),
                },
                a11y: RetainedUiA11y {
                    role: RetainedUiRole::Text,
                    label: Some("状态".into()),
                    value: Some("就绪".into()),
                },
            },
        ],
    };
    let mut main =
        build_semantics_tree(&retained).map_err(|error| format!("semantics build: {error:?}"))?;
    main.nodes.extend(legend_tree.nodes);
    Ok(main)
}

fn control_type_label(id: i32) -> &'static str {
    match id {
        50000 => "Button",
        50006 => "Image",
        50007 => "ListItem",
        50020 => "Text",
        50025 => "Custom",
        50026 => "Group",
        50033 => "Pane",
        _ => "Unknown",
    }
}

fn expected_rows(tree: &SemanticsTree) -> Vec<(i32, String)> {
    tree.walk_ids()
        .into_iter()
        .filter_map(|id| {
            let node = tree.node(&id)?;
            Some((control_type_for(node.role, &id).id(), node.name.clone()?))
        })
        .collect()
}

/// Client-side walk on a worker MTA thread — the topology real AT clients
/// use; WM_GETOBJECT crosses to the window thread, which pumps below.
fn walk_from_client(hwnd: isize) -> Result<Vec<(i32, String)>, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    };
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
            .map_err(|error| format!("CoCreateInstance(CUIAutomation): {error}"))?;
    let element = unsafe { automation.ElementFromHandle(HWND(hwnd as *mut _)) }
        .map_err(|error| format!("ElementFromHandle: {error}"))?;
    let condition = unsafe { automation.CreateTrueCondition() }
        .map_err(|error| format!("CreateTrueCondition: {error}"))?;
    let found = unsafe { element.FindAll(TreeScope_Subtree, &condition) }
        .map_err(|error| format!("FindAll(subtree): {error}"))?;
    let count = unsafe { found.Length() }.map_err(|error| format!("Length: {error}"))?;
    let mut rows = Vec::new();
    for index in 0..count {
        let item = unsafe { found.GetElement(index) }
            .map_err(|error| format!("GetElement({index}): {error}"))?;
        let control_type = unsafe { item.CurrentControlType() }
            .map_err(|error| format!("ControlType: {error}"))?;
        let name = unsafe { item.CurrentName() }.map_err(|error| format!("Name: {error}"))?;
        rows.push((control_type.0, name.to_string()));
    }
    Ok(rows)
}

/// windows-rs 把 DefWindowProcW 包装成普通 Rust fn,WNDCLASSEXW 需要裸
/// extern "system" 签名,这里垫一层。
unsafe extern "system" fn smoke_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    unsafe { wm::DefWindowProcW(hwnd, msg, wparam, lparam) }
}

unsafe fn create_smoke_window() -> Result<HWND, String> {
    let class_name = w!("DeepEngineUiaSmokeClass");
    let hinstance =
        unsafe { GetModuleHandleW(None) }.map_err(|error| format!("GetModuleHandleW: {error}"))?;
    let class = wm::WNDCLASSEXW {
        cbSize: std::mem::size_of::<wm::WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(smoke_wndproc),
        hInstance: HINSTANCE(hinstance.0),
        lpszClassName: class_name,
        ..Default::default()
    };
    if unsafe { wm::RegisterClassExW(&class) } == 0 {
        return Err("RegisterClassExW failed".into());
    }
    unsafe {
        wm::CreateWindowExW(
            wm::WINDOW_EX_STYLE(0),
            class_name,
            w!("Deep Engine UIA Smoke"),
            wm::WS_OVERLAPPEDWINDOW,
            wm::CW_USEDEFAULT,
            wm::CW_USEDEFAULT,
            480,
            320,
            None,
            None,
            Some(HINSTANCE(hinstance.0)),
            None,
        )
    }
    .map_err(|error| format!("CreateWindowExW: {error}"))
}

fn pump() {
    let mut message = wm::MSG::default();
    unsafe {
        while wm::PeekMessageW(&mut message, None, 0, 0, wm::PM_REMOVE).as_bool() {
            let _ = wm::TranslateMessage(&message);
            wm::DispatchMessageW(&message);
        }
    }
}

pub fn run_uia_smoke() -> Result<String, String> {
    let tree = smoke_semantics_tree()?;
    let expected = expected_rows(&tree);
    if expected.len() != EXPECTED_NODE_COUNT {
        return Err(format!(
            "uia smoke fixture drifted: expected {EXPECTED_NODE_COUNT} nodes, built {}",
            expected.len()
        ));
    }

    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .map_err(|error| format!("CoInitializeEx(main): {error}"))?;
    let hwnd = unsafe { create_smoke_window() }?;
    let hwnd_value = hwnd.0 as isize;
    let mut bridge = UiaBridge::attach(hwnd_value, tree)
        .map_err(|error| format!("UiaBridge::attach: {error}"))?;

    // 换树 + 事件路径也走到:replace 触发 StructureChanged、随后触发
    // PropertyChanged(节流后同一事件窗口只发一次,这里只验证不失败)。
    bridge
        .replace_semantics(smoke_semantics_tree()?)
        .map_err(|error| format!("replace_semantics: {error}"))?;
    bridge
        .raise_property_changed()
        .map_err(|error| format!("raise_property_changed: {error}"))?;

    let (sender, receiver) = mpsc::channel::<Result<Vec<(i32, String)>, String>>();
    std::thread::spawn(move || {
        let _ = sender.send(walk_from_client(hwnd_value));
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut walked = loop {
        if let Ok(result) = receiver.try_recv() {
            break result?;
        }
        pump();
        if Instant::now() > deadline {
            return Err(
                "uia smoke: client walk timed out after 20s — WM_GETOBJECT was never answered by \
                 the window thread"
                    .into(),
            );
        }
        std::thread::sleep(Duration::from_millis(5));
    };

    // detach 幂等 + 清理窗口,全部先于断言(断言失败也不能泄漏窗口)。
    bridge
        .detach()
        .map_err(|error| format!("detach: {error}"))?;
    bridge
        .detach()
        .map_err(|error| format!("second detach must stay idempotent: {error}"))?;
    unsafe { wm::DestroyWindow(hwnd) }.map_err(|error| format!("DestroyWindow: {error}"))?;

    walked.sort();
    // UIA 把默认窗口代理(标题栏/菜单 chrome)与我们的内容树合并暴露;断言
    // 只对内容节点负责:每个期望节点必须原样出现在 walked 里,额外元素只
    // 允许是 OS 窗口 chrome(不属于语义树)。
    let missing: Vec<&(i32, String)> = expected
        .iter()
        .filter(|row| !walked.contains(row))
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "uia smoke missing content nodes {missing:?} in walked tree {walked:?}"
        ));
    }
    if walked.len() < EXPECTED_NODE_COUNT {
        return Err(format!(
            "uia smoke walked {} elements, fewer than the {EXPECTED_NODE_COUNT} content nodes",
            walked.len()
        ));
    }
    // 显式锚点,防止集合包含检查掩盖语义错误。
    for anchor in [
        (50033, "Deep Engine".to_string()),
        (50026, "电池产量趋势图".to_string()),
        (50020, "状态".to_string()),
    ] {
        if !walked.contains(&anchor) {
            return Err(format!("uia smoke missing anchor {anchor:?} in {walked:?}"));
        }
    }
    if !walked
        .iter()
        .any(|(control_type, name)| *control_type == 50007 && name.contains("Series A"))
    {
        return Err(format!(
            "uia smoke: no legend ListItem for 'Series A' in {walked:?}"
        ));
    }

    let chrome = walked.len() - EXPECTED_NODE_COUNT;
    let listed: String = walked
        .iter()
        .map(|(control_type, name)| format!("\n  {} '{}'", control_type_label(*control_type), name))
        .collect();
    Ok(format!(
        "uia smoke OK: {EXPECTED_NODE_COUNT} content nodes enumerated via in-process UIA client \
         (+{chrome} OS window chrome elements, not part of the semantics tree). \
         Narrator 朗读验证留作人工后续步骤:{listed}"
    ))
}
