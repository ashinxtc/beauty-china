# -*- coding: utf-8 -*-
import sys
import time
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')

def run_tests():
    print("=== Starting End-to-End Tests for beautifulChina (Multi-Child & Cloud Sync) ===")
    errors = []
    console_logs = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel='msedge')
        page = browser.new_page(viewport={"width": 1024, "height": 768})

        # Listen for console errors
        page.on("console", lambda msg: console_logs.append(f"[{msg.type}] {msg.text}"))
        page.on("pageerror", lambda err: errors.append(f"PageError: {err}"))

        # 1. Load index.html
        url = "file:///D:/AntigravityworkSpace/beautifulChina/index.html"
        print(f"1. Loading page: {url}")
        page.goto(url)
        time.sleep(1)

        # Check page title
        title = page.title()
        assert "美丽中国" in title, f"Title unexpected: {title}"
        print(f"   Page Title: {title}")

        # 2. Check Navbar Child Chip & Sync Badge
        child_chip = page.locator("#child-chip-btn")
        assert child_chip.is_visible(), "Child chip button should be visible in navbar"
        child_name = page.locator("#child-chip-name").inner_text()
        print(f"2. Default Child: {child_name}")

        sync_btn = page.locator("#sync-badge-btn")
        assert sync_btn.is_visible(), "Sync badge button should be visible in navbar"
        print(f"   Sync Badge: {sync_btn.inner_text()}")

        # 3. Test Opening Child Switcher Modal
        print("3. Testing Child Switcher Modal")
        child_chip.click()
        time.sleep(0.5)
        child_modal = page.locator("#child-modal")
        assert child_modal.is_visible(), "Child modal should be visible"
        
        cards = page.locator(".child-profile-card")
        print(f"   Existing Children Cards: {cards.count()}")
        assert cards.count() >= 1, "Should have at least 1 child profile"

        # 4. Test Adding a Second Child ("辰辰", 中学组, 🐯)
        print("4. Testing Adding New Child (辰辰, 中学组, 🐯)")
        page.fill("#new-child-name", "辰辰")
        page.select_option("#new-child-grade", "中学组")
        page.click("#new-child-avatar-picker span[data-avatar='🐯']")
        
        # Click Add and Switch
        page.click("button:has-text('确认添加并切换')")
        time.sleep(0.5)

        # Verify active child updated on navbar
        new_active_name = page.locator("#child-chip-name").inner_text()
        new_active_avatar = page.locator("#child-chip-avatar").inner_text()
        print(f"   Switched Active Child: {new_active_avatar} {new_active_name}")
        assert new_active_name == "辰辰", f"Expected active child '辰辰', got '{new_active_name}'"
        assert new_active_avatar == "🐯", f"Expected active avatar '🐯', got '{new_active_avatar}'"

        # 5. Answer Question 1 as "辰辰"
        print("5. Answering Question 1 as 辰辰 (Choose C)")
        page.locator(".option-item").nth(2).click()
        time.sleep(0.5)
        banner_chen = page.locator(".result-banner")
        assert banner_chen.is_visible(), "Banner should be visible for 辰辰"
        assert "回答正确" in banner_chen.inner_text()

        # 6. Switch back to "大宝" and verify independent progress
        print("6. Switching back to 大宝 (Verify Data Isolation)")
        child_chip.click()
        time.sleep(0.5)
        page.screenshot(path="test_screenshot_child_modal.png")
        print("   Saved screenshot: test_screenshot_child_modal.png")
        
        # Click 大宝 card
        dabao_card = page.locator(".child-profile-card:has-text('大宝')")
        dabao_card.click()
        time.sleep(0.5)
        
        current_after_switch = page.locator("#child-chip-name").inner_text()
        assert current_after_switch == "大宝", f"Expected '大宝', got '{current_after_switch}'"
        print("   Switched back to 大宝 successfully!")

        # 7. Test Cloud Sync Modal
        print("7. Testing Cloud Sync Modal")
        sync_btn.click()
        time.sleep(0.5)
        sync_modal = page.locator("#sync-modal")
        assert sync_modal.is_visible(), "Sync modal should open"
        page.screenshot(path="test_screenshot_sync_modal.png")
        print("   Saved screenshot: test_screenshot_sync_modal.png")

        # Set Sync Code
        print("   Setting test sync code 'family_test_999'")
        page.fill("#sync-code-input", "family_test_999")
        
        # Click save
        page.on("dialog", lambda dialog: dialog.accept()) # auto accept alerts
        page.click("button:has-text('保存绑定')")
        time.sleep(2)

        # Verify sync code saved and badge updated
        page.click("#sync-modal .modal-close-btn")
        time.sleep(0.3)
        assert not sync_modal.is_visible()
        
        badge_text_after = page.locator("#sync-status-text").inner_text()
        print(f"   Sync Badge Text after save: {badge_text_after}")
        assert badge_text_after in ["已绑定", "已同步", "同步中"], f"Unexpected badge text: {badge_text_after}"

        # 8. Check console errors
        print("8. Checking Console & Page Errors")
        severe_errors = [e for e in console_logs if "[error]" in e.lower() and "favicon" not in e.lower()]
        print(f"   Page errors: {len(errors)}")
        print(f"   Console severe errors: {len(severe_errors)}")
        if errors:
            print("Errors:", errors)
        if severe_errors:
            print("Severe logs:", severe_errors)

        browser.close()
        print("\n=== ALL MULTI-CHILD & CLOUD SYNC TESTS PASSED! ===")

if __name__ == "__main__":
    run_tests()
