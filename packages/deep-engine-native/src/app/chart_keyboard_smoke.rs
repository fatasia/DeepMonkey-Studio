//! P1-16 第三批:真实窗口键盘 smoke。
//!
//! 复用生产键盘入口 `window_events::chart_key`(不是复制判定),在真实 GPU 窗口里
//! 按序驱动 Tab 聚焦 → 方向键移动(焦点环跟随) → Enter 激活 → Esc 释放,
//! 每一步都断言**可观察的状态变化**与像素提交事实,而不是「函数返回 true」。
//!
//! 与 CPU 层 `native_ui::chart_a11y` 单测的分工:那层锁定状态机语义,本层锁定
//! 「真实窗口里按键确实走到了生产派发路径并改变了呈现」。
use winit::keyboard::KeyCode;

use super::NativeApp;
use super::window_events::{chart_key, chart_legend_focus};

/// 键盘 smoke 的推进阶段。顺序固定,便于失败时定位到具体一步。
const STAGES: [KeyCode; 6] = [
    KeyCode::Tab,        // 0: 进入图例焦点
    KeyCode::ArrowRight, // 1: 焦点后移(焦点环应跟随)
    KeyCode::ArrowLeft,  // 2: 焦点前移(回到上一项)
    KeyCode::Space,      // 3: 激活当前项(与 Enter 同派发路径)
    KeyCode::Escape,     // 4: 释放焦点
    KeyCode::Tab,        // 5: 再次聚焦,证明释放后可重新进入
];

pub(super) fn advance_smoke(app: &mut NativeApp) -> Result<bool, String> {
    let step = app.chart_key_probe.unwrap_or(0) as usize;
    if step >= STAGES.len() {
        // 收尾校验:释放后重新聚焦必须真的拿到焦点,否则键盘入口是死的。
        if chart_legend_focus().is_some() {
            app.chart_key_probe = None;
            println!("native chart keyboard smoke: tab/move/activate/release/refocus committed");
            return Ok(true);
        }
        return Err("chart keyboard smoke: refocus after release did not take focus".into());
    }
    let key = STAGES[step];
    let before_focus = chart_legend_focus();
    let before_shape = presentation_signature(app);
    let before_hidden = chart_hidden(app);

    if !chart_key(app, key) {
        return Err(format!(
            "chart keyboard smoke: key {key:?} at stage {step} was not handled"
        ));
    }

    // 逐步断言:焦点类按键必须改变焦点;激活类按键必须改变图例语义状态。
    let after_focus = chart_legend_focus();
    // 焦点环只在「焦点存在/不存在」翻转,或焦点索引真的移动时才改变命令集。
    // 图例只有一项时方向键是合法的空操作,不能因此判失败——所以按焦点是否
    // 真的变化来决定是否要求呈现变化,而不是无条件要求。
    let focus_moved = before_focus != after_focus;
    match step {
        0 => {
            if after_focus.is_none() {
                return Err("chart keyboard smoke: Tab did not focus a legend item".into());
            }
        }
        1 | 2 => {
            if after_focus.is_none() {
                return Err(format!("chart keyboard smoke: focus lost after {key:?}"));
            }
        }
        3 => {
            // 图例项激活的语义是**切换系列可见性**(与鼠标点击图例同一条 dispatch),
            // 不是选中数据点;因此断言隐藏集合变化。
            let after_hidden = chart_hidden(app);
            if after_hidden == before_hidden {
                return Err(format!(
                    "chart keyboard smoke: activation did not toggle legend visibility \
                     (hidden stayed {before_hidden:?})"
                ));
            }
        }
        4 => {
            if after_focus.is_some() {
                return Err("chart keyboard smoke: Escape did not release legend focus".into());
            }
        }
        _ => {}
    }
    // 焦点真的变化时,必须能在像素里看到:焦点环增删/移动,形状必然变化。
    // 口径说明:焦点环不改变几何帧 revision(图例层用自己的 revision),
    // 因此比较展示列表的命令形状而不是 revision。
    let after_shape = presentation_signature(app);
    if focus_moved && after_shape == before_shape {
        return Err(format!(
            "chart keyboard smoke: stage {step} ({key:?}) moved focus {before_focus:?} -> {after_focus:?} \
             but the presentation list did not change"
        ));
    }
    println!(
        "native chart keyboard smoke: stage {step} {key:?} focus {before_focus:?} -> {after_focus:?} commands {} -> {}",
        before_shape.0, after_shape.0
    );
    app.chart_key_probe = Some(step as u8 + 1);
    Ok(false)
}

/// 当前被隐藏的系列集合(图例激活的作用对象),排序后比较。
fn chart_hidden(app: &NativeApp) -> Vec<String> {
    app.content
        .active()
        .chart
        .as_ref()
        .map(|chart| {
            let mut hidden = chart.state().hidden_series.to_vec();
            hidden.sort();
            hidden
        })
        .unwrap_or_default()
}

/// 当前展示列表的形状指纹:命令数 + 每条命令的 id 与变换。
///
/// 焦点环的 command id 按**页**命名(`legend.focus-ring.p{page}`),焦点在同一页
/// 内移动时 id 不变、只有几何变——所以指纹必须包含变换/路径资源,否则「环移动了」
/// 会被误判成「没变化」。
fn presentation_signature(app: &NativeApp) -> (usize, Vec<String>) {
    use deep_engine_native::deep2d::Deep2dCommand;
    let Some(content) = app.content.active().deep2d.as_ref() else {
        return (0, Vec::new());
    };
    let list = content.display_list();
    let ids = list
        .commands
        .iter()
        .map(|command| match command {
            Deep2dCommand::Path(path) => format!(
                "{}:{:?}:{}",
                path.id,
                path.transform.map(f64::to_bits),
                path.path_id
            ),
            Deep2dCommand::Text(text) => format!(
                "{}:{:?}:{}",
                text.id,
                text.transform.map(f64::to_bits),
                text.text
            ),
            Deep2dCommand::Image(image) => format!(
                "{}:{:?}:{}",
                image.id,
                image.transform.map(f64::to_bits),
                image.image_id
            ),
        })
        .collect();
    (list.commands.len(), ids)
}
