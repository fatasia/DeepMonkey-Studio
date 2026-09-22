use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct RunnerArgs {
    pub output: PathBuf,
    pub warmup_frames: u64,
    pub sample_frames: u64,
    pub duration_seconds: f64,
    pub instances: u32,
    pub hidden: bool,
}

impl RunnerArgs {
    pub fn parse() -> Result<Self, String> {
        let mut output = None;
        let mut warmup_frames = 120;
        let mut sample_frames = 600;
        let mut duration_seconds = 0.0;
        let mut instances = 4096;
        let mut hidden = false;
        let mut args = std::env::args().skip(1);
        while let Some(argument) = args.next() {
            match argument.as_str() {
                "--output" => output = Some(PathBuf::from(next(&mut args, "--output")?)),
                "--warmup-frames" => warmup_frames = parse(next(&mut args, "--warmup-frames")?, "--warmup-frames")?,
                "--sample-frames" => sample_frames = parse(next(&mut args, "--sample-frames")?, "--sample-frames")?,
                "--duration-seconds" => duration_seconds = parse(next(&mut args, "--duration-seconds")?, "--duration-seconds")?,
                "--instances" => instances = parse(next(&mut args, "--instances")?, "--instances")?,
                "--hidden" => hidden = true,
                other => return Err(format!("unknown argument {other}")),
            }
        }
        let output = output.ok_or_else(|| "--output is required".to_owned())?;
        if warmup_frames < 10 || sample_frames < 30 || !(0.0..=86_400.0).contains(&duration_seconds)
            || !(1..=1_000_000).contains(&instances)
        {
            return Err("invalid sampling floor, duration, or instance count".to_owned());
        }
        Ok(Self { output, warmup_frames, sample_frames, duration_seconds, instances, hidden })
    }
}

fn next(args: &mut impl Iterator<Item = String>, name: &str) -> Result<String, String> {
    args.next().ok_or_else(|| format!("{name} requires a value"))
}

fn parse<T: std::str::FromStr>(value: String, name: &str) -> Result<T, String> {
    value.parse().map_err(|_| format!("{name} has an invalid value"))
}

