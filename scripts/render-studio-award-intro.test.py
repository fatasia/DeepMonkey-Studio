"""Guard source identity, source speed, variable edit clock and backend claims."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('award',Path(__file__).with_name('render-studio-award-intro.py'))
award=importlib.util.module_from_spec(spec)
spec.loader.exec_module(award)
SOURCE=award.ROOT/'deliverables/studio-020-20261007/intro-astra/raw/astra-viewer-hero-wide-take1/viewer-hero-wide-1080p.mp4'


class EditClockTests(unittest.TestCase):
    def setUp(self):
        self.edl={'schema':'studio-film-segments.v1','fps':30,'totalFrames':75,'chapters':[
            {'id':'P01','targetInFrame':0,'targetOutFrame':75,'sourceSegments':[
                {'id':'a','kind':'footage','source':str(SOURCE),'sourceIn':1,'frames':30,'sha256':award.sha(SOURCE),
                 'identityVerified':True,'visualReviewed':True,'backend':'webgl'},
                {'id':'b','kind':'footage','source':str(SOURCE),'sourceIn':6,'frames':45,'sha256':award.sha(SOURCE),
                 'identityVerified':True,'visualReviewed':True,'backend':'webgl'}]}]}

    def test_variable_duration_multiple_original_speed_clips(self):
        self.assertEqual(award.validate(self.edl),[])

    def test_reject_stale_source_hash(self):
        self.edl['chapters'][0]['sourceSegments'][0]['sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'identity'):
            award.validate(self.edl)

    def test_reject_loop_or_hold_to_fill_window(self):
        self.edl['chapters'][0]['sourceSegments'][0]['sourceIn']=24.4
        with self.assertRaisesRegex(ValueError,'exceeds original'):
            award.validate(self.edl)

    def test_reject_three_with_deep_label(self):
        self.edl['chapters'][0]['sourceSegments'][0]['expectedBackend']='webgpu'
        with self.assertRaisesRegex(ValueError,'Backend label'):
            award.validate(self.edl)

    def test_missing_visual_review_stays_pending(self):
        self.edl['chapters'][0]['sourceSegments'][1]['visualReviewed']=False
        self.assertEqual(award.validate(self.edl),['P01/b'])

    def test_reject_unfilled_chapter(self):
        self.edl['chapters'][0]['sourceSegments'][1]['frames']=44
        with self.assertRaisesRegex(ValueError,'exactly fill'):
            award.validate(self.edl)

    def test_reject_edit_clock_gap(self):
        extra=copy.deepcopy(self.edl['chapters'][0])
        extra.update(id='P02',targetInFrame=76,targetOutFrame=151)
        self.edl['chapters'].append(extra)
        self.edl['totalFrames']=151
        with self.assertRaisesRegex(ValueError,'contiguous'):
            award.validate(self.edl)

    def test_awaiting_capture_is_explicit_pending(self):
        self.edl['chapters'][0]['sourceSegments'][0]['source']=None
        self.assertEqual(award.validate(self.edl),['P01/a'])

    def test_authored_motion_has_no_renderer_identity(self):
        item=self.edl['chapters'][0]['sourceSegments'][0]
        item.update(kind='conceptMotion',authoredMotion=True)
        with self.assertRaisesRegex(ValueError,'renderer identity'):
            award.validate(self.edl)
        item.pop('backend')
        self.assertEqual(award.validate(self.edl),[])

    def test_editorial_viewport_is_footage_and_keeps_source_clock(self):
        item=self.edl['chapters'][0]['sourceSegments'][0]
        item['presentation']={'kind':'worldFrame','revealFrames':16}
        self.assertEqual(award.validate(self.edl),[])
        item['presentation']['revealFrames']=30
        with self.assertRaisesRegex(ValueError,'viewport reveal clock'):
            award.validate(self.edl)

    def test_editorial_frame_does_not_claim_a_product_camera(self):
        value=award.world_frame_filter('fps=30','#0b1114',16)
        self.assertIn('overlay',value)
        self.assertNotIn('setpts',value)
        self.assertNotIn('zoompan',value)

    def test_result_hold_requires_capture_origin_and_reading_role(self):
        item=self.edl['chapters'][0]['sourceSegments'][0]
        item.update(kind='readingHold')
        with self.assertRaisesRegex(ValueError,'Reading hold requires'):
            award.validate(self.edl,False)
        item.update(readingRole='resultReadability',sourceEvidence={'source':str(SOURCE),'sha256':award.sha(SOURCE),'timestamp':2})
        self.assertEqual(award.validate(self.edl,False),[])


if __name__=='__main__':
    unittest.main()
