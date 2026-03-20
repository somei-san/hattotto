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

  // ── Indented checkbox auto-continue ────────────────────
  test("indented '  - [ ] task' → Enter inserts '  - [ ] ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("  - [ ] task");
    await page.keyboard.press("Enter");
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    expect(text).toContain("  - [ ] task\n  - [ ] ");
  });

  test("indented '  - item' → Enter inserts '  - ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("  - item1");
    await page.keyboard.press("Enter");
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    expect(text).toContain("  - item1\n  - ");
  });

  test("indented '  1. item' → Enter inserts '  2. ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("  1. item1");
    await page.keyboard.press("Enter");
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    expect(text).toContain("  1. item1\n  2. ");
  });

  // ── Enter at beginning/middle of line ─────────────────
  test("Enter at middle of '- hello world' splits and continues", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("- hello world");
    // Move caret to middle (after "hello")
    for (let i = 0; i < " world".length; i++) {
      await page.keyboard.press("ArrowLeft");
    }
    await page.keyboard.press("Enter");
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    // Should split: "- hello\n- world"
    expect(text).toContain("- hello\n- world");
  });

  test("Enter at beginning of '- item' inserts prefix before content", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("- item");
    // Move caret to right after "- " (beginning of content)
    for (let i = 0; i < "item".length; i++) {
      await page.keyboard.press("ArrowLeft");
    }
    await page.keyboard.press("Enter");
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    // Should have "- \n- item"
    expect(text).toContain("- \n- item");
  });

  // ── Enter before prefix does NOT auto-continue ─────────
  test("Enter before '- ' prefix inserts plain newline, no auto-continue", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("- item");
    // Move caret to very beginning of line (before "- ")
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    // Should NOT insert a "- " prefix: just a plain newline before "- item"
    expect(text).toContain("\n- item");
    // Should NOT have two bullet prefixes
    const bulletCount = (text.match(/^- /gm) || []).length;
    expect(bulletCount).toBe(1);
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
