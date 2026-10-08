"""Assemble admitted continuous SMT footage on the Astra 180-second edit clock."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
DEFAULT = ROOT / 'deliverables/studio-020-20261007/intro-astra'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def run(args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True, encoding='utf-8', errors='replace')


def probe(path):
    return json.loads(run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', str(path)]))


def preparation():
    spec = importlib.util.spec_from_file_location('astra_preparation', ROOT / 'scripts/prepare-studio-astra-intro.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_narration_clock(folder, edl):
    timing = json.loads((folder / 'narration-timing.json').read_text(encoding='utf-8'))
    items = {item['id']: item for item in timing['entries']}
    pause = preparation().SENTENCE_PAUSE
    for window in edl['narrationWindows']:
        cursor = window['start']
        for identity in window['ids']:
            item = items[identity]
            if abs(item['start'] - cursor) > .001 or abs(item['end'] - item['start'] - item['duration']) > .001:
                raise ValueError('Narration timing differs from the EDL; rerun prepare with --voices')
            if digest(Path(item['audio'])) != item['sha256']:
                raise ValueError('Prepared narration source audio changed')
            cursor += item['duration'] + pause
        if cursor - pause > window['end'] + .001:
            raise ValueError('Actual narration exceeds the current shot window')


def readiness(folder, edl):
    preparation().check(edl)
    pending = [{'id': shot['id'], 'seconds': (shot['targetOutFrame'] - shot['targetInFrame']) / 30,
                'action': shot['action'], 'capture': shot['capture']}
               for shot in edl['shots'] if not shot.get('source') or not shot.get('identityVerified')]
    audio = folder / 'narration-180s.wav'
    if audio.is_file():
        validate_narration_clock(folder, edl)
    if audio.is_file() and abs(float(probe(audio)['format']['duration']) - 180) > .001:
        raise ValueError('Prepared narration must be exactly 180 seconds')
    report = {'ready': not pending, 'shots': len(edl['shots']), 'totalFrames': 5400,
              'pending': pending, 'narrationReady': audio.is_file(), 'edlSha256': digest(folder / 'edl.json'),
              'encoding': {'video': 'H.264', 'fps': 30, 'size': [1920, 1080], 'threads': 2},
              'sourcePolicy': 'Recorded video at its original speed; no image source, loop, or added motion'}
    (folder / 'render-readiness.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return report


def ass_color(color):
    if not re.fullmatch(r'#[0-9A-Fa-f]{6}', color):
        raise ValueError('Computed product colors must use six hexadecimal RGB digits')
    return '&H00' + color[5:7] + color[3:5] + color[1:3]


def ass_time(seconds):
    count = round(seconds * 100)
    hours, count = divmod(count, 360000)
    minutes, count = divmod(count, 6000)
    secs, centis = divmod(count, 100)
    return f'{hours}:{minutes:02}:{secs:02}.{centis:02}'


def timestamp(value):
    hours, minutes, seconds = value.replace(',', '.').split(':')
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def subtitles(folder, edl, tokens, work):
    primary, accent, background = [ass_color(tokens[key]) for key in ['--text-strong', '--accent', '--bg-0']]
    styles = '\n'.join([
        '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', 'WrapStyle: 2',
        '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        f'Style: Subtitle,Microsoft YaHei,38,{primary},{primary},{background},&H90000000,0,0,0,0,100,100,0,0,1,2,1,2,72,72,34,1',
        f'Style: Label,Microsoft YaHei,28,{primary},{primary},{background},&H90000000,0,0,0,0,100,100,0,0,1,2,1,7,48,48,74,1',
        f'Style: Title,Microsoft YaHei,56,{accent},{accent},{background},&H90000000,-1,0,0,0,100,100,0,0,1,2,1,7,72,72,74,1',
        '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ])
    events = []

    def add(start, end, style, words, placement=''):
        if '{' in words or '}' in words:
            raise ValueError('Subtitle text cannot contain ASS override syntax')
        escaped = words.replace('\n', r'\N')
        events.append(f'Dialogue: 0,{ass_time(start)},{ass_time(end)},{style},,0,0,0,,{placement}{escaped}')

    text = (folder / 'narration.srt').read_text(encoding='utf-8-sig')
    pattern = r'(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})\n(.*?)(?:\n\s*\n|$)'
    cues = re.findall(pattern, text, re.S)
    expected = json.loads((folder / 'caption-cues.json').read_text(encoding='utf-8'))
    if not cues or len(cues) != len(expected):
        raise ValueError('Caption count differs from actual speech boundary preparation')
    for (begin, end, words), cue in zip(cues, expected):
        if abs(timestamp(begin) - cue['start']) > .001 or abs(timestamp(end) - cue['end']) > .001 or words.strip() != cue['text']:
            raise ValueError('Caption timing or wording differs from actual speech boundary preparation')
    for begin, end, words in cues:
        for shot in edl['shots']:
            a, b = max(timestamp(begin), shot['targetInFrame'] / 30), min(timestamp(end), shot['targetOutFrame'] / 30)
            if a < b:
                # Placement is checked against each actual capture before source admission.
                position = shot.get('subtitlePosition', 'bottom')
                if position not in ['bottom', 'top']:
                    raise ValueError(f"Invalid subtitle placement: {shot['id']}")
                add(a, b, 'Subtitle', words.strip(), r'{\an8\pos(960,74)}' if position == 'top' else '')
    add(10, 13, 'Title', 'DeepMonkey Studio')
    for shot_id, label in [('S14', 'Three.js'), ('S15', 'Deep WebGPU'), ('S16', 'Deep WASM')]:
        shot = next(shot for shot in edl['shots'] if shot['id'] == shot_id)
        add(shot['targetInFrame'] / 30, shot['targetOutFrame'] / 30 - .2, 'Label', label)
    add(140, 143, 'Label', 'Rust 内核 → Native / WASM', r'{\an7\pos(48,124)}')
    path = work / 'captions.ass'
    path.write_text(styles + '\n' + '\n'.join(events) + '\n', encoding='utf-8-sig')
    return path


def admitted_clips(edl, work, background):
    clips, evidence = [], []
    for shot in edl['shots']:
        frames = shot['targetOutFrame'] - shot['targetInFrame']
        crop = shot.get('crop', [0, 0, 1, 1])
        if len(crop) != 4 or any(not isinstance(v, (float, int)) for v in crop):
            raise ValueError(f"Invalid fixed editorial crop: {shot['id']}")
        x, y, width, height = crop
        if not (0 <= x < 1 and 0 <= y < 1 and 0 < width <= 1-x and 0 < height <= 1-y):
            raise ValueError(f"Crop outside the recorded source: {shot['id']}")
        identity = digest(Path(shot['source'])) + json.dumps(shot, sort_keys=True) + background
        key = hashlib.sha256(identity.encode()).hexdigest()[:16]
        clip = work / f"{shot['id']}-{key}.mp4"
        if not clip.exists():
            run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-threads', '2', '-filter_threads', '1',
                 '-ss', str(shot['sourceIn']), '-i', shot['source'], '-an', '-vf',
                 f'fps=30,crop=trunc(iw*{width}/2)*2:trunc(ih*{height}/2)*2:trunc(iw*{x}/2)*2:trunc(ih*{y}/2)*2,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x{background[1:]},setsar=1,format=yuv420p',
                 '-frames:v', str(frames), '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '18', str(clip)])
        video = next(stream for stream in probe(clip)['streams'] if stream['codec_type'] == 'video')
        if int(video['nb_frames']) != frames or video['avg_frame_rate'] != '30/1':
            raise ValueError(f"Clip length/frame rate mismatch: {shot['id']}")
        clips.append(clip)
        evidence.append({**shot, 'encodedFrames': frames, 'clipSha256': digest(clip)})
    concat = work / 'clips.ffconcat'
    concat.write_text('ffconcat version 1.0\n' + '\n'.join(f"file '{clip.name}'" for clip in clips) + '\n', encoding='utf-8')
    return concat, evidence


def render(folder, edl, args):
    preparation().check(edl, require_sources=True)
    required_backends = {'S14': 'webgl', 'S15': 'webgpu', 'S16': 'wasm'}
    for shot in edl['shots']:
        if not shot.get('visualReviewed'):
            raise ValueError(f"Review source clarity, subtitle placement and UI outcome before render: {shot['id']}")
        if shot['id'] in required_backends and shot.get('backend') != required_backends[shot['id']]:
            raise ValueError(f"Recorded backend differs from the planned backend label: {shot['id']}")
    if not args.tokens or not args.music:
        raise ValueError('Supply the captured product computed tokens JSON and the original soundtrack')
    tokens = json.loads(args.tokens.read_text(encoding='utf-8'))
    output = args.output or folder / 'deepmonkey-studio-intro-astra.mp4'
    if output.exists():
        raise ValueError('Choose a new final output; previous versions are retained')
    work = folder / 'render-work'
    work.mkdir(exist_ok=True)
    captions = subtitles(folder, edl, tokens, work)
    concat, sources = admitted_clips(edl, work, tokens['--bg-0'])
    joined = work / 'picture.mp4'
    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', str(concat), '-c', 'copy', '-an', str(joined)], cwd=work)
    mixed = work / 'mix.wav'
    filters = '[1:a]volume=0.10,afade=t=in:d=2,afade=t=out:st=176:d=4[m];[0:a][m]amix=inputs=2:normalize=0,atrim=duration=180,apad[mix]'
    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-filter_complex_threads', '2', '-i', str(folder / 'narration-180s.wav'),
         '-stream_loop', '-1', '-i', str(args.music), '-filter_complex', filters, '-map', '[mix]', '-t', '180', '-ar', '48000', '-ac', '2', str(mixed)])
    loudness = subprocess.run(['ffmpeg', '-hide_banner', '-threads', '2', '-i', str(mixed), '-af', 'loudnorm=I=-16:TP=-1:LRA=9:print_format=json', '-f', 'null', '-'], capture_output=True, text=True, encoding='utf-8', check=True).stderr
    measured = json.loads(loudness[loudness.rfind('{'):loudness.rfind('}') + 1])
    (work / 'mix-loudness.json').write_text(json.dumps(measured, indent=2), encoding='utf-8')
    audio_filter = 'loudnorm=I=-16:TP=-1:LRA=9:linear=true:' + ':'.join(f'{target}={measured[source]}' for target, source in
        [('measured_I', 'input_i'), ('measured_TP', 'input_tp'), ('measured_LRA', 'input_lra'), ('measured_thresh', 'input_thresh'), ('offset', 'target_offset')])
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-threads', '2', '-filter_threads', '1', '-i', str(joined), '-i', str(mixed),
         '-f', 'ffmetadata', '-i', str(folder / 'chapters.ffmeta'), '-map', '0:v:0', '-map', '1:a:0', '-map_metadata', '2', '-map_chapters', '2',
         '-vf', f'ass={captions.name}', '-af', audio_filter, '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '18',
         '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-t', '180', '-movflags', '+faststart', str(output)], cwd=work)
    info = probe(output)
    video = next(stream for stream in info['streams'] if stream['codec_type'] == 'video')
    if video['nb_frames'] != '5400' or len(info['chapters']) != 7 or abs(float(info['format']['duration']) - 180) > .08:
        raise ValueError('Final duration/frame/chapter validation failed')
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-xerror', '-threads', '2', '-i', str(output), '-f', 'null', '-'])
    for extension in ['srt', 'vtt']:
        shutil.copyfile(folder / f'narration.{extension}', output.with_suffix(f'.{extension}'))
    output.with_suffix('.evidence.json').write_text(json.dumps({'output': str(output), 'sha256': digest(output), 'edlSha256': digest(folder / 'edl.json'),
        'sources': sources, 'tokensSha256': digest(args.tokens), 'soundtrackSha256': digest(args.music), 'fullDecode': 'passed',
        'probe': info, 'visualAcceptance': 'two full picture reviews required'}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=DEFAULT)
    parser.add_argument('--render', action='store_true')
    parser.add_argument('--tokens', type=Path)
    parser.add_argument('--music', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    edl = json.loads((args.project / 'edl.json').read_text(encoding='utf-8'))
    report = readiness(args.project, edl)
    print(json.dumps({'ready': report['ready'], 'pending': [shot['id'] for shot in report['pending']], 'narrationReady': report['narrationReady']}))
    if args.render:
        render(args.project, edl, args)


if __name__ == '__main__':
    main()
