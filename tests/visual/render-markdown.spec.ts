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

test.describe("renderMarkdown — ordered list auto-numbering", () => {
  /** Helper: extract display numbers from md-order-num spans */
  function extractOrderNums(html: string): string[] {
    return [...html.matchAll(/<span class="md-order-num">(\d+)\.<\/span>/g)].map(m => m[1]);
  }

  test("sequential 1. 1. 1. displays as 1. 2. 3.", async ({ notePage }) => {
    const html = await render(notePage, "1. alpha\n1. bravo\n1. charlie");
    expect(extractOrderNums(html)).toEqual(["1", "2", "3"]);
  });

  test("indent change resets counter", async ({ notePage }) => {
    const html = await render(notePage, "1. top\n  1. sub-a\n  1. sub-b\n1. top2");
    // top=1, sub-a=1, sub-b=2, top2=1 (level change resets counter)
    expect(extractOrderNums(html)).toEqual(["1", "1", "2", "1"]);
  });

  test("non-numbered line resets counter", async ({ notePage }) => {
    const html = await render(notePage, "1. first\nplain text\n1. second");
    // plain text resets, so both show 1
    expect(extractOrderNums(html)).toEqual(["1", "1"]);
  });

  test("empty line resets counter", async ({ notePage }) => {
    const html = await render(notePage, "1. a\n1. b\n\n1. c");
    expect(extractOrderNums(html)).toEqual(["1", "2", "1"]);
  });

  test("bullet list between ordered lists resets counter", async ({ notePage }) => {
    const html = await render(notePage, "1. x\n- bullet\n1. y");
    expect(extractOrderNums(html)).toEqual(["1", "1"]);
  });

  test("mixed bullet and ordered interleaved", async ({ notePage }) => {
    const html = await render(notePage, "- bullet1\n1. ord1\n1. ord2\n- bullet2\n1. ord3");
    // ord1=1, ord2=2, then bullet resets, ord3=1
    expect(extractOrderNums(html)).toEqual(["1", "2", "1"]);
  });

  test("deeper indent resets when returning to parent level", async ({ notePage }) => {
    const html = await render(notePage, "1. a\n1. b\n  1. child1\n  1. child2\n1. c");
    // a=1, b=2, child1=1, child2=2, c=1 (returning to parent resets counter)
    expect(extractOrderNums(html)).toEqual(["1", "2", "1", "2", "1"]);
  });

  test("single ordered item displays as 1.", async ({ notePage }) => {
    const html = await render(notePage, "1. only");
    expect(extractOrderNums(html)).toEqual(["1"]);
  });

  test("source number is ignored — always auto-increments", async ({ notePage }) => {
    const html = await render(notePage, "5. first\n99. second\n1. third");
    expect(extractOrderNums(html)).toEqual(["1", "2", "3"]);
  });
});
