use deep_engine_native::deep2d::{
    DEEP_2D_DISPLAY_LIST_BUDGETS, Deep2dCommand, Deep2dDisplayList, Deep2dIssueCode,
    validate_display_list,
};
use serde_json::Value;

fn golden_json() -> Value {
    serde_json::from_str(include_str!("../fixtures/deep2d_display_list_v1.json"))
        .expect("golden fixture")
}

fn parse(value: &Value) -> Deep2dDisplayList {
    serde_json::from_value(value.clone()).expect("typed Deep2dDisplayList")
}

#[test]
fn enforces_total_utf16_text_budget_separately_from_per_command_budget() {
    let mut display_list = parse(&golden_json());
    let Deep2dCommand::Text(template) = display_list.commands[1].clone() else {
        panic!("text command")
    };
    display_list.commands = (0..5)
        .map(|index| {
            let mut command = template.clone();
            command.id = format!("text:{index}");
            command.text = "测".repeat(900_000);
            Deep2dCommand::Text(command)
        })
        .collect();
    let result = validate_display_list(&display_list);
    assert_eq!(result.issues.len(), 1);
    assert_eq!(result.issues[0].code, Deep2dIssueCode::BudgetExceeded);
    assert_eq!(result.issues[0].path, "commands");
}

#[test]
fn enforces_per_command_budgets_without_traversing_oversized_clips() {
    let mut display_list = parse(&golden_json());
    let Deep2dCommand::Path(path) = &mut display_list.commands[0] else {
        panic!("path command")
    };
    path.clip_path_ids = Some(vec![
        "missing".into();
        DEEP_2D_DISPLAY_LIST_BUDGETS.clips_per_command + 1
    ]);
    path.dash = Some(vec![1.0; DEEP_2D_DISPLAY_LIST_BUDGETS.dash_entries + 1]);
    let result = validate_display_list(&display_list);
    assert_eq!(
        result
            .issues
            .iter()
            .map(|issue| issue.code)
            .collect::<Vec<_>>(),
        vec![
            Deep2dIssueCode::BudgetExceeded,
            Deep2dIssueCode::InvalidNumber,
        ]
    );
    assert!(
        result
            .issues
            .iter()
            .all(|issue| !issue.path.contains("clipPathIds["))
    );
}

#[test]
fn counts_text_as_utf16_code_units_and_caps_diagnostics() {
    let mut display_list = parse(&golden_json());
    let Deep2dCommand::Text(text) = &mut display_list.commands[1] else {
        panic!("text command")
    };
    text.text = "😀".repeat(DEEP_2D_DISPLAY_LIST_BUDGETS.text_code_units_per_command / 2 + 1);
    assert!(
        validate_display_list(&display_list)
            .issues
            .iter()
            .any(|issue| issue.path == "commands[1].text")
    );

    let template = display_list.commands[2].clone();
    display_list.commands = (0..300)
        .map(|index| {
            let mut command = template.clone();
            let Deep2dCommand::Image(image) = &mut command else {
                unreachable!()
            };
            image.id = "__proto__".into();
            image.image_id = format!("missing:{index}");
            command
        })
        .collect();
    assert_eq!(validate_display_list(&display_list).issues.len(), 256);
}
