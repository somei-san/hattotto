import { test, expect } from "./fixtures";

/** Click the preview overlay to enter edit mode, then wait for the editor to appear */
async function enterEditMode(page: import("@playwright/test").Page) {
  await page.click("#markdown-view");
  await page.waitForSelector(".editor", { state: "visible" });
}

test.describe("Markdown autocontinue E2E", () => {
  // ── Bullet list auto-continue ───────────────────────────
  test("- item → Enter inserts '- ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("- item1");
    await page.keyboard.press("Enter");
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    expect(text).toContain("- item1\n- ");
  });

  test("* item → Enter inserts '* ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("* item1");
    await page.keyboard.press("Enter");
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    expect(text).toContain("* item1\n* ");
  });

  test("1. item → Enter inserts '2. ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("1. item1");
    await page.keyboard.press("Enter");
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    expect(text).toContain("1. item1\n2. ");
  });

  test("> quote → Enter inserts '> ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("> quote");
    await page.keyboard.press("Enter");
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    expect(text).toContain("> quote\n> ");
  });

  test("- [ ] task → Enter inserts '- [ ] ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("- [ ] task");
    await page.keyboard.press("Enter");
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    expect(text).toContain("- [ ] task\n- [ ] ");
  });

  // ── Empty list item cancellation ────────────────────────
  test("empty bullet '- ' + Enter cancels the list", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("- item1");
    await page.keyboard.press("Enter");
    // Now we have "- item1\n- ", press Enter again on the empty bullet
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
      const el = document.querySelector('.editor') as HTMLElement;
      return el && !el.innerText.match(/\n- \s*$/);
    });
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    // The empty "- " should be removed
    expect(text).not.toMatch(/\n- \n/);
    expect(text).not.toMatch(/\n- $/);
  });

  // ── Plain text does not trigger ─────────────────────────
  test("plain text → Enter does not insert prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("hello world");
    await page.keyboard.press("Enter");
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    // Should just have a newline, no prefix
    expect(text).toContain("hello world\n");
    expect(text).not.toMatch(/hello world\n[-*>]/);
    expect(text).not.toMatch(/hello world\n\d+\./);
  });

  // ── Re-entry guard (no infinite loop) ──────────────────
  test("auto-insert does not freeze (re-entry guard)", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("- item");
    await page.keyboard.press("Enter");
    // If re-entry guard is broken, this would timeout
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    // Should have exactly one "- " prefix inserted, not multiple
    const prefixCount = (text.match(/\n- /g) || []).length;
    expect(prefixCount).toBe(1);
  });
});
