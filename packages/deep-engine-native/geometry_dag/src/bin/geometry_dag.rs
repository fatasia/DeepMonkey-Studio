//! `geometry_dag` CLI — Nanite M2 离线编译工具入口。
//!
//! 用法:
//! ```text
//! geometry_dag build <input.obj> <output.dgc> [--levels N] [--max-triangles N]
//!                                        [--max-vertices N] [--no-compress] [--quiet]
//! geometry_dag info  <input.dgc>
//! geometry_dag verify <input.dgc>
//! ```
//!
//! `build`:OBJ → 簇级 DAG → `.dgc`(输出统计:层数/簇数/耗时/压缩比)。
//! `info`:打印段级摘要,不校验 CRC。
//! `verify`:全量解析 + CRC 校验,成功退出码 0。

use std::process::ExitCode;
use std::time::Instant;

#[derive(Debug)]
enum Command {
    Build {
        input: String,
        output: String,
        options: BuildOptions,
    },
    Info {
        input: String,
    },
    Verify {
        input: String,
    },
}

#[derive(Debug, Default)]
struct BuildOptions {
    levels: Option<u32>,
    max_triangles: Option<u32>,
    max_vertices: Option<u32>,
    compress: bool,
    quiet: bool,
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(&args).and_then(run) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("geometry_dag: error: {message}");
            ExitCode::FAILURE
        }
    }
}

fn usage() -> String {
    "usage: geometry_dag build <in.obj> <out.dgc> [--levels N] [--max-triangles N] [--max-vertices N] [--no-compress] [--quiet]\n       geometry_dag info <in.dgc>\n       geometry_dag verify <in.dgc>".into()
}

fn parse_args(args: &[String]) -> Result<Command, String> {
    let Some(command) = args.first() else {
        return Err(usage());
    };
    match command.as_str() {
        "build" => {
            let mut positional: Vec<&str> = Vec::new();
            let mut options = BuildOptions {
                compress: true,
                ..Default::default()
            };
            let mut iter = args[1..].iter();
            while let Some(arg) = iter.next() {
                let mut flag_value = |name: &str| -> Result<u32, String> {
                    iter.next()
                        .and_then(|v| v.parse::<u32>().ok())
                        .ok_or_else(|| format!("{name} expects a number"))
                };
                match arg.as_str() {
                    "--levels" => options.levels = Some(flag_value("--levels")?),
                    "--max-triangles" => {
                        options.max_triangles = Some(flag_value("--max-triangles")?)
                    }
                    "--max-vertices" => options.max_vertices = Some(flag_value("--max-vertices")?),
                    "--no-compress" => options.compress = false,
                    "--quiet" => options.quiet = true,
                    other => {
                        if other.starts_with("--") {
                            return Err(format!("unknown flag {other}\n{}", usage()));
                        }
                        positional.push(other);
                    }
                }
            }
            if positional.len() != 2 {
                return Err(format!("build needs <in.obj> <out.dgc>\n{}", usage()));
            }
            Ok(Command::Build {
                input: positional[0].to_string(),
                output: positional[1].to_string(),
                options,
            })
        }
        "info" | "verify" => {
            let Some(path) = args.get(1) else {
                return Err(format!("{command} needs <in.dgc>\n{}", usage()));
            };
            if args.len() > 2 {
                return Err(format!("{command} takes exactly one path\n{}", usage()));
            }
            Ok(if command == "info" {
                Command::Info {
                    input: path.clone(),
                }
            } else {
                Command::Verify {
                    input: path.clone(),
                }
            })
        }
        "--help" | "-h" | "help" => Err(usage()),
        other => Err(format!("unknown command {other:?}\n{}", usage())),
    }
}

fn run(command: Command) -> Result<(), String> {
    match command {
        Command::Build {
            input,
            output,
            options,
        } => build(&input, &output, &options),
        Command::Info { input } => info(&input),
        Command::Verify { input } => verify(&input),
    }
}

fn build(input: &str, output: &str, options: &BuildOptions) -> Result<(), String> {
    let started = Instant::now();
    let text = std::fs::read_to_string(input).map_err(|e| format!("cannot read {input}: {e}"))?;
    let geometry = geometry_dag::parse_obj(&text).map_err(|e| format!("{e}"))?;
    let parse_elapsed = started.elapsed();

    let build_started = Instant::now();
    let dag = geometry_dag::build_meshlet_dag(
        &geometry,
        &geometry_dag::DagOptions {
            levels: options.levels,
            max_triangles: options.max_triangles,
            max_vertices: options.max_vertices,
            output_triangle_budget: None,
        },
    )
    .map_err(|e| format!("{e}"))?;
    let build_elapsed = build_started.elapsed();

    let write_started = Instant::now();
    let bytes = geometry_dag::write_dgc(
        &dag,
        &geometry_dag::DgcWriteOptions {
            compress: options.compress,
        },
    )
    .map_err(|e| format!("{e}"))?;
    std::fs::write(output, &bytes).map_err(|e| format!("cannot write {output}: {e}"))?;
    let write_elapsed = write_started.elapsed();

    if !options.quiet {
        let raw_estimate: usize = dag
            .levels
            .iter()
            .map(|level| {
                (level.positions.len()
                    + level.indices.len()
                    + level.descriptors.len()
                    + level.vertex_remap.len()
                    + level.local_triangle_indices.len()
                    + level.bounds.len()
                    + level.source_triangles.len()
                    + level.cluster_source_spans.len())
                    * 4
            })
            .sum();
        let total_clusters: usize = dag.levels.iter().map(|l| l.meshlet_count).sum();
        println!(
            "build ok: {} triangles ({} vertices) -> {} levels / {} clusters",
            geometry.triangle_count(),
            geometry.vertex_count(),
            dag.levels.len(),
            total_clusters
        );
        for level in &dag.levels {
            println!(
                "  level {}: {:>9} tris, {:>7} clusters, error {:.6}",
                level.level,
                level.indices.len() / 3,
                level.meshlet_count,
                level.error
            );
        }
        println!(
            "dgc: {} bytes (payload raw {}, compressed ratio {:.2}x), zlib={}",
            bytes.len(),
            raw_estimate,
            raw_estimate as f64 / bytes.len().max(1) as f64,
            options.compress
        );
        println!(
            "timings: parse {:.1?}, build {:.1?}, serialize+write {:.1?}, total {:.1?}",
            parse_elapsed,
            build_elapsed,
            write_elapsed,
            started.elapsed()
        );
    }
    Ok(())
}

fn info(input: &str) -> Result<(), String> {
    let bytes = std::fs::read(input).map_err(|e| format!("cannot read {input}: {e}"))?;
    let dag = geometry_dag::read_dgc(&bytes).map_err(|e| format!("{e}"))?;
    println!(
        "dgc ok: {} bytes, {} levels, {} parent pairs, source {} tris / {} verts",
        bytes.len(),
        dag.levels.len(),
        dag.parents_by_level.len(),
        dag.levels[0].indices.len() / 3,
        dag.levels[0].positions.len() / 3
    );
    for level in &dag.levels {
        println!(
            "  level {}: {} tris, {} clusters, error {:.6}, maxVerts {}, maxTris {}",
            level.level,
            level.indices.len() / 3,
            level.meshlet_count,
            level.error,
            level.max_vertices(),
            level.max_triangles()
        );
    }
    for (k, parents) in dag.parents_by_level.iter().enumerate() {
        let linked = parents
            .iter()
            .filter(|&&p| p != geometry_dag::NO_PARENT)
            .count();
        println!(
            "  parents k={k}: {} fine clusters, {linked} linked",
            parents.len()
        );
    }
    Ok(())
}

fn verify(input: &str) -> Result<(), String> {
    let bytes = std::fs::read(input).map_err(|e| format!("cannot read {input}: {e}"))?;
    let dag = geometry_dag::read_dgc(&bytes).map_err(|e| format!("{e}"))?;
    println!("verify ok: {} (CRC + structure valid)", input);
    println!(
        "  {} levels, {} cluster(s) total",
        dag.levels.len(),
        dag.levels.iter().map(|l| l.meshlet_count).sum::<usize>()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parse_build_command() {
        let cmd = parse_args(&args(&[
            "build",
            "in.obj",
            "out.dgc",
            "--levels",
            "3",
            "--no-compress",
        ]))
        .expect("ok");
        match cmd {
            Command::Build {
                input,
                output,
                options,
            } => {
                assert_eq!(input, "in.obj");
                assert_eq!(output, "out.dgc");
                assert_eq!(options.levels, Some(3));
                assert!(!options.compress);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn parse_rejects_unknown_flag() {
        assert!(parse_args(&args(&["build", "a", "b", "--bogus"])).is_err());
    }

    #[test]
    fn parse_rejects_missing_paths() {
        assert!(parse_args(&args(&["build", "a"])).is_err());
        assert!(parse_args(&args(&["info"])).is_err());
        assert!(parse_args(&args(&["frobnicate"])).is_err());
    }

    #[test]
    fn parse_info_verify() {
        assert!(matches!(
            parse_args(&args(&["info", "a.dgc"])).expect("ok"),
            Command::Info { .. }
        ));
        assert!(matches!(
            parse_args(&args(&["verify", "a.dgc"])).expect("ok"),
            Command::Verify { .. }
        ));
    }
}
