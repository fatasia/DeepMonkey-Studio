"""Build the 180-second product film from recorded Studio screens."""
import argparse
import asyncio
import hashlib
import json
import math
import re
import shutil
import struct
import subprocess
import wave
from functools import lru_cache
from pathlib import Path

import edge_tts
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
PLAN_PATH = ROOT / "docs/assets/studio-020/video-plan.json"
PLAN = json.loads(PLAN_PATH.read_text(encoding="utf-8"))
OUT = Path(PLAN["outputDirectory"])
CAPTURE = Path(PLAN["captureDirectory"])
WORK = OUT / "intro-product-film"
STEM = "deepmonkey-studio-intro"
FEATURES_SHA = "9c0051089be65fa831e005db9121e2798743661eabada9499ee69bff22cf82dd"


def run(args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True, encoding="utf-8").strip()


@lru_cache(maxsize=64)
def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def duration(file):
    return float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(file)]))


def stamp(sec, vtt=False):
    ms = round(sec * 1000)
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02}{'.' if vtt else ','}{ms:03}"


def source(shot):
    return Path(shot["file"]) if Path(shot["file"]).is_absolute() else CAPTURE / shot["file"]


def crop_frame(file, rect):
    with Image.open(file) as original:
        image = original.convert("RGB")
        w, h = image.size
        x, y, cw, ch = rect
        image = image.crop((round(x*w), round(y*h), round((x+cw)*w), round((y+ch)*h)))
        # A crop may include UI panels: preserve pixels rather than stretching them.
        scaled = ImageOps.contain(image, (1920, 1080), Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", (1920, 1080), "#0b1114")
        canvas.paste(scaled, ((1920-scaled.width)//2, (1080-scaled.height)//2))
        return canvas


def cues(text, start, voice_length):
    phrases = [part.strip() for part in re.findall(r"[^，。；]+[，。；]?", text) if part.strip()]
    total = sum(len(phrase) for phrase in phrases)
    result = []
    for phrase in phrases:
        end = start + voice_length * len(phrase) / total
        width = math.ceil(len(phrase) / math.ceil(len(phrase)/27))
        result.append((start, end, "\n".join(phrase[i:i+width] for i in range(0, len(phrase), width))))
        start = end
    return result


def ass_header():
    return """[Script Info]
PlayResX: 1920
PlayResY: 1080
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Subtitle,Microsoft YaHei,38,&H00FFFFFF,&H00FFFFFF,&H00140C07,&H90000000,0,0,0,0,100,100,0,0,1,2,1,2,80,80,38,1
Style: Heading,Microsoft YaHei,54,&H004DAAD6,&H004DAAD6,&H00140C07,&H90000000,-1,0,0,0,100,100,1,0,1,2,1,7,78,78,60,1
Style: Brand,Microsoft YaHei,70,&H00EFF0E6,&H00EFF0E6,&H00140C07,&H90000000,-1,0,0,0,100,100,1,0,1,2,1,5,80,80,40,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def dialogue(start, end, style, text):
    return f"Dialogue: 0,{stamp(start, True)[:-1]},{stamp(end, True)[:-1]},{style},,0,0,0,," + text.replace("\n", r"\N")


async def voice(chapter):
    audio = WORK / f"{chapter['key']}.mp3"
    rate = chapter.get("voiceRate", "+4%")
    identity = hashlib.sha256(json.dumps([chapter["text"], PLAN["voice"], rate], ensure_ascii=False).encode()).hexdigest()
    meta = audio.with_suffix(".voice.json")
    if not audio.exists() or not meta.exists() or json.loads(meta.read_text(encoding="utf-8"))["sha256"] != identity:
        await edge_tts.Communicate(chapter["text"], PLAN["voice"], rate=rate).save(str(audio))
        meta.write_text(json.dumps({"sha256":identity,"text":chapter["text"],"voice":PLAN["voice"],"rate":rate}, ensure_ascii=False, indent=2), encoding="utf-8")
    if duration(audio) > chapter["duration"] - 2:
        raise ValueError(f"Rewrite {chapter['key']} narration: {duration(audio):.2f}s exceeds shot window")
    return audio


def recorded_video_frames(shot, chapter_key, index):
    file = source(shot)
    crop = shot.get("crop", [0, 0, 1, 1])
    identity = hashlib.sha256(json.dumps([sha(file),shot,"raw-recording-30fps-v1"],sort_keys=True).encode()).hexdigest()
    directory = WORK / f"{chapter_key}-{index:02}-recording-{identity[:12]}"
    directory.mkdir(exist_ok=True)
    marker = directory / "frames.json"
    if not marker.exists():
        x,y,w,h = crop
        filter_ = f"fps=30,crop=iw*{w}:ih*{h}:iw*{x}:ih*{y},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0b1114"
        run(["ffmpeg","-y","-hide_banner","-loglevel","error","-threads","2","-filter_threads","2","-ss",str(shot["start"]),"-i",str(file),"-t",str(shot["duration"]),"-vf",filter_,"-threads","2",str(directory/"%05d.png")])
        files = sorted(directory.glob("*.png"))
        assert len(files) == round(shot["duration"]*30),(file,len(files))
        marker.write_text(json.dumps({"identity":identity,"files":[f.name for f in files]}))
    return [directory/name for name in json.loads(marker.read_text())["files"]]


def prepare_shots(chapter):
    listing, evidence = ["ffconcat version 1.0"], []
    for index, shot in enumerate(chapter["shots"]):
        file = source(shot)
        rect = shot.get("crop", [0, 0, 1, 1])
        hold = shot["duration"]
        if shot.get("video"):
            frames = recorded_video_frames(shot,chapter["key"],index)
            for frame in frames:
                listing.extend([f"file '{frame.as_posix()}'", "duration 0.033333333"])
            evidence.append({**shot,"sourceSha256":sha(file),"recordedFrames":len(frames)})
            continue
        # Editorial camera move only; source UI pixels remain the recorded action.
        focused = rect != [0, 0, 1, 1] and shot.get("push", True)
        steps = 10 if focused else 1
        for step in range(steps):
            t = (step + 1)/steps
            eased = t*t*(3-2*t)
            framing = [a*eased+b*(1-eased) for a,b in zip(rect,[0,0,1,1])]
            image = crop_frame(file, framing)
            if shot.get("brand"):
                shade = Image.new("RGB", image.size, "#0b1114")
                image = Image.blend(image, shade, 0.75)
            normalized = WORK / f"{chapter['key']}-{index:02}-{step:02}.png"
            image.save(normalized)
            span = 0.06 if step < steps-1 else hold - 0.06*(steps-1)
            listing.extend([f"file '{normalized.as_posix()}'", f"duration {span:.6f}"])
        evidence.append({**shot,"sourceSha256":sha(file)})
    listing.append(listing[-2])
    concat = WORK / f"{chapter['key']}.ffconcat"
    concat.write_text("\n".join(listing), encoding="utf-8")
    return concat, evidence


def sfx(chapters):
    rate, total = 48000, 180*48000
    samples = bytearray(total*2)
    points = [0.15,18,44,68,96,120,152,175]
    for point in points:
        for i in range(int(rate*0.16)):
            t = i/rate
            value = int(500*math.sin(2*math.pi*(540-1200*t)*t)*math.exp(-32*t))
            struct.pack_into("<h", samples, (round(point*rate)+i)*2, value)
    file = WORK / "operation-atmosphere.wav"
    with wave.open(str(file), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(samples)
    return file


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--narration-only", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    story = PLAN["introStory"]
    assert sum(c["duration"] for c in story) == 180 and len(story) == 7
    assert sha(OUT / "deepmonkey-studio-features.mp4") == FEATURES_SHA
    WORK.mkdir(parents=True, exist_ok=True)
    for chapter in story:
        assert abs(sum(s["duration"] for s in chapter["shots"])-chapter["duration"]) < .01
        for shot in chapter["shots"]:
            assert source(shot).is_file(), source(shot)
    if args.check:
        print("180s / 7 chapters / all recorded sources present / full feature film unchanged", flush=True)
        return
    backup = OUT / "backup-intro-284s"
    backup.mkdir(exist_ok=True)
    for file in OUT.glob(f"{STEM}.*"):
        if not (backup/file.name).exists():
            shutil.copy2(file, backup/file.name)
    files, chapters, all_cues, cursor, evidence = [], [";FFMETADATA1"], [], 0, []
    for chapter in story:
        audio = await voice(chapter)
        print(f"{chapter['key']} narration {duration(audio):.2f}s / {chapter['duration']}s", flush=True)
        if args.narration_only:
            continue
        concat, sources = prepare_shots(chapter)
        local_cues = cues(chapter["text"], 1.1, duration(audio))
        overlay = ass_header()+"\n"+"\n".join(dialogue(a,b,"Subtitle",t) for a,b,t in local_cues)
        if chapter["key"] == "hero":
            overlay += "\n"+dialogue(2.4,7.0,"Heading",r"{\fad(500,500)}Deep Monkey Studio")
        else:
            overlay += "\n"+dialogue(.35,3.2,"Heading",r"{\fad(220,350)}"+chapter["title"])
        if chapter["key"] == "delivery":
            overlay += "\n"+dialogue(chapter["duration"]-5,chapter["duration"],"Brand",r"{\fad(350,0)}Deep Monkey Studio\N{\fs32}从创作，到持续运行\N{\fs25}github.com/fatasia/DeepMonkey-Studio")
        subtitle = WORK / f"{chapter['key']}.ass"
        subtitle.write_text(overlay, encoding="utf-8")
        target = WORK / f"{chapter['key']}.mp4"
        identity = hashlib.sha256(json.dumps([chapter,sha(audio),sources,sha(subtitle),"product-film-v3-industrial-concept"], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        cache = target.with_suffix(".identity.json")
        if not target.exists() or not cache.exists() or json.loads(cache.read_text())["sha256"] != identity:
            run(["ffmpeg","-y","-hide_banner","-loglevel","error","-threads","2","-filter_threads","2","-f","concat","-safe","0","-i",str(concat),"-i",str(audio),
                 "-vf",f"fps=30,subtitles='{subtitle.relative_to(OUT).as_posix()}'", "-af","adelay=1100:all=1,apad",
                 "-t",str(chapter["duration"]),"-c:v","libx264","-crf","19","-preset","fast","-threads","2","-pix_fmt","yuv420p",
                 "-c:a","aac","-ar","48000","-ac","2","-b:a","160k",str(target)],cwd=OUT)
            cache.write_text(json.dumps({"sha256":identity}))
        end = cursor+chapter["duration"]
        chapters += ["[CHAPTER]","TIMEBASE=1/1000",f"START={cursor*1000}",f"END={end*1000}",f"title={chapter['title']}"]
        all_cues += [(a+cursor,b+cursor,t) for a,b,t in local_cues]
        evidence.append({"title":chapter["title"],"start":cursor,"duration":chapter["duration"],"sources":sources})
        files.append(f"file '{target.as_posix()}'")
        cursor = end
        print(f"{chapter['key']} chapter encoded", flush=True)
    if args.narration_only:
        return
    concat, metadata = WORK / "film.ffconcat", WORK / "film.ffmeta"
    concat.write_text("\n".join(files), encoding="utf-8")
    metadata.write_text("\n".join(chapters), encoding="utf-8")
    (OUT / "intro.ffmeta").write_text("\n".join(chapters), encoding="utf-8")
    music = Path(PLAN["introMusic"])
    target = OUT / f"{STEM}.mp4"
    run(["ffmpeg","-y","-hide_banner","-loglevel","error","-threads","2","-filter_complex_threads","2","-f","concat","-safe","0","-i",str(concat),
         "-stream_loop","-1","-i",str(music),"-i",str(sfx(story)),"-i",str(metadata),
         "-filter_complex","[0:a]asplit=2[voice][key];[1:a]volume=0.23,afade=t=in:d=1.5,afade=t=out:st=176:d=4[bed];[bed][key]sidechaincompress=threshold=0.03:ratio=6:attack=15:release=350[duck];[voice][duck][2:a]amix=inputs=3:duration=first:normalize=0,alimiter=limit=0.89[a]",
         "-map","0:v","-map","[a]","-map_metadata","3","-c:v","copy","-c:a","aac","-ar","48000","-ac","2","-b:a","192k","-t","180","-movflags","+faststart",str(target)])
    for extension in ["srt","vtt"]:
        vtt = extension == "vtt"
        text = "WEBVTT\n\n" if vtt else ""
        text += "\n".join(f"{i}\n{stamp(a,vtt)} --> {stamp(b,vtt)}\n{t}\n" for i,(a,b,t) in enumerate(all_cues,1))
        (OUT/f"{STEM}.zh-CN.{extension}").write_text(text, encoding="utf-8")
    run(["ffmpeg","-y","-hide_banner","-v","error","-xerror","-threads","2","-i",str(target),"-f","null","-"])
    probe = json.loads(run(["ffprobe","-v","error","-show_format","-show_streams","-show_chapters","-of","json",str(target)]))
    (OUT/f"{STEM}.evidence.json").write_text(json.dumps({"version":"0.2.0","sha256":sha(target),"probe":probe,"chapters":evidence,"sourcePlan":str(PLAN_PATH),"music":{"source":str(music),"sha256":sha(music)},"editing":"Recorded screen pixels; editorial crops and camera pushes; original atmosphere music and subtle synthesized transitions."}, ensure_ascii=False, indent=2), encoding="utf-8")
    assets = [{"name":file.name,"path":str(file),"bytes":file.stat().st_size,"sha256":sha(file)} for film in ["intro","features"] for file in sorted(OUT.glob(f"deepmonkey-studio-{film}.*"))]
    (OUT/"video-assets.json").write_text(json.dumps({"version":"0.2.0","files":assets}, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT/"VIDEO-SHA256SUMS.txt").write_text("\n".join(f"{a['sha256']}  {a['name']}" for a in assets)+"\n", encoding="utf-8")
    assert sha(OUT / "deepmonkey-studio-features.mp4") == FEATURES_SHA
    print(f"FINAL {duration(target):.3f}s / {target.stat().st_size} bytes / {sha(target)}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
