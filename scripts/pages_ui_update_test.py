import importlib.util
import json
import pathlib
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('pages_ui_update', pathlib.Path(__file__).with_name('pages-ui-update.py'))
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)


class PagesUiUpdateTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.site = self.root / 'site'
        self.site.mkdir()
        for name in ui.ENTRY_FILES | {'assets/current.js'}:
            file = self.site / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('entry', encoding='utf-8')
        self.workspace = {'schemaVersion': 1, 'defaultPath': '/', 'state': {'projects': [{'id': 'smt'}]}}
        (self.site / 'demo/workspace.json').write_text(json.dumps(self.workspace), encoding='utf-8')
        (self.site / 'editor-hosting.json').write_text(json.dumps({'productionDeployment': 'browser-local-demo', 'apiOrigin': None}), encoding='utf-8')
        self.base = self.root / 'base.zip'
        self.base.write_bytes(b'immutable release')
        self.update, self.manifest = self.root / 'ui.zip', self.root / 'manifest.json'
        ui.pack(self.site, self.base, self.update, self.manifest, 'a' * 40)

    def test_applies_ui_without_replacing_frozen_assets(self):
        (self.site / 'assets/old.js').write_text('obsolete', encoding='utf-8')
        frozen = self.site / 'demo/model.glb'
        frozen.write_bytes(b'frozen model')
        ui.apply(self.site, self.base, self.update, self.manifest)
        self.assertFalse((self.site / 'assets/old.js').exists())
        self.assertEqual(frozen.read_bytes(), b'frozen model')
        self.assertTrue((self.site / 'pages-ui-version.json').exists())

    def test_checksum_failure_preserves_active_files(self):
        self.base.write_bytes(b'wrong release')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            ui.apply(self.site, self.base, self.update, self.manifest)
        self.assertTrue((self.site / 'assets/current.js').exists())

    def test_rejects_changed_frozen_workspace(self):
        (self.site / 'demo/workspace.json').write_text(json.dumps({**self.workspace, 'state': {'projects': []}}), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'frozen demo'):
            ui.apply(self.site, self.base, self.update, self.manifest)
        self.assertTrue((self.site / 'assets/current.js').exists())

    def test_rejects_traversal_and_symlinks(self):
        for name in ['../bad.js', '/absolute', 'assets/../index.html', 'assets\\bad.js', 'demo/resource.glb']:
            self.assertFalse(ui.allowed(name), name)
        with zipfile.ZipFile(self.update, 'a') as archive:
            link = zipfile.ZipInfo('assets/link.js')
            link.external_attr = 0o120777 << 16
            archive.writestr(link, 'current.js')
        with zipfile.ZipFile(self.update) as archive:
            with self.assertRaisesRegex(ValueError, 'Unsafe'):
                ui.inspect_archive(archive)


if __name__ == '__main__':
    unittest.main()
