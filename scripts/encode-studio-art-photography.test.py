"""Clock and source-integrity checks without touching completed real captures."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from PIL import Image

spec=importlib.util.spec_from_file_location('photography',Path(__file__).with_name('encode-studio-art-photography.py'))
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class ClockIntegrity(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name)
        for index in range(3): Image.new('RGB',(16,9)).save(self.root/f'{index}.png')
        self.capture={'schema':'studio-real-screencast.v1','wallStartMs':1000000,'wallEndMs':1000500,
                      'frames':[{'file':f'{i}.png','metadata':{'timestamp':t}} for i,t in [(0,1000.0),(2,1000.4),(1,1000.1)]]}
        self.manifest=self.root/'frames.json'
    def tearDown(self): self.temp.cleanup()
    def write(self):
        self.manifest.write_text(json.dumps(self.capture),encoding='utf-8')
        return self.manifest.read_bytes()
    def test_stable_chronology_preserves_source(self):
        before=self.write(); capture,records,start,end,size=module.load(self.manifest)
        self.assertEqual([r['arrivalIndex'] for r in records],[0,2,1])
        self.assertEqual([r['timestamp'] for r in records],[1000.0,1000.1,1000.4])
        self.assertEqual(end-records[0]['timestamp'],.5)
        self.assertAlmostEqual(end-records[-1]['timestamp'],.1)
        self.assertEqual(self.manifest.read_bytes(),before)
        self.assertEqual(size,(16,9))
        self.assertTrue(all(len(r['sha256'])==64 for r in records))
    def test_duplicate_timestamp_is_rejected(self):
        self.capture['frames'][2]['metadata']['timestamp']=1000.0; self.write()
        with self.assertRaisesRegex(ValueError,'Duplicate'): module.load(self.manifest)
    def test_unfinished_clock_is_rejected(self):
        self.capture['wallEndMs']=1000300; self.write()
        with self.assertRaisesRegex(ValueError,'bracket'): module.load(self.manifest)
    def test_source_escape_is_rejected(self):
        self.capture['frames'][2]['file']='../outside.png'; self.write()
        with self.assertRaisesRegex(ValueError,'escaping'): module.load(self.manifest)

if __name__=='__main__': unittest.main()
