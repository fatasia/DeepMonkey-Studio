pub(super) fn same_value(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    if a == b {
        return true;
    }
    // Large integer category IDs cannot be compared by first rounding to f64.
    let integer = |value: &serde_json::Value| {
        value
            .as_i64()
            .map(i128::from)
            .or_else(|| value.as_u64().map(i128::from))
    };
    match (integer(a), integer(b)) {
        (Some(a), Some(b)) => return a == b,
        (Some(value), None) | (None, Some(value)) if value.abs() > 9_007_199_254_740_992 => {
            return false;
        }
        _ => {}
    }
    match (a.as_f64(), b.as_f64()) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}
