"""Encode unchanged CDP capture frames on their original clock, with an optional final reading hold."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('manifest', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--tail', type=float, default=0)
args = parser.parse_args()
if not 0 <= args.tail <= 2:
    raise ValueError('Reading hold must be between zero and two seconds')
if args.output.exists():
    raise ValueError('Choose a new output; source previews are retained')
manifest = json.loads(args.manifest.read_text(encoding='utf-8'))
frames = manifest['frames'] if isinstance(manifest, dict) else manifest
times = [frame['metadata']['timestamp'] for frame in frames]
if len(times) < 2 or any(not math.isfinite(t) for t in times) or any(b <= a for a, b in zip(times, times[1:])):
    raise ValueError('At least two strictly increasing actual CDP timestamps required')
recorded_end = times[-1]
wall_start = None
if isinstance(manifest, dict):
    if manifest.get('schema') != 'studio-real-screencast.v1':
        raise ValueError('Unknown capture clock contract')
    wall_start = manifest['wallStartMs'] / 1000
    recorded_end = manifest['wallEndMs'] / 1000
    if not all(math.isfinite(t) for t in [wall_start, recorded_end]) or not wall_start <= times[0] < times[-1] <= recorded_end:
        raise ValueError('Capture wall clock must bracket the frame event timestamps')
def frame_path(frame):
    path = (args.manifest.parent / frame['file']).resolve()
    if not path.is_relative_to(args.manifest.parent.resolve()) or not path.is_file():
        raise ValueError('Invalid source capture path')
    return path.as_posix().replace("'", "'\\''")
concat = args.output.with_suffix('.ffconcat')
lines = ['ffconcat version 1.0']
for index, frame in enumerate(frames[:-1]):
    lines += [f"file '{frame_path(frame)}'", f'duration {times[index+1]-times[index]:.9f}']
captured_idle_tail = recorded_end - times[-1]
lines += [f"file '{frame_path(frames[-1])}'", f'duration {captured_idle_tail + args.tail:.9f}', f"file '{frame_path(frames[-1])}'"]
concat.write_text('\n'.join(lines) + '\n', encoding='utf-8')
seconds = recorded_end-times[0]+args.tail
command = [shutil.which('ffmpeg'), '-y', '-hide_banner', '-loglevel', 'error', '-filter_threads', '1', '-f', 'concat',
           '-safe', '0', '-i', str(concat), '-t', f'{seconds:.9f}', '-vf', 'fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x11191d,format=yuv420p',
           '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '19', '-movflags', '+faststart', '-an', str(args.output)]
subprocess.run(command, check=True)
probe = json.loads(subprocess.check_output([shutil.which('ffprobe'), '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(args.output)]))
stream = probe['streams'][0]
if stream['width'] != 1920 or stream['height'] != 1080 or stream['avg_frame_rate'] != '30/1':
    raise ValueError('Expected original 1080p capture at 30fps')
subprocess.run([shutil.which('ffmpeg'), '-hide_banner', '-loglevel', 'error', '-xerror', '-threads', '2', '-i', str(args.output), '-f', 'null', '-'], check=True)
sha = lambda path: hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()
evidence = {'manifest': str(args.manifest.resolve()), 'manifestSha256': sha(args.manifest), 'sourceFrames': len(frames),
            'sourceDuration': recorded_end-times[0], 'frameEventSpan': times[-1]-times[0],
            'captureWallStart': wall_start, 'captureWallEnd': recorded_end if wall_start is not None else None,
            'capturedIdleTail': captured_idle_tail, 'unobservedLead': times[0]-wall_start if wall_start is not None else None,
            'maxFrameGap': max(b-a for a,b in zip(times,times[1:])),
            'finalReadingHold': args.tail, 'output': str(args.output.resolve()), 'sha256': sha(args.output),
            'encodedDuration': float(probe['format']['duration']), 'audio': False, 'wholeIntro': False, 'fullDecode': 'passed'}
args.output.with_suffix('.evidence.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(evidence, ensure_ascii=False, indent=2))
