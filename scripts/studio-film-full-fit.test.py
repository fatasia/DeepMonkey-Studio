"""Check full-source fit and retained image edges with an actual FFmpeg frame."""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('fit', ROOT/'scripts/lib/studioFilmFullFit.py')
fit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fit)


class FullFit(unittest.TestCase):
    def test_capture_sizes_and_caption_separation(self):
        for width,height in [(1920,1080),(1920,1061),(1440,900),(440,382),(1280,800)]:
            box=fit.rectangle(width,height)
            self.assertGreaterEqual(box['x'],0)
            self.assertGreaterEqual(box['y'],0)
            self.assertLessEqual(box['x']+box['width'],1920)
            self.assertLessEqual(box['y']+box['height'],960)
            self.assertLess(box['aspectRoundingError'],.006)

    def test_non_square_pixel_source(self):
        box=fit.rectangle(1440,1080,4/3)
        self.assertAlmostEqual(box['width']/box['height'],16/9,places=2)

    def test_native_resolution_cap(self):
        box=fit.rectangle(440,382,max_scale=1)
        self.assertEqual([box['width'],box['height']],[440,382])

    def test_forbidden_ui_transforms(self):
        for key in fit.FORBIDDEN:
            with self.assertRaises(ValueError): fit.validate_layout({key:False})
        with self.assertRaises(ValueError): fit.validate_layout({'overlays':[{'text':'label'}]})

    def test_caption_name_and_bounds(self):
        self.assertIn('AI for Science',fit.caption_text('面向AI for\nScience'))
        with self.assertRaises(ValueError):fit.caption_text('a\nb\nc')

    def test_actual_edge_pixels_and_safe_bar(self):
        folder=ROOT/'test-output/studio-film-full-fit'
        folder.mkdir(exist_ok=True)
        source=folder/'edge-source.png';output=folder/'edge-fitted.png'
        image=Image.new('RGB',(1920,1061),'white');draw=ImageDraw.Draw(image)
        colors=['red','lime','blue','yellow']
        corners=[(0,0),(1860,0),(0,1001),(1860,1001)]
        for (x,y),color in zip(corners,colors):draw.rectangle((x,y,x+59,y+59),fill=color)
        image.save(source)
        transform,box=fit.filter_for(1920,1061,'#0b1114')
        self.assertNotIn('crop=',transform);self.assertNotIn('zoompan',transform)
        subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-threads','2','-i',str(source),
                        '-vf',transform,'-frames:v','1','-update','1',str(output)],check=True)
        actual=Image.open(output).convert('RGB')
        samples=[(box['x']+15,box['y']+15),(box['x']+box['width']-15,box['y']+15),
                 (box['x']+15,box['y']+box['height']-15),
                 (box['x']+box['width']-15,box['y']+box['height']-15)]
        expected=[(255,0,0),(0,255,0),(0,0,255),(255,255,0)]
        for point,rgb in zip(samples,expected):
            self.assertLess(max(abs(a-b) for a,b in zip(actual.getpixel(point),rgb)),12)
        self.assertLess(max(abs(a-b) for a,b in zip(actual.getpixel((960,1020)),(11,17,20))),4)


if __name__=='__main__':unittest.main()
