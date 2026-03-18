import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";

async function render(page: Page, text: string): Promise<string> {
  return page.evaluate((t: string) => (window as any).renderMarkdown(t), text);
}

test.describe("renderMarkdown — inline & block elements", () => {
  test("heading h1", async ({ notePage }) => {
    const html = await render(notePage, "# Heading 1");
    expect(html).toContain('class="md-h1"');
  });

  test("heading h2", async ({ notePage }) => {
    const html = await render(notePage, "## Heading 2");
    expect(html).toContain('class="md-h2"');
  });

  test("heading h3", async ({ notePage }) => {
    const html = await render(notePage, "### Heading 3");
    expect(html).toContain('class="md-h3"');
  });

  test("bullet list", async ({ notePage }) => {
    const html = await render(notePage, "- item");
    expect(html).toContain('class="md-bullet"');
  });

  test("checkbox unchecked", async ({ notePage }) => {
    const html = await render(notePage, "- [ ] task");
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain("checked");
  });

  test("checkbox checked", async ({ notePage }) => {
    const html = await render(notePage, "- [x] task");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
  });

  test("ordered list", async ({ notePage }) => {
    const html = await render(notePage, "1. item");
    expect(html).toContain('class="md-ordered"');
  });

  test("bold", async ({ notePage }) => {
    const html = await render(notePage, "**text**");
    expect(html).toContain("<strong>");
  });

  test("italic", async ({ notePage }) => {
    const html = await render(notePage, "*text*");
    expect(html).toContain("<em>");
  });

  test("strikethrough", async ({ notePage }) => {
    const html = await render(notePage, "~~text~~");
    expect(html).toContain("<del>");
  });

  test("inline code", async ({ notePage }) => {
    const html = await render(notePage, "`code`");
    expect(html).toContain("<code>");
  });

  test("link", async ({ notePage }) => {
    const html = await render(notePage, "[text](https://example.com)");
    expect(html).toContain('<a href="https://example.com"');
  });

  test("blockquote", async ({ notePage }) => {
    const html = await render(notePage, "> text");
    expect(html).toContain('class="md-blockquote"');
  });

  test("horizontal rule", async ({ notePage }) => {
    const html = await render(notePage, "---");
    expect(html).toContain("<hr");
  });

  test("empty string returns placeholder", async ({ notePage }) => {
    const html = await render(notePage, "");
    expect(html).toContain("md-placeholder");
  });

  test("composite: heading + list + bold", async ({ notePage }) => {
    const html = await render(notePage, "# Title\n- **bold item**");
    expect(html).toContain('class="md-h1"');
    expect(html).toContain('class="md-bullet"');
    expect(html).toContain("<strong>");
  });

  test("nested inline: bold with code inside", async ({ notePage }) => {
    const html = await render(notePage, "**太字の中に`code`**");
    expect(html).toContain("<strong>");
    expect(html).toContain("<code>");
  });
});
