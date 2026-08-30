import { test, expect, enterEdit, getContent, placeCaret } from "./fixtures";

// Enter による行分割・リスト自動継続（beforeinput の insertParagraph）は未実装で、
// preventDefault の no-op（Enter が何もしない）のため、全テストを fixme にしている
test.describe("Markdown autocontinue E2E", () => {
  // ── Bullet list auto-continue ───────────────────────────
  test.fixme("- item → Enter inserts '- ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- item1");
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    expect(text).toContain("- item1\n- ");
  });

  test.fixme("* item → Enter inserts '* ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("* item1");
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    expect(text).toContain("* item1\n* ");
  });

  test.fixme("1. item → Enter inserts '2. ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("1. item1");
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    expect(text).toContain("1. item1\n2. ");
  });

  test.fixme("> quote → Enter inserts '> ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("> quote");
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    expect(text).toContain("> quote\n> ");
  });

  test.fixme("- [ ] task → Enter inserts '- [ ] ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- [ ] task");
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    expect(text).toContain("- [ ] task\n- [ ] ");
  });

  // ── Empty list item cancellation ────────────────────────
  test.fixme("empty bullet '- ' + Enter cancels the list", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- item1");
    await page.keyboard.press("Enter");
    // Now we have "- item1\n- ", press Enter again on the empty bullet
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    // The empty "- " should be removed
    expect(text).not.toMatch(/\n- \n/);
    expect(text).not.toMatch(/\n- $/);
  });

  // ── Plain text does not trigger ─────────────────────────
  test.fixme("plain text → Enter does not insert prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("hello world");
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    // Should just have a newline, no prefix
    expect(text).toContain("hello world\n");
    expect(text).not.toMatch(/hello world\n[-*>]/);
    expect(text).not.toMatch(/hello world\n\d+\./);
  });

  // ── Indented checkbox auto-continue ────────────────────
  test.fixme("indented '  - [ ] task' → Enter inserts '  - [ ] ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("  - [ ] task");
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    expect(text).toContain("  - [ ] task\n  - [ ] ");
  });

  test.fixme("indented '  - item' → Enter inserts '  - ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("  - item1");
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    expect(text).toContain("  - item1\n  - ");
  });

  test.fixme("indented '  1. item' → Enter inserts '  2. ' prefix", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("  1. item1");
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    expect(text).toContain("  1. item1\n  2. ");
  });

  // ── Enter at beginning/middle of line ─────────────────
  test.fixme("Enter at middle of '- hello world' splits and continues", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- hello world");
    // Move caret to middle (after "hello")
    for (let i = 0; i < " world".length; i++) {
      await page.keyboard.press("ArrowLeft");
    }
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    // Should split: "- hello\n- world"
    expect(text).toContain("- hello\n- world");
  });

  test.fixme("Enter at beginning of '- item' inserts prefix before content", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- item");
    // Move caret to right after "- " (beginning of content)
    for (let i = 0; i < "item".length; i++) {
      await page.keyboard.press("ArrowLeft");
    }
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    // Should have "- \n- item"
    expect(text).toContain("- \n- item");
  });

  // ── Enter before prefix does NOT auto-continue ─────────
  test.fixme("Enter before '- ' prefix inserts plain newline, no auto-continue", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- item");
    // Move caret to very beginning of line (before "- ")
    await placeCaret(page, 0, 0);
    await page.keyboard.press("Enter");
    const text = await getContent(page);
    // Should NOT insert a "- " prefix: just a plain newline before "- item"
    expect(text).toContain("\n- item");
    // Should NOT have two bullet prefixes
    const bulletCount = (text.match(/^- /gm) || []).length;
    expect(bulletCount).toBe(1);
  });

  // ── Re-entry guard (no infinite loop) ──────────────────
  test.fixme("auto-insert does not freeze (re-entry guard)", async ({ openNote }) => {
    const page = await openNote();
    await enterEdit(page);
    await page.keyboard.type("- item");
    await page.keyboard.press("Enter");
    // If re-entry guard is broken, this would timeout
    const text = await getContent(page);
    // Should have exactly one "- " prefix inserted, not multiple
    const prefixCount = (text.match(/\n- /g) || []).length;
    expect(prefixCount).toBe(1);
  });
});
