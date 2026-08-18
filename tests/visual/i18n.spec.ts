import { test, expect, injectNoteMock } from "./fixtures";

// 設定の language（"auto" | "ja" | "en"）による表示切り替えを検証する。
// 文言そのものが主題なので、スクリーンショットではなくテキストで見る。

test.describe("設定画面の英語化", () => {
  test("language: en で開くと、タブ・セクション見出し・保存ボタンが英語表記になる", async ({ openSettings }) => {
    const page = await openSettings({ language: "en" });

    await expect(page.locator("#tab-settings")).toHaveText("Settings");
    await expect(page.locator("#tab-help")).toHaveText("Help");
    await expect(page.locator(".section-title").first()).toHaveText("Default Color for New Notes");
    await expect(page.locator("#save-btn")).toHaveText("Save");

    await page.click('[data-tab="help"]');
    await expect(page.locator("#panel-help .section-title").first()).toHaveText("Basic Usage");
  });

  test("language: ja を明示すると、ブラウザロケール(en-US)に関わらず日本語のまま", async ({ openSettings }) => {
    const page = await openSettings({ language: "ja" });
    await expect(page.locator("#tab-settings")).toHaveText("設定");
    await expect(page.locator("#tab-help")).toHaveText("ヘルプ");

    await page.click('[data-tab="help"]');
    await expect(page.locator("#panel-help .section-title").first()).toHaveText("基本操作");
  });

  test("言語セレクタを英語に変更すると、保存を待たず即座に表示が切り替わる", async ({ settingsPage }) => {
    await expect(settingsPage.locator("#tab-settings")).toHaveText("設定");
    await settingsPage.selectOption("#language-select", "en");
    await expect(settingsPage.locator("#tab-settings")).toHaveText("Settings");
  });
});

test.describe("付箋の英語化", () => {
  test("language: en で開くと、ボタンの title / aria-label と空付箋のプレースホルダーが英語になる", async ({ openNote }) => {
    const page = await openNote({}, { language: "en" });

    await expect(page.locator("#btn-delete")).toHaveAttribute("title", "Delete");
    await expect(page.locator("#btn-new")).toHaveAttribute("title", "New note");
    await expect(page.locator("#btn-color")).toHaveAttribute("title", "Color");
    await expect(page.locator("#btn-pin")).toHaveAttribute("aria-label", "Pin");
    await expect(page.locator("#markdown-view")).toHaveAttribute("aria-label", "Note content");
    await expect(page.locator(".md-placeholder")).toHaveText("Type a note…");
  });

  test("ピン留め中に settings-changed で言語を en に切り替えると、ピンボタンの aria-label が Unpin になる", async ({ openNote }) => {
    const page = await openNote({ pinned: true }, { language: "ja" });
    await expect(page.locator("#btn-pin")).toHaveAttribute("aria-label", "ピン留め解除");

    await page.evaluate(() => {
      const listeners = (window as any).__globalListeners["settings-changed"];
      listeners?.forEach((fn: any) => fn({
        payload: {
          default_color: "yellow", opacity: 100, bring_all_to_front: true,
          show_pin_button: true, show_new_button: true, show_color_button: true,
          confirm_before_delete: true, language: "en",
        },
      }));
    });

    await expect(page.locator("#btn-pin")).toHaveAttribute("aria-label", "Unpin");
  });
});

test.describe("ゴミ箱の英語化", () => {
  test("language: en で開くと、見出し・「すべて削除」ボタン・空メッセージが英語になる", async ({ openTrash }) => {
    const page = await openTrash([], { language: "en" });

    await expect(page.locator(".header h1")).toContainText("Trash");
    await expect(page.locator("#btn-empty")).toHaveText("Empty Trash");
    await expect(page.locator(".empty-msg")).toHaveText("Trash is empty");
  });

  test("開いたまま settings-changed で言語を en に切り替えると、見出し・ボタン・空メッセージが英語になる", async ({ openTrash }) => {
    const page = await openTrash([], { language: "ja" });
    await expect(page.locator(".header h1")).toContainText("ゴミ箱");
    await expect(page.locator("#btn-empty")).toHaveText("すべて削除");
    await expect(page.locator(".empty-msg")).toHaveText("ゴミ箱は空です");

    await page.evaluate(() => {
      const listeners = (window as any).__globalListeners["settings-changed"];
      listeners?.forEach((fn: any) => fn({ payload: { language: "en" } }));
    });

    await expect(page.locator(".header h1")).toContainText("Trash");
    await expect(page.locator("#btn-empty")).toHaveText("Empty Trash");
    await expect(page.locator(".empty-msg")).toHaveText("Trash is empty");
  });
});

test.describe("window.I18N.resolve()", () => {
  test("'ja' / 'en' はそのまま解決される", async ({ notePage }) => {
    expect(await notePage.evaluate(() => (window as any).I18N.resolve("ja"))).toBe("ja");
    expect(await notePage.evaluate(() => (window as any).I18N.resolve("en"))).toBe("en");
  });

  test("'auto' と undefined は navigator.language の primary subtag で決まる", async ({ browser }) => {
    const jaCtx = await browser.newContext({ locale: "ja-JP" });
    const jaPage = await jaCtx.newPage();
    await injectNoteMock(jaPage);
    await jaPage.goto("/note.html?id=test-note-id");
    await jaPage.waitForLoadState("networkidle");
    expect(await jaPage.evaluate(() => (window as any).I18N.resolve("auto"))).toBe("ja");
    expect(await jaPage.evaluate(() => (window as any).I18N.resolve(undefined))).toBe("ja");
    await jaCtx.close();

    const frCtx = await browser.newContext({ locale: "fr-FR" });
    const frPage = await frCtx.newPage();
    await injectNoteMock(frPage);
    await frPage.goto("/note.html?id=test-note-id");
    await frPage.waitForLoadState("networkidle");
    expect(await frPage.evaluate(() => (window as any).I18N.resolve("auto"))).toBe("en");
    expect(await frPage.evaluate(() => (window as any).I18N.resolve(undefined))).toBe("en");
    await frCtx.close();
  });
});

test.describe("i18n テーブルの整合性", () => {
  test("ja / en の訳がすべてのキーで揃っている（訳抜け検知）", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const missingTranslations: string[] = [];
    page.on("console", (msg) => {
      if (msg.text().includes("は ja/en の訳が揃っていません")) {
        missingTranslations.push(msg.text());
      }
    });

    await injectNoteMock(page);
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    expect(missingTranslations).toEqual([]);
    await context.close();
  });
});
