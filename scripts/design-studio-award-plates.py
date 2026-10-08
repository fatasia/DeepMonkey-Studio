"""Create editorial concept diagrams with the captured product brand tokens."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'deliverables/studio-020-20261007/intro-award-v2-20261008'
TOKENS=json.loads((OUT/'computed-product-tokens.json').read_text(encoding='utf-8'))
BG,TEXT,ACCENT=[TOKENS[k] for k in ['--bg-0','--text-strong','--accent']]
FONTS=Path('C:/Windows/Fonts')
DEST=OUT/'plates'
DEST.mkdir(exist_ok=True)


def font(size,bold=False):
    return ImageFont.truetype(str(FONTS/('msyhbd.ttc' if bold else 'msyh.ttc')),size)


def base(title,subtitle):
    image=Image.new('RGB',(1920,1080),BG)
    draw=ImageDraw.Draw(image)
    draw.text((96,60),'DEEP MONKEY STUDIO',font=font(24),fill=ACCENT)
    draw.line((96,114,1824,114),fill=ACCENT,width=1)
    draw.text((96,172),title,font=font(80,True),fill=TEXT)
    draw.text((100,292),subtitle,font=font(34),fill=TEXT)
    return image,draw


def row(draw,y,names,accent=False):
    span=1728/len(names)
    for i,name in enumerate(names):
        center=96+(i+.5)*span
        draw.text((center,y),name,font=font(44,True),fill=ACCENT if accent else TEXT,anchor='mt')


def connection(draw,y):
    draw.line((960,y,960,y+80),fill=ACCENT,width=2)
    draw.polygon([(950,y+67),(970,y+67),(960,y+82)],fill=ACCENT)


image,draw=base('上层创作，下层复用','一个工程，连接工作台与开放能力')
row(draw,440,['二维','三维','脚本 / 插件'])
connection(draw,510)
row(draw,625,['作者工程'],True)
connection(draw,695)
row(draw,810,['引擎','数据','模型'])
image.save(DEST/'layers.png')

image,draw=base('对象 · 关系 · 行动','把业务知识写进工程')
row(draw,520,['设备','传感器','告警 / 工单'])
draw.line((380,640,1540,640),fill=ACCENT,width=2)
for x in [384,960,1536]:
    draw.ellipse((x-8,632,x+8,648),fill=ACCENT)
row(draw,745,['身份','字段映射','输入与影响'],True)
image.save(DEST/'semantics.png')

image,draw=base('把计算花在需要的地方','重复、变化与远近，各有处理方式')
row(draw,470,['重复设备','场景变化','远近内容'])
for x in [384,960,1536]:
    draw.line((x,560,x,650),fill=ACCENT,width=2)
row(draw,710,['实例合批','增量更新','按需加载'],True)
image.save(DEST/'efficiency.png')

image,draw=base('共享工程，不同运行路径','场景包 · 资源 · 能力契约')
row(draw,422,['作者工程'],True)
connection(draw,490)
row(draw,610,['Three.js','Deep WebGPU','Rust 内核'])
draw.text((960,681),'TypeScript',font=font(28),fill=TEXT,anchor='mt')
draw.line((1536,698,1536,776),fill=ACCENT,width=2)
draw.text((1536,810),'Native / WASM',font=font(40,True),fill=ACCENT,anchor='mt')
image.save(DEST/'backends.png')

image,draw=base('工程，走进下一段工作','从工作台到使用它的人')
row(draw,455,['浏览器独立运行'],True)
connection(draw,530)
row(draw,710,['Windows / 离线包','Docker 团队部署'])
draw.text((960,900),'交付方式',font=font(28),fill=TEXT,anchor='mt')
image.save(DEST/'delivery.png')

image,draw=base('你创造的世界','我将它留下来')
draw.text((96,480),'DeepMonkey Studio',font=font(72,True),fill=ACCENT)
draw.text((100,615),'从 Vibe Coding，到 Vibe World',font=font(40),fill=TEXT)
draw.text((100,870),'github.com/fatasia/DeepMonkey-Studio',font=font(32),fill=TEXT)
image.save(DEST/'closing.png')

image,draw=base('数据，有了来处','处理逻辑把输入、规则与输出组织起来')
row(draw,470,['输入数据','处理规则','数据产品'])
draw.line((380,620,1540,620),fill=ACCENT,width=2)
for x in [680,1256]:
    draw.polygon([(x-12,608),(x+12,620),(x-12,632)],fill=ACCENT)
row(draw,745,['来源','清洗 / 过滤','对象属性'],True)
image.save(DEST/'data.png')

image,draw=base('让经验成为行为','配置规则，编写逻辑')
row(draw,480,['事件','动作','脚本'])
draw.line((380,620,1540,620),fill=ACCENT,width=2)
row(draw,745,['触发条件','参数与目标','生命周期'],True)
image.save(DEST/'behaviors.png')

image,draw=base('保留条件，查看结果','工况推演 · 独立示例')
row(draw,490,['输入条件','推演模型','结果记录'])
draw.line((380,620,1540,620),fill=ACCENT,width=2)
row(draw,755,['参数','适用域','来源与指纹'],True)
image.save(DEST/'simulation.png')

image,draw=base('通过场景接口，读出工程','Server SDK · 实际匿名读取当前发布场景')
code=["import { ServerClient } from '@bim-studio/server-sdk';",
      "const client = new ServerClient({", "  profile: { baseUrl: API_ORIGIN }, authStore", "});",
      "const scene = await client.request(", "  `/api/public/scenes/${sceneId}/browse`", ");"]
mono=ImageFont.truetype(str(FONTS/'consola.ttf'),30)
for i,line in enumerate(code):
    draw.text((100,410+i*50),line,font=mono,fill=TEXT)
draw.line((1135,420,1135,835),fill=ACCENT,width=2)
for i,line in enumerate(['HTTP 200','发布版本 1','SMT 产线 · 1 模型','WebGL · 隐藏工具栏']):
    draw.text((1210,440+i*95),line,font=font(34, i==0),fill=ACCENT if i==0 else TEXT)
image.save(DEST/'sdk.png')
print(DEST)
