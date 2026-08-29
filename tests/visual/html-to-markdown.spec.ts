import { test, expect } from "./fixtures";

async function convert(page: any, html: string): Promise<string> {
  return page.evaluate((h: string) => (window as any).htmlToMarkdown(h), html);
}

test.describe("htmlToMarkdown", () => {
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

  test("hr → ---", async ({ notePage }) => {
    expect(await convert(notePage, "<p>before</p><hr><p>after</p>"))
      .toBe("before\n---\nafter\n");
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

  // ── img: data: URI → save_pasted_image 経由で画像記法 ────
  test("data: image → save_pasted_image で保存した相対パスの画像記法", async ({ notePage }) => {
    expect(await convert(notePage, '<img src="data:image/png;base64,iVBORw0KGgo=" alt="cat">'))
      .toBe("![cat](images/00000000-0000-4000-8000-000000000001.png)");
  });

  test("data: image (URL エンコード形式) → alt テキストのみ", async ({ notePage }) => {
    expect(await convert(notePage, '<img src="data:image/png,%89PNG" alt="cat">'))
      .toBe("cat");
  });

  test("data: image に charset パラメータが付いていても base64 部分をデコードする", async ({ notePage }) => {
    expect(await convert(
      notePage,
      '<img src="data:image/png;charset=utf-8;base64,iVBORw0KGgo=" alt="cat">',
    )).toBe("![cat](images/00000000-0000-4000-8000-000000000001.png)");
  });

  test("BASE64,（大文字）も base64 部分をデコードする", async ({ notePage }) => {
    expect(await convert(notePage, '<img src="data:image/png;BASE64,iVBORw0KGgo=" alt="cat">'))
      .toBe("![cat](images/00000000-0000-4000-8000-000000000001.png)");
  });

  test("DATA:（大文字接頭辞）も data: URI として扱う", async ({ notePage }) => {
    expect(await convert(notePage, '<img src="DATA:image/png;base64,iVBORw0KGgo=" alt="cat">'))
      .toBe("![cat](images/00000000-0000-4000-8000-000000000001.png)");
  });

  // ── img: https:// URL → 通常リンク（画像記法にしない） ───
  test("https image → 通常リンク", async ({ notePage }) => {
    expect(await convert(notePage, '<img src="https://example.com/cat.png" alt="cat">'))
      .toBe("[cat](https://example.com/cat.png)");
  });

  test("http image → 通常リンク", async ({ notePage }) => {
    expect(await convert(notePage, '<img src="http://example.com/cat.png" alt="cat">'))
      .toBe("[cat](http://example.com/cat.png)");
  });

  test("alt が空の https image → URL 自体をリンクテキストにする", async ({ notePage }) => {
    expect(await convert(notePage, '<img src="https://example.com/cat.png">'))
      .toBe("[https://example.com/cat.png](https://example.com/cat.png)");
  });

  // https image は `[alt](url)` というリンク記法になり画像記法（![alt|300](...)）にはならないため、
  // alt に | が含まれていても幅指定と誤解釈されない。除去してはいけない
  test("alt に | を含む https image → リンクテキストの | は保持される", async ({ notePage }) => {
    expect(await convert(notePage, '<img src="https://example.com/cat.png" alt="cat|300">'))
      .toBe("[cat|300](https://example.com/cat.png)");
  });

  // 一方、data: image は `![alt](path)` という画像記法になるため、alt 末尾の |数字 は
  // markdown.js の parseImageAlt に幅指定と誤解釈される。ここでは除去して意図しない幅指定を防ぐ
  test("alt に | を含む data: image → 画像記法の | は除去される", async ({ notePage }) => {
    expect(await convert(notePage, '<img src="data:image/png;base64,iVBORw0KGgo=" alt="cat|300">'))
      .toBe("![cat300](images/00000000-0000-4000-8000-000000000001.png)");
  });

  // ── img: blob: / file: など → alt テキストのみ残す ───────
  test("blob: image → alt テキストのみ", async ({ notePage }) => {
    expect(await convert(notePage, '<img src="blob:https://example.com/xyz" alt="cat">'))
      .toBe("cat");
  });

  test("blob: image で alt も無ければ何も残さない", async ({ notePage }) => {
    expect(await convert(notePage, '<img src="blob:https://example.com/xyz">'))
      .toBe("");
  });

  test("file: image → alt テキストのみ", async ({ notePage }) => {
    expect(await convert(notePage, '<img src="file:///tmp/cat.png" alt="cat">'))
      .toBe("cat");
  });

  // ── img: alt の無害化（] は下流が \] を解釈しないため除去する） ──
  test("alt に ] を含む data: image → ] を除去する", async ({ notePage }) => {
    expect(await convert(notePage, '<img src="data:image/png;base64,iVBORw0KGgo=" alt="a[b]c">'))
      .toBe("![a[bc](images/00000000-0000-4000-8000-000000000001.png)");
  });

  test("alt に ] を含む data: image → renderMarkdown が <img> を描画する", async ({ notePage }) => {
    const markdown = await convert(notePage, '<img src="data:image/png;base64,iVBORw0KGgo=" alt="a[b]c">');
    const html = await notePage.evaluate(
      (md: string) => (window as any).renderMarkdown(md),
      markdown,
    );
    // `]` をエスケープではなく除去しているので alt="a[bc" として <img> が描画される
    // （\] のまま残すと markdown.js の `[^\]]*` が途中で終端と誤認し <img> にならない）
    expect(html).toContain("<img");
    expect(html).toContain('alt="a[bc"');
  });

  test("alt に改行を含む https image → 空白に置換", async ({ notePage }) => {
    expect(await convert(notePage, '<img src="https://example.com/cat.png" alt="line1\nline2">'))
      .toBe("[line1 line2](https://example.com/cat.png)");
  });

  // ── ネストした ul/ol → 2 スペース単位のインデント ─────────
  test("ネストした ul → 親の文末に潰れず、2 スペースインデントの入れ子行になる", async ({ notePage }) => {
    expect(await convert(notePage, "<ul><li>parent<ul><li>child</li></ul></li></ul>"))
      .toBe("- parent\n  - child\n");
  });

  test("ネストした ol → 親の直下の子は 1 から採番し直し、2 スペースインデントになる", async ({ notePage }) => {
    expect(await convert(notePage, "<ol><li>one<ol><li>two</li></ol></li><li>three</li></ol>"))
      .toBe("1. one\n  1. two\n2. three\n");
  });

  test("2 階層ネストした ul → インデントが階層ぶん積み重なる", async ({ notePage }) => {
    expect(await convert(
      notePage,
      "<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>",
    )).toBe("- a\n  - b\n    - c\n");
  });

  test("兄弟 li にネストしたリストがあっても、後続の兄弟 li は巻き込まれない", async ({ notePage }) => {
    expect(await convert(
      notePage,
      "<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>",
    )).toBe("- a\n  - a1\n- b\n");
  });

  // ── pre → フェンス（```） ──────────────────────────────────
  test("pre > code → フェンスで囲む", async ({ notePage }) => {
    expect(await convert(notePage, "<pre><code>const x = 1;</code></pre>"))
      .toBe("```\nconst x = 1;\n```\n");
  });

  test("複数行の pre > code → 改行を保持したままフェンスで囲む", async ({ notePage }) => {
    expect(await convert(notePage, "<pre><code>line1\nline2</code></pre>"))
      .toBe("```\nline1\nline2\n```\n");
  });

  test("code の無い pre → pre 自身のテキストをフェンスで囲む", async ({ notePage }) => {
    expect(await convert(notePage, "<pre>plain</pre>")).toBe("```\nplain\n```\n");
  });

  // 構文ハイライト目的でトークンごとに <span> を挟む貼り付け元（VS Code 等）を想定
  test("pre > code 内の装飾タグ（構文ハイライト等）はテキストとして読み捨てる", async ({ notePage }) => {
    expect(await convert(
      notePage,
      '<pre><code><span class="hljs-keyword">const</span> x = 1;</code></pre>',
    )).toBe("```\nconst x = 1;\n```\n");
  });

  test("空の pre は出力しない", async ({ notePage }) => {
    expect(await convert(notePage, "<pre></pre>")).toBe("");
  });

  // ── img: 同一 data: URI の重複 ────────────────────────────
  test("同じ data: URI が複数回出てきても1回だけ保存し同じパスを使い回す", async ({ notePage }) => {
    const html = '<img src="data:image/png;base64,iVBORw0KGgo=" alt="a">'
      + '<img src="data:image/png;base64,iVBORw0KGgo=" alt="b">';
    expect(await convert(notePage, html)).toBe(
      "![a](images/00000000-0000-4000-8000-000000000001.png)"
      + "![b](images/00000000-0000-4000-8000-000000000001.png)",
    );
  });
});
