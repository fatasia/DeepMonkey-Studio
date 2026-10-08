"""Full-source display geometry and subtitle isolation for recorded product media."""
import math

WIDTH, HEIGHT, CONTENT_HEIGHT, CAPTION_CENTER = 1920, 1080, 960, 1020
FORBIDDEN = ('crop', 'zoom', 'zoompan', 'presentation', 'worldFrame', 'stretch')


def validate_layout(segment):
    if any(key in segment for key in FORBIDDEN):
        raise ValueError('Full-source fit does not accept crop, zoom or editorial viewport')
    if segment.get('overlays'):
        raise ValueError('Recorded UI is kept clear; labels belong in the subtitle safe area')


def rectangle(width, height, sar=1, max_scale=None):
    if min(width, height, sar) <= 0:
        raise ValueError('Positive source geometry required')
    display_width = width * sar
    scale = min(WIDTH/display_width, CONTENT_HEIGHT/height)
    if max_scale is not None:
        if max_scale<=0:raise ValueError('Positive maximum scale required')
        scale=min(scale,max_scale)
    fitted_width = max(2, 2*math.floor(display_width*scale/2))
    fitted_height = max(2, 2*math.floor(height*scale/2))
    error = abs(fitted_width/fitted_height/(display_width/height)-1)
    if error > 2/fitted_width+2/fitted_height:
        raise ValueError('Aspect ratio rounding differs from source')
    return {'sourceWidth': width, 'sourceHeight': height, 'sourceSar': sar,
            'x': (WIDTH-fitted_width)//2, 'y': (CONTENT_HEIGHT-fitted_height)//2,
            'width': fitted_width, 'height': fitted_height,
            'captionArea': [0, CONTENT_HEIGHT, WIDTH, HEIGHT-CONTENT_HEIGHT],
            'aspectRoundingError': error, 'sourceEdgesPreserved': True,'maxScale':max_scale}


def filter_for(width, height, background, sar=1, max_scale=None):
    box = rectangle(width, height, sar,max_scale)
    # Numeric min-fit dimensions prevent auto-cover, changing camera or stretching.
    return (f"fps=30,scale={box['width']}:{box['height']}:flags=lanczos,setsar=1,"
            f"pad={WIDTH}:{HEIGHT}:{box['x']}:{box['y']}:color=0x{background.lstrip('#')},"
            'format=yuv420p'), box


def caption_text(text):
    text = text.replace('AI for\nScience', '\nAI for Science')
    if len(text.splitlines()) > 2 or '{' in text or '}' in text:
        raise ValueError('Plain captions of at most two lines required')
    return text
