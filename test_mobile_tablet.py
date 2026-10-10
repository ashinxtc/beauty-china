# -*- coding: utf-8 -*-
import asyncio
from playwright.async_api import async_playwright

async def full_mobile_test():
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel='msedge')
        
        # Test on iPhone 14/15 viewport (390 x 844)
        page = await browser.new_page(viewport={'width': 390, 'height': 844})
        
        errors = []
        page.on('pageerror', lambda err: errors.append(str(err)))
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
        
        await page.goto('file:///D:/AntigravityworkSpace/beautifulChina/index.html')
        await page.wait_for_timeout(500)
        
        # 1. Test answering question Q1
        print('1. Testing Q1 option click...')
        options = page.locator('.option-item')
        count = await options.count()
        assert count == 3, f'Expected 3 options, got {count}'
        await options.nth(2).click() # Click option C (correct for Q1)
        await page.wait_for_timeout(500)
        
        banner = page.locator('.result-banner')
        assert await banner.is_visible(), 'Result banner not visible after answering'
        print('   Q1 answered correctly, result banner visible.')
        
        # 2. Test next question
        print('2. Testing Next Question button...')
        await page.locator('#next-btn').click()
        await page.wait_for_timeout(300)
        q_text = await page.locator('.q-title').inner_text()
        print(f'   Switched to Q2: {q_text[:30]}...')
        
        # 3. Test changing bank on mobile
        print('3. Testing bank select on mobile...')
        await page.select_option('#bank-select', 'elem')
        await page.wait_for_timeout(500)
        elem_count = await page.locator('#progress-text').inner_text()
        assert '267' in elem_count, f'Expected 267 questions for elem bank, got {elem_count}'
        print(f'   Bank switched to elementary: {elem_count}')
        
        # 4. Test switching mode pills (horizontal swipe/click)
        print('4. Testing mode switch to 20-speed mode...')
        pill_20 = page.locator('.pill-btn[data-mode="random"]')
        await pill_20.click()
        await page.wait_for_timeout(500)
        random_count = await page.locator('#progress-text').inner_text()
        assert '20' in random_count, f'Expected 20 questions in random mode, got {random_count}'
        print(f'   Mode switched to 20 speed: {random_count}')
        
        # 5. Test opening child modal on mobile
        print('5. Testing child modal on mobile...')
        await page.locator('#child-chip-btn').click()
        await page.wait_for_timeout(500)
        assert await page.locator('#child-modal').is_visible(), 'Child modal not visible'
        await page.screenshot(path='test_mobile_child_modal.png')
        await page.locator('#child-modal .modal-close-btn').click()
        await page.wait_for_timeout(300)
        print('   Child modal verified.')
        
        # 6. Test opening sync modal on mobile
        print('6. Testing sync modal on mobile...')
        await page.locator('#sync-badge-btn').click()
        await page.wait_for_timeout(500)
        assert await page.locator('#sync-modal').is_visible(), 'Sync modal not visible'
        await page.screenshot(path='test_mobile_sync_modal.png')
        await page.locator('#sync-modal .modal-close-btn').click()
        await page.wait_for_timeout(300)
        print('   Sync modal verified.')
        
        # 7. Test opening handbook on mobile
        print('7. Testing handbook modal on mobile...')
        await page.locator('.nav-quick-actions button:has-text("📖")').click()
        await page.wait_for_timeout(500)
        assert await page.locator('#handbook-modal').is_visible(), 'Handbook modal not visible'
        await page.screenshot(path='test_mobile_handbook_modal.png')
        await page.locator('#handbook-modal .modal-close-btn').click()
        await page.wait_for_timeout(300)
        print('   Handbook modal verified.')
        
        # 8. Test question sheet on mobile
        print('8. Testing question sheet on mobile...')
        await page.locator('#sheet-btn').click()
        await page.wait_for_timeout(500)
        assert await page.locator('#sheet-modal').is_visible(), 'Sheet modal not visible'
        await page.screenshot(path='test_mobile_sheet_modal.png')
        await page.locator('#sheet-modal .modal-close-btn').click()
        await page.wait_for_timeout(300)
        print('   Question sheet modal verified.')
        
        # 9. Test toggle study mode
        print('9. Testing study mode toggle...')
        study_btn = page.locator('#study-mode-toggle-btn')
        await study_btn.click()
        await page.wait_for_timeout(300)
        btn_text = await study_btn.inner_text()
        assert '背题' in btn_text, f'Expected 背题模式, got {btn_text}'
        print('   Study mode toggled to recite mode.')
        
        # Check error logs
        print(f'Total page errors: {len(errors)}')
        if errors:
            print('Errors found:', errors)
            
        await browser.close()
        assert len(errors) == 0, 'Page had errors!'
        print('\n=== ALL MOBILE E2E TESTS PASSED WITH 0 ERRORS! ===')

if __name__ == '__main__':
    asyncio.run(full_mobile_test())
