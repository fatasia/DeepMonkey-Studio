use super::primitives::symbol;

pub(super) fn contains_entry_point(source: &str, stage: &str, name: &str) -> bool {
    if !symbol(name) {
        return false;
    }
    let mut code = source.as_bytes().to_vec();
    let mut index = 0;
    let mut block_depth = 0_u32;
    let mut quote = None;
    while index < code.len() {
        let current = code[index];
        let next = code.get(index + 1).copied();
        if block_depth > 0 {
            if current == b'/' && next == Some(b'*') {
                block_depth += 1;
                erase_pair(&mut code, index);
                index += 2;
                continue;
            }
            if current == b'*' && next == Some(b'/') {
                block_depth -= 1;
                erase_pair(&mut code, index);
                index += 2;
                continue;
            }
            erase_unless_newline(&mut code[index]);
            index += 1;
            continue;
        }
        if let Some(mark) = quote {
            if current == b'\\' {
                erase_pair(&mut code, index);
                index += 2;
                continue;
            }
            if current == mark {
                quote = None;
            }
            erase_unless_newline(&mut code[index]);
            index += 1;
            continue;
        }
        if current == b'/' && next == Some(b'/') {
            while index < code.len() && code[index] != b'\n' {
                code[index] = b' ';
                index += 1;
            }
            continue;
        }
        if current == b'/' && next == Some(b'*') {
            block_depth = 1;
            erase_pair(&mut code, index);
            index += 2;
            continue;
        }
        if current == b'"' || current == b'\'' {
            quote = Some(current);
            code[index] = b' ';
        }
        index += 1;
    }
    let compact = String::from_utf8_lossy(&code)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let pattern = format!("@{stage} fn {name}");
    compact.contains(&format!("{pattern}(")) || compact.contains(&format!("{pattern} ("))
}

fn erase_pair(code: &mut [u8], index: usize) {
    code[index] = b' ';
    if index + 1 < code.len() {
        code[index + 1] = b' ';
    }
}

fn erase_unless_newline(value: &mut u8) {
    if *value != b'\n' {
        *value = b' ';
    }
}

#[cfg(test)]
mod tests {
    use super::contains_entry_point;

    #[test]
    fn sees_real_entry_points_with_comments_between_tokens() {
        let source = "@vertex /* note */ fn deepVertex /* note */ () {}";
        assert!(contains_entry_point(source, "vertex", "deepVertex"));
    }

    #[test]
    fn ignores_line_nested_block_and_quoted_forgeries() {
        for source in [
            "// @vertex fn deepVertex() {}",
            "/* outer /* @vertex fn deepVertex() {} */ end */",
            "let forged = \"@vertex fn deepVertex()\";",
            "let forged = '@vertex fn deepVertex()';",
        ] {
            assert!(!contains_entry_point(source, "vertex", "deepVertex"));
        }
    }
}
