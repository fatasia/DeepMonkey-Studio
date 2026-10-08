"""Reuse historical chapters and add timestamped CUA captures for release 0.2.0."""
import argparse
import asyncio
import hashlib
import json
import math
import re
import subprocess
from pathlib import Path
import edge_tts
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PLAN = json.loads((ROOT / "docs/assets/studio-020/video-plan.json").read_text(encoding="utf-8"))
OUTPUT = Path(PLAN["outputDirectory"])
CAPTURE = Path(PLAN["captureDirectory"])
FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"


def run(args):
    return subprocess.check_output(args, text=True, encoding="utf-8").strip()


def duration(file):
    return float(run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(file)]))


def stamp(seconds, vtt=False):
    millis = max(0, round(seconds * 1000))
    hours, millis = divmod(millis, 3600000)
    minutes, millis = divmod(millis, 60000)
    secs, millis = divmod(millis, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02}{'.' if vtt else ','}{millis:03}"


def captions(text, length):
    sentences = [item.strip() + "。" for item in text.split("。") if item.strip()]
    total = sum(len(item) for item in sentences)
    result, cursor = [], 0.0
    for sentence in sentences:
        end = cursor + length * len(sentence) / total
        # Balance long captions instead of leaving a one-character second line.
        width = math.ceil(len(sentence) / math.ceil(len(sentence) / 42))
        lines = "\n".join(sentence[i:i+width] for i in range(0, len(sentence), width))
        result.append((cursor, end, lines))
        cursor = end
    return result


def write_captions(file, cues, vtt=False):
    blocks = ["WEBVTT\n"] if vtt else []
    for index, (start, end, text) in enumerate(cues, 1):
        blocks.append(f"{index}\n{stamp(start,vtt)} --> {stamp(end,vtt)}\n{text}\n")
    file.write_text("\n".join(blocks), encoding="utf-8")


def retained_captions(film, start, span, cursor):
    text = Path(PLAN["historical"][film]["subtitles"]).read_text(encoding="utf-8-sig")
    def seconds(value):
        h, m, s = value.replace(",", ".").split(":")
        return int(h)*3600+int(m)*60+float(s)
    cues = []
    for a, b, words in re.findall(r"(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})\n(.*?)(?:\n\s*\n|$)", text, re.S):
        begin, end = max(start, seconds(a)), min(start+span, seconds(b))
        if end > begin:
            cues.append((cursor+begin-start, cursor+end-start, words.strip()))
    return cues


async def narrate(film, key, clip):
    audio = OUTPUT / "voice" / f"{film}-{key}.mp3"
    text = clip[f"{film}Text"]
    identity = hashlib.sha256(text.encode()).hexdigest()
    meta = audio.with_suffix(".json")
    if not audio.exists() or not meta.exists() or json.loads(meta.read_text(encoding="utf-8"))["textSha256"] != identity:
        await edge_tts.Communicate(text, PLAN["voice"], rate=PLAN["voiceRate"]).save(str(audio))
        meta.write_text(json.dumps({"text":text,"textSha256":identity,"voice":PLAN["voice"],"rate":PLAN["voiceRate"]},ensure_ascii=False,indent=2),encoding="utf-8")
    return audio


def frames_for(clip):
    frames = []
    for prefix in clip["captures"]:
        manifest = CAPTURE / f"{prefix}-frames.json"
        if not manifest.exists():
            raise FileNotFoundError(f"Missing current-source capture: {manifest}")
        batch = json.loads(manifest.read_text(encoding="utf-8"))
        if not batch:
            raise ValueError(f"Empty capture {prefix}")
        for index, item in enumerate(batch):
            file = CAPTURE / item["file"]
            if not file.is_file():
                raise FileNotFoundError(file)
            delta = max(1/30, batch[index+1]["time"] - item["time"]) if index+1 < len(batch) else 1
            frames.append((file, min(delta, 3)))
    if clip.get("tailImage"):
        frames.append((CAPTURE / clip["tailImage"], 3))
    return frames


def build_capture(film, key, clip, audio):
    work = OUTPUT / "clips" / film
    work.mkdir(parents=True, exist_ok=True)
    frames = frames_for(clip)
    length = duration(audio) + 1
    cues = captions(clip[f"{film}Text"], length-1)
    target = work / f"{key}.mp4"
    identity = hashlib.sha256(json.dumps({
        "encoding": "1080p30-crf20-ass34-balanced42-png-aac48k-stereo-v3",
        "text": clip[f"{film}Text"], "audio": hashlib.sha256(audio.read_bytes()).hexdigest(),
        "frames": [(str(file), span, hashlib.sha256(file.read_bytes()).hexdigest()) for file, span in frames],
    }, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    cache = target.with_suffix(".identity.json")
    if target.exists() and cache.exists() and json.loads(cache.read_text(encoding="utf-8"))["sha256"] == identity:
        if abs(duration(target)-length) < 0.1:
            print(f"{film}/{key}: reused verified current capture", flush=True)
            return target, cues
    observed = sum(span for _, span in frames)
    scale = min(4, length / observed)
    held = max(0, length - observed * scale)
    concat = work / f"{key}.ffconcat"
    lines = ["ffconcat version 1.0"]
    for index, (file, span) in enumerate(frames):
        # A concat stream has one decoder: JPEG screencast frames and PNG tails
        # must share an encoding or the tail is silently lost as a decode error.
        normalized = OUTPUT / "frames" / f"{file.stem}.png"
        normalized.parent.mkdir(parents=True, exist_ok=True)
        if not normalized.exists() or normalized.stat().st_mtime < file.stat().st_mtime:
            with Image.open(file) as frame:
                frame.convert("RGB").save(normalized)
        escaped = normalized.as_posix().replace("'", "'\\''")
        lines.extend([f"file '{escaped}'", f"duration {span*scale+(held if index==len(frames)-1 else 0):.6f}"])
    lines.append(lines[-2])
    concat.write_text("\n".join(lines), encoding="utf-8")
    subtitle = work / f"{key}.ass"
    ass = ["[Script Info]\nPlayResX: 1920\nPlayResY: 1080\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Microsoft YaHei,34,&H00FFFFFF,&H00FFFFFF,&H00202020,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,28,28,28,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
    for start, end, text in cues:
        ass.append(f"Dialogue: 0,{stamp(start,True)[:-1]},{stamp(end,True)[:-1]},Default,,0,0,0,,"+text.replace("\n",r"\N"))
    subtitle.write_text("\n".join(ass),encoding="utf-8")
    # Use relative subtitle paths to avoid Windows drive-letter filter escaping.
    filter_path = subtitle.relative_to(OUTPUT).as_posix()
    subprocess.run([FFMPEG,"-y","-hide_banner","-loglevel","error","-threads","2","-filter_threads","2","-f","concat","-safe","0","-i",str(concat),"-i",str(audio),
        "-vf",f"scale=1920:1080:flags=lanczos,subtitles='{filter_path}'",
        "-t",str(length),"-r","30","-c:v","libx264","-crf","20","-preset","fast","-threads","2","-pix_fmt","yuv420p",
        "-af","apad","-c:a","aac","-ar","48000","-ac","2","-b:a","160k","-movflags","+faststart",str(target)],cwd=OUTPUT,check=True)
    cache.write_text(json.dumps({"sha256":identity},indent=2),encoding="utf-8")
    print(f"{film}/{key}: {length:.2f}s current capture", flush=True)
    return target, cues


def historical_sections(film):
    source = PLAN["historical"][film]
    timeline = json.loads(Path(source["timeline"]).read_text(encoding="utf-8"))
    return Path(source["video"]), timeline["sections" if film=="intro" else "chapters"]


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--narration-only", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--clips-only", action="store_true", help="Prepare available clips; never emit a partial final video")
    parser.add_argument("--film", choices=["intro","features"])
    parser.add_argument("--clip-keys", nargs="+", choices=list(PLAN["clips"]), help="Prepare selected current clips only")
    parser.add_argument("--retained-only", action="store_true", help="Prepare retained chapters without producing a final video")
    args = parser.parse_args()
    if args.retained_only:
        args.clips_only = True
    if args.clip_keys and not args.clips_only:
        parser.error("--clip-keys requires --clips-only")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "voice").mkdir(exist_ok=True)
    films = [args.film] if args.film else ["intro","features"]
    for film in films:
        if film == "intro" and PLAN.get("introStory") and not args.clips_only and not args.retained_only:
            flags = [flag for active, flag in [(args.check, "--check"), (args.narration_only, "--narration-only")] if active]
            import sys
            subprocess.run([sys.executable, str(ROOT / "scripts/build-studio-020-intro.py"), *flags], check=True)
            continue
        source, sections = historical_sections(film)
        files, chapter_meta, all_cues, evidence, cursor = [], [";FFMETADATA1"], [], [], 0.0
        for index, key in enumerate(PLAN["edits"][film]):
            if args.retained_only and isinstance(key, str):
                continue
            if args.clip_keys and (not isinstance(key, str) or key not in args.clip_keys):
                continue
            if isinstance(key, str):
                clip = PLAN["clips"][key]
                if args.clips_only and any(not (CAPTURE/f"{prefix}-frames.json").exists() for prefix in clip["captures"]):
                    print(f"{film}/{key}: pending current capture",flush=True)
                    continue
                if args.check:
                    print(f"{film}/{key}: {len(frames_for(clip))} current frames", flush=True)
                    continue
                audio = await narrate(film, key, clip)
                if args.narration_only:
                    print(f"{film}/{key}: narration {duration(audio):.2f}s", flush=True)
                    continue
                file, cues = build_capture(film,key,clip,audio)
                title = clip["title"]
                all_cues.extend((start+cursor,end+cursor,text) for start,end,text in cues)
                evidence.append({"chapter":title,"type":"current CUA frames","captures":clip["captures"],"evidence":clip["evidence"]})
            else:
                if args.check or args.narration_only:
                    continue
                section = sections[key]
                span = section.get("duration", section.get("end",0)-section["start"])
                file = OUTPUT / "clips" / film / f"retained-{key}-{round(section['start']*1000)}.mp4"
                file.parent.mkdir(parents=True,exist_ok=True)
                if not file.exists() or file.stat().st_size == 0 or abs(duration(file)-span)>0.1 or file.stat().st_mtime<source.stat().st_mtime:
                    run([FFMPEG,"-y","-hide_banner","-loglevel","error","-threads","2","-ss",str(section["start"]),"-i",str(source),"-t",str(span),"-r","30",
                        "-c:v","libx264","-crf","20","-preset","fast","-threads","2","-pix_fmt","yuv420p","-c:a","aac","-ar","48000","-ac","2","-b:a","160k",str(file)])
                title = section["title"]
                all_cues.extend(retained_captions(film,section["start"],span,cursor))
                evidence.append({"chapter":title,"type":"historical retained","source":str(source),"start":section["start"],"duration":span})
            end = cursor + duration(file)
            chapter_meta += ["[CHAPTER]","TIMEBASE=1/1000",f"START={round(cursor*1000)}",f"END={round(end*1000)}",f"title={title}"]
            files.append(f"file '{file.as_posix()}'")
            cursor = end
        if args.check or args.narration_only or args.clips_only:
            continue
        listing, meta = OUTPUT / f"{film}.ffconcat", OUTPUT / f"{film}.ffmeta"
        listing.write_text("\n".join(files),encoding="utf-8")
        meta.write_text("\n".join(chapter_meta),encoding="utf-8")
        stem = f"deepmonkey-studio-{film}"
        final = OUTPUT / f"{stem}.mp4"
        run([FFMPEG,"-y","-hide_banner","-loglevel","error","-f","concat","-safe","0","-i",str(listing),"-i",str(meta),"-map_metadata","1","-c","copy","-movflags","+faststart",str(final)])
        write_captions(OUTPUT/f"{stem}.zh-CN.srt",all_cues)
        write_captions(OUTPUT/f"{stem}.zh-CN.vtt",all_cues,True)
        run([FFMPEG,"-y","-hide_banner","-v","error","-xerror","-threads","2","-i",str(final),"-f","null","-"])
        probe = json.loads(run([FFPROBE,"-v","error","-show_format","-show_streams","-show_chapters","-of","json",str(final)]))
        (OUTPUT/f"{stem}.evidence.json").write_text(json.dumps({"version":PLAN["version"],"sourcePlan":str(ROOT/"docs/assets/studio-020/video-plan.json"),"sha256":hashlib.sha256(final.read_bytes()).hexdigest(),"probe":probe,"chapters":evidence},ensure_ascii=False,indent=2),encoding="utf-8")
        print(f"{film}: {cursor:.2f}s {final.stat().st_size} bytes",flush=True)


if __name__ == "__main__":
    asyncio.run(main())
