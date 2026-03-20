import { test, expect } from "./fixtures";

// ── note.html accessibility ──────────────────────────────

test.describe("note.html accessibility", () => {
  test("color picker has role=radiogroup", async ({ notePage }) => {
    const picker = notePage.locator(".color-picker");
    await expect(picker).toHaveAttribute("role", "radiogroup");
  });

  test("each color-dot has role=radio and aria-label", async ({ notePage }) => {
    const dots = notePage.locator(".color-picker .color-dot");
    const count = await dots.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(dots.nth(i)).toHaveAttribute("role", "radio");
      const label = await dots.nth(i).getAttribute("aria-label");
      expect(label).toBeTruthy();
    }
  });

  test("editor has aria-label", async ({ notePage }) => {
    const editor = notePage.locator("#editor");
    await expect(editor).toHaveAttribute("aria-label", "付箋の内容");
  });

  test("markdown view has role=document", async ({ notePage }) => {
    const mdView = notePage.locator("#markdown-view");
    await expect(mdView).toHaveAttribute("role", "document");
  });

  test("pin button has aria-pressed", async ({ notePage }) => {
    const btn = notePage.locator("#btn-pin");
    const pressed = await btn.getAttribute("aria-pressed");
    expect(pressed).toMatch(/^(true|false)$/);
  });

  test("context menu has role=menu", async ({ notePage }) => {
    const menu = notePage.locator(".context-menu");
    await expect(menu).toHaveAttribute("role", "menu");
  });
});

// ── settings.html accessibility ──────────────────────────

test.describe("settings.html accessibility", () => {
  test("tabs have role=tab and aria-selected", async ({ settingsPage }) => {
    const tabs = settingsPage.locator("[role=tab]");
    const count = await tabs.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const selected = await tabs.nth(i).getAttribute("aria-selected");
      expect(selected).toMatch(/^(true|false)$/);
    }
  });

  test("panels have role=tabpanel", async ({ settingsPage }) => {
    const panels = settingsPage.locator("[role=tabpanel]");
    const count = await panels.count();
    expect(count).toBeGreaterThan(0);
  });

  test("color picker dots have role=radio", async ({ settingsPage }) => {
    const dots = settingsPage.locator("#color-picker .color-dot");
    const count = await dots.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(dots.nth(i)).toHaveAttribute("role", "radio");
      const label = await dots.nth(i).getAttribute("aria-label");
      expect(label).toBeTruthy();
    }
  });
});

// ── trash.html accessibility ─────────────────────────────

test.describe("trash.html accessibility", () => {
  test("list has role=list", async ({ trashPage }) => {
    const list = trashPage.locator("#list");
    await expect(list).toHaveAttribute("role", "list");
  });

  test("restore buttons have aria-label", async ({ openTrash }) => {
    const page = await openTrash([
      { id: "t1", content: "deleted note", color: "yellow", x: 0, y: 0, width: 280, height: 320, zoom: 100, pinned: false },
    ]);
    const btn = page.locator(".btn-restore");
    const count = await btn.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(btn.nth(i)).toHaveAttribute("aria-label", "復元");
    }
  });
});
