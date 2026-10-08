"""Render variable-length product films from audited footage segments and concept plates."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
DEFAULT = ROOT / 'deliverables/studio-020-20261007/intro-award-v2-20261008'
FPS = 30


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def run(args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True, encoding='utf-8', errors='replace')


def probe(path):
    return json.loads(run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)]))


def shared():
    spec = importlib.util.spec_from_file_location('astra_render', ROOT / 'scripts/render-studio-astra-intro.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate(edl, inspect_sources=True):
    if edl.get('schema') != 'studio-film-segments.v1' or edl.get('fps') != FPS:
        raise ValueError('Unknown edit clock contract')
    cursor, pending, identities = 0, [], set()
    for chapter in edl['chapters']:
        if chapter['id'] in identities or chapter['targetInFrame'] != cursor:
            raise ValueError('Chapter IDs must be unique and edit clock contiguous')
        identities.add(chapter['id'])
        count = 0
        for segment in chapter['sourceSegments']:
            frames = segment['frames']
            if type(frames) is not int or frames <= 0:
                raise ValueError('Positive integer segment frames required')
            count += frames
            if segment.get('kind') not in ['footage', 'conceptPlate', 'conceptMotion', 'readingHold']:
                raise ValueError('Segments are recorded footage or explicit editorial concepts')
            if segment.get('kind') == 'readingHold':
                origin = segment.get('sourceEvidence', {})
                if not all(key in origin for key in ['source','sha256','timestamp']) or segment.get('readingRole') != 'resultReadability':
                    raise ValueError('Reading hold requires original capture identity and a readability role')
                if frames > FPS*8:
                    raise ValueError('Reading hold exceeds the short result reading window')
            if segment.get('kind') == 'conceptMotion' and (not segment.get('authoredMotion') or segment.get('backend')):
                raise ValueError('Concept motion must be explicitly authored, without a renderer identity')
            presentation = segment.get('presentation')
            if presentation:
                if segment['kind'] != 'footage' or presentation.get('kind') != 'worldFrame':
                    raise ValueError('Editorial viewport requires actual footage')
                reveal = presentation.get('revealFrames', 0)
                if type(reveal) is not int or not 0 <= reveal < frames:
                    raise ValueError('Invalid editorial viewport reveal clock')
            if not segment.get('source'):
                pending.append(f"{chapter['id']}/{segment['id']}")
                continue
            if not segment.get('identityVerified') or not segment.get('visualReviewed'):
                pending.append(f"{chapter['id']}/{segment['id']}")
            if segment.get('expectedBackend') and segment.get('backend') != segment['expectedBackend']:
                raise ValueError('Backend label differs from actual recorded source')
            crop = segment.get('crop', [0, 0, 1, 1])
            if len(crop) != 4 or any(type(x) not in [int, float] for x in crop):
                raise ValueError('Invalid editorial crop')
            x, y, w, h = crop
            if not (0 <= x < 1 and 0 <= y < 1 and 0 < w <= 1-x and 0 < h <= 1-y):
                raise ValueError('Crop outside source')
            if inspect_sources:
                source = Path(segment['source'])
                if not source.is_file() or sha(source) != segment.get('sha256'):
                    raise ValueError('Source file identity changed')
                if segment['kind'] in ['footage', 'conceptMotion']:
                    if source.suffix.lower() not in ['.mp4', '.webm', '.mov', '.mkv']:
                        raise ValueError('Recorded or authored motion cannot use image sources')
                    start = segment.get('sourceIn', 0)
                    if start < 0 or start + frames / FPS > float(probe(source)['format']['duration']) + .001:
                        raise ValueError('Clip exceeds original source; do not add hold or loop')
                elif source.suffix.lower() not in ['.png', '.jpg', '.jpeg']:
                    raise ValueError('Concept plate must be an authored image')
                if segment['kind'] == 'readingHold':
                    capture=Path(segment['sourceEvidence']['source'])
                    moment=segment['sourceEvidence']['timestamp']
                    if sha(capture)!=segment['sourceEvidence']['sha256'] or not 0 <= moment < float(probe(capture)['format']['duration']):
                        raise ValueError('Reading hold origin identity or clock changed')
        if count != chapter['targetOutFrame'] - cursor or count <= 0:
            raise ValueError('Segment durations must exactly fill their chapter')
        cursor = chapter['targetOutFrame']
    if cursor != edl['totalFrames'] or type(cursor) is not int or cursor <= 0:
        raise ValueError('Total frame count differs from edit clock')
    return pending


def captions(edl, tokens, work, cues):
    helper = shared()
    primary, accent, background = [helper.ass_color(tokens[key]) for key in ['--text-strong', '--accent', '--bg-0']]
    header = '\n'.join([
        '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', 'WrapStyle: 2',
        '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        f'Style: Caption,Microsoft YaHei,38,{primary},{primary},{background},&H90000000,0,0,0,0,100,100,0,0,1,2,1,2,90,90,42,1',
        f'Style: Title,Microsoft YaHei,80,{primary},{primary},{background},&H90000000,-1,0,0,0,100,100,0,0,1,1,0,7,96,96,120,1',
        f'Style: Label,Microsoft YaHei,32,{accent},{accent},{background},&H90000000,0,0,0,0,100,100,0,0,1,1,0,7,96,96,120,1',
        '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'])
    events, placements = [], []
    def add(a, b, style, text, position=''):
        if '{' in text or '}' in text:
            raise ValueError('Plain title/caption text required')
        words = text.replace('AI for\nScience', 'AI for Science\n').replace('\n', r'\N')
        events.append(f'Dialogue: 0,{helper.ass_time(a)},{helper.ass_time(b)},{style},,0,0,0,,{position}{words}')
    for chapter in edl['chapters']:
        cursor = chapter['targetInFrame'] / FPS
        for segment in chapter['sourceSegments']:
            end = cursor + segment['frames'] / FPS
            placements.append((cursor, end, segment.get('subtitlePosition', 'bottom')))
            for overlay in segment.get('overlays', []):
                a, b = cursor + overlay.get('start', 0), cursor + overlay.get('end', end-cursor)
                if not cursor <= a < b <= end:
                    raise ValueError('Overlay exceeds segment')
                x, y = overlay.get('position', [96, 120])
                add(a, b, overlay.get('style', 'Title'), overlay['text'], rf'{{\an7\pos({x},{y})\fad(200,200)}}')
            cursor = end
    previous = 0
    for cue in cues:
        if not previous <= cue['start'] < cue['end'] <= edl['totalFrames']/FPS + .001:
            raise ValueError('Caption clock overlaps or exceeds film')
        previous = cue['end']
        for a, b, position in placements:
            if position not in ['top', 'bottom']:
                raise ValueError('Caption position must be top or bottom')
            begin, end = max(a, cue['start']), min(b, cue['end'])
            if begin < end:
                add(begin, end, 'Caption', cue['text'], r'{\an8\pos(960,48)}' if position == 'top' else '')
    path = work / 'captions.ass'
    path.write_text(header + '\n' + '\n'.join(events), encoding='utf-8-sig')
    return path


def world_frame_filter(normalize, background, reveal_frames):
    # The source remains original-speed footage; only the film's surrounding layout moves.
    scale_progress = f'(1-pow(1-min(n/{reveal_frames},1),3))' if reveal_frames else '1'
    overlay_progress = f'(1-pow(1-min(max(n-1,0)/{reveal_frames},1),3))' if reveal_frames else '1'
    return (
        f'[0:v]{normalize},split=2[world][canvas];'
        f'[canvas]drawbox=x=0:y=0:w=iw:h=ih:color=0x{background[1:]}:t=fill[base];'
        f"[world]scale=w='trunc((1920-800*{scale_progress})/2)*2':"
        f"h='trunc((1080-450*{scale_progress})/2)*2':eval=frame,setsar=1[framed];"
        f"[base][framed]overlay=x='720*{overlay_progress}':y='208*{overlay_progress}':"
        f"eval=frame:shortest=1,drawbox=x=718:y=206:w=1124:h=634:color=0x56616a:t=1:"
        f"enable='gte(n,{reveal_frames})',format=yuv420p[out]"
    )


def assemble(edl, work, background):
    clips, evidence = [], []
    for chapter in edl['chapters']:
        for segment in chapter['sourceSegments']:
            key = hashlib.sha256((json.dumps(segment, sort_keys=True)+background+'original-speed-normalization.v1').encode()).hexdigest()[:16]
            clip = work / f"{chapter['id']}-{segment['id']}-{key}.mp4"
            if not clip.exists():
                source = ['-ss', str(segment.get('sourceIn', 0)), '-i', segment['source']] if segment['kind'] in ['footage','conceptMotion'] else ['-loop', '1', '-i', segment['source']]
                x, y, w, h = segment.get('crop', [0, 0, 1, 1])
                filters = f'fps=30,crop=trunc(iw*{w}/2)*2:trunc(ih*{h}/2)*2:trunc(iw*{x}/2)*2:trunc(ih*{y}/2)*2,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x{background[1:]},setsar=1,format=yuv420p'
                if segment.get('presentation'):
                    visual = ['-filter_complex_threads','1','-filter_complex',
                              world_frame_filter(filters,background,segment['presentation'].get('revealFrames',0)),
                              '-map','[out]']
                else:
                    visual = ['-vf',filters]
                run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-threads', '2', '-filter_threads', '1', *source,
                     '-an', *visual, '-frames:v', str(segment['frames']), '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '18', str(clip)])
            video = next(s for s in probe(clip)['streams'] if s['codec_type'] == 'video')
            if int(video['nb_frames']) != segment['frames'] or video['avg_frame_rate'] != '30/1':
                raise ValueError('Rendered segment has incorrect frame clock')
            clips.append(clip)
            evidence.append({'chapter': chapter['id'], **segment, 'clipSha256': sha(clip)})
    concat = work / 'clips.ffconcat'
    concat.write_text('ffconcat version 1.0\n'+'\n'.join(f"file '{p.name}'" for p in clips)+'\n', encoding='utf-8')
    return concat, evidence


def render(folder, edl, args):
    folder = folder.resolve()
    edl_sha = sha(folder/'edl.json')
    pending = validate(edl)
    if pending:
        raise ValueError(f'Unaudited segments: {pending}')
    output = (args.output or folder / 'deepmonkey-studio-intro-award-v2.mp4').resolve()
    if output.exists():
        raise ValueError('Preserve previous output; choose another filename')
    tokens = json.loads((folder / 'computed-product-tokens.json').read_text(encoding='utf-8'))
    work = folder / 'render-work'
    work.mkdir(exist_ok=True)
    seconds = edl['totalFrames'] / FPS
    cues = json.loads((folder / 'caption-cues.json').read_text(encoding='utf-8')) if not args.picture_only else []
    if not args.picture_only:
        audio = Path(edl['narration']['source'])
        if sha(audio) != edl['narration']['sha256'] or abs(float(probe(audio)['format']['duration']) - seconds) > .001:
            raise ValueError('Prepared narration identity/duration differs from edit clock')
        if sha(folder/'caption-cues.json') != edl['narration']['captionSha256']:
            raise ValueError('Prepared actual speech captions changed')
        if edl.get('soundtrack'):
            music = Path(edl['soundtrack']['source'])
            if sha(music) != edl['soundtrack']['sha256']:
                raise ValueError('Original soundtrack identity changed')
            mixed = work / 'mix.wav'
            filters = f'[0:a]asplit=2[v][sc];[1:a]volume=0.12,afade=t=in:d=2,afade=t=out:st={max(0,seconds-4)}:d=4[m];[m][sc]sidechaincompress=threshold=0.018:ratio=6:attack=30:release=550:makeup=1:link=average:detection=rms[duck];[v][duck]amix=inputs=2:normalize=0,apad,atrim=duration={seconds}[out]'
            run(['ffmpeg','-y','-hide_banner','-loglevel','error','-threads','2','-filter_complex_threads','2','-i',str(audio),
                 '-stream_loop','-1','-i',str(music),'-filter_complex',filters,'-map','[out]','-ar','48000','-ac','2',str(mixed)])
            audio = mixed
    caption_path = captions(edl, tokens, work, cues)
    concat, evidence = assemble(edl, work, tokens['--bg-0'])
    picture = work / 'picture.mp4'
    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', str(concat), '-an', '-c', 'copy', str(picture)], cwd=work)
    metadata = work / 'chapters.ffmeta'
    lines = [';FFMETADATA1']
    for chapter in edl['chapters']:
        title = re.sub(r'[\n\r=;#]', ' ', chapter['title'])
        lines += ['[CHAPTER]', 'TIMEBASE=1/30', f"START={chapter['targetInFrame']}", f"END={chapter['targetOutFrame']}", f'title={title}']
    metadata.write_text('\n'.join(lines), encoding='utf-8')
    inputs = ['-i', str(picture)]
    maps = ['-map', '0:v:0']
    if not args.picture_only:
        inputs += ['-i', str(audio)]
        maps += ['-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-af', 'loudnorm=I=-16:TP=-1:LRA=9']
    metadata_index = 1 if args.picture_only else 2
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-threads', '2', '-filter_threads', '1', *inputs, '-f', 'ffmetadata', '-i', str(metadata),
         *maps, '-map_metadata', str(metadata_index), '-map_chapters', str(metadata_index), '-vf', f'ass={caption_path.name}', '-c:v', 'libx264',
         '-threads', '2', '-preset', 'fast', '-crf', '18', '-t', str(seconds), '-movflags', '+faststart', str(output)], cwd=work)
    info = probe(output)
    video = next(s for s in info['streams'] if s['codec_type'] == 'video')
    if int(video['nb_frames']) != edl['totalFrames'] or abs(float(info['format']['duration'])-seconds) > .08:
        raise ValueError('Final picture differs from variable edit clock')
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-xerror', '-threads', '2', '-i', str(output), '-f', 'null', '-'])
    if not args.picture_only:
        voice = shared().preparation()
        for extension in ['srt','vtt']:
            lines = ['WEBVTT\n'] if extension=='vtt' else []
            for index,cue in enumerate(cues,1):
                display_text = cue['text'].replace('AI for\nScience', '\nAI for Science')
                lines += [str(index),f"{voice.stamp(cue['start'],extension=='vtt')} --> {voice.stamp(cue['end'],extension=='vtt')}",display_text,'']
            output.with_suffix(f'.{extension}').write_text('\n'.join(lines),encoding='utf-8')
    if sha(folder/'edl.json') != edl_sha:
        raise ValueError('EDL changed during render; preserve output as an unadmitted draft')
    output.with_suffix('.evidence.json').write_text(json.dumps({'output': str(output), 'sha256': sha(output), 'edlSha256': edl_sha,
        'totalFrames': edl['totalFrames'], 'duration': seconds, 'sources': evidence, 'pictureOnly': args.picture_only,
        'tokensSha256': sha(folder/'computed-product-tokens.json'), 'soundtrack': edl.get('soundtrack'),
        'fullDecode': 'passed', 'visualAcceptance': 'two full reviews pending'}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=DEFAULT)
    parser.add_argument('--render', action='store_true')
    parser.add_argument('--picture-only', action='store_true')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    edl = json.loads((args.project/'edl.json').read_text(encoding='utf-8'))
    pending = validate(edl)
    print(json.dumps({'totalFrames': edl['totalFrames'], 'seconds': edl['totalFrames']/FPS, 'pending': pending}))
    if args.render:
        render(args.project, edl, args)


if __name__ == '__main__':
    main()
