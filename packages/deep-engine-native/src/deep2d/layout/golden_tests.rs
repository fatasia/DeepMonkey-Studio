//! 布局求解黄金用例:确定性钉死(f32 逐位相等),覆盖刀 2 合同的每个性质。
//!
//! 预期值全部由 CSS flexbox 算术解析推导(视口/尺寸/间距全取整数,除 grow
//! 均分用例外不涉及小数);taffy `use_rounding` 的取整语义由 fractional 用例
//! 单独钉住:round 按累计位置取整(x=round, w=round(x+w)-round(x)),
//! 保证兄弟盒共享边无半像素缝。

use super::commands::{to_commands, to_display_list, CommandParams};
use super::solve::{solve, LayoutSolution, TextMeasureInput};
use super::tree::{LayoutBoxVisual, LayoutLeaf, LayoutNode, LayoutTextSpec, LayoutTree, NodeId};
use super::{LayoutAlign, LayoutEdges, LayoutJustify, LayoutStyle, LayoutWrap};
use crate::deep2d::command_types::{BoxShadow, Deep2dCommand, Deep2dPaint};

fn box_node(style: LayoutStyle) -> LayoutNode {
    LayoutNode::box_node(style)
}

fn solve_ok(tree: &LayoutTree, viewport: [f32; 2]) -> LayoutSolution {
    solve(tree, viewport, None).expect("solve must succeed")
}

fn fixed(width: f32, height: f32) -> LayoutStyle {
    LayoutStyle::size(width, height)
}

#[track_caller]
fn assert_rect(solution: &LayoutSolution, id: NodeId, expected: [f32; 4]) {
    let rect = solution.rect(id);
    let actual = [rect.x, rect.y, rect.width, rect.height];
    assert_eq!(
        actual, expected,
        "node {id:?} rect mismatch (bit-exact pin)"
    );
    // 逐位:NaN 不可能出现(校验已拦),f32 相等即逐位相等。
    for (a, b) in actual.iter().zip(expected.iter()) {
        assert_eq!(a.to_bits(), b.to_bits(), "node {id:?} bit drift");
    }
}

#[test]
fn row_fixed_children_pack_from_start() {
    let mut tree = LayoutTree::new(box_node(fixed(200.0, 100.0)));
    let a = tree
        .append(NodeId::ROOT, box_node(fixed(50.0, 20.0)))
        .expect("a");
    let b = tree
        .append(NodeId::ROOT, box_node(fixed(50.0, 20.0)))
        .expect("b");
    let solution = solve_ok(&tree, [200.0, 100.0]);
    assert_rect(&solution, NodeId::ROOT, [0.0, 0.0, 200.0, 100.0]);
    assert_rect(&solution, a, [0.0, 0.0, 50.0, 20.0]);
    assert_rect(&solution, b, [50.0, 0.0, 50.0, 20.0]);
}

#[test]
fn column_stacks_downward_and_fixed_cross_size_beats_stretch() {
    let mut tree = LayoutTree::new(box_node(LayoutStyle {
        direction: super::LayoutDirection::Column,
        ..fixed(200.0, 100.0)
    }));
    let a = tree
        .append(NodeId::ROOT, box_node(fixed(30.0, 10.0)))
        .expect("a");
    let b = tree
        .append(NodeId::ROOT, box_node(fixed(30.0, 20.0)))
        .expect("b");
    let solution = solve_ok(&tree, [200.0, 100.0]);
    // align=stretch 只作用于 auto 交叉尺寸;固定宽 30 不被拉伸。
    assert_rect(&solution, a, [0.0, 0.0, 30.0, 10.0]);
    assert_rect(&solution, b, [0.0, 10.0, 30.0, 20.0]);
}

#[test]
fn flex_grow_divides_free_space_and_rounding_keeps_edges_stitched() {
    let mut tree = LayoutTree::new(box_node(fixed(100.0, 50.0)));
    let mut grow = fixed(0.0, 10.0);
    grow.flex_grow = 1.0;
    let a = tree
        .append(NodeId::ROOT, box_node(grow.clone()))
        .expect("a");
    let b = tree
        .append(NodeId::ROOT, box_node(grow.clone()))
        .expect("b");
    let c = tree.append(NodeId::ROOT, box_node(grow)).expect("c");
    let solution = solve_ok(&tree, [100.0, 50.0]);
    // 100/3 = 33.333334(f32);CSS 取整:x=round(x),w=round(x+w)-round(x):
    // x0=0 w=33;x1=33(33.333334→33)w=34(67-33);x2=67(66.666668→67)w=33(100-67)。
    assert_rect(&solution, a, [0.0, 0.0, 33.0, 10.0]);
    assert_rect(&solution, b, [33.0, 0.0, 34.0, 10.0]);
    assert_rect(&solution, c, [67.0, 0.0, 33.0, 10.0]);
}

#[test]
fn all_six_justify_states_pin_expected_positions() {
    // 4 个 20x10 子节点,容器 200x60,align=Start(交叉轴不拉伸)。
    // 无 gap:自由空间 = 200 - 4*20 = 120,全部整除,解析值无小数。
    let cases: [(&str, LayoutJustify, [f32; 4]); 6] = [
        ("flex-start", LayoutJustify::FlexStart, [0.0, 20.0, 40.0, 60.0]),
        ("flex-end", LayoutJustify::FlexEnd, [120.0, 140.0, 160.0, 180.0]),
        ("center", LayoutJustify::Center, [60.0, 80.0, 100.0, 120.0]),
        ("space-between", LayoutJustify::SpaceBetween, [0.0, 60.0, 120.0, 180.0]),
        ("space-around", LayoutJustify::SpaceAround, [15.0, 65.0, 115.0, 165.0]),
        ("space-evenly", LayoutJustify::SpaceEvenly, [24.0, 68.0, 112.0, 156.0]),
    ];
    for (name, justify, starts) in cases {
        let mut tree = LayoutTree::new(box_node(LayoutStyle {
            justify,
            align_items: LayoutAlign::Start,
            ..fixed(200.0, 60.0)
        }));
        let mut ids = Vec::new();
        for index in 0..4 {
            ids.push(
                tree.append(NodeId::ROOT, box_node(fixed(20.0, 10.0)))
                    .unwrap_or_else(|error| panic!("{name}: {error}")),
            );
        }
        let solution = solve_ok(&tree, [200.0, 60.0]);
        for (id, start) in ids.iter().zip(starts.iter()) {
            assert_rect(&solution, *id, [*start, 0.0, 20.0, 10.0]);
        }
    }
}

#[test]
fn wrap_moves_overflow_to_next_line_and_row_gap_separates_lines() {
    let mut tree = LayoutTree::new(box_node(LayoutStyle {
        wrap: LayoutWrap::Wrap,
        row_gap: 10.0,
        column_gap: 25.0,
        ..fixed(250.0, 100.0)
    }));
    let a = tree
        .append(NodeId::ROOT, box_node(fixed(100.0, 20.0)))
        .expect("a");
    let b = tree
        .append(NodeId::ROOT, box_node(fixed(100.0, 20.0)))
        .expect("b");
    let c = tree
        .append(NodeId::ROOT, box_node(fixed(100.0, 20.0)))
        .expect("c");
    let solution = solve_ok(&tree, [250.0, 100.0]);
    // 行1:100 + gap25 + 100 = 225 ≤ 250。
    // 容器交叉高 definite(100)→ align-content 缺省把行拉伸均分:
    // 每行高 = (100 - row_gap10)/2 = 45;行2 y = 45 + row_gap10 = 55(CSS 语义)。
    assert_rect(&solution, a, [0.0, 0.0, 100.0, 20.0]);
    assert_rect(&solution, b, [125.0, 0.0, 100.0, 20.0]);
    assert_rect(&solution, c, [0.0, 55.0, 100.0, 20.0]);
}

#[test]
fn padding_offsets_children_and_root_margin_offsets_root() {
    let mut tree = LayoutTree::new(LayoutNode::box_node(LayoutStyle {
        padding: LayoutEdges::uniform(10.0),
        ..fixed(100.0, 100.0)
    }));
    let child = tree
        .append(NodeId::ROOT, box_node(fixed(50.0, 20.0)))
        .expect("child");
    let solution = solve_ok(&tree, [100.0, 100.0]);
    // 钉住坐标语义:子 location 相对父 border box 原点,padding 计入偏移。
    assert_rect(&solution, child, [10.0, 10.0, 50.0, 20.0]);

    let mut margined = LayoutTree::new(LayoutNode::box_node(LayoutStyle {
        margin: LayoutEdges {
            top: 4.0,
            left: 6.0,
            ..LayoutEdges::ZERO
        },
        ..fixed(50.0, 50.0)
    }));
    // taffy 根节点语义:根框固定在视口原点,根自身 margin 不位移根框
    // (与 CSS body margin 不同;组件场景根 margin 恒 0,该行为钉死防漂移)。
    let solution = solve(&margined, [100.0, 100.0], None).expect("margined root");
    assert_rect(&solution, NodeId::ROOT, [0.0, 0.0, 50.0, 50.0]);
}

#[test]
fn align_items_states_cross_axis_positions() {
    // 容器 200x60,子 20x20 固定;交叉轴(row → y)四种对齐。
    let cases = [
        (LayoutAlign::Start, 0.0),
        (LayoutAlign::Center, 20.0),
        (LayoutAlign::End, 40.0),
    ];
    for (align, y) in cases {
        let mut tree = LayoutTree::new(box_node(LayoutStyle {
            align_items: align,
            ..fixed(200.0, 60.0)
        }));
        let child = tree
            .append(NodeId::ROOT, box_node(fixed(20.0, 20.0)))
            .expect("child");
        let solution = solve_ok(&tree, [200.0, 60.0]);
        assert_rect(&solution, child, [0.0, y, 20.0, 20.0]);
    }
    // stretch:固定高 20 不被拉伸(auto 高才拉伸)。
    let mut auto_height = LayoutTree::new(box_node(LayoutStyle {
        align_items: LayoutAlign::Stretch,
        ..fixed(200.0, 60.0)
    }));
    let child = auto_height
        .append(NodeId::ROOT, box_node(LayoutStyle {
            width: Some(20.0),
            ..LayoutStyle::new()
        }))
        .expect("child");
    let solution = solve_ok(&auto_height, [200.0, 60.0]);
    // auto 高 + stretch → 拉满容器高(Box leaf 测量恒 0,被 clamp 为 0 后拉伸)。
    assert_rect(&solution, child, [0.0, 0.0, 20.0, 60.0]);
}

#[test]
fn align_self_overrides_container_align() {
    let mut tree = LayoutTree::new(box_node(LayoutStyle {
        align_items: LayoutAlign::Start,
        ..fixed(200.0, 60.0)
    }));
    let child = tree
        .append(
            NodeId::ROOT,
            box_node(LayoutStyle {
                align_self: Some(LayoutAlign::End),
                ..fixed(20.0, 20.0)
            }),
        )
        .expect("child");
    let solution = solve_ok(&tree, [200.0, 60.0]);
    assert_rect(&solution, child, [0.0, 40.0, 20.0, 20.0]);
}

#[test]
fn nested_containers_accumulate_offsets() {
    // 卡片骨架:root(200x120,padding 8,column)→ header(184x24)+ body(row,
    // gap 8)→ icon(16x16)+ text(占位 120x16)。
    let mut tree = LayoutTree::new(LayoutNode::box_node(LayoutStyle {
        direction: super::LayoutDirection::Column,
        padding: LayoutEdges::uniform(8.0),
        ..fixed(200.0, 120.0)
    }));
    let header = tree
        .append(NodeId::ROOT, box_node(fixed(184.0, 24.0)))
        .expect("header");
    let body = tree
        .append(
            NodeId::ROOT,
            box_node(LayoutStyle {
                column_gap: 8.0,
                align_items: LayoutAlign::Center,
                ..fixed(184.0, 80.0)
            }),
        )
        .expect("body");
    let icon = tree
        .append(body, box_node(fixed(16.0, 16.0)))
        .expect("icon");
    let text = tree
        .append(body, box_node(fixed(120.0, 16.0)))
        .expect("text");
    let solution = solve_ok(&tree, [200.0, 120.0]);
    assert_rect(&solution, NodeId::ROOT, [0.0, 0.0, 200.0, 120.0]);
    assert_rect(&solution, header, [8.0, 8.0, 184.0, 24.0]);
    assert_rect(&solution, body, [8.0, 32.0, 184.0, 80.0]);
    // body 交叉轴(y)center:内容高 16,起点 = 32 + (80-16)/2 = 64。
    assert_rect(&solution, icon, [8.0, 64.0, 16.0, 16.0]);
    assert_rect(&solution, text, [8.0 + 16.0 + 8.0, 64.0, 120.0, 16.0]);
}

#[test]
fn text_leaf_measures_through_injected_seam() {
    // align=Start:文本 leaf 的固有尺寸不被交叉轴拉伸(测量接缝的本测试焦点)。
    let mut tree = LayoutTree::new(box_node(LayoutStyle {
        align_items: LayoutAlign::Start,
        ..fixed(100.0, 40.0)
    }));
    let text = tree
        .append(
            NodeId::ROOT,
            LayoutNode::text_node(
                LayoutStyle::new(),
                LayoutTextSpec {
                    text: "指标: 42.5".into(),
                    font_id: "font-main".into(),
                    font_size: 12.0,
                    color: [1.0, 1.0, 1.0, 1.0],
                },
            ),
        )
        .expect("text");
    let mut measure_calls = 0usize;
    let mut saw_intrinsic_call = false;
    let solution = solve(
        &tree,
        [100.0, 40.0],
        Some(&mut |spec: &LayoutTextSpec, input: TextMeasureInput| {
            measure_calls += 1;
            assert_eq!(spec.text, "指标: 42.5");
            // flex 会对同一叶子多次测量:固有尺寸查询 available=MAX_CONTENT
            // (max=None);后续阶段 available 可为已解析的 Definite 值(透传,
            // 具体数值属 taffy 内部阶段,由精确版本+钉死输出兜底)。
            if input.max_width.is_none() {
                saw_intrinsic_call = true;
            }
            [80.0, 14.0]
        }),
    )
    .expect("text solve");
    assert_rect(&solution, text, [0.0, 0.0, 80.0, 14.0]);
    assert!(measure_calls >= 1, "measure invoked at least once");
    assert!(saw_intrinsic_call, "intrinsic (MAX_CONTENT) call must happen");
}

#[test]
fn zero_viewport_solves_without_error_or_nan() {
    // 0x0 视口是合法输入(finite 且非负);固定尺寸仍生效(CSS:定尺寸优先于
    // 可用空间,溢出合法)→ 根保持 100x100,不报错、不 NaN。
    let mut tree = LayoutTree::new(box_node(fixed(100.0, 100.0)));
    tree.append(NodeId::ROOT, box_node(fixed(10.0, 10.0)))
        .expect("child");
    let solution = solve_ok(&tree, [0.0, 0.0]);
    assert_rect(&solution, NodeId::ROOT, [0.0, 0.0, 100.0, 100.0]);
    for rect in &solution.rects {
        assert!(rect.x.is_finite() && rect.y.is_finite());
        assert!(rect.width.is_finite() && rect.height.is_finite());
    }
}

#[test]
fn solve_is_bit_deterministic_across_repeated_runs() {
    let mut tree = LayoutTree::new(box_node(fixed(97.0, 41.0)));
    let mut grow = fixed(13.0, 7.0);
    grow.flex_grow = 1.0;
    grow.margin = LayoutEdges {
        top: 1.0,
        left: 2.0,
        bottom: 3.0,
        right: 4.0,
    };
    for _ in 0..5 {
        tree.append(NodeId::ROOT, box_node(grow.clone()))
            .expect("child");
    }
    let first = solve_ok(&tree, [97.0, 41.0]);
    for _ in 0..8 {
        let again = solve_ok(&tree, [97.0, 41.0]);
        assert_eq!(first.root_size, again.root_size);
        assert_eq!(first.rects.len(), again.rects.len());
        for (a, b) in first.rects.iter().zip(again.rects.iter()) {
            assert_eq!(a.x.to_bits(), b.x.to_bits());
            assert_eq!(a.y.to_bits(), b.y.to_bits());
            assert_eq!(a.width.to_bits(), b.width.to_bits());
            assert_eq!(a.height.to_bits(), b.height.to_bits());
        }
    }
}

#[test]
fn fail_closed_rejects_invalid_input() {
    // 负 padding。
    let mut bad_padding = LayoutTree::new(LayoutNode::box_node(LayoutStyle {
        padding: LayoutEdges::uniform(-1.0),
        ..fixed(10.0, 10.0)
    }));
    let _ = &mut bad_padding;
    let error = solve(&bad_padding, [10.0, 10.0], None).expect_err("negative padding rejected");
    assert!(
        error.contains("padding edge 'top'"),
        "actionable error names the property family: {error}"
    );
    // 非有限视口。
    let tree = LayoutTree::new(box_node(fixed(10.0, 10.0)));
    assert!(solve(&tree, [f32::NAN, 10.0], None).is_err());
    assert!(solve(&tree, [10.0, f32::INFINITY], None).is_err());
    assert!(solve(&tree, [-1.0, 10.0], None).is_err());
    // 非有限样式值。
    let bad_width = LayoutTree::new(box_node(LayoutStyle {
        width: Some(f32::NAN),
        ..LayoutStyle::new()
    }));
    assert!(solve(&bad_width, [10.0, 10.0], None).is_err());
    // 负 flex_grow。
    let bad_grow = LayoutTree::new(box_node(LayoutStyle {
        flex_grow: -0.5,
        ..fixed(10.0, 10.0)
    }));
    assert!(solve(&bad_grow, [10.0, 10.0], None).is_err());
}

#[test]
#[should_panic(expected = "requires a TextMeasurer")]
fn auto_sized_text_without_measurer_fails_closed() {
    let mut tree = LayoutTree::new(box_node(fixed(100.0, 40.0)));
    tree.append(
        NodeId::ROOT,
        LayoutNode::text_node(
            LayoutStyle::new(),
            LayoutTextSpec {
                text: "auto".into(),
                font_id: "font-main".into(),
                font_size: 12.0,
                color: [0.0, 0.0, 0.0, 1.0],
            },
        ),
    )
    .expect("text");
    let _ = solve_ok(&tree, [100.0, 40.0]);
}

#[test]
fn zero_sized_nodes_collapse_without_error() {
    let mut tree = LayoutTree::new(box_node(fixed(100.0, 40.0)));
    let collapsed = tree
        .append(NodeId::ROOT, box_node(fixed(0.0, 10.0)))
        .expect("collapsed");
    let solution = solve_ok(&tree, [100.0, 40.0]);
    assert_rect(&solution, collapsed, [0.0, 0.0, 0.0, 10.0]);
    // 退化盒不产出命令(可见性判定),整树仍可产出。
    let commands = to_commands(
        &tree,
        &solution,
        &CommandParams {
            id_prefix: "probe",
            fonts: &[],
        },
    )
    .expect("commands");
    assert!(commands.is_empty(), "collapsed visual emits nothing");
}

#[test]
fn commands_map_visuals_and_z_order_by_document_order() {
    let mut tree = LayoutTree::new(
        box_node(fixed(200.0, 120.0)).with_visual(LayoutBoxVisual {
            background: Some(Deep2dPaint::Solid([0.1, 0.1, 0.12, 1.0])),
            corner_radius: 12.0,
            ..LayoutBoxVisual::default()
        }),
    );
    let header = tree
        .append(
            NodeId::ROOT,
            box_node(fixed(200.0, 32.0)).with_visual(LayoutBoxVisual {
                background: Some(Deep2dPaint::LinearGradient(
                    crate::deep2d::command_types::LinearGradientPaint {
                        start: [0.0, 0.0],
                        end: [200.0, 0.0],
                        stops: vec![crate::deep2d::command_types::GradientStop {
                            offset: 0.0,
                            color: [0.2, 0.4, 0.9, 1.0],
                        }],
                    },
                )),
                ..LayoutBoxVisual::default()
            }),
        )
        .expect("header");
    let bare = tree
        .append(NodeId::ROOT, box_node(fixed(10.0, 10.0)))
        .expect("bare");
    let solution = solve_ok(&tree, [200.0, 120.0]);
    let commands = to_commands(
        &tree,
        &solution,
        &CommandParams {
            id_prefix: "golden",
            fonts: &[],
        },
    )
    .expect("commands");
    // 两个视觉节点(root、header);bare 无视觉不产出。
    assert_eq!(commands.len(), 2);
    let Deep2dCommand::Path(root_command) = &commands[0] else {
        panic!("root visual is a path");
    };
    assert_eq!(root_command.id, "golden-box-0");
    assert_eq!(root_command.path_id, "golden-rect-0");
    assert_eq!(root_command.z_order, 0);
    assert_eq!(root_command.transform[4], 0.0);
    assert_eq!(root_command.transform[5], 0.0);
    assert_eq!(root_command.corner_radius, Some(12.0));
    let Deep2dCommand::Path(header_command) = &commands[1] else {
        panic!("header visual is a path");
    };
    assert_eq!(header_command.id, "golden-box-1");
    assert_eq!(header_command.z_order, 1);
    assert_eq!(header_command.transform[4], 0.0);
    assert_eq!(header_command.transform[5], 0.0);
    assert!(header_command.corner_radius.is_none());
    assert!(matches!(
        header_command.fill,
        Some(Deep2dPaint::LinearGradient(_))
    ));
    let _ = bare;
}

#[test]
fn display_list_assembles_resources_and_rejects_missing_fonts() {
    // 文本 + 视觉 + 字体齐备 → 资源面完整;字体缺失 → fail-closed。
    let font = crate::deep2d::types::FontResource {
        id: "font-main".into(),
        revision: 1,
        asset_id: "asset:font-main".into(),
        family: "Inter".into(),
        weight: 400,
        style: crate::deep2d::types::FontStyle::Normal,
    };
    let mut tree = LayoutTree::new(
        box_node(fixed(200.0, 60.0)).with_visual(LayoutBoxVisual {
            background: Some(Deep2dPaint::Solid([0.08, 0.09, 0.11, 1.0])),
            corner_radius: 8.0,
            ..LayoutBoxVisual::default()
        }),
    );
    tree.append(
        NodeId::ROOT,
        LayoutNode::text_node(
            LayoutStyle::size(80.0, 14.0),
            LayoutTextSpec {
                text: "你好 deep2d".into(),
                font_id: "font-main".into(),
                font_size: 14.0,
                color: [1.0, 1.0, 1.0, 1.0],
            },
        ),
    )
    .expect("text");
    let solution = solve_ok(&tree, [200.0, 60.0]);
    let params = CommandParams {
        id_prefix: "card",
        fonts: &[font],
    };
    let list = to_display_list(&tree, &solution, "card-golden", 7, &params).expect("display list");
    assert_eq!(list.id, "card-golden");
    assert_eq!(list.revision, 7);
    assert_eq!(list.resources.len(), 2, "1 rect path + 1 font");
    assert_eq!(list.commands.len(), 2);
    assert_eq!(list.logical_width, 200.0);
    assert_eq!(list.logical_height, 60.0);
    // TextCommand 路径同样过冻结校验链(font 引用/预算/色彩规则零改动通过)。
    let validation = crate::deep2d::validate_display_list(&list);
    assert!(
        validation.valid,
        "layout TextCommand must pass frozen validation: {:?}",
        validation.issues
    );

    let missing_font = CommandParams {
        id_prefix: "card",
        fonts: &[],
    };
    let error = to_display_list(&tree, &solution, "card-golden", 7, &missing_font)
        .expect_err("missing font must fail closed");
    assert!(error.contains("font-main"), "actionable error: {error}");
}

#[test]
fn visual_without_background_emits_nothing_and_passes_validation() {
    // 同族排查钉死:挂了 corner_radius/shadow 但无 background 的视觉盒不产出
    // 命令与资源(冻结校验链 EmptyPaint 拒绝无 fill 的 Path 命令)。
    let mut tree = LayoutTree::new(
        box_node(fixed(100.0, 40.0)).with_visual(LayoutBoxVisual {
            corner_radius: 8.0,
            shadow: Some(BoxShadow {
                offset_x: 0.0,
                offset_y: 2.0,
                blur_radius: 4.0,
                spread: 0.0,
                color: [0.0, 0.0, 0.0, 0.5],
                corner_radius: None,
            }),
            ..LayoutBoxVisual::default()
        }),
    );
    tree.append(
        NodeId::ROOT,
        box_node(fixed(20.0, 10.0)).with_visual(LayoutBoxVisual {
            corner_radius: 4.0,
            ..LayoutBoxVisual::default()
        }),
    )
    .expect("child");
    let solution = solve_ok(&tree, [100.0, 40.0]);
    let params = CommandParams {
        id_prefix: "bare",
        fonts: &[],
    };
    let commands = to_commands(&tree, &solution, &params).expect("commands");
    assert!(commands.is_empty(), "paint-less visuals emit nothing");
    let list = to_display_list(&tree, &solution, "bare-golden", 1, &params).expect("list");
    assert!(list.resources.is_empty(), "no orphan rect resources");
}

#[test]
fn invalid_id_prefix_fails_closed() {
    let tree = LayoutTree::new(box_node(fixed(10.0, 10.0)));
    let solution = solve_ok(&tree, [10.0, 10.0]);
    let error = to_commands(
        &tree,
        &solution,
        &CommandParams {
            id_prefix: "bad prefix!",
            fonts: &[],
        },
    )
    .expect_err("invalid prefix rejected");
    assert!(error.contains("id_prefix"), "actionable error: {error}");
}

#[test]
fn leaf_layout_contract_box_without_size_collapses() {
    // Box leaf 无固定尺寸 → 主轴(auto 宽)测量恒 0 → 塌缩;交叉轴 auto 高
    // 被 align=stretch 拉满容器(钉死的确定性语义:视觉节点必须有固定尺寸或 grow)。
    let mut tree = LayoutTree::new(box_node(fixed(100.0, 40.0)));
    let auto = tree
        .append(NodeId::ROOT, box_node(LayoutStyle::new()))
        .expect("auto");
    let solution = solve_ok(&tree, [100.0, 40.0]);
    assert_rect(&solution, auto, [0.0, 0.0, 0.0, 40.0]);
}

#[test]
fn justify_and_gap_together_pin_pixel_layout() {
    // 组合钉死:gap 参与 free space 扣减,分布量叠加在 gap 之上(CSS 语义,
    // taffy compute_alignment_offset:项间 = gap + free/(分布份数))。
    let mut tree = LayoutTree::new(box_node(LayoutStyle {
        justify: LayoutJustify::SpaceEvenly,
        column_gap: 10.0,
        align_items: LayoutAlign::Start,
        ..fixed(120.0, 20.0)
    }));
    let a = tree
        .append(NodeId::ROOT, box_node(fixed(20.0, 10.0)))
        .expect("a");
    let b = tree
        .append(NodeId::ROOT, box_node(fixed(20.0, 10.0)))
        .expect("b");
    let solution = solve_ok(&tree, [120.0, 20.0]);
    // free = 120 - 40(项) - 10(gap) = 70;evenly 每份 = 70/3 = 23.333334:
    // x0 = 23(取整);x1 = 23.333334 + 20 + (10 + 23.333334) = 76.666668 → 77。
    // 取整按累计位置 round(x),兄弟边共享无半像素缝。
    let rect_a = solution.rect(a);
    let rect_b = solution.rect(b);
    assert_eq!(rect_a.x.to_bits(), 23.0f32.to_bits());
    assert_eq!(rect_b.x.to_bits(), 77.0f32.to_bits());
}
