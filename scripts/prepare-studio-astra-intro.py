"""Prepare the Astra 180s film EDL, source audit and timed narration; no GPU capture."""
import argparse
import asyncio
import hashlib
import json
import re
import subprocess
import unicodedata
from pathlib import Path

import edge_tts

ROOT = Path(__file__).resolve().parent.parent
PLAN = ROOT / "docs/assets/studio-020/intro-astra-180s-plan.md"
OUT = ROOT / "deliverables/studio-020-20261007/intro-astra"
CAPTURE = ROOT.parent / "deliverables/studio-020-cua"
OLD_CAPTURE = ROOT.parent / "deliverables/system-feature-screencast-20260926"
VOICE = "zh-CN-XiaoxiaoNeural"
FPS = 30
SENTENCE_PAUSE = .2
NARRATION_EDITS = {
    "N10": "Agent 从这些对象、数据和关系里读取上下文。给它一个目标，它调用工具，把结果带回工作过程。",
    "N16": "用 SDK，把引擎、数据和场景接进你的应用。",
}

# Actual record windows. Source slots are admitted only after continuous footage
# and the common device identity have been checked; images are reference-only.
SHOTS = [
    ("S01", 0, 14, "smt-establish", "设备细部→横移→全景；清除选择轴"),
    ("S02", 14, 28, "smt-select", "同设备选择→层级和属性定位"),
    ("S03", 28, 35, "smt-material", "同设备材质实改→表面变化"),
    ("S04", 35, 43, "smt-timeline", "环境实改→真实时间线→设备近景"),
    ("S05", 43, 53, "data-connect", "处理节点移动→保存→运行SMT-01流程"),
    ("S06", 53, 60, "data-result", "逐节点输入输出→20/18/18运行计数"),
    ("S07", 60, 67, "ontology-drag", "从设备身份→对应对象→拖开节点"),
    ("S08", 67, 78, "ontology-relation", "端口拉线→方向/字段映射→保存草稿"),
    ("S09", 78, 90, "ontology-action", "已发布SMT-01行动→只读预览风险/影响/可执行结果"),
    ("S10", 90, 97, "agent-context", "已完成SMT-01任务→展开真实决策与工具记录"),
    ("S11", 97, 102, "agent-result", "同一已完成任务→18条与温度/压力范围"),
    ("S12", 102, 117, "behavior-config", "同设备点击事件→定位/视角/颜色配置"),
    ("S13", 117, 125, "behavior-run", "预览点击→设备近景→时间线运行"),
    ("S14", 125, 130, "backend-three", "Three同源工程书签运动"),
    ("S15", 130, 135, "backend-webgpu", "Deep WebGPU同书签运动"),
    ("S16", 135, 143, "backend-wasm", "Deep WASM同书签运动；末3秒Rust结构图"),
    ("S17", 143, 155, "runtime-sdk", "重复设备与增量机制标注→真实SDK消费者"),
    ("S18", 155, 161, "delivery-web", "发布检查→实际Viewer相机操作"),
    ("S19", 161, 167, "delivery-windows", "Windows同场景独立运行"),
    ("S20", 167, 171, "delivery-docker", "Docker健康与真实应用→退出编辑器"),
    ("S21", 171, 180, "viewer-continue", "独立Viewer延续→作者句→品牌与仓库"),
]
CHAPTERS = [
    (0, 28, "演示结束，世界继续"), (28, 43, "创造"),
    (43, 60, "数据回到设备"), (60, 90, "业务身份"),
    (90, 125, "理解与行动"), (125, 155, "同一份工程"),
    (155, 180, "交给下一位"),
]
WINDOWS = [
    (2, 14, ["N01"]), (14.3, 28, ["N02", "N03"]),
    (28.2, 43, ["N04", "N05"]), (43.4, 60, ["N06"]),
    (60.3, 78, ["N07", "N08"]), (78.5, 90, ["N09"]),
    (90.3, 102, ["N10"]), (109.3, 125, ["N11", "N12"]),
    (125.3, 143, ["N13", "N14"]), (143.3, 155, ["N15", "N16"]),
    (155.3, 171, ["N17"]), (171.2, 179.5, ["N18", "N19"]),
]
REFERENCES = {
    "S05": ["pipeline-drag", "pipeline-connect"], "S06": ["pipeline-debug", "pipeline-filter-debug"],
    "S07": ["ontology"], "S08": ["relation-config"], "S09": ["ontology"],
    "S10": ["agent-updates"], "S11": ["agent-updates"],
    "S14": ["render-engines"], "S15": ["render-engines"], "S16": ["render-wasm"],
    "S17": ["sdk-delivery"], "S18": ["delivery-offline"],
}


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def duration(path):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], text=True).strip())


def stamp(seconds, vtt=False):
    ms = round(seconds * 1000)
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02}{'.' if vtt else ','}{ms:03}"


def narration():
    text = PLAN.read_text(encoding="utf-8")
    rows = [row for row in text.splitlines() if row.startswith("| 00:") or row.startswith("| 01:") or row.startswith("| 02:")]
    result = {}
    for row in rows:
        for identity, content in re.findall(r"\*\*(N\d{2})\*\*\s*(.*?)(?=\*\*N\d{2}\*\*|\s*\|\s*$)", row):
            result[identity] = content.strip()
    assert sorted(result) == [f"N{i:02}" for i in range(1, 20)], sorted(result)
    result.update(NARRATION_EDITS)
    return result


def spoken(text):
    # Subtitle typography stays formal; this pronunciation mapping only affects TTS.
    for written, read in [("DeepMonkey Studio", "Deep Monkey Studio"), ("Three.js", "Three J S"),
                          ("WebGPU", "Web G P U"), ("WASM", "瓦斯姆"), ("Native", "原生"), ("SDK", "S D K")]:
        text = text.replace(written, read)
    return text


def formal(text):
    for read, written in [("瓦斯姆", "WASM"), ("原生", "Native"), ("Three J S", "Three.js"),
                          ("Web G P U", "WebGPU"), ("S D K", "SDK"), ("Deep Monkey Studio", "DeepMonkey Studio")]:
        text = text.replace(read, written)
    return text.strip()


def text_width(text):
    return sum(2 if unicodedata.east_asian_width(character) in "WF" else 1 for character in text)


def wrap_caption(text):
    if text_width(text) <= 44:
        return text
    choices = [index + 1 for index, character in enumerate(text) if character in "、，； "
               and 16 <= text_width(text[:index + 1]) <= 44 and text_width(text[index + 1:]) <= 44]
    if not choices:
        choices = [index for index in range(1, len(text))
                   if text_width(text[:index]) <= 44 and text_width(text[index:]) <= 44]
    if not choices:
        raise ValueError(f"Caption exceeds two lines: {text}")
    split = min(choices, key=lambda index: abs(text_width(text[:index]) - text_width(text[index:])))
    return text[:split].strip() + "\n" + text[split:].strip()


def timed_captions(item):
    words = item["words"]
    position = 0
    for word in words:
        offset = item["spoken"].find(word["text"], position)
        if offset < 0:
            raise ValueError(f"Word boundary transcript mismatch: {item['id']} {word['text']}")
        word["textStart"] = offset
        position = offset + len(word["text"])
        word["textEnd"] = position
    spans, group_start, group_end = [], None, None
    # Prefer complete clauses. Enumeration terms and names remain intact even if
    # the synthesizer returns character-sized Chinese/Latin word boundaries.
    for match in re.finditer(r"[^，。；：？]+[，。；：？]?", item["spoken"]):
        if group_start is not None and (text_width(formal(item["spoken"][group_start:match.end()])) > 44
                                       or item["spoken"][group_end - 1] in "。？"):
            spans.append((group_start, group_end)); group_start = None
        if group_start is None:
            group_start = match.start()
        group_end = match.end()
    if group_start is not None:
        spans.append((group_start, group_end))
    result = []
    for start, end in spans:
        selected = [word for word in words if word["textStart"] >= start and word["textEnd"] <= end]
        assert selected
        result.append({"start": round(item["start"] + selected[0]["offset"] / 10000000, 3),
                       "end": round(item["start"] + (selected[-1]["offset"] + selected[-1]["duration"]) / 10000000, 3),
                       "text": wrap_caption(formal(item["spoken"][start:end])), "narrationId": item["id"]})
    return result


def source_audit():
    groups = {}
    for path in sorted(CAPTURE.glob("*-frames.json")):
        frames = json.loads(path.read_text(encoding="utf-8"))
        if not frames:
            continue
        intervals = [b["time"] - a["time"] for a, b in zip(frames, frames[1:])]
        groups[path.name.removesuffix("-frames.json")] = {
            "kind": "timestamped-images", "index": str(path), "indexSha256": sha(path),
            "count": len(frames), "actualDuration": round(frames[-1]["time"] - frames[0]["time"], 6),
            "maxGap": round(max(intervals, default=0), 6), "use": "reference-only",
            "reason": "必须按原始时间和共同设备身份审查后才可作为动作；不延长或插值成操作证据",
            "frames": [{**frame, "sha256": sha(CAPTURE / frame["file"])} for frame in frames],
        }
    manifest = OLD_CAPTURE / "v3-recording-manifest.json"
    historic = json.loads(manifest.read_text(encoding="utf-8"))
    video = Path(historic["video"])
    return {"currentCaptureGroups": groups, "historicalRecording": {
        "path": str(video), "sha256": sha(video), "duration": duration(video),
        "manifest": str(manifest), "manifestSha256": sha(manifest), "chapters": historic["chapters"],
        "use": "候选补镜；不得替代新版交互或反复裁切贯穿全片",
    }}


def prepare():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "audio").mkdir(exist_ok=True)
    (OUT / "raw").mkdir(exist_ok=True)
    texts = narration()
    save(OUT / "source-audit.json", source_audit())
    edl = {"title": "演示结束，世界继续", "fps": FPS, "totalFrames": 5400, "duration": 180,
           "plan": str(PLAN), "planSha256": sha(PLAN), "status": "awaiting-verified-continuous-capture",
           "identity": {"projectId": None, "sceneId": None,
                        "deviceId": None, "deviceName": None, "dataObjectKey": None, "dataPrimaryKeyValue": None},
           "shots": [{"id": identity, "targetInFrame": start * FPS, "targetOutFrame": end * FPS,
                      "key": key, "action": action, "source": None, "sourceIn": None, "sourceOut": None,
                      "sourceSha256": None, "backend": None, "historical": False,
                      "identityVerified": False, "captions": ids, "references": REFERENCES.get(identity, []),
                      "capture": str(OUT / "raw" / f"astra-{key}.webm")}
                     for identity, start, end, key, action in SHOTS
                     for ids in [[n for a, b, group in WINDOWS if a < end and b > start for n in group]]],
           "chapters": [{"start": a, "end": b, "title": title} for a, b, title in CHAPTERS],
           "narrationWindows": [{"start": a, "end": b, "ids": ids} for a, b, ids in WINDOWS],
           "narration": [{"id": identity, "text": text, "spoken": spoken(text)} for identity, text in texts.items()]}
    path = OUT / "edl.json"
    proof_path = OUT / "video-qa-identity-proof.json"
    if proof_path.exists():
        proof = json.loads(proof_path.read_text(encoding="utf-8"))
        edl["identity"] = {key: proof[key] for key in ["projectId", "sceneId", "modelId", "deviceId", "deviceName"]}
        edl["identity"].update(dataObjectKey="Device", dataPrimaryKeyValue=proof["deviceId"])
    # Recording admission is manual review evidence and survives preparation reruns.
    if path.exists():
        previous = json.loads(path.read_text(encoding="utf-8"))
        edl["identity"] = previous["identity"]
        old = {shot["id"]: shot for shot in previous["shots"]}
        for shot in edl["shots"]:
            for key in ["source", "sourceIn", "sourceOut", "sourceSha256", "backend", "historical", "identityVerified", "visualReviewed", "subtitlePosition", "captureReview", "crop", "taskId", "taskActiveDurationMs", "taskStatus"]:
                if key not in old[shot["id"]]:
                    continue
                shot[key] = old[shot["id"]][key]
    save(path, edl)
    metadata = [";FFMETADATA1", "title=DeepMonkey Studio：演示结束，世界继续"]
    for chapter in edl["chapters"]:
        metadata += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={chapter['start']*1000}",
                     f"END={chapter['end']*1000}", f"title={chapter['title']}"]
    (OUT / "chapters.ffmeta").write_text("\n".join(metadata) + "\n", encoding="utf-8")
    (OUT / "narration.md").write_text("# 演示结束，世界继续 · 旁白\n\n" +
        "\n\n".join(f"{identity} · {text}" for identity, text in texts.items()) + "\n", encoding="utf-8")
    return edl


async def make_voice(item):
    audio = OUT / "audio" / f"{item['id']}.mp3"
    boundaries = audio.with_suffix(".words.jsonl")
    cache = audio.with_suffix(".voice.json")
    identity = hashlib.sha256(json.dumps([item["spoken"], VOICE, "+0%", "WordBoundary"], ensure_ascii=False).encode()).hexdigest()
    if not audio.exists() or not boundaries.exists() or not cache.exists() or json.loads(cache.read_text(encoding="utf-8"))["identity"] != identity:
        await edge_tts.Communicate(item["spoken"], VOICE, rate="+0%", boundary="WordBoundary").save(str(audio), str(boundaries))
        save(cache, {"identity": identity, "voice": VOICE, "rate": "+0%", **item})
    words = [json.loads(line) for line in boundaries.read_text(encoding="utf-8").splitlines() if line]
    assert words and all(word["type"] == "WordBoundary" for word in words)
    return {**item, "audio": str(audio), "sha256": sha(audio), "duration": duration(audio), "words": words}


async def voices(edl):
    # Speech generation uses one request at a time; encoding stays CPU-only, two threads.
    audio = {}
    for item in edl["narration"]:
        audio[item["id"]] = await make_voice(item)
        print(f"{item['id']}: {audio[item['id']]['duration']:.3f}s natural", flush=True)
    schedule, overrun = [], []
    for window in edl["narrationWindows"]:
        cursor = window["start"]
        for identity in window["ids"]:
            item = audio[identity]
            schedule.append({**item, "start": round(cursor, 3), "end": round(cursor + item["duration"], 3)})
            cursor += item["duration"] + SENTENCE_PAUSE
        if cursor - SENTENCE_PAUSE > window["end"]:
            overrun.append({**window, "actualEnd": round(cursor - SENTENCE_PAUSE, 3), "excess": round(cursor - SENTENCE_PAUSE - window["end"], 3)})
    save(OUT / "narration-timing.json", {"rate": "+0%", "entries": schedule, "overruns": overrun})
    if overrun:
        print(json.dumps({"rewriteRequired": overrun}, ensure_ascii=False, indent=2), flush=True)
        return
    # Captions are grouped at real word boundaries; the original written sentence
    # is retained with timed phrase boundaries, never allocated by character count.
    cues = [cue for item in schedule for cue in timed_captions(item)]
    save(OUT / "caption-cues.json", cues)
    for extension in ["srt", "vtt"]:
        result = ["WEBVTT\n"] if extension == "vtt" else []
        for index, cue in enumerate(cues, 1):
            result += [str(index), f"{stamp(cue['start'], extension == 'vtt')} --> {stamp(cue['end'], extension == 'vtt')}", cue["text"], ""]
        (OUT / f"narration.{extension}").write_text("\n".join(result), encoding="utf-8")
    inputs, filters = [], []
    for i, item in enumerate(schedule):
        inputs += ["-i", item["audio"]]
        filters.append(f"[{i}:a]aresample=48000,adelay={round(item['start']*1000)}:all=1[a{i}]")
    filters.append("".join(f"[a{i}]" for i in range(len(schedule))) +
                   f"amix=inputs={len(schedule)}:normalize=0,apad,atrim=duration=180[out]")
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-threads", "2", "-filter_complex_threads", "2", *inputs,
                    "-filter_complex", ";".join(filters), "-map", "[out]", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "1",
                    str(OUT / "narration-180s.wav")], check=True)
    print("Natural narration fits all windows; timed subtitles and 180s voice track prepared.", flush=True)


def check(edl, require_sources=False):
    shots = edl["shots"]
    assert shots[0]["targetInFrame"] == 0 and shots[-1]["targetOutFrame"] == 5400
    for previous, current in zip(shots, shots[1:]):
        assert previous["targetOutFrame"] == current["targetInFrame"]
    missing = [shot["id"] for shot in shots if not shot["source"] or not shot["identityVerified"]]
    if require_sources and missing:
        raise ValueError(f"Continuous same-device source admission required: {missing}")
    if require_sources:
        for key in ["sceneId", "deviceId", "deviceName", "dataObjectKey", "dataPrimaryKeyValue"]:
            if not edl["identity"][key]:
                raise ValueError(f"Common device continuity requires {key}.")
        for shot in shots:
            path = Path(shot["source"])
            if path.suffix.lower() not in [".webm", ".mp4", ".mov", ".mkv"] or not path.is_file():
                raise ValueError(f"{shot['id']} requires continuous recorded video: {path}")
            if sha(path) != shot["sourceSha256"]:
                raise ValueError(f"{shot['id']} source changed after admission.")
            if not 0 <= shot["sourceIn"] < shot["sourceOut"] <= duration(path) + .001:
                raise ValueError(f"{shot['id']} has invalid source in/out.")
            needed = (shot["targetOutFrame"] - shot["targetInFrame"]) / FPS
            if shot["sourceOut"] - shot["sourceIn"] + .001 < needed:
                raise ValueError(f"{shot['id']} source window cannot be stretched to fill its target.")
    print(f"EDL: {len(shots)} shots, 5400 frames / 180s; {len(missing)} await source admission.", flush=True)


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voices", action="store_true")
    parser.add_argument("--require-sources", action="store_true")
    args = parser.parse_args()
    edl = prepare()
    check(edl, args.require_sources)
    if args.voices:
        await voices(edl)
    prepared = ["edl.json", "narration.md", "narration-180s.wav", "narration.srt", "narration.vtt",
                "caption-cues.json", "narration-timing.json", "chapters.ffmeta", "source-audit.json"]
    save(OUT / "preparation-sha256.json", {name: sha(OUT / name) for name in prepared if (OUT / name).is_file()})


if __name__ == "__main__":
    asyncio.run(main())
