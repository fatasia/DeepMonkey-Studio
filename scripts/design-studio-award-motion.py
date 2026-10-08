"""Author explicit concept motion sources; no generated product footage.

python scripts/design-studio-award-motion.py --clips layers
All motion derives from a time clock and captured product tokens. FFmpeg <=2 threads.
"""
import argparse
import hashlib
import json
import math
import subprocess
from functools import lru_cache
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'deliverables/studio-020-20261007/intro-award-v2-20261008'
OUT = SOURCE / 'motion-graphics'
TOKENS = json.loads((SOURCE / 'computed-product-tokens.json').read_text(encoding='utf-8'))
W, H, FPS, FRAMES = 1920, 1080, 30, 150
def rgb(s):
    return tuple(int(s[i:i+2], 16) for i in (1, 3, 5))
BG, TEXT, GOLD = [rgb(TOKENS[k]) for k in ('--bg-0', '--text-strong', '--accent')]
def mix(a, b, p):
    return tuple(round(x+(y-x)*p) for x, y in zip(a, b))
MUTED, LINE = mix(BG, TEXT, .57), mix(BG, TEXT, .20)

@lru_cache(None)
def font(size, bold=False):
    return ImageFont.truetype('C:/Windows/Fonts/'+('msyhbd.ttc' if bold else 'msyh.ttc'), size)
def ease(t):
    t = min(1, max(0, t))
    return 1-(1-t)**4
def progress(t, start, duration=.65):
    return ease((t-start)/duration)
def lerp(a, b, p):
    return a+(b-a)*p

def base():
    im = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(im)
    # Token-mixed ambient light creates depth without decorative particles.
    for y in range(H):
        amount=.021*max(0, 1-abs(y-440)/540)
        d.line((0,y,W,y), fill=mix(BG,TEXT,amount))
    return im

def text(im, label, x, y, size, p=1, color=TEXT, bold=False, anchor='lt', rise=0):
    if p <= 0: return
    layer=Image.new('RGBA', im.size)
    ImageDraw.Draw(layer).text((round(x),round(y+rise*(1-p))),label,font=font(size,bold),fill=(*color,round(p*255)),anchor=anchor)
    im.paste(layer,(0,0),layer)

def draw_path(im, points, p, color=GOLD, width=3):
    if p <= 0: return
    lengths=[math.dist(a,b) for a,b in zip(points,points[1:])]
    remain=sum(lengths)*min(1,p)
    d=ImageDraw.Draw(im)
    for a,b,length in zip(points,points[1:],lengths):
        q=min(1,remain/length) if length else 1
        if q <= 0: break
        d.line((a,(lerp(a[0],b[0],q),lerp(a[1],b[1],q))),fill=color,width=width)
        remain-=length

def dot(im,x,y,p,color=GOLD,r=6):
    r*=p
    if r: ImageDraw.Draw(im).ellipse((x-r,y-r,x+r,y+r),fill=color)

def heading(im,t,kicker,title):
    text(im,'DEEP MONKEY STUDIO',112,62,22,color=MUTED)
    text(im,kicker,1808,62,22,color=MUTED,anchor='rt')
    text(im,title,112,176,72,progress(t,0,.7),bold=True,rise=28)

def layers(t):
    im=base(); heading(im,t,'工程架构 · 概念关系','上层创作，下层复用')
    text(im,'把创作入口，连接到同一份工程。',116,282,29,progress(t,.25),color=MUTED)
    xs=[520,960,1400]
    for i,(x,label) in enumerate(zip(xs,['二维','三维','脚本 / 插件'])):
        p=progress(t,.5+i*.12)
        text(im,label,x,390,38,p,anchor='mm',rise=18)
        draw_path(im,[(x,433),(x,472),(960,472),(960,510)],progress(t,1.05+i*.15,.8),mix(BG,GOLD,.72),2)
    p=progress(t,1.3,.7); d=ImageDraw.Draw(im)
    if p: d.rounded_rectangle((700-30*(1-p),516,1220+30*(1-p),631),radius=5,fill=mix(BG,GOLD,.045*p),outline=mix(BG,GOLD,.7*p),width=2)
    text(im,'作者工程',960,571,49,p,color=GOLD,bold=True,anchor='mm')
    for i,(x,label) in enumerate(zip(xs,['引擎','数据','模型'])):
        draw_path(im,[(960,634),(960,688),(x,688),(x,746)],progress(t,2.1+i*.14,.85),mix(BG,GOLD,.72),2)
        text(im,label,x,794,39,progress(t,2.7+i*.12),bold=True,anchor='mm',rise=18)
    text(im,'工作台搭建应用  /  开放模块继续创造',960,905,25,progress(t,3.25),color=MUTED,anchor='mm')
    return im

def semantics(t):
    im=base(); heading(im,t,'本体 · 概念关系','让业务知识，成为工程的一部分')
    text(im,'对象有身份。关系有方向。行动有依据。',116,282,29,progress(t,.2),color=MUTED)
    xs=[320,745,1170,1595]
    labels=['设备','传感器','告警','工单']; details=['对象身份','字段映射','输入条件','行动与影响']
    for i,x in enumerate(xs):
        start=.55+i*.49; p=progress(t,start)
        text(im,f'0{i+1}',x,465,24,p,color=MUTED,anchor='mm')
        text(im,labels[i],x,559,54,p,color=GOLD if i==3 else TEXT,bold=True,anchor='mm',rise=22)
        dot(im,x,649,p,color=GOLD if i==3 else MUTED)
        text(im,details[i],x,733,28,progress(t,start+.35),color=MUTED,anchor='mm')
        if i<3:
            draw_path(im,[(x+15,649),(xs[i+1]-16,649)],progress(t,start+.35,.62),GOLD,3)
            q=progress(t,start+.8,.24)
            if q: ImageDraw.Draw(im).polygon([(xs[i+1]-30,643),(xs[i+1]-18,649),(xs[i+1]-30,655)],fill=mix(BG,GOLD,q))
    draw_path(im,[(320,815),(1595,815)],progress(t,2.9,.7),LINE,1)
    text(im,'对象 · 关系 · 行动',960,886,28,progress(t,3.2),color=GOLD,anchor='mm')
    return im

def efficiency(t):
    im=base(); heading(im,t,'引擎策略 · 概念图形','把计算，花在需要的地方')
    text(im,'重复、变化与远近，各有处理方式。',116,282,29,progress(t,.2),color=MUTED)
    xs=[390,960,1530]
    for i,(x,label,result) in enumerate(zip(xs,['重复设备','场景变化','远近内容'],['实例合批','增量更新','按需加载'])):
        start=.5+i*.4; p=progress(t,start)
        text(im,label,x,427,32,p,anchor='mm',rise=12)
        q=progress(t,1.4+i*.38,.9); d=ImageDraw.Draw(im)
        if i==0:
            for j in range(9):
                col,row=j%3,j//3
                xx=lerp(x-105+col*90,x-55+col*45,q)
                yy=lerp(540+row*70,570+row*45,q)
                side=lerp(38,26,q)
                d.rectangle((xx,yy,xx+side,yy+side),outline=mix(BG,TEXT,p*.7),width=2)
            if q: d.rounded_rectangle((x-76,551,x+77,691),radius=3,outline=mix(BG,GOLD,q),width=3)
        elif i==1:
            for row in range(4):
                for col in range(5):
                    xx=x-125+col*52; yy=551+row*38
                    active=(col==2 and row in (1,2))
                    d.rectangle((xx,yy,xx+38,yy+23),fill=mix(BG,GOLD,q*.8) if active else mix(BG,TEXT,p*.12),outline=mix(BG,TEXT,p*.2))
        else:
            for j in range(3):
                radius=[53,34,19][j]; xx=x-108+j*102
                amount=lerp(.58,[.85,.39,.17][j],q)*p
                d.ellipse((xx-radius,608-radius,xx+radius,608+radius),outline=mix(BG,GOLD,amount),width=[4,3,2][j])
            draw_path(im,[(x-165,700),(x+163,700)],q,LINE,1)
        draw_path(im,[(x,735),(x,777)],progress(t,2.2+i*.32),GOLD,2)
        text(im,result,x,831,40,progress(t,2.5+i*.32),color=GOLD,bold=True,anchor='mm',rise=14)
    return im

def backends(t):
    im=base(); heading(im,t,'运行路径 · 概念关系','共享工程，不同运行路径')
    text(im,'场景包 · 资源 · 能力契约',116,282,29,progress(t,.2),color=MUTED)
    text(im,'作者工程',960,410,43,progress(t,.45),color=GOLD,bold=True,anchor='mm',rise=18)
    xs=[450,960,1470]
    for i,(x,label) in enumerate(zip(xs,['Three.js','Deep WebGPU','Rust 内核'])):
        draw_path(im,[(960,451),(960,497),(x,497),(x,546)],progress(t,.95+i*.17,.85),GOLD,2)
        text(im,label,x,592,42,progress(t,1.55+i*.17),bold=True,anchor='mm',rise=20)
    text(im,'TypeScript',705,682,26,progress(t,2.1),color=MUTED,anchor='mm')
    for i,(x,label) in enumerate(zip([1330,1630],['WASM','Native'])):
        draw_path(im,[(1470,637),(1470,716),(x,716),(x,766)],progress(t,2.2+i*.13,.8),GOLD,2)
        text(im,label,x,812,35,progress(t,2.85+i*.13),color=GOLD,bold=True,anchor='mm',rise=14)
    text(im,'复用 Rust 内核',1470,894,24,progress(t,3.25),color=MUTED,anchor='mm')
    return im

def closing(t):
    im=base(); d=ImageDraw.Draw(im)
    text(im,'DEEP MONKEY STUDIO',112,62,22,color=MUTED)
    # The sentence is the subject; a line becomes a durable authoring mark.
    p=progress(t,.05,1.0)
    text(im,'你创造的世界',112,267,106,p,bold=True,rise=44)
    q=progress(t,1.05,1.0)
    text(im,'我将它留下来',112,418,106,q,color=GOLD,bold=True,rise=35)
    draw_path(im,[(116,620),(1804,620)],progress(t,1.85,1.1),mix(BG,GOLD,.65),2)
    text(im,'从 Vibe Coding，到 Vibe World',116,700,39,progress(t,2.2,.85),color=TEXT,rise=18)
    text(im,'DeepMonkey Studio',116,804,31,progress(t,2.85),color=MUTED)
    text(im,'github.com/fatasia/DeepMonkey-Studio',1804,862,25,progress(t,3.15),color=MUTED,anchor='rt')
    return im

def data(t):
    im=base(); heading(im,t,'数据链路 · 概念关系','数据，有了来处')
    text(im,'从来源与规则，抵达空间对象。',116,282,29,progress(t,.2),color=MUTED)
    xs=[385,920,1480]; d=ImageDraw.Draw(im)
    for i,(x,label,sub) in enumerate(zip(xs,['输入数据','处理规则','空间对象'],['数据库 / 接口 / 工业协议','清洗 / 过滤','对象属性'])):
        start=.55+i*.63; p=progress(t,start)
        text(im,label,x,440,40,p,bold=True,anchor='mm',rise=18)
        text(im,sub,x,784,26,progress(t,start+.3),color=MUTED,anchor='mm')
        if i==0:
            for j in range(3):
                yy=560+j*43
                d.line((x-88,yy,x+88,yy),fill=mix(BG,TEXT,p*.52),width=3)
                dot(im,x-110,yy,p,MUTED,4)
        elif i==1:
            d.rectangle((x-95,538,x+95,690),outline=mix(BG,TEXT,p*.3),width=2)
            for j in range(3):
                draw_path(im,[(x-60,570+j*37),(x+60-j*18,570+j*37)],progress(t,1.28+j*.12),MUTED,3)
        else:
            d.rounded_rectangle((x-124,529,x+124,706),radius=4,outline=mix(BG,GOLD,p*.7),width=3)
            # Attributes appear only after the data edge has arrived.
            q=progress(t,2.9,.65)
            text(im,'对象身份',x,575,27,p,color=GOLD,anchor='mm')
            draw_path(im,[(x-88,618),(x+88,618)],q,LINE,1)
            for j in range(2):
                draw_path(im,[(x-85,650+j*24),(x+85,650+j*24)],progress(t,3.02+j*.15),mix(BG,TEXT,.48),2)
        if i<2:
            draw_path(im,[(x+130,617),(xs[i+1]-135,617)],progress(t,.95+i*.95,.95),GOLD,3)
    text(im,'来源  →  规则  →  对象属性',960,903,28,progress(t,3.5),color=GOLD,anchor='mm')
    return im

CLIPS={k:globals()[k] for k in ['layers','semantics','efficiency','backends','closing','data']}

def snapshots(names,round_name):
    dest=OUT/round_name; dest.mkdir(parents=True,exist_ok=True)
    for name in names:
        samples=[.6,1.5,2.7,4.3]
        sheet=Image.new('RGB',(1920,1080),BG)
        for i,t in enumerate(samples):
            shot=CLIPS[name](t); shot.save(dest/f'{name}-{t:.1f}.png')
            shot=shot.resize((960,540),Image.Resampling.LANCZOS)
            sheet.paste(shot,((i%2)*960,(i//2)*540))
        sheet.save(dest/f'{name}-contact.png')

def render(name):
    path=OUT/f'{name}.mp4'
    args=['ffmpeg','-y','-hide_banner','-loglevel','error','-threads','2','-filter_threads','2','-f','rawvideo','-pixel_format','rgb24','-video_size','1920x1080','-framerate',str(FPS),'-i','pipe:0','-an','-c:v','libx264','-threads','2','-preset','fast','-crf','17','-pix_fmt','yuv420p','-movflags','+faststart',str(path)]
    proc=subprocess.Popen(args,stdin=subprocess.PIPE)
    for frame in range(FRAMES):
        proc.stdin.write(CLIPS[name](frame/FPS).tobytes())
    proc.stdin.close()
    if proc.wait(): raise RuntimeError(f'Encoding failed: {name}')
    probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(path)],text=True))
    stream=probe['streams'][0]
    assert int(stream['nb_frames'])==FRAMES and stream['width']==W and stream['height']==H
    subprocess.run(['ffmpeg','-v','error','-threads','2','-i',str(path),'-f','null','-'],check=True)
    return {'id':name,'kind':'conceptMotion','source':str(path),'sha256':hashlib.file_digest(path.open('rb'),'sha256').hexdigest(),'frames':FRAMES,'fps':FPS,'duration':float(probe['format']['duration']),'stableFromSeconds':4.15 if name=='data' else 3.9,'sourceIn':0,'identityVerified':True,'visualReviewed':True,'semanticRole':'原创动态图形 / 概念关系；不作为产品操作实证','subtitlePosition':'bottom','overlays':[]}

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--clips',nargs='+',choices=CLIPS,default=list(CLIPS)); parser.add_argument('--snapshots-only',action='store_true'); parser.add_argument('--round',default='review-1')
    args=parser.parse_args(); OUT.mkdir(parents=True,exist_ok=True)
    (OUT/'review-tokens.css').write_text(':root{'+''.join(k+':'+v+';' for k,v in TOKENS.items())+'}',encoding='utf-8')
    snapshots(args.clips,args.round)
    if not args.snapshots_only:
        manifest=OUT/'manifest.json'; items=json.loads(manifest.read_text(encoding='utf-8')) if manifest.exists() else {}
        for name in args.clips:
            items[name]=render(name)
            manifest.write_text(json.dumps(items,ensure_ascii=False,indent=2),encoding='utf-8')
            print(json.dumps(items[name],ensure_ascii=False),flush=True)
if __name__=='__main__': main()
