import { test, expect, injectNoteMock, enterEdit, selectMarkdownRange } from "./fixtures";

// 描画部分（markdown-view）のテキスト選択に対するコピー挙動（issue #70）。
// - 通常コピー（⌘C 相当）: text/html（装飾付き）と text/plain を同時にクリップボードへ載せる。
//   text/plain は行構造（インデント・リスト記号・チェックボックス記法・コードフェンス・
//   --- ・> ・# 見出しマーカー）は raw のまま残し、インライン装飾（**太字** 等）だけを
//   可視テキストへ置換したもの（「形式なしでも構造が読める」ことを狙う）
// - 「Markdown をコピー」（右クリックメニュー）: 選択範囲の生 Markdown 記法のままコピーする
// 実際の Range 選択はマウスドラッグではなく、note.js と同じ nodeAt 方式で DOM 上の
// (行, 可視オフセット) から Range を組み立てて再現する。

/** document へ copy の ClipboardEvent を dispatch し、preventDefault の有無とセットされた
 * text/html・text/plain を返す。 */
function dispatchCopyWithClipboardData(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const dt = new DataTransfer();
    const ev = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: dt });
    const notCanceled = document.dispatchEvent(ev);
    return {
      notCanceled,
      html: dt.getData("text/html"),
      plain: dt.getData("text/plain"),
    };
  });
}

function capturedCalls(page: import("@playwright/test").Page, cmd: string) {
  return page.evaluate(
    (c) => (window as any).__captured_invokes.filter((call: any) => call.cmd === c),
    cmd,
  );
}

test.describe("通常コピー（markdown-view のテキスト選択、⌘C 相当）", () => {
  test("複数行選択: text/plain に記法が含まれず、text/html に装飾タグが含まれ、preventDefault される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "**bold** line0\nline1 text" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // 1 行目全体（可視 "bold line0"）〜 2 行目全体（"line1 text"）を選択
    await selectMarkdownRange(page, 0, 0, 1, "line1 text".length);

    const { notCanceled, html, plain } = await dispatchCopyWithClipboardData(page);

    expect(notCanceled).toBe(false); // preventDefault() された
    expect(plain).toBe("bold line0\nline1 text");
    expect(plain).not.toContain("**");
    expect(html).toContain("<strong>bold</strong>");

    await ctx.close();
  });

  test("画像を含む選択: text/html に img タグが無く、alt テキストで代替される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const IMAGE_PATH = "images/00000000-0000-4000-8000-000000000001.png";
    await injectNoteMock(
      page,
      { content: `before\n![caption](${IMAGE_PATH})\nafter` },
      {},
      { captureInvokes: true },
    );
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectMarkdownRange(page, 0, 0, 2, "after".length);

    const { html, plain } = await dispatchCopyWithClipboardData(page);

    expect(html).not.toContain("<img");
    expect(html).not.toContain(IMAGE_PATH);
    expect(html).toContain("caption");
    expect(plain).not.toContain("![");

    await ctx.close();
  });

  test(".raw-editor 内の選択に触れる copy は preventDefault されない（既定動作に任せる）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "editable line" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await enterEdit(page, 0);
    await page.evaluate(() => {
      const ed = document.querySelector("#editor")!;
      const range = document.createRange();
      range.selectNodeContents(ed);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    const { notCanceled } = await dispatchCopyWithClipboardData(page);
    expect(notCanceled).toBe(true); // preventDefault されていない = 既定のコピーに任せた

    await ctx.close();
  });

  test("選択なしの copy は何もしない（text/html・text/plain がセットされない）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "plain line" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => window.getSelection()?.removeAllRanges());

    const { notCanceled, html, plain } = await dispatchCopyWithClipboardData(page);
    expect(notCanceled).toBe(true);
    expect(html).toBe("");
    expect(plain).toBe("");

    await ctx.close();
  });

  test("1 行内で装飾をまたぐ部分選択: plain はインライン装飾だけ外した可視テキストになる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    // raw: "abc **bold** def" / 可視: "abc bold def"
    await injectNoteMock(page, { content: "abc **bold** def" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // 可視 "abc bold def" の 1 文字目〜10 文字目（"bc bold d"）。<strong> の内部をまたぐ部分選択
    await selectMarkdownRange(page, 0, 1, 0, 10);

    const { plain } = await dispatchCopyWithClipboardData(page);
    expect(plain).toBe("bc bold d");

    await ctx.close();
  });

  test("序数リスト行の全選択: plain は raw の番号マーカーを含む行そのものになる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "1. item text" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const el = document.querySelector('#markdown-view [data-line="0"]')!;
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    const { plain } = await dispatchCopyWithClipboardData(page);
    expect(plain).toBe("1. item text");

    await ctx.close();
  });

  // renderMarkdown は番号行の連続ブロックごとに 1 から自動採番し直す（raw の数字は無視する）ため、
  // 画面表示の番号と raw の番号がずれることがある。plain は raw の番号をそのまま残す仕様（画面
  // 表示に合わせて採番し直さない）ことを、raw と表示がずれる具体例で確認する
  test("番号リストの raw 番号が画面表示の連番と異なっていても、plain は raw の番号のまま残す", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    // renderMarkdown は新しい番号ブロックを常に 1 から表示するため、raw で "5." と書いても
    // 画面表示は "1." になる
    await injectNoteMock(page, { content: "5. item text" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const el = document.querySelector('#markdown-view [data-line="0"]')!;
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    const { plain } = await dispatchCopyWithClipboardData(page);
    expect(plain).toBe("5. item text");

    await ctx.close();
  });

  test("チェックボックス行の全選択: plain は raw のチェックボックス記法（- [ ] ）を含む行そのものになる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "- [ ] task text" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const el = document.querySelector('#markdown-view [data-line="0"]')!;
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    const { plain } = await dispatchCopyWithClipboardData(page);
    expect(plain).toBe("- [ ] task text");

    await ctx.close();
  });
});

test.describe("通常コピー: text/html のセマンティック変換（複数行選択）", () => {
  test("見出し・入れ子リスト・チェックボックス・引用・コードブロック・空行・通常行が構造化された HTML になり、data-*/class を含まない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const content = [
      "# Heading",
      "- a",
      "  - a1",
      "- b",
      "- [ ] todo",
      "- [x] done",
      "> q1",
      "> q2",
      "plain line",
      "```",
      "code line",
      "```",
      "",
      "last line",
    ].join("\n");
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectMarkdownRange(page, 0, 0, 13, "last line".length);

    const { html } = await dispatchCopyWithClipboardData(page);

    expect(html).toBe(
      "<h1>Heading</h1>"
      + "<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>"
      + "<ul><li>[ ] todo</li><li>[x] done</li></ul>"
      + "<blockquote><p>q1</p><p>q2</p></blockquote>"
      + "<p>plain line</p>"
      + '<pre style="font-family: monospace"><code>code line</code></pre>'
      + "<p></p>"
      + "<p>last line</p>",
    );
    expect(html).not.toMatch(/data-|class=/);

    await ctx.close();
  });

  test("番号リストの途中から選択しても、画面に見えている番号が <ol start> に反映される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const content = ["1. i1", "2. i2", "3. i3", "4. i4"].join("\n");
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // 3 番目の項目（表示上 "3."）から末尾まで選択
    await selectMarkdownRange(page, 2, 0, 3, "4. i4".length);

    const { html } = await dispatchCopyWithClipboardData(page);
    expect(html).toBe('<ol start="3"><li value="3">i3</li><li value="4">i4</li></ol>');

    await ctx.close();
  });

  // .md-order-num（自動採番の表示専用プレフィックス）より後ろから選択が始まると、選択範囲の
  // クローンにはそのスパンが含まれない。クローンから番号を読むと拾えず 1 にフォールバックして
  // 画面の番号とずれるバグがあったため、元の行要素（mdView 側）から番号を読むことを確認する
  test("番号スパンより後ろ（項目本文の途中）から選択しても <ol start> が画面の番号のままになる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const content = ["1. i1", "2. i2", "3. i3", "4. i4"].join("\n");
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // "3. i3" の "3. " の直後（"i3" の "i" の手前）から選択開始
    await selectMarkdownRange(page, 2, 3, 3, "4. i4".length);

    const { html } = await dispatchCopyWithClipboardData(page);
    expect(html).toBe('<ol start="3"><li value="3">i3</li><li value="4">i4</li></ol>');

    await ctx.close();
  });

  // renderMarkdown は番号行以外（bullet 等）が挟まるとカウンタをリセットするため、入れ子を
  // 挟んだ番号リストは画面表示・text/plain が「1 / 1 / 2」のように連番が途中でリセットされる
  // ことがある。種別混在でも 1 つの <ol> にまとめる仕様上、value を付けないとブラウザの既定の
  // 自動採番（1 / 2 / 3）に頼ることになり画面表示と食い違うため、各 <li> に value を明示する
  test("入れ子を挟んだ番号リスト（bullet でカウンタがリセットされる）→ 各 <li> に画面表示どおりの value が付く", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const content = ["1. one", "  - sub", "1. two", "2. three"].join("\n");
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectMarkdownRange(page, 0, 0, 3, "2. three".length);

    const { html, plain } = await dispatchCopyWithClipboardData(page);
    // plain は raw の行構造のまま（インデント・"- " マーカーも残る）。画面表示・html の value は
    // 「1 / 1 / 2」（"1. two" の直前の bullet 行でカウンタがリセットされる）
    expect(plain).toBe("1. one\n  - sub\n1. two\n2. three");
    expect(html).toBe(
      '<ol start="1"><li value="1">one<ul><li>sub</li></ul></li>'
      + '<li value="1">two</li><li value="2">three</li></ol>',
    );

    await ctx.close();
  });

  // 種別（bullet/ordered/check）ごとに連続グループを分けると種別をまたぐ入れ子が失われる。
  // レベル差による親子関係は種別をまたいで判定し、ノードごとに正しいタグ（check は ul）へ
  // 振り分けられることを確認する
  test("bullet の下に check がネストしても、種別ごとに分断されず 1 つのリストにまとまる", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const content = ["- 買い物", "  - [ ] 牛乳", "  - [ ] パン", "- 掃除"].join("\n");
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectMarkdownRange(page, 0, 0, 3, "掃除".length);

    const { html } = await dispatchCopyWithClipboardData(page);
    expect(html).toBe(
      "<ul><li>買い物<ul><li>[ ] 牛乳</li><li>[ ] パン</li></ul></li><li>掃除</li></ul>",
    );

    await ctx.close();
  });

  // htmlToMarkdown に通すと `- [ ] 牛乳` の形に戻り、本物のチェックボックスとして復元される
  // （li 先頭が `[ ] `/`[x] ` の平文になっているため、貼り戻し先で `- [ ] ...` と解釈される）
  test("round-trip: 種別混在（bullet の下に check）の入れ子も元の Markdown にそのまま戻る", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const content = ["- 買い物", "  - [ ] 牛乳", "  - [ ] パン", "- 掃除"].join("\n");
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectMarkdownRange(page, 0, 0, 3, "掃除".length);

    const { html } = await dispatchCopyWithClipboardData(page);
    const roundTripped = await page.evaluate((h: string) => (window as any).htmlToMarkdown(h), html);

    expect((roundTripped as string).replace(/\n$/, "")).toBe(content);

    await ctx.close();
  });

  // htmlToMarkdown（リッチテキストペースト変換）に通し、別の付箋へ貼り戻したときに構造が
  // 復元されることを確認する。チェックボックスも `[x] `/`[ ] ` の平文表現から `- [x] `/`- [ ] `
  // として本物のチェックボックスに復元される
  test("round-trip: 生成した text/html を htmlToMarkdown に通すと、元の Markdown にそのまま戻る", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const lines = [
      "# Title",
      "- a",
      "  - a1",
      "- b",
      "1. x",
      "2. y",
      "---",
      "> q1",
      "> q2",
      "```",
      "code",
      "```",
      "",
      "plain",
      "- [ ] todo",
      "- [x] done",
    ];
    const content = lines.join("\n");
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectMarkdownRange(page, 0, 0, 15, "- [x] done".length);

    const { html } = await dispatchCopyWithClipboardData(page);
    const roundTripped = await page.evaluate((h: string) => (window as any).htmlToMarkdown(h), html);

    // nodeToMd は各ブロックの末尾に \n を付けるため、末尾に 1 つ多く付く分だけ剥がして比較する
    expect((roundTripped as string).replace(/\n$/, "")).toBe(content);

    await ctx.close();
  });
});

test.describe("通常コピー: text/plain（行構造は raw のまま、インライン装飾だけ外す）", () => {
  test("見出し・リスト（入れ子）・チェックボックス・引用・区切り線・コードブロック・空行を含む複数行選択で、マーカー・インデント・フェンスが残り、コード内の装飾記法は外さない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const content = [
      "# **Heading**",
      "- *italic* item",
      "  - `code` sub",
      "- [ ] ~~strike~~ todo",
      "> quote **bold**",
      "---",
      "```",
      "raw **not** stripped",
      "```",
      "",
      "5. five",
    ].join("\n");
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectMarkdownRange(page, 0, 0, 10, "5. five".length);

    const { plain } = await dispatchCopyWithClipboardData(page);
    expect(plain).toBe(
      "# Heading\n"
      + "- italic item\n"
      + "  - code sub\n"
      + "- [ ] strike todo\n"
      + "> quote bold\n"
      + "---\n"
      + "```\n"
      + "raw **not** stripped\n" // コードブロックの中身は markdown 記法として解釈しない（raw のまま）
      + "```\n"
      + "\n"
      + "5. five", // renderMarkdown は表示上 "1." に採番し直すが、plain は raw の "5." を残す
    );

    await ctx.close();
  });

  // 「行頭から次行の先頭までドラッグ」の典型操作では、選択終端が次行の可視オフセット 0
  // （＝そのマーカー直後、内容は 1 文字も選択されていない）に落ちる。resolveSelectionBounds が
  // これを切り詰めないと、次行のマーカー（`> ` / `- [ ] ` / `1. ` 等）だけが混入してしまう
  test("選択終端が次行の先頭（可視オフセット 0）に落ちても、次行のマーカーが混入しない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const content = ["first line", "> quote", "- [ ] task", "1. item"].join("\n");
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // 1 行目の先頭（0,0）〜 2 行目の可視オフセット 0（"> " の直後、内容の手前）
    await selectMarkdownRange(page, 0, 0, 1, 0);
    const { plain: plainQuote } = await dispatchCopyWithClipboardData(page);
    expect(plainQuote).toBe("first line\n");
    expect(plainQuote).not.toContain(">");

    // 2 行目の先頭（0,0）〜 3 行目の可視オフセット 0（"- [ ] " の直後、内容の手前）
    await selectMarkdownRange(page, 1, 0, 2, 0);
    const { plain: plainCheck } = await dispatchCopyWithClipboardData(page);
    expect(plainCheck).toBe("> quote\n");
    expect(plainCheck).not.toContain("[ ]");

    // 3 行目の先頭（0,0）〜 4 行目の可視オフセット 0（"1. " の直後、内容の手前）
    await selectMarkdownRange(page, 2, 0, 3, 0);
    const { plain: plainOrdered } = await dispatchCopyWithClipboardData(page);
    expect(plainOrdered).toBe("- [ ] task\n");
    expect(plainOrdered).not.toContain("1.");

    await ctx.close();
  });

  // コード行にはマーカーという概念が無く、raw の生テキストがそのまま可視テキストになる。
  // 「終了端が次行の可視オフセット 0（＝マーカー長と一致）なら切り詰める」正規化を無条件に
  // 適用すると、コード行の内容がたまたまマーカーパターン（"- " 等）に一致する文字数で選択を
  // 止めたときに、選択済みの文字（この場合 "  - "）ごと落ちてしまっていた
  test("コードブロック内で終了端がマーカー相当の文字数と一致しても、選択済みの文字が落ちない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const content = ["head", "```", "  - li", "```"].join("\n");
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const row0 = document.querySelector('#markdown-view [data-line="0"]')!;
      const codeEl = document.querySelector("#markdown-view pre.md-codeblock code")!;
      const w0 = document.createTreeWalker(row0, NodeFilter.SHOW_TEXT);
      const t0 = w0.nextNode() as Text;
      const wc = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
      const tc = wc.nextNode() as Text;
      const range = document.createRange();
      range.setStart(t0, 0);
      range.setEnd(tc, 4); // "  - li" の "  - "（4 文字）の直後で止める
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    const { plain } = await dispatchCopyWithClipboardData(page);
    expect(plain).toBe("head\n```\n  - ");

    await ctx.close();
  });

  test("コードブロック内で開始端がマーカー相当の文字数と一致しても、選択していない行頭が混入しない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const content = ["```", "  - listish", "```"].join("\n");
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const codeEl = document.querySelector("#markdown-view pre.md-codeblock code")!;
      const wc = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
      const tc = wc.nextNode() as Text;
      const range = document.createRange();
      range.setStart(tc, 4); // "  - listish" の "  - "（4 文字）の直後から始める
      range.setEnd(tc, 8); // "list" まで
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    const { plain } = await dispatchCopyWithClipboardData(page);
    expect(plain).toBe("list");

    await ctx.close();
  });

  // コードブロックの可視テキストはフェンス内側の内容行だけなので、選択終端が「閉じた
  // ブロックの最後の内容行の末尾」に解決されると、閉じフェンス行が行スライスの範囲外に落ちる
  // （開きフェンスは選択がブロック上方から入ると自然に含まれるのに非対称だった）
  test("選択終端がブロックの最後の内容行の末尾に一致すると、閉じフェンス行を含めて取る", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const content = ["head", "```", "code line", "```"].join("\n");
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const row0 = document.querySelector('#markdown-view [data-line="0"]')!;
      const codeEl = document.querySelector("#markdown-view pre.md-codeblock code")!;
      const w0 = document.createTreeWalker(row0, NodeFilter.SHOW_TEXT);
      const t0 = w0.nextNode() as Text;
      const wc = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
      const tc = wc.nextNode() as Text;
      const range = document.createRange();
      range.setStart(t0, 0);
      range.setEnd(tc, tc.textContent!.length); // "code line" の末尾ちょうど
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    const { plain } = await dispatchCopyWithClipboardData(page);
    expect(plain).toBe("head\n```\ncode line\n```");

    await ctx.close();
  });

  // ブロックの可視テキスト全体（内容行の先頭〜末尾）をちょうど選択した場合、開き・閉じ両方の
  // フェンスを含めて丸ごと取れる（非対称にしない）
  test("ブロックの可視テキスト全体（内容行のみ）を選択すると、開き・閉じ両方のフェンスを含めて取る", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const content = ["```", "code line", "```"].join("\n");
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const codeEl = document.querySelector("#markdown-view pre.md-codeblock code")!;
      const range = document.createRange();
      range.selectNodeContents(codeEl); // 内容行の可視テキスト全体（"code line"）だけを選択
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    const { plain } = await dispatchCopyWithClipboardData(page);
    expect(plain).toBe("```\ncode line\n```");

    await ctx.close();
  });

  // 複数行あるブロックのうち 1 行だけ（先頭〜末尾）を選択したときは、その行が
  // ブロックの最初の内容行でも最後の内容行でもない限り、両端が揃ってブロック全体を覆っては
  // いないためフェンスを付けない。片側だけ付くと未クローズの断片ができ、貼り戻すと以降の行まで
  // コードブロック化してしまう
  test("複数行あるブロックの内容行 1 行だけを選択（先頭〜末尾）しても、フェンスは付かない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const content = ["```js", "line1", "line2", "```"].join("\n");
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const codeEl = document.querySelector("#markdown-view pre.md-codeblock code")!;
      const wc = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
      const tc = wc.nextNode() as Text; // "line1\nline2"
      const range = document.createRange();
      range.setStart(tc, 0);
      range.setEnd(tc, "line1".length); // "line1" の先頭〜末尾だけ（"line2" には触れない）
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    const { plain } = await dispatchCopyWithClipboardData(page);
    expect(plain).toBe("line1");

    await ctx.close();
  });
});

test.describe("通常コピー: 画像（alt 空/非空）", () => {
  const IMAGE_PATH = "images/00000000-0000-4000-8000-000000000001.png";

  test("alt が非空 + 拡張子あり → html・plain とも「(alt.拡張子)」になる（生 Markdown 記法は出さない）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const content = [
      `with alt ![cat](${IMAGE_PATH}) end`,
      `no alt ![](${IMAGE_PATH}) end`,
    ].join("\n");
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // 2 行目の可視テキストは "no alt " + [img は可視文字を持たない] + " end" = "no alt  end"（11 文字）
    await selectMarkdownRange(page, 0, 0, 1, "no alt  end".length);

    const { html, plain } = await dispatchCopyWithClipboardData(page);
    // alt 非空（"cat"）も拡張子付きにする（"(cat.png)"）。alt 空のフォールバックラベルも
    // src の拡張子を含める（"(画像.png)"）
    expect(html).toBe("<p>with alt (cat.png) end</p><p>no alt (画像.png) end</p>");
    expect(plain).toBe("with alt (cat.png) end\nno alt (画像.png) end");
    expect(html).not.toContain(IMAGE_PATH);
    expect(plain).not.toContain(IMAGE_PATH);
    expect(html).not.toContain("![");
    expect(plain).not.toContain("![");

    await ctx.close();
  });

  test("拡張子が読み取れないパスなら、alt 非空は「(alt)」、alt 空は「(画像)」のまま", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const content = [
      "with alt ![cat](https://example.com/image) end",
      "no alt ![](https://example.com/image) end",
    ].join("\n");
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // 2 行目の可視テキストは "no alt " + [img は可視文字を持たない] + " end" = "no alt  end"（11 文字）
    await selectMarkdownRange(page, 0, 0, 1, "no alt  end".length);

    const { html, plain } = await dispatchCopyWithClipboardData(page);
    expect(html).toBe("<p>with alt (cat) end</p><p>no alt (画像) end</p>");
    expect(plain).toBe("with alt (cat) end\nno alt (画像) end");

    await ctx.close();
  });

  // リンクや装飾に包まれた画像（`[![alt](p)](url)` / `**![a](p)**`）は inlineSegments が
  // リンク・装飾と画像をまとめて 1 つのセグメントに合併するため、raw が画像記法だけでは
  // 終わらず完全一致にならない。visibleText が空になる点は素の画像と同じなので、それで判定する
  test("リンク・装飾に包まれた画像も「(alt.拡張子)」またはフォールバックラベルになる（消えない）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    const content = [
      `[![alt](${IMAGE_PATH})](https://example.com) after`,
      `**![b](${IMAGE_PATH})** after`,
    ].join("\n");
    await injectNoteMock(page, { content }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectMarkdownRange(page, 0, 0, 1, "b after".length);

    const { plain } = await dispatchCopyWithClipboardData(page);
    expect(plain).toBe("(alt.png) after\n(b.png) after");

    await ctx.close();
  });
});

// hr（<hr> は子ノードを持たない）や内容行の無い空フェンス（<code> が空）は、その行に可視の
// テキストノードが 1 つも無い。resolveSelectionPoint は選択の開始・終了をテキストノード基準で
// 区別するため、その行だけを選択しても start/end が同じ点に潰れ、plain が空文字になっていた
test.describe("通常コピー: 可視文字を持たない行だけの選択", () => {
  test("--- のみの全選択 → plain が --- になる（空文字にならない）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "---" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const mdView = document.getElementById("markdown-view")!;
      const range = document.createRange();
      range.selectNodeContents(mdView);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    const { plain } = await dispatchCopyWithClipboardData(page);
    expect(plain).toBe("---");

    await ctx.close();
  });

  test("内容行の無い空フェンスのみの全選択 → plain がフェンスそのものになる（空文字にならない）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "```\n```" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const mdView = document.getElementById("markdown-view")!;
      const range = document.createRange();
      range.selectNodeContents(mdView);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    const { plain } = await dispatchCopyWithClipboardData(page);
    expect(plain).toBe("```\n```");

    await ctx.close();
  });
});

test.describe("通常コピー: 生 Markdown へ解決できない選択は既定のコピーに任せる", () => {
  test("空の付箋（プレースホルダ表示）を選択して copy → preventDefault されず、text/html にプレースホルダ文言が載らない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const placeholder = document.querySelector(".md-placeholder")!;
      const range = document.createRange();
      range.selectNodeContents(placeholder);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    const { notCanceled, html, plain } = await dispatchCopyWithClipboardData(page);
    expect(notCanceled).toBe(true); // preventDefault されていない = 既定のコピーに任せた
    expect(html).toBe("");
    expect(plain).toBe("");

    await ctx.close();
  });
});

// 「1 行だけ選択」は cloneContents() の形が選択の張り方で 2 通りに分かれる：
// (a) 選択の境界が mdView 直下の子オフセット（コンテナレベル）で表現される場合、その行要素は
//     属性ごとまるごと複製される（行頭から次行の手前までドラッグする等、実際の操作で起こる）。
//     こちらは rowsToSemanticHtml を通し、見出し等の構造を維持する
// (b) 選択の両端がその行のテキストノード内に収まる場合（selectNodeContents 等）、行要素
//     そのものはクローンに現れず、内部の子（チェックボックス行の <input>+<span> など）が
//     そのままトップレベルの子になる。こちらは装飾付きインライン HTML から
//     class・data-*・<input> を落とすだけの経路になる
test.describe("通常コピー: 単一行選択（複数行にまたがらない）でも属性が残らない", () => {
  test("見出しを丸ごと1行選択（行頭がコンテナレベルの境界になる操作）→ <h1> に構造化される", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "# Heading\nnext line" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const mdView = document.getElementById("markdown-view")!;
      const row0 = document.querySelector('#markdown-view [data-line="0"]')!;
      const walker = document.createTreeWalker(row0, NodeFilter.SHOW_TEXT);
      const textNode = walker.nextNode() as Text;
      const range = document.createRange();
      range.setStart(mdView, 0); // 行の直前（mdView 直下の子オフセット）から
      range.setEnd(textNode, textNode.textContent!.length); // 行末まで
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    const { html } = await dispatchCopyWithClipboardData(page);
    expect(html).toBe("<h1>Heading</h1>");

    await ctx.close();
  });

  test("チェックボックス行の全選択（selectNodeContents）→ input と data-* が clipboard に残らない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "- [x] done task" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const el = document.querySelector('#markdown-view [data-line="0"]')!;
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    const { html } = await dispatchCopyWithClipboardData(page);
    expect(html).not.toContain("<input");
    expect(html).not.toMatch(/data-/);
    expect(html).toContain("done task");

    await ctx.close();
  });
});

test.describe("resolveSelectionRange（Markdown をコピーが使う生 Markdown の写像）", () => {
  test("装飾記法の内部に選択境界が落ちても、選択した可視文字に対応する raw 範囲をそのまま取る", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    // raw: "abc **bold** def" / 可視: "abc bold def"
    await injectNoteMock(page, { content: "abc **bold** def" }, {}, {});
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    const markdown = await page.evaluate(() => {
      const el = document.querySelector('#markdown-view [data-line="0"]')!;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodeAt = (offset: number) => {
        let remaining = offset;
        let node: Text | null;
        let last: Text | null = null;
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        while ((node = w.nextNode() as Text | null)) {
          last = node;
          if (remaining <= node.textContent!.length) return { node, offset: remaining };
          remaining -= node.textContent!.length;
        }
        return last ? { node: last, offset: last.textContent!.length } : { node: el, offset: 0 };
      };
      // 可視 "abc bold def" の 5 文字目（"bold" の内部、"b" の直後）〜 11 文字目（" def" の内部、"e" の直後）
      const start = nodeAt(5);
      const end = nodeAt(11);
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      return (window as unknown as { resolveSelectionRange(r: Range): string | null })
        .resolveSelectionRange(range);
    });

    // 開始端は装飾セグメント "**bold**" の中身（"bold"）の内部に落ちるので charMap で厳密対応し、
    // "b" の次の raw 位置から始まる（"**bold" の "**b" は選択していないので含めない）
    expect(markdown).toBe("old** de");

    await ctx.close();
  });

  test("選択が行頭の可視位置から始まると、行頭のマーカー（リスト記号等）を含めて取る", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "- item text" }, {}, {});
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    const markdown = await page.evaluate(() => {
      const el = document.querySelector('#markdown-view [data-line="0"]')!;
      const range = document.createRange();
      range.selectNodeContents(el); // 可視テキスト全体（"item text"）を選択
      return (window as unknown as { resolveSelectionRange(r: Range): string | null })
        .resolveSelectionRange(range);
    });

    expect(markdown).toBe("- item text");

    await ctx.close();
  });

  // 選択終端が次行の先頭（可視オフセット 0 ＝マーカー直後）に落ちると、resolveSelectionBounds が
  // 切り詰める前は次行のマーカーだけを拾ってしまっていた（「行頭から次行の先頭までドラッグ」の
  // 典型操作。text/plain と resolveSelectionBounds を共有するため同じ修正で両方直る）
  test("選択終端が次行の先頭（可視オフセット 0）に落ちても、次行のマーカーが混入しない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "first line\n> quote" }, {}, {});
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    const markdown = await page.evaluate(() => {
      const range = document.createRange();
      const row0 = document.querySelector('#markdown-view [data-line="0"]')!;
      const row1 = document.querySelector('#markdown-view [data-line="1"]')!;
      const w0 = document.createTreeWalker(row0, NodeFilter.SHOW_TEXT);
      const t0 = w0.nextNode() as Text;
      range.setStart(t0, 0);
      // 2 行目の可視オフセット 0（マーカー直後）＝ row1 の先頭（コンテナレベルの境界）
      range.setEnd(row1, 0);
      return (window as unknown as { resolveSelectionRange(r: Range): string | null })
        .resolveSelectionRange(range);
    });

    expect(markdown).toBe("first line\n");
    expect(markdown).not.toContain(">");

    await ctx.close();
  });

  test("コードブロック内で終了端がマーカー相当の文字数と一致しても、選択済みの文字が落ちない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "head\n```\n  - li\n```" }, {}, {});
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    const markdown = await page.evaluate(() => {
      const row0 = document.querySelector('#markdown-view [data-line="0"]')!;
      const codeEl = document.querySelector("#markdown-view pre.md-codeblock code")!;
      const w0 = document.createTreeWalker(row0, NodeFilter.SHOW_TEXT);
      const t0 = w0.nextNode() as Text;
      const wc = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
      const tc = wc.nextNode() as Text;
      const range = document.createRange();
      range.setStart(t0, 0);
      range.setEnd(tc, 4); // "  - li" の "  - "（4 文字）の直後で止める
      return (window as unknown as { resolveSelectionRange(r: Range): string | null })
        .resolveSelectionRange(range);
    });

    expect(markdown).toBe("head\n```\n  - ");

    await ctx.close();
  });

  test("選択終端がブロックの最後の内容行の末尾に一致すると、閉じフェンス行を含めて取る", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "head\n```\ncode line\n```" }, {}, {});
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    const markdown = await page.evaluate(() => {
      const row0 = document.querySelector('#markdown-view [data-line="0"]')!;
      const codeEl = document.querySelector("#markdown-view pre.md-codeblock code")!;
      const w0 = document.createTreeWalker(row0, NodeFilter.SHOW_TEXT);
      const t0 = w0.nextNode() as Text;
      const wc = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
      const tc = wc.nextNode() as Text;
      const range = document.createRange();
      range.setStart(t0, 0);
      range.setEnd(tc, tc.textContent!.length); // "code line" の末尾ちょうど
      return (window as unknown as { resolveSelectionRange(r: Range): string | null })
        .resolveSelectionRange(range);
    });

    expect(markdown).toBe("head\n```\ncode line\n```");

    await ctx.close();
  });

  test("ブロックの可視テキスト全体（内容行のみ）を選択すると、開き・閉じ両方のフェンスを含めて取る", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "```\ncode line\n```" }, {}, {});
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    const markdown = await page.evaluate(() => {
      const codeEl = document.querySelector("#markdown-view pre.md-codeblock code")!;
      const range = document.createRange();
      range.selectNodeContents(codeEl); // 内容行の可視テキスト全体（"code line"）だけを選択
      return (window as unknown as { resolveSelectionRange(r: Range): string | null })
        .resolveSelectionRange(range);
    });

    expect(markdown).toBe("```\ncode line\n```");

    await ctx.close();
  });

  test("複数行あるブロックの内容行 1 行だけを選択（先頭〜末尾）しても、フェンスは付かない", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "```js\nline1\nline2\n```" }, {}, {});
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    const markdown = await page.evaluate(() => {
      const codeEl = document.querySelector("#markdown-view pre.md-codeblock code")!;
      const wc = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
      const tc = wc.nextNode() as Text; // "line1\nline2"
      const range = document.createRange();
      range.setStart(tc, 0);
      range.setEnd(tc, "line1".length); // "line1" の先頭〜末尾だけ（"line2" には触れない）
      return (window as unknown as { resolveSelectionRange(r: Range): string | null })
        .resolveSelectionRange(range);
    });

    expect(markdown).toBe("line1");

    await ctx.close();
  });

  // 可視文字ゼロ行（hr・空フェンス）の退化補正は resolveSelectionBounds に一元化してあるため、
  // text/plain（buildPlainFromSelection）と「Markdown をコピー」（resolveSelectionRange）の
  // どちらも同じ結果になる
  test("--- のみの全選択 → text/plain と同じく空文字にならず --- が返る", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "---" }, {}, {});
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    const markdown = await page.evaluate(() => {
      const mdView = document.getElementById("markdown-view")!;
      const range = document.createRange();
      range.selectNodeContents(mdView);
      return (window as unknown as { resolveSelectionRange(r: Range): string | null })
        .resolveSelectionRange(range);
    });

    expect(markdown).toBe("---");

    await ctx.close();
  });
});

test.describe("右クリックメニューの「Markdown をコピー」", () => {
  test("選択ありで右クリック → hasSelection: true で show_context_menu が呼ばれ、ctx-copy-markdown で退避した生 Markdown が copy_markdown へ渡る", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "**bold** line0\nline1" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await selectMarkdownRange(page, 0, 0, 0, "bold line0".length);

    await page.locator('#markdown-view [data-line="0"]').first().click({ button: "right" });

    await expect.poll(async () => (await capturedCalls(page, "show_context_menu")).length).toBe(1);
    const menuCalls = await capturedCalls(page, "show_context_menu");
    expect((menuCalls[0].args as any).hasSelection).toBe(true);

    // ネイティブメニューの「Markdown をコピー」選択を、appWindow の ctx-copy-markdown リスナー
    // を直接発火させることで模す（Playwright にはネイティブメニューが無いため）
    await page.evaluate(() => {
      const listeners = (window as any).__appWindowListeners["ctx-copy-markdown"] || [];
      listeners.forEach((fn: () => void) => fn());
    });

    await expect.poll(async () => (await capturedCalls(page, "copy_markdown")).length).toBe(1);
    const copyCalls = await capturedCalls(page, "copy_markdown");
    expect((copyCalls[0].args as any).text).toBe("**bold** line0");

    await ctx.close();
  });

  test("選択なしで右クリック → hasSelection: false", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "line0" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.locator('#markdown-view [data-line="0"]').first().click({ button: "right" });

    await expect.poll(async () => (await capturedCalls(page, "show_context_menu")).length).toBe(1);
    const menuCalls = await capturedCalls(page, "show_context_menu");
    expect((menuCalls[0].args as any).hasSelection).toBe(false);

    await ctx.close();
  });

  // 空行だけを選択すると resolveSelectionRange は raw の内容どおり空文字を返す（これ自体は
  // 正しい）。空文字のまま hasSelection: true にすると、copy_markdown へ空文字が渡り
  // クリップボードが空になってしまうため、空文字なら選択なし扱いにする
  test("空行だけを選択して右クリック → resolveSelectionRange が空文字を返すため hasSelection: false", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "line0\n\nline2" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const row1 = document.querySelector('#markdown-view [data-line="1"]')!; // 2 行目（空行）
      const range = document.createRange();
      range.selectNodeContents(row1);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    // 空行は見た目の高さが低く actionability チェックに引っかかりうるため force で直接発火する
    await page.locator('#markdown-view [data-line="1"]').click({ button: "right", force: true });

    await expect.poll(async () => (await capturedCalls(page, "show_context_menu")).length).toBe(1);
    const menuCalls = await capturedCalls(page, "show_context_menu");
    expect((menuCalls[0].args as any).hasSelection).toBe(false);

    await ctx.close();
  });

  // 未クローズのコードフェンス（EOF まで ``` が閉じない）は data-line-end が「閉じフェンス行」
  // ではなく「最後の内容行自身」を指すため、選択範囲の写像が特殊なケースになる。
  test("内容行が無い未クローズフェンス（```だけ）を選択して右クリックしても例外にならずメニューが開く", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    await injectNoteMock(page, { content: "```" }, {}, { captureInvokes: true });
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    // markdown-view 全体（＝空の内容を持つ未クローズフェンスの pre 1 個）を選択する。
    // この選択で resolveSelectionRange が例外を投げると、e.preventDefault() 済みのまま
    // show_context_menu に到達できずメニューが一切開かなくなる
    await page.evaluate(() => {
      const el = document.getElementById("markdown-view")!;
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.locator("#markdown-view").click({ button: "right" });

    await expect.poll(async () => (await capturedCalls(page, "show_context_menu")).length).toBe(1);

    await ctx.close();
  });
});

test.describe("未クローズのコードフェンス内の選択（resolveSelectionRange の行写像）", () => {
  test("閉じフェンスが無くても最後の内容行末まで正しく写像される（末尾行が欠落しない）", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 350 } });
    const page = await ctx.newPage();
    // 閉じフェンス無し（EOF まで ``` のまま）。内容行は "foo" "bar" の 2 行
    await injectNoteMock(page, { content: "```\nfoo\nbar" }, {}, {});
    await page.goto("/note.html?id=test-note-id");
    await page.waitForLoadState("networkidle");

    const markdown = await page.evaluate(() => {
      const codeEl = document.querySelector("#markdown-view pre.md-codeblock code")!;
      const range = document.createRange();
      range.selectNodeContents(codeEl); // フェンス内側の可視テキスト全体（"foo\nbar"）を選択
      return (window as unknown as { resolveSelectionRange(r: Range): string | null })
        .resolveSelectionRange(range);
    });

    // 末尾行（"bar"）が行写像のループ範囲から外れて欠落しないことを確認する
    expect(markdown).toBe("foo\nbar");

    await ctx.close();
  });
});
