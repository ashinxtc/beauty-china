"""Run the core touch workflows at phone and tablet widths."""
import unittest
from playwright.sync_api import expect
from test_app import AppBrowserCase


class MobileTabletTests(AppBrowserCase):
    def open_touch_phone(self, width=390, height=844):
        """Use browser-generated touch input, including normal touch scrolling."""
        self.context.close()
        self.context = self.browser.new_context(
            viewport={'width': width, 'height': height}, has_touch=True, is_mobile=True)
        self.context.add_init_script("localStorage.setItem('bc_auto_sync_enabled', 'false')")
        self.context.route('https://sync.daka-tool.top/**', self.sync_service)
        self.page = self.context.new_page()
        self.page.set_default_timeout(5000)
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.on('dialog', self.accept_dialog)
        self.page.goto(self.url)
        self.page.locator('.option-item').first.wait_for()
        self.touch_session = self.context.new_cdp_session(self.page)

    def touch_gesture(self, selector='.q-title', dx=-150, dy=0,
                      multiple=False, add_finger=False, cancel=False):
        target = self.page.locator(selector).first
        target.scroll_into_view_if_needed()
        self.wait_for_layout(selector)
        box = target.bounding_box()
        size = self.page.viewport_size
        start_x = max(30, min(size['width'] - 30, box['x'] + box['width'] / 2))
        header_bottom = self.page.locator('.navbar').bounding_box()['height']
        nav_top = self.page.locator('.bottom-nav').bounding_box()['y']
        start_y = max(header_bottom + 12,
                      min(nav_top - 20, box['y'] + box['height'] / 2))
        point = {'x': start_x, 'y': start_y, 'id': 1}
        points = [point]
        if multiple:
            points.append({'x': start_x + 8, 'y': start_y + 8, 'id': 2})
        self.page.evaluate("""() => {
            window.__mobileTouchOrigin = null;
            document.addEventListener('touchstart', event => {
                window.__mobileTouchOrigin = {
                    classes: [...event.target.classList], trusted: event.isTrusted,
                };
            }, {once: true, capture: true});
        }""")
        self.touch_session.send('Input.dispatchTouchEvent', {
            'type': 'touchStart', 'touchPoints': points})
        if add_finger:
            points.append({'x': start_x + 8, 'y': start_y + 8, 'id': 2})
            self.touch_session.send('Input.dispatchTouchEvent', {
                'type': 'touchStart', 'touchPoints': points})
        moved = [dict(p, x=p['x'] + dx, y=p['y'] + dy) for p in points]
        self.touch_session.send('Input.dispatchTouchEvent', {
            'type': 'touchMove', 'touchPoints': moved})
        self.touch_session.send('Input.dispatchTouchEvent', {
            'type': 'touchCancel' if cancel else 'touchEnd', 'touchPoints': []})
        self.last_touch_origin = self.page.evaluate('window.__mobileTouchOrigin')
        self.assertTrue(self.last_touch_origin['trusted'])

    def wait_for_layout(self, selector):
        """Wait for changing question/card animations instead of a fixed sleep."""
        self.page.evaluate('delete window.__mobileTestLayout')
        self.page.wait_for_function("""selector => {
            const node = document.querySelector(selector);
            if (!node) return false;
            const box = node.getBoundingClientRect();
            const value = [box.x, box.y, box.width, box.height].map(x => x.toFixed(2)).join(',');
            const prior = window.__mobileTestLayout;
            const stable = prior && prior.selector === selector && prior.value === value
                ? prior.stable + 1 : 0;
            window.__mobileTestLayout = {selector, value, stable};
            return stable >= 3;
        }""", arg=selector)

    def current_number(self):
        return int(self.page.locator('#progress-text').inner_text().split('/')[0])

    def assert_question_start_visible(self):
        self.page.wait_for_function("""() => {
            const card = document.getElementById('question-card-container');
            const top = card.getBoundingClientRect().top;
            const headerBottom = document.querySelector('.navbar').getBoundingClientRect().bottom;
            const margin = parseFloat(getComputedStyle(card).scrollMarginTop) || 0;
            const documentTop = top + window.scrollY;
            const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
            const targetScroll = Math.min(maxScroll, Math.max(0, documentTop - margin));
            const expectedTop = documentTop - targetScroll;
            // Short questions may fit the viewport and have no room to scroll.
            return top >= headerBottom - 1 && Math.abs(top - expectedTop) <= 2;
        }""")

    def assert_bottom_controls_visible(self):
        self.wait_for_layout('.bottom-nav')
        size = self.page.viewport_size
        for selector in ['#prev-btn', '#next-btn', '.bottom-tools .nav-btn']:
            for button in self.page.locator(selector).all():
                box = button.bounding_box()
                self.assertGreaterEqual(box['x'], 0)
                self.assertGreaterEqual(box['y'], 0)
                self.assertLessEqual(box['x'] + box['width'], size['width'] + 1)
                self.assertLessEqual(box['y'] + box['height'], size['height'] + 1)

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
        self.wait_for_layout('.nav-status-bar')
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
        self.wait_for_layout('.nav-status-bar')
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

    def test_phone_navigation_stays_visible_and_long_explanation_is_uncovered(self):
        self.open_touch_phone(width=320, height=700)
        self.page.evaluate("""() => {
            const question = BEAUTIFUL_CHINA_DATA.unified[0];
            question.question = '这是一道用于检验手机长题滚动的题目。'.repeat(45);
            question.answer_explanation = '阅读解析时应能看清最后一行，底部按钮不能遮住答案依据。'.repeat(60);
            AppBridge.jumpToQuestion(0);
        }""")
        self.page.evaluate('window.scrollTo(0, 0)')
        self.assert_bottom_controls_visible()
        self.assertEqual(self.page.locator('.bottom-nav').evaluate(
            '(node) => getComputedStyle(node).position'), 'fixed')
        expect(self.page.locator('#prev-btn')).to_be_disabled()
        self.page.locator('.option-item').nth(2).click()
        expect(self.page.locator('.result-header')).to_contain_text('回答正确')
        self.page.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)')
        self.assert_bottom_controls_visible()
        self.wait_for_layout('#question-card-container')
        card = self.page.locator('#question-card-container').bounding_box()
        bar = self.page.locator('.bottom-nav').bounding_box()
        self.assertLessEqual(card['y'] + card['height'], bar['y'] + 1)
        self.assertGreater(self.page.evaluate('window.scrollY'), 300)
        self.page.locator('#next-btn').click()
        self.assertEqual(self.current_number(), 2)
        self.assert_question_start_visible()
        self.assertEqual(self.child_data()['answers']['Q_0001'], 'C')
        self.assertEqual(self.child_data()['progressIndex']['unified'], 1)
        self.page.locator('#prev-btn').click()
        self.assertEqual(self.current_number(), 1)
        self.assert_question_start_visible()
        expect(self.page.locator('.result-header')).to_contain_text('回答正确')

    def test_compact_phone_bank_selector_remains_accessible(self):
        self.open_touch_phone(width=320, height=700)
        self.page.evaluate('window.scrollTo(0, 0)')
        select = self.page.locator('#bank-select')
        self.wait_for_layout('#bank-select')
        box = select.bounding_box()
        self.assertGreaterEqual(box['x'], 0)
        self.assertLessEqual(box['x'] + box['width'], 320)
        self.assertGreaterEqual(box['height'], 40)
        self.assertEqual(select.evaluate('(node) => node.labels.length'), 1)
        select.select_option('elem')
        count = self.page.evaluate('BEAUTIFUL_CHINA_DATA.banks.elem.length')
        expect(self.page.locator('#progress-text')).to_have_text(f'1 / {count}')
        self.assert_bottom_controls_visible()
        self.assertEqual(self.page.evaluate('document.documentElement.scrollWidth'), 320)

    def test_touch_swipes_navigate_in_both_directions_and_stop_at_boundaries(self):
        self.open_touch_phone()
        self.touch_gesture(dx=150)
        self.assertEqual(self.current_number(), 1)
        self.touch_gesture()
        self.assertEqual(self.current_number(), 2)
        self.assert_question_start_visible()
        self.assertEqual(self.child_data()['progressIndex']['unified'], 1)
        self.touch_gesture(dx=150)
        self.assertEqual(self.current_number(), 1)
        total = self.page.evaluate('BEAUTIFUL_CHINA_DATA.unified.length')
        self.page.evaluate('(index) => AppBridge.jumpToQuestion(index)', total - 1)
        expect(self.page.locator('#next-btn')).to_be_disabled()
        self.touch_gesture()
        self.assertEqual(self.current_number(), total)
        self.touch_gesture(dx=150)
        self.assertEqual(self.current_number(), total - 1)

    def test_touch_scrolling_short_motion_multitouch_and_cancel_do_not_navigate(self):
        self.open_touch_phone()
        self.page.evaluate('AppBridge.jumpToQuestion(1)')
        for gesture in [
            {'dx': 0, 'dy': -90},
            {'dx': -20, 'dy': 0},
            {'dx': -50, 'dy': -110},
            {'dx': -150, 'multiple': True},
            {'dx': -150, 'add_finger': True},
            {'dx': -150, 'cancel': True},
        ]:
            with self.subTest(gesture=gesture):
                self.touch_gesture(**gesture)
                self.assertEqual(self.current_number(), 2)

    def test_touch_starting_on_interactive_content_or_modal_does_not_navigate(self):
        self.open_touch_phone()
        self.page.evaluate('AppBridge.jumpToQuestion(1)')
        for tag in ['button', 'a', 'input', 'select', 'img']:
            with self.subTest(tag=tag):
                self.page.evaluate("""tag => {
                    document.getElementById('touch-test-target')?.remove();
                    const target = document.createElement(tag);
                    target.id = 'touch-test-target';
                    target.style.cssText = 'display:block;width:220px;height:48px;margin:16px 0';
                    if (tag === 'a') { target.href = '#'; target.textContent = '阅读链接'; }
                    if (tag === 'button') target.textContent = '操作按钮';
                    if (tag === 'input') target.type = 'text';
                    if (tag === 'select') target.innerHTML = '<option>选择内容</option>';
                    if (tag === 'img') target.alt = '示意图片';
                    document.querySelector('.q-title').after(target);
                }""", tag)
                self.touch_gesture('#touch-test-target')
                self.assertEqual(self.current_number(), 2)
        self.page.locator('#touch-test-target').evaluate('(node) => node.remove()')
        self.touch_gesture('.option-item')
        self.assertEqual(self.current_number(), 2)
        self.page.locator('.option-item').first.click()
        expect(self.page.locator('.option-item.disabled')).not_to_have_count(0)
        # Answered choices use pointer-events:none: the browser hits the list.
        self.touch_gesture('.option-item.disabled')
        self.assertIn('options-list', self.last_touch_origin['classes'])
        self.assertEqual(self.current_number(), 2)
        self.page.evaluate("""() => {
            const imageQuestion = BEAUTIFUL_CHINA_DATA.unified.find(q => q.images?.length);
            BEAUTIFUL_CHINA_DATA.unified[1].images = [imageQuestion.images[0]];
            AppBridge.jumpToQuestion(1);
            // Make the clickable wrapper padding a clear, separate touch target.
            document.querySelector('.q-img-wrap').style.padding = '24px';
        }""")
        self.page.wait_for_function('document.querySelector(".q-img").naturalWidth > 0')
        self.touch_gesture('.q-img-zoom-tip')
        self.assertIn('q-img-wrap', self.last_touch_origin['classes'])
        self.assertEqual(self.current_number(), 2)
        expect(self.page.locator('#image-zoom-modal')).to_be_hidden()
        self.page.locator('#sheet-btn').click()
        expect(self.page.locator('#sheet-modal')).to_be_visible()
        self.touch_gesture('#sheet-modal .modal-title')
        self.assertEqual(self.current_number(), 2)
        self.page.locator('#sheet-modal .modal-close-btn').click()
        self.touch_gesture()
        self.assertEqual(self.current_number(), 3)

    def test_swiping_clears_unsubmitted_practice_choices_and_preserves_exam_choices(self):
        self.open_touch_phone()
        index = self.page.evaluate("""BEAUTIFUL_CHINA_DATA.unified.findIndex(
            q => q.answer && q.answer.length > 1)""")
        self.page.evaluate('(index) => AppBridge.jumpToQuestion(index)', index)
        self.page.locator('.option-item').first.click()
        expect(self.page.locator('.multi-submit-btn')).to_contain_text('已选 1 项')
        self.touch_gesture()
        self.touch_gesture(dx=150)
        expect(self.page.locator('.multi-submit-btn')).to_contain_text('已选 0 项')
        self.page.evaluate("AppBridge.switchMode('exam')")
        self.page.locator('.option-item').first.click()
        title = self.page.locator('.q-title').inner_text()
        self.touch_gesture()
        self.assertEqual(self.current_number(), 2)
        self.touch_gesture(dx=150)
        self.assertEqual(self.page.locator('.q-title').inner_text(), title)
        expect(self.page.locator('.option-item.selected')).to_have_count(1)
        expect(self.page.locator('#exam-timer-display')).to_be_visible()
        self.assertEqual(self.child_data()['examHistory'], [])

    def test_mouse_drag_does_not_change_questions_on_phone_or_desktop(self):
        for width in [390, 1024]:
            with self.subTest(width=width):
                self.page.set_viewport_size({'width': width, 'height': 844})
                self.page.locator('.q-title').scroll_into_view_if_needed()
                self.wait_for_layout('.q-title')
                box = self.page.locator('.q-title').bounding_box()
                x = box['x'] + box['width'] / 2
                y = box['y'] + box['height'] / 2
                self.page.mouse.move(x, y)
                self.page.mouse.down()
                self.page.mouse.move(x - 150, y, steps=6)
                self.page.mouse.up()
                self.assertEqual(self.current_number(), 1)

    def test_tablet_and_landscape_phone_bottom_navigation_is_fixed(self):
        for viewport in [{'width': 768, 'height': 1024}, {'width': 844, 'height': 390}]:
            with self.subTest(viewport=viewport):
                self.page.set_viewport_size(viewport)
                self.assert_bottom_controls_visible()
                self.assertEqual(self.page.locator('.bottom-nav').evaluate(
                    '(node) => getComputedStyle(node).position'), 'fixed')
                box = self.page.locator('.bottom-nav').bounding_box()
                self.assertGreaterEqual(box['x'], 0)
                self.assertLessEqual(box['x'] + box['width'], viewport['width'] + 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
