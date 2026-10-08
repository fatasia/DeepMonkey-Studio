"""Contact sheets for exactly the two completed clean Viewer sources."""
import bisect
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from PIL import Image,ImageDraw,ImageFont,ImageOps

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'deliverables/studio-020-20261007/intro-award-v2-20261008/art-clean-photography'
REVIEW=OUT/'review'; REVIEW.mkdir(exist_ok=True)
TIMES=[.5,2.5,4.5,7.5]
parser=argparse.ArgumentParser(); parser.add_argument('--accept-reviewed',action='store_true'); args=parser.parse_args()
tokens=json.loads((OUT.parent/'computed-product-tokens.json').read_text(encoding='utf-8'))
font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',20)

def contact(name,files,kind):
    sheet=Image.new('RGB',(1920,1080),tokens['--bg-0'])
    for i,(path,t) in enumerate(zip(files,TIMES)):
        with Image.open(path) as im:
            frame=ImageOps.pad(im.convert('RGB'),(960,540),color=tokens['--bg-0'])
        d=ImageDraw.Draw(frame); d.rectangle((0,0,960,35),fill=tokens['--bg-0'])
        d.text((15,3),f'{kind} · {name} · {t:.1f}秒',font=font,fill=tokens['--text-strong'])
        sheet.paste(frame,((i%2)*960,(i//2)*540))
    sheet.save(REVIEW/f'{name}-{kind}-contact.png')

manifest={}
for name in ['art-clean-wide','art-clean-detail-take2']:
    evidence=json.loads((OUT/f'{name}.evidence.json').read_text(encoding='utf-8'))
    original=json.loads(Path(evidence['rawManifest']).read_text(encoding='utf-8'))
    evidence['publishedSourceIdentity']={k:original[k] for k in ['url','projectId','sceneId','assetId','modelAssetId','deviceKey','backend'] if k in original}
    if hashlib.file_digest(Path(evidence['source']).open('rb'),'sha256').hexdigest()!=evidence['sha256']:
        raise ValueError('Canonical footage SHA changed')
    if hashlib.file_digest(Path(evidence['rawManifest']).open('rb'),'sha256').hexdigest()!=evidence['rawManifestSha256']:
        raise ValueError('Completed manifest SHA changed')
    evidence['visualReviewed']=args.accept_reviewed
    (OUT/f'{name}.evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf-8')
    times=[r['timestamp'] for r in evidence['sourceFrameIdentities']]
    files=[Path(evidence['sourceFrameIdentities'][bisect.bisect_right(times,times[0]+t)-1]['file']) for t in TIMES]
    contact(name,files,'原始')
    dest=REVIEW/f'{name}-%02d.png'
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-threads','2','-filter_threads','2','-i',evidence['source'],
                    '-vf','select=eq(n\\,15)+eq(n\\,75)+eq(n\\,135)+eq(n\\,225)','-fps_mode','vfr','-frames:v','4','-threads','2',str(dest)],check=True)
    contact(name,[REVIEW/f'{name}-{i:02d}.png' for i in range(1,5)],'解码')
    manifest[name]={k:v for k,v in evidence.items() if k!='sourceFrameIdentities'}
    manifest[name]['evidence']=str(OUT/f'{name}.evidence.json')
    manifest[name]['usableSpan']=[0,evidence['duration']]
    manifest[name]['reviewContacts']=[str(REVIEW/f'{name}-{kind}-contact.png') for kind in ['原始','解码']]
    print(name,'source and decoded contacts ready',flush=True)
(OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
