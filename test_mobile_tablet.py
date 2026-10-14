"""Run the core touch workflows at phone and tablet widths."""
import unittest
from playwright.sync_api import expect
from test_app import AppBrowserCase


class MobileTabletTests(AppBrowserCase):
    def run_workflow(self, viewport):
        self.page.set_viewport_size(viewport)
        self.page.locator('.option-item').nth(2).click()
        self.assertIn('回答正确', self.page.locator('.result-header').inner_text())
        self.page.locator('#next-btn').click()
        self.page.select_option('#bank-select', 'elem')
        count = self.page.evaluate('BEAUTIFUL_CHINA_DATA.banks.elem.length')
        self.assertIn(str(count), self.page.locator('#progress-text').inner_text())
        self.page.locator('.pill-btn[data-mode="random"]').click()
        self.assertIn('20', self.page.locator('#progress-text').inner_text())
        for trigger, modal in [('#child-chip-btn', 'child-modal'), ('#sync-badge-btn', 'sync-modal')]:
            self.page.locator(trigger).click()
            expect(self.page.locator('#' + modal)).to_be_visible()
            self.page.locator('#' + modal + ' .modal-close-btn').click()
            expect(self.page.locator('#' + modal)).to_be_hidden()
        self.page.evaluate('AppBridge.openHandbook(1)')
        expect(self.page.locator('#handbook-modal')).to_be_visible()
        self.page.locator('#handbook-modal .modal-close-btn').click()

    def test_phone_workflow(self):
        self.run_workflow({'width': 390, 'height': 844})

    def test_tablet_workflow(self):
        self.run_workflow({'width': 768, 'height': 1024})

    def test_narrow_phone_controls_and_exam_fit_the_screen(self):
        self.page.set_viewport_size({'width': 320, 'height': 700})
        for selector in ['.mode-pills .pill-btn', '.bottom-nav .nav-btn', '.q-fav-toggle']:
            for button in self.page.locator(selector).all():
                box = button.bounding_box()
                self.assertGreaterEqual(box['x'], 0)
                self.assertLessEqual(box['x'] + box['width'], 320)
        self.page.locator('.pill-btn[data-mode="exam"]').click()
        button = self.page.locator('#exam-submit-btn').bounding_box()
        self.assertLessEqual(button['x'] + button['width'], 320)
        self.assertEqual(self.page.evaluate('document.documentElement.scrollWidth'), 320)

    def test_long_nickname_keeps_status_controls_visible_and_text_literal(self):
        self.page.set_viewport_size({'width': 320, 'height': 700})
        nickname = '小明 <勇士> & familyfamilyfamily'
        self.page.evaluate("name=>CloudSync.addProfile({name,avatar:'🐯'})", nickname)
        for button in self.page.locator('.nav-status-bar button').all():
            box = button.bounding_box()
            self.assertGreaterEqual(box['x'], 0)
            self.assertLessEqual(box['x'] + box['width'], 320)
        self.page.locator('#child-chip-btn').click()
        expect(self.page.locator('#child-modal')).to_be_visible()
        expect(self.page.locator('.child-profile-card.active .child-info-name')).to_contain_text(nickname)
        self.assertEqual(self.page.locator('#children-card-list .child-info-name > 勇士').count(), 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
