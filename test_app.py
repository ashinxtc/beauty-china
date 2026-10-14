"""Browser regressions using a local server and a simulated sync service."""
import json
import os
from pathlib import Path
import shutil
import threading
import unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class AppBrowserCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(ROOT)))
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.playwright = sync_playwright().start()
        executable = os.environ.get('TEST_BROWSER_PATH') or shutil.which('chromium')
        options = {'headless': True}
        if executable:
            options['executable_path'] = executable
        cls.browser = cls.playwright.chromium.launch(**options)
        cls.url = f'http://127.0.0.1:{cls.server.server_port}/'

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join()

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 1024, 'height': 768})
        self.context.add_init_script("localStorage.setItem('bc_auto_sync_enabled', 'false')")
        self.cloud = None
        self.requests = []
        self.errors = []
        self.dialogs = []
        self.context.route('https://sync.daka-tool.top/**', self.sync_service)
        self.page = self.context.new_page()
        self.page.set_default_timeout(5000)
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.on('dialog', self.accept_dialog)
        self.page.goto(self.url)
        self.page.locator('.option-item').first.wait_for()

    def accept_dialog(self, dialog):
        self.dialogs.append(dialog.message)
        dialog.accept()

    def sync_service(self, route):
        request = route.request
        self.requests.append((request.method, request.url))
        headers = {'Access-Control-Allow-Origin': '*',
                   'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
                   'Access-Control-Allow-Headers': 'Content-Type'}
        if request.method == 'OPTIONS':
            route.fulfill(status=204, headers=headers)
        elif request.method == 'POST':
            self.cloud = json.loads(request.post_data)
            route.fulfill(status=200, json={'ok': True}, headers=headers)
        elif self.cloud is None:
            route.fulfill(status=404, json={}, headers=headers)
        elif '/ts?' in request.url:
            route.fulfill(status=200, json={'ts': self.cloud['_syncTs']}, headers=headers)
        else:
            route.fulfill(status=200, json=self.cloud, headers=headers)

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [], 'Unexpected JavaScript errors')

    def child_data(self):
        return self.page.evaluate('CloudSync.getActiveChildData()')


class AppTests(AppBrowserCase):
    def test_correct_answer_and_independent_children(self):
        self.page.locator('.option-item').nth(2).click()
        self.assertIn('回答正确', self.page.locator('.result-header').inner_text())
        self.page.evaluate("CloudSync.addProfile({name: '辰辰', avatar: '🐯'})")
        self.assertEqual(self.page.locator('#child-chip-name').inner_text(), '辰辰')
        self.assertEqual(self.page.locator('.result-banner').count(), 0)
        self.assertEqual(self.child_data()['answers'], {})
        self.page.evaluate("AppBridge.switchChild('child_default')")
        self.assertEqual(self.child_data()['answers']['Q_0001'], 'C')

    def test_stats_button_opens_the_current_child_dashboard_and_backup(self):
        self.page.locator('.option-item').nth(2).click()
        title = self.page.locator('.q-title').inner_text()
        self.page.locator('.nav-quick-actions button[title="查看学情与勋章"]').click()
        expect(self.page.locator('#stats-modal')).to_be_visible()
        self.assertIn('100%', self.page.locator('.stats-summary-grid').inner_text())
        self.page.keyboard.press('ArrowRight')
        self.assertEqual(self.page.locator('.q-title').inner_text(), title)
        with self.page.expect_download() as downloaded:
            self.page.get_by_role('button', name='📤 导出备份').click()
        backup = json.loads(Path(downloaded.value.path()).read_text())
        self.assertEqual(backup['answers']['Q_0001'], 'C')
        self.page.locator('#stats-modal .modal-close-btn').click()
        self.page.evaluate("CloudSync.addProfile({name:'新孩子',avatar:'🐼'})")
        self.page.locator('.nav-quick-actions button[title="查看学情与勋章"]').click()
        self.assertIn('0%', self.page.locator('.stats-summary-grid').inner_text())

    def test_mistake_can_be_answered_twice_and_mastered(self):
        self.page.locator('.option-item').first.click()
        self.page.evaluate("AppBridge.switchMode('mistakes')")
        self.assertEqual(self.page.locator('.option-item.disabled').count(), 0)
        self.page.locator('.option-item').nth(2).click()
        self.assertEqual(self.child_data()['mistakes']['Q_0001']['consecutiveCorrect'], 1)
        self.page.get_by_role('button', name='🔁 再答一次').click()
        self.page.locator('.option-item').nth(2).click()
        self.assertTrue(self.child_data()['mistakes']['Q_0001']['mastered'])
        self.page.evaluate("AppBridge.switchMode('mistakes')")
        self.assertEqual(self.page.locator('#progress-text').inner_text(), '0 / 0')
        self.page.get_by_role('button', name='返回全库练习').click()
        count = self.page.evaluate('BEAUTIFUL_CHINA_DATA.unified.length')
        self.assertEqual(self.page.locator('#progress-text').inner_text(), f'1 / {count}')

    def test_source_bank_mistakes_and_favorites_remain_visible(self):
        self.page.select_option('#bank-select', 'elem')
        self.page.locator('.q-fav-toggle').click()
        self.page.locator('.option-item').first.click()
        self.page.evaluate("AppBridge.switchMode('mistakes')")
        self.assertEqual(self.page.locator('#progress-text').inner_text(), '1 / 1')
        self.assertIn('elem_001', self.child_data()['mistakes'])
        self.page.evaluate("AppBridge.switchMode('favorites')")
        self.assertEqual(self.page.locator('#progress-text').inner_text(), '1 / 1')
        self.assertEqual(self.page.locator('.option-item.disabled').count(), 0)

    def test_unconfirmed_questions_are_absent_from_every_child_bank(self):
        self.assertTrue(self.page.evaluate("""[BEAUTIFUL_CHINA_DATA.unified,
            ...Object.values(BEAUTIFUL_CHINA_DATA.banks)].every(bank=>bank.every(q=>q.scorable && q.answer))"""))
        self.assertEqual(self.page.locator('.pill-btn[data-mode="pending"]').count(), 0)
        self.assertFalse(self.page.evaluate("BEAUTIFUL_CHINA_DATA.banks.contest25.some(q=>q.num===696 || q.num===902)"))

    def test_scored_sessions_use_only_verified_answers(self):
        self.page.select_option('#bank-select', 'contest25')
        self.page.evaluate("AppBridge.switchMode('random'); AppBridge.openQuestionSheet()")
        count = self.page.evaluate('BEAUTIFUL_CHINA_DATA.banks.contest25.filter(q=>q.scorable).length')
        total = min(20, count)
        self.assertEqual(self.page.locator('#sheet-grid .grid-cell').count(), total)
        for index in range(total):
            self.page.evaluate('(index) => AppBridge.jumpToQuestion(index)', index)
            self.assertNotIn('不计分', self.page.locator('.q-tags').inner_text())

    def test_random_session_does_not_reuse_old_answers(self):
        self.page.evaluate("""const data=CloudSync.getActiveChildData();
            BEAUTIFUL_CHINA_DATA.unified.forEach(q=>{if(q.answer)data.answers[q.uid]=q.answer});
            CloudSync.saveActiveChildData(data);CloudSync.emit('data-merged', {});
            AppBridge.switchMode('random')""")
        self.assertEqual(self.page.locator('.result-banner').count(), 0)
        self.assertEqual(self.page.locator('.option-item.disabled').count(), 0)

    def test_cloud_merge_preserves_exam_question_and_answer(self):
        self.page.evaluate("AppBridge.switchMode('exam'); AppBridge.selectOption('A')")
        title = self.page.locator('.q-title').inner_text()
        self.page.evaluate("CloudSync.smartMerge(CloudSync.collectPayload()); CloudSync.emit('data-merged', {})")
        self.assertEqual(self.page.locator('.q-title').inner_text(), title)
        self.assertEqual(self.page.locator('.option-item.selected').count(), 1)
        self.assertTrue(self.page.locator('#exam-timer-display').is_visible())

    def test_leaving_exam_cancels_submission(self):
        self.page.evaluate("AppBridge.switchMode('exam'); AppBridge.switchMode('sequence'); AppBridge.submitExam()")
        self.assertFalse(self.page.locator('#exam-timer-display').is_visible())
        self.assertFalse(self.page.locator('#exam-submit-btn').is_visible())
        self.assertEqual(self.child_data()['examHistory'], [])
        self.assertEqual(self.dialogs, [])

    def test_submit_once_then_review_the_actual_exam(self):
        self.page.evaluate("AppBridge.switchMode('exam'); AppBridge.selectOption('A')")
        self.page.locator('#exam-submit-btn').click()
        self.assertEqual(len(self.child_data()['examHistory']), 1)
        self.page.evaluate('AppBridge.submitExam()')
        self.assertEqual(len(self.child_data()['examHistory']), 1)
        self.page.get_by_role('button', name='查看全部答卷解析').click()
        self.assertTrue(self.page.locator('.result-banner').is_visible())
        self.page.evaluate('AppBridge.openQuestionSheet()')
        self.assertEqual(self.page.locator('#sheet-grid .grid-cell').count(), 50)

    def test_manual_sync_uploads_the_union(self):
        self.page.locator('.option-item').nth(2).click()
        self.cloud = self.page.evaluate('CloudSync.collectPayload()')
        self.cloud['childrenData']['child_default']['answers'] = {'Q_0002': 'B'}
        self.cloud['childrenData']['child_default']['answerUpdatedAt'] = {'Q_0002': 1}
        self.page.evaluate("CloudSync.setSyncCode('local-test-family'); AppBridge.syncNow()")
        self.assertTrue(any(method == 'POST' for method, _ in self.requests))
        uploaded = self.cloud['childrenData']['child_default']['answers']
        self.assertEqual(uploaded['Q_0001'], 'C')
        self.assertEqual(uploaded['Q_0002'], 'B')
        self.assertIn('双向合并', self.dialogs[-1])

    def test_repeating_the_same_answer_updates_its_timestamp(self):
        self.page.locator('.option-item').nth(2).click()
        first_time = self.child_data()['answerUpdatedAt']['Q_0001']
        self.page.get_by_role('button', name='🔁 再答一次').click()
        self.page.locator('.option-item').nth(2).click()
        self.assertGreater(self.child_data()['answerUpdatedAt']['Q_0001'], first_time)

    def test_multi_choice_and_switching_clear_partial_selection(self):
        self.page.evaluate("""AppBridge.jumpToQuestion(BEAUTIFUL_CHINA_DATA.unified.findIndex(
            q => q.answer && q.answer.length > 1))""")
        self.page.locator('.option-item').first.click()
        self.assertIn('已选 1 项', self.page.locator('.multi-submit-btn').inner_text())
        self.page.select_option('#bank-select', 'elem')
        self.page.evaluate("""AppBridge.jumpToQuestion(BEAUTIFUL_CHINA_DATA.banks.elem.findIndex(
            q => q.answer && q.answer.length > 1))""")
        self.assertIn('已选 0 项', self.page.locator('.multi-submit-btn').inner_text())
        self.page.locator('.option-item').first.click()
        self.page.locator('.multi-submit-btn').click()
        self.assertTrue(self.page.locator('.result-banner').is_visible())

    def test_retired_saved_favorites_and_mistakes_do_not_reappear(self):
        pending = json.loads((ROOT / 'pending_questions.json').read_text())
        self.page.evaluate("""uid => {
            const data=CloudSync.getActiveChildData();data.favorites[uid]=true;
            data.mistakes[uid]={mastered:false};CloudSync.saveActiveChildData(data);
            CloudSync.emit('data-merged',{});AppBridge.switchMode('favorites');
        }""", pending[0]['uid'])
        self.assertEqual(self.page.locator('#progress-text').inner_text(), '0 / 0')
        self.page.evaluate("AppBridge.switchMode('mistakes')")
        self.assertEqual(self.page.locator('#progress-text').inner_text(), '0 / 0')

    def test_corrected_source_bank_answer_and_repaired_options(self):
        self.page.select_option('#bank-select', 'middle')
        self.page.evaluate('AppBridge.jumpToQuestion(BEAUTIFUL_CHINA_DATA.banks.middle.findIndex(q=>q.num===117)); AppBridge.selectOption("C")')
        self.assertIn('回答正确', self.page.locator('.result-header').inner_text())
        self.page.evaluate('AppBridge.jumpToQuestion(BEAUTIFUL_CHINA_DATA.banks.middle.findIndex(q=>q.num===234))')
        self.assertEqual(self.page.locator('.option-item').count(), 4)
        self.page.evaluate('AppBridge.selectOption("B")')
        self.assertIn('回答正确', self.page.locator('.result-header').inner_text())

    def test_reordered_2025_answer_is_correct_in_main_program(self):
        self.page.select_option('#bank-select', 'contest25')
        self.page.evaluate('AppBridge.jumpToQuestion(BEAUTIFUL_CHINA_DATA.banks.contest25.findIndex(q=>q.num===326)); AppBridge.selectOption("B")')
        self.assertIn('回答正确', self.page.locator('.result-header').inner_text())
        self.assertTrue(self.page.locator('.result-explanation a').count() > 0)

    def test_old_sequence_progress_follows_the_original_question(self):
        expected = self.page.evaluate("""() => {
            const uid=BEAUTIFUL_CHINA_DATA.summary.legacy_uid_map.Q_0101;
            return BEAUTIFUL_CHINA_DATA.unified.findIndex(q=>q.uid===uid);
        }""")
        self.page.evaluate("""() => {
            const data=CloudSync.getActiveChildData();delete data.bankRevision;
            delete data.progressQuestions;
            data.progressIndex.unified=100;
            localStorage.setItem('bc_children_data',JSON.stringify({child_default:data}));
        }""")
        self.page.reload()
        total = self.page.evaluate('BEAUTIFUL_CHINA_DATA.unified.length')
        self.assertEqual(self.page.locator('#progress-text').inner_text(), f'{expected+1} / {total}')

    def test_final_five_option_correction_and_explanation(self):
        self.page.select_option('#bank-select', 'contest25')
        self.page.evaluate('AppBridge.jumpToQuestion(BEAUTIFUL_CHINA_DATA.banks.contest25.findIndex(q=>q.num===11))')
        self.assertEqual(self.page.locator('.option-item').count(), 5)
        for letter in 'ABCDE':
            self.page.evaluate('(letter)=>AppBridge.selectOption(letter)', letter)
        self.page.locator('.multi-submit-btn').click()
        self.assertIn('回答正确', self.page.locator('.result-header').inner_text())
        self.assertIn('漏选E', self.page.locator('.answer-note').inner_text())

    def test_six_option_question_accepts_the_f_keyboard_choice(self):
        self.page.select_option('#bank-select', 'contest25')
        self.page.evaluate('AppBridge.jumpToQuestion(BEAUTIFUL_CHINA_DATA.banks.contest25.findIndex(q=>q.num===403))')
        self.assertEqual(self.page.locator('.option-item').count(), 6)
        self.page.locator('.q-title').click()
        self.page.keyboard.press('6')
        self.assertIn('F', self.page.locator('.option-item.selected .opt-letter').inner_text())
        for letter in 'ABCDE':
            self.page.evaluate('(letter)=>AppBridge.selectOption(letter)', letter)
        self.page.locator('.multi-submit-btn').click()
        self.assertIn('回答正确', self.page.locator('.result-header').inner_text())

    def test_ordered_blanks_preserve_order_in_practice_and_exam(self):
        self.page.select_option('#bank-select', 'contest25')
        self.page.evaluate('AppBridge.jumpToQuestion(BEAUTIFUL_CHINA_DATA.banks.contest25.findIndex(q=>q.num===17))')
        self.page.evaluate('AppBridge.selectOption("B"); AppBridge.selectOption("C")')
        self.page.locator('.multi-submit-btn').click()
        self.assertIn('回答错误', self.page.locator('.result-header').inner_text())
        self.page.get_by_role('button', name='🔁 再答一次').click()
        self.page.evaluate('AppBridge.selectOption("C"); AppBridge.selectOption("B")')
        self.page.locator('.multi-submit-btn').click()
        self.assertIn('回答正确', self.page.locator('.result-header').inner_text())
        self.page.evaluate("""const q=BEAUTIFUL_CHINA_DATA.banks.contest25.find(q=>q.num===17);
            BEAUTIFUL_CHINA_DATA.banks.contest25=[q];AppBridge.switchMode('exam');
            AppBridge.selectOption('C');AppBridge.selectOption('B');AppBridge.submitExam();""")
        self.assertEqual(self.child_data()['examHistory'][-1]['score'], 100)

    def test_previous_bank_revision_resumes_by_question_id(self):
        self.page.evaluate("""() => {
            const data=CloudSync.getActiveChildData();delete data.progressQuestions;
            data.bankRevision=Object.keys(BEAUTIFUL_CHINA_DATA.progress_migrations).find(
                revision=>BEAUTIFUL_CHINA_DATA.progress_migrations[revision].contest25.length===1143);
            data.progressIndex.contest25=325;
            localStorage.setItem('bc_children_data',JSON.stringify({child_default:data}));
        }""")
        self.page.reload()
        self.page.select_option('#bank-select', 'contest25')
        self.assertIn('原文件第 326 题', self.page.locator('.q-tags').inner_text())


if __name__ == '__main__':
    unittest.main(verbosity=2)
