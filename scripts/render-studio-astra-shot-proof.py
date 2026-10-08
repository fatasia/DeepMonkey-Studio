"""Render a contiguous admitted excerpt with its actual timed narration and subtitles."""
import argparse
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('astra_renderer', ROOT / 'scripts/render-studio-astra-intro.py')
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)
parser = argparse.ArgumentParser()
parser.add_argument('--shots', nargs='+', required=True)
parser.add_argument('--folder', type=Path, default=renderer.DEFAULT)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
folder, output = args.folder.resolve(), args.output.resolve()
if output.exists():
    raise ValueError('Choose a new proof filename; keep earlier reviews')
edl = json.loads((folder / 'edl.json').read_text(encoding='utf-8'))
renderer.validate_narration_clock(folder, edl)
shots = [next(shot for shot in edl['shots'] if shot['id'] == shot_id) for shot_id in args.shots]
for index, shot in enumerate(shots):
    if not all(shot.get(key) for key in ['source', 'identityVerified', 'visualReviewed']):
        raise ValueError(f"Source has not been admitted: {shot['id']}")
    if renderer.digest(Path(shot['source'])) != shot['sourceSha256']:
        raise ValueError('Recorded source hash changed')
    if index and shots[index - 1]['targetOutFrame'] != shot['targetInFrame']:
        raise ValueError('Proof shots must be contiguous on the actual edit clock')
    duration = (shot['targetOutFrame'] - shot['targetInFrame']) / 30
    if shot['sourceOut'] - shot['sourceIn'] < duration:
        raise ValueError('Recorded source window is too short')
work = folder / f"proof-{'-'.join(args.shots)}"
work.mkdir(exist_ok=True)
tokens = json.loads((folder / 'computed-product-tokens.json').read_text(encoding='utf-8'))
full_ass = renderer.subtitles(folder, edl, tokens, work)
start, end = shots[0]['targetInFrame'] / 30, shots[-1]['targetOutFrame'] / 30
events = []
for line in full_ass.read_text(encoding='utf-8-sig').splitlines():
    if not line.startswith('Dialogue:'):
        events.append(line)
        continue
    fields = line.split(',', 9)
    a, b = max(renderer.timestamp(fields[1]), start), min(renderer.timestamp(fields[2]), end)
    if a < b:
        fields[1], fields[2] = renderer.ass_time(a - start), renderer.ass_time(b - start)
        events.append(','.join(fields))
ass = work / 'proof.ass'
ass.write_text('\n'.join(events) + '\n', encoding='utf-8-sig')
concat, sources = renderer.admitted_clips({'shots': shots}, work, tokens['--bg-0'])
renderer.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-filter_threads', '1', '-threads', '2',
              '-f', 'concat', '-safe', '0', '-i', str(concat), '-ss', str(start), '-i', str(folder / 'narration-180s.wav'),
              '-map', '0:v', '-map', '1:a', '-t', str(end - start), '-vf', 'ass=proof.ass',
              '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '18',
              '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(output)], cwd=work)
metadata = renderer.probe(output)
video = next(stream for stream in metadata['streams'] if stream['codec_type'] == 'video')
if int(video['nb_frames']) != shots[-1]['targetOutFrame'] - shots[0]['targetInFrame']:
    raise ValueError('Proof edit clock mismatch')
renderer.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-xerror', '-threads', '2', '-i', str(output), '-f', 'null', '-'])
evidence = {'output': str(output), 'sha256': renderer.digest(output), 'sources': sources, 'editStart': start,
            'editEnd': end, 'encodedDuration': float(metadata['format']['duration']), 'wholeIntro': False,
            'fullDecode': 'passed', 'soundtrack': False, 'edlSha256': renderer.digest(folder / 'edl.json'),
            'narrationSha256': renderer.digest(folder / 'narration-180s.wav'),
            'captionsSha256': renderer.digest(folder / 'narration.srt')}
output.with_suffix('.evidence.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({key: value for key, value in evidence.items() if key != 'sources'}, ensure_ascii=False))
