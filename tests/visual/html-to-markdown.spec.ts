import { test, expect } from "./fixtures";

// htmlToMarkdown is defined inside note.html's <script> scope.
// We evaluate it in the browser context via the notePage fixture.

async function convert(page: any, html: string): Promise<string> {
  return page.evaluate((h: string) => (window as any).htmlToMarkdown(h), html);
}

test.describe("htmlToMarkdown", () => {
  test.beforeEach(async ({ notePage }) => {
    // Expose htmlToMarkdown to window so we can call it from evaluate
    await notePage.evaluate(() => {
      // htmlToMarkdown is already in scope via the note.html script
      (window as any).htmlToMarkdown = (window as any).htmlToMarkdown;
    });
  });

  test("plain text passthrough", async ({ notePage }) => {
    expect(await convert(notePage, "hello world")).toBe("hello world");
  });

  test("link → markdown link", async ({ notePage }) => {
    expect(await convert(notePage, '<a href="https://example.com">Example</a>'))
      .toBe("[Example](https://example.com)");
  });

  test("bold → **text**", async ({ notePage }) => {
    expect(await convert(notePage, "<strong>bold</strong>")).toBe("**bold**");
  });

  test("b tag → **text**", async ({ notePage }) => {
    expect(await convert(notePage, "<b>bold</b>")).toBe("**bold**");
  });

  test("italic → *text*", async ({ notePage }) => {
    expect(await convert(notePage, "<em>italic</em>")).toBe("*italic*");
  });

  test("i tag → *text*", async ({ notePage }) => {
    expect(await convert(notePage, "<i>italic</i>")).toBe("*italic*");
  });

  test("strikethrough → ~~text~~", async ({ notePage }) => {
    expect(await convert(notePage, "<del>deleted</del>")).toBe("~~deleted~~");
  });

  test("s tag → ~~text~~", async ({ notePage }) => {
    expect(await convert(notePage, "<s>deleted</s>")).toBe("~~deleted~~");
  });

  test("code → `text`", async ({ notePage }) => {
    expect(await convert(notePage, "<code>const x</code>")).toBe("`const x`");
  });

  test("h1 → # text", async ({ notePage }) => {
    expect(await convert(notePage, "<h1>Title</h1>")).toBe("# Title\n");
  });

  test("h2 → ## text", async ({ notePage }) => {
    expect(await convert(notePage, "<h2>Subtitle</h2>")).toBe("## Subtitle\n");
  });

  test("h3 → ### text", async ({ notePage }) => {
    expect(await convert(notePage, "<h3>Section</h3>")).toBe("### Section\n");
  });

  test("unordered list → - items", async ({ notePage }) => {
    expect(await convert(notePage, "<ul><li>apple</li><li>banana</li></ul>"))
      .toBe("- apple\n- banana\n");
  });

  test("ordered list → numbered items", async ({ notePage }) => {
    expect(await convert(notePage, "<ol><li>first</li><li>second</li></ol>"))
      .toBe("1. first\n2. second\n");
  });

  test("blockquote → > text", async ({ notePage }) => {
    expect(await convert(notePage, "<blockquote>quoted text</blockquote>"))
      .toBe("> quoted text\n");
  });

  test("nested: bold link", async ({ notePage }) => {
    expect(await convert(notePage, '<strong><a href="https://example.com">link</a></strong>'))
      .toBe("**[link](https://example.com)**");
  });

  test("mixed inline", async ({ notePage }) => {
    expect(await convert(notePage, "hello <strong>bold</strong> and <em>italic</em>"))
      .toBe("hello **bold** and *italic*");
  });

  test("p tags add newlines", async ({ notePage }) => {
    expect(await convert(notePage, "<p>first</p><p>second</p>"))
      .toBe("first\nsecond\n");
  });

  test("br → newline", async ({ notePage }) => {
    expect(await convert(notePage, "line1<br>line2"))
      .toBe("line1\nline2");
  });

  // ── Edge cases: empty nodes ──────────────────────────────
  test("empty <strong> produces no output", async ({ notePage }) => {
    expect(await convert(notePage, "<strong></strong>")).toBe("");
  });

  test("empty <em> produces no output", async ({ notePage }) => {
    expect(await convert(notePage, "<em></em>")).toBe("");
  });

  test("empty <del> produces no output", async ({ notePage }) => {
    expect(await convert(notePage, "<del></del>")).toBe("");
  });

  test("empty <code> produces no output", async ({ notePage }) => {
    expect(await convert(notePage, "<code></code>")).toBe("");
  });

  test("empty <h1> produces no output", async ({ notePage }) => {
    expect(await convert(notePage, "<h1></h1>")).toBe("");
  });

  // ── Edge cases: unknown/unsupported tags ─────────────────
  test("unknown tag passes through children", async ({ notePage }) => {
    expect(await convert(notePage, "<span>hello</span>")).toBe("hello");
  });

  test("nested unknown tags pass through", async ({ notePage }) => {
    expect(await convert(notePage, '<span><span>deep</span></span>')).toBe("deep");
  });

  // ── Security: script/style stripping ─────────────────────
  test("script tag is stripped entirely", async ({ notePage }) => {
    expect(await convert(notePage, '<script>alert("xss")</script>')).toBe("");
  });

  test("style tag is stripped entirely", async ({ notePage }) => {
    expect(await convert(notePage, "<style>body{color:red}</style>")).toBe("");
  });

  test("script mixed with content is stripped", async ({ notePage }) => {
    expect(await convert(notePage, 'hello<script>alert(1)</script> world'))
      .toBe("hello world");
  });

  // ── Security: javascript: URL sanitization ───────────────
  test("javascript: href is stripped", async ({ notePage }) => {
    expect(await convert(notePage, '<a href="javascript:alert(1)">click</a>'))
      .toBe("click");
  });

  test("JAVASCRIPT: href (case-insensitive) is stripped", async ({ notePage }) => {
    expect(await convert(notePage, '<a href="JAVASCRIPT:void(0)">click</a>'))
      .toBe("click");
  });

  test("link without href passes through text", async ({ notePage }) => {
    expect(await convert(notePage, "<a>no link</a>")).toBe("no link");
  });

  // ── Nesting ──────────────────────────────────────────────
  test("bold inside italic", async ({ notePage }) => {
    expect(await convert(notePage, "<em><strong>both</strong></em>"))
      .toBe("***both***");
  });

  test("link inside list item", async ({ notePage }) => {
    expect(await convert(notePage, '<ul><li><a href="https://example.com">link</a></li></ul>'))
      .toBe("- [link](https://example.com)\n");
  });

  test("inline formatting inside heading", async ({ notePage }) => {
    expect(await convert(notePage, "<h2><strong>Bold Title</strong></h2>"))
      .toBe("## **Bold Title**\n");
  });

  test("multiple paragraphs with inline formatting", async ({ notePage }) => {
    expect(await convert(notePage, "<p>hello <em>world</em></p><p><strong>done</strong></p>"))
      .toBe("hello *world*\n**done**\n");
  });

  // ── Blockquote edge cases ────────────────────────────────
  test("multiline blockquote", async ({ notePage }) => {
    expect(await convert(notePage, "<blockquote><p>line1</p><p>line2</p></blockquote>"))
      .toBe("> line1\n> line2\n");
  });
});
