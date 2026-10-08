"""Inspect the final exported film against the frozen source and caption clocks."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def call(args):
    return subprocess.run(args,capture_output=True,text=True,encoding='utf-8',errors='replace',check=True)


def sha(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def main(path):
    folder=path.parent;edl=json.loads((folder/'edl.json').read_text(encoding='utf-8'))
    evidence=json.loads(path.with_suffix('.evidence.json').read_text(encoding='utf-8'))
    actual=json.loads(call(['ffprobe','-v','error','-show_streams','-show_format','-show_chapters','-of','json',str(path)]).stdout)
    video=next(s for s in actual['streams'] if s['codec_type']=='video')
    audio=next(s for s in actual['streams'] if s['codec_type']=='audio')
    assert (video['width'],video['height'],video['avg_frame_rate'],int(video['nb_frames']))==(1920,1080,'30/1',5205)
    assert audio['sample_rate']=='48000' and audio['channels']==2
    assert len(actual['chapters'])==12 and abs(float(actual['format']['duration'])-173.5)<.05
    assert evidence['edlSha256']==sha(folder/'edl.json') and evidence['sha256']==sha(path)
    cues=json.loads((folder/'caption-cues.json').read_text(encoding='utf-8'));assert len(cues)==51
    assert all(0<=c['start']<c['end']<=173.5 for c in cues)
    for source in evidence['sources']:
        assert sha(Path(source['source']))==source['sha256']
        box=source['fit'];assert box['sourceEdgesPreserved']
        assert box['x']>=0 and box['y']>=0 and box['x']+box['width']<=1920 and box['y']+box['height']<=960
    # Decode includes video and audio; fail immediately on a malformed frame.
    call(['ffmpeg','-hide_banner','-loglevel','error','-xerror','-threads','2','-i',str(path),'-f','null','-'])
    loudness=call(['ffmpeg','-hide_banner','-nostats','-threads','2','-i',str(path),'-vn','-af','loudnorm=I=-16:TP=-1:LRA=9:print_format=json','-f','null','-']).stderr
    measured=json.loads(loudness[loudness.rfind('{'):loudness.rfind('}')+1])
    assert -17<=float(measured['input_i'])<=-15
    assert float(measured['input_tp'])<=-.7
    result={'output':str(path),'sha256':sha(path),'edlSha256':sha(folder/'edl.json'),
            'durationSeconds':float(actual['format']['duration']),'frames':int(video['nb_frames']),
            'dimensions':[1920,1080],'fps':'30/1','audio':{'sampleRate':48000,'channels':2},
            'chapters':12,'captions':51,'allSourceIdentities':'passed','fullSourceFit':'passed',
            'fullDecode':'passed','loudness':measured,'sizeBytes':path.stat().st_size}
    path.with_suffix('.verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('path',type=Path)
    main(parser.parse_args().path.resolve())
