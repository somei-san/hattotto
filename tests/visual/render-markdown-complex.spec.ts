import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";

async function render(page: Page, text: string): Promise<string> {
  return page.evaluate((t: string) => (window as any).renderMarkdown(t), text);
}

// ── Markdown 複合パターン ────────────────────────────────────

test.describe("renderMarkdown — 複合パターン", () => {
  test("ネストされたリスト（2段階）", async ({ notePage }) => {
    const html = await render(notePage, "- item\n  - nested");
    expect(html).toContain("class=\"md-bullet\"");
    // 2つの bullet が存在
    const count = (html.match(/md-bullet/g) || []).length;
    expect(count).toBe(2);
  });

  test("ネストされたリスト（3段階）", async ({ notePage }) => {
    const html = await render(notePage, "- a\n  - b\n    - c");
    const count = (html.match(/md-bullet/g) || []).length;
    expect(count).toBe(3);
  });

  test("チェックボックス + 番号リスト混在", async ({ notePage }) => {
    const html = await render(notePage, "- [ ] task\n1. ordered");
    expect(html).toContain("md-check");
    expect(html).toContain("md-ordered");
  });

  test("引用ブロック + インライン装飾", async ({ notePage }) => {
    const html = await render(notePage, "> **bold** and *italic*");
    expect(html).toContain("md-blockquote");
    expect(html).toContain("<strong>");
    expect(html).toContain("<em>");
  });

  test("見出し + リスト + チェックボックスの連続", async ({ notePage }) => {
    const text = "# Title\n- item\n- [ ] task\n- [x] done";
    const html = await render(notePage, text);
    expect(html).toContain("md-h1");
    expect(html).toContain("md-bullet");
    expect(html).toContain("md-check");
    // done のチェックボックスは checked
    expect(html).toContain("checked");
  });

  test("コードブロック内の Markdown 記号は処理されない", async ({ notePage }) => {
    const text = "```\n# not a heading\n- not a list\n```";
    const html = await render(notePage, text);
    expect(html).not.toContain("md-h1");
    expect(html).not.toContain("md-bullet");
    expect(html).toContain("md-codeblock");
  });

  test("インラインコード内の装飾は処理されない", async ({ notePage }) => {
    const html = await render(notePage, "`**not bold**`");
    expect(html).not.toContain("<strong>");
    expect(html).toContain("<code>");
  });

  test("番号リストの自動採番（連番）", async ({ notePage }) => {
    const text = "1. first\n1. second\n1. third";
    const html = await render(notePage, text);
    // 各アイテムが異なる番号を持つ
    expect(html).toContain(">1.</span>");
    expect(html).toContain(">2.</span>");
    expect(html).toContain(">3.</span>");
  });

  test("区切り線（---）", async ({ notePage }) => {
    const html = await render(notePage, "before\n---\nafter");
    expect(html).toContain("<hr");
  });

  test("太字 + 斜体 + 取消線の組み合わせ", async ({ notePage }) => {
    const html = await render(notePage, "**bold** *italic* ~~strike~~");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<del>strike</del>");
  });

  test("リンク記法 [text](url)", async ({ notePage }) => {
    const html = await render(notePage, "[Google](https://google.com)");
    expect(html).toContain('href="https://google.com"');
    expect(html).toContain(">Google</a>");
  });
});

// ── 生URL自動リンク ─────────────────────────────────────────

test.describe("renderMarkdown — 生URL自動リンク", () => {
  test("https:// URL がクリック可能なリンクに変換される", async ({ notePage }) => {
    const html = await render(notePage, "visit https://example.com today");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain(">https://example.com</a>");
  });

  test("http:// URL もリンクに変換される", async ({ notePage }) => {
    const html = await render(notePage, "http://example.com");
    expect(html).toContain('href="http://example.com"');
  });

  test("[text](url) 記法の URL は二重リンクにならない", async ({ notePage }) => {
    const html = await render(notePage, "[link](https://example.com)");
    // href が1つだけ存在する（二重にならない）
    const hrefCount = (html.match(/href=/g) || []).length;
    expect(hrefCount).toBe(1);
  });

  test("コードブロック内の URL はリンクにならない", async ({ notePage }) => {
    const html = await render(notePage, "`https://example.com`");
    expect(html).not.toContain('href=');
  });

  test("複数の URL が同一行にある場合、それぞれリンクになる", async ({ notePage }) => {
    const html = await render(notePage, "https://a.com and https://b.com");
    expect(html).toContain('href="https://a.com"');
    expect(html).toContain('href="https://b.com"');
  });
});
