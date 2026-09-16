//! SVG path 基本指令子集解析:封闭支持矩阵,fail-closed。
//!
//! ## 支持矩阵(明确列出,其余一律拒绝,不猜测)
//!
//! | 指令 | 含义 | 形态 |
//! |---|---|---|
//! | `M` / `m` | moveto(绝对 / 相对) | 一组 `(x, y)` |
//! | `L` / `l` | lineto(绝对 / 相对) | 一组 `(x, y)` |
//! | `H` / `h` | 水平 lineto | 一个数 |
//! | `V` / `v` | 垂直 lineto | 一个数 |
//! | `Z` / `z` | 闭合子路径 | 无参数 |
//!
//! - **拒绝**(显式原因):`C c S s Q q T t`(曲线)、`A a`(圆弧)、任何其他字符;
//! - **不支持隐式坐标组重复**:每条指令后恰有一组坐标(`M 1 1 2 2` 被拒);
//! - **不支持隐式小数切分**(`1.5.5` 被拒,解析即失败);
//! - 数值必须可解析、有限,且绝对值 ≤ `MAX_DRAW_VALUE`(与 Deep2d 一致);
//! - 子路径必须以 `M`/`m` 开头;`Z` 之后 current point 回到子路径起点。

use crate::deep2d::Deep2dPathVerb;

use super::validate::MAX_DRAW_VALUE;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Token {
    Command(char),
    Number(f64),
}

/// 把 path data 解析为 Deep2d 路径动词;任何越界情况返回显式原因。
pub fn parse_svg_path_subset(data: &str) -> Result<Vec<Deep2dPathVerb>, String> {
    let tokens = tokenize(data)?;
    let mut verbs = Vec::new();
    let mut current = (0.0_f64, 0.0_f64);
    let mut subpath_start = (0.0_f64, 0.0_f64);
    let mut has_move = false;
    let mut index = 0;
    while index < tokens.len() {
        let Token::Command(command) = tokens[index] else {
            return Err("path data must alternate command letters and coordinates".into());
        };
        index += 1;
        if !matches!(
            command,
            'M' | 'm' | 'L' | 'l' | 'H' | 'h' | 'V' | 'v' | 'Z' | 'z'
        ) {
            return Err(format!(
                "unsupported svg path command '{command}' (supported subset: M m L l H h V v Z z)"
            ));
        }
        match command {
            'M' | 'm' | 'L' | 'l' => {
                let (x, y) = pair(&tokens, &mut index, command)?;
                let absolute = (x, y);
                let point = if command.is_ascii_lowercase() {
                    (current.0 + x, current.1 + y)
                } else {
                    absolute
                };
                if matches!(command, 'M' | 'm') {
                    verbs.push(Deep2dPathVerb::Move {
                        x: point.0,
                        y: point.1,
                    });
                    subpath_start = point;
                    has_move = true;
                } else {
                    require_move(has_move, command)?;
                    verbs.push(Deep2dPathVerb::Line {
                        x: point.0,
                        y: point.1,
                    });
                }
                current = point;
            }
            'H' | 'h' => {
                let x = number(&tokens, &mut index, command)?;
                require_move(has_move, command)?;
                current = if command == 'h' {
                    (current.0 + x, current.1)
                } else {
                    (x, current.1)
                };
                verbs.push(Deep2dPathVerb::Line {
                    x: current.0,
                    y: current.1,
                });
            }
            'V' | 'v' => {
                let y = number(&tokens, &mut index, command)?;
                require_move(has_move, command)?;
                current = if command == 'v' {
                    (current.0, current.1 + y)
                } else {
                    (current.0, y)
                };
                verbs.push(Deep2dPathVerb::Line {
                    x: current.0,
                    y: current.1,
                });
            }
            _ => {
                // 'Z' | 'z'
                require_move(has_move, command)?;
                verbs.push(Deep2dPathVerb::Close);
                current = subpath_start;
            }
        }
        if matches!(tokens.get(index), Some(Token::Number(_))) {
            return Err(format!(
                "implicit coordinate repetition after '{command}' is not supported (each command takes exactly one coordinate group)"
            ));
        }
    }
    if verbs.is_empty() {
        return Err("path data contains no drawing commands".into());
    }
    Ok(verbs)
}

fn require_move(has_move: bool, command: char) -> Result<(), String> {
    if has_move {
        Ok(())
    } else {
        Err(format!(
            "subpath must start with 'M' or 'm' before '{command}'"
        ))
    }
}

/// 消费一组 `(x, y)` 坐标。
fn pair(tokens: &[Token], index: &mut usize, command: char) -> Result<(f64, f64), String> {
    let x = number(tokens, index, command)?;
    let y = number(tokens, index, command)?;
    Ok((x, y))
}

fn number(tokens: &[Token], index: &mut usize, command: char) -> Result<f64, String> {
    let Some(Token::Number(value)) = tokens.get(*index).copied() else {
        return Err(format!("command '{command}' requires a numeric argument"));
    };
    *index += 1;
    Ok(value)
}

fn tokenize(data: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let mut chars = data.chars().peekable();
    while let Some(&ch) = chars.peek() {
        if ch.is_whitespace() || ch == ',' {
            chars.next();
            continue;
        }
        if ch.is_ascii_alphabetic() {
            chars.next();
            tokens.push(Token::Command(ch));
            continue;
        }
        if !(ch.is_ascii_digit() || matches!(ch, '+' | '-' | '.')) {
            return Err(format!("unexpected character '{ch}' in path data"));
        }
        let mut text = String::new();
        while let Some(&ch) = chars.peek() {
            if ch.is_ascii_digit() || matches!(ch, '+' | '-' | '.' | 'e' | 'E') {
                text.push(ch);
                chars.next();
            } else {
                break;
            }
        }
        let value: f64 = text
            .parse()
            .map_err(|_| format!("'{text}' is not a valid path number"))?;
        if !value.is_finite() || value.abs() > MAX_DRAW_VALUE {
            return Err(format!(
                "path number '{text}' is not finite within ±{MAX_DRAW_VALUE}"
            ));
        }
        tokens.push(Token::Number(value));
    }
    Ok(tokens)
}
