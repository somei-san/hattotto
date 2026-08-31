import { test, expect, placeCaret, getContent, selectMarkdownRange } from "./fixtures";

// IME は compositionstart でキャレット/選択位置を退避し、compositionend で e.data を
// その位置へ splice して再描画する（WebKit がネイティブに書き込んだ DOM は巻き戻し扱いで
// 捨てる。取消（data 空）は再描画のみで退避位置へキャレットを戻す）。確定 Enter の直後に
// 届く重複 beforeinput（insertText/insertParagraph）は 1 マイクロタスクぶん無視する。
//
// 合成 CompositionEvent は実 IME と完全には一致しない。WebKit が composition 中に DOM へ
// 直接書き込む挙動は、composing 中の beforeinput を経由させず Range.insertNode で直接テキスト
// ノードを差し込むことで模擬する（execCommand は beforeinput/input を発火させてしまい、実際の
// ネイティブ書き込み経路と異なるため使わない）。この模擬で確認できるのは「composition 中の DOM
// 書き込みは compositionend の再描画で丸ごと作り直され rawContent に影響しない」ことまでで、
// 実機 WKWebView 固有のタイミング（compositionend 前後の描画・ペイントの競合）はこのスイートの
// 対象外（このファイル末尾のコメント参照）。

async function compositionStart(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    document.getElementById("markdown-view")!
      .dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
}

async function compositionEnd(page: import("@playwright/test").Page, data: string) {
  await page.evaluate((d) => {
    document.getElementById("markdown-view")!
      .dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: d }));
  }, data);
}

/** compositionstart から compositionend(data) までを一息に行う（介入経路の検証など、
 * composition 中の状態を挟まない単純なケース向け）。 */
async function dispatchComposition(page: import("@playwright/test").Page, data: string) {
  await compositionStart(page);
  await compositionEnd(page, data);
}

/** 現在のキャレット位置へ text を直接テキストノードとして書き込み、キャレットをその直後へ
 * 移す。WebKit が composition 中にネイティブへ書き込む DOM を模擬する（beforeinput を経由しない）。 */
async function insertNativeCompositionText(page: import("@playwright/test").Page, text: string) {
  await page.evaluate((t) => {
    const sel = window.getSelection()!;
    const range = sel.getRangeAt(0);
    const node = document.createTextNode(t);
    range.insertNode(node);
    range.setStartAfter(node);
    range.setEndAfter(node);
    sel.removeAllRanges();
    sel.addRange(range);
  }, text);
}

/** insertNativeCompositionText が置いたテキストノードの末尾 1 文字を取り除く。WebKit が
 * composition 中の Backspace で自身の書き込みを縮める様子を模擬する。 */
async function removeLastNativeChar(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const sel = window.getSelection()!;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent ?? "";
    node.textContent = text.slice(0, -1);
    const offset = node.textContent.length;
    const r = document.createRange();
    r.setStart(node, offset);
    r.setEnd(node, offset);
    sel.removeAllRanges();
    sel.addRange(r);
  });
}

/** composing 中に Backspace の keydown を送る（実際の文字削除はブラウザの既定処理に頼らず
 * insertNativeCompositionText/removeLastNativeChar で模擬するため、ここでは「note.js の
 * keydown フォールバックが誤発動して e.preventDefault() しないこと」だけを確認する）。 */
async function dispatchComposingBackspaceKeydown(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const view = document.getElementById("markdown-view")!;
    const e = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    view.dispatchEvent(e);
    return e.defaultPrevented;
  });
}

/** 現在のキャレットが属する行番号（data-line）。コードブロック内は開始行が返る。無ければ -1。 */
function caretLine(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const node = window.getSelection()?.anchorNode ?? null;
    const el = node instanceof Element ? node : node?.parentElement;
    const line = el?.closest("[data-line]")?.getAttribute("data-line");
    return line == null ? -1 : Number(line);
  });
}

/** 現在のキャレット位置の raw 列（行頭マーカーぶんを加算した位置）。装飾（**bold** 等）を
 * 含まない行でのみ raw と一致する。 */
function caretRawColumn(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return -1;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const lineEl = el?.closest("[data-line]");
    if (!lineEl) return -1;
    const pre = document.createRange();
    pre.selectNodeContents(lineEl);
    pre.setEnd(range.startContainer, range.startOffset);
    const visible = pre.toString().length;
    const lineIdx = Number(lineEl.getAttribute("data-line"));
    const raw = ((window as unknown as { getRawContent(): string }).getRawContent().split("\n"))[lineIdx];
    const m = raw.match(/^(#{1,3} |[-*] \[[ xX]\] |[-*] |> |\d+\. )/);
    return (m ? m[0].length : 0) + visible;
  });
}

/** 現在のキャレットがコードブロック（<pre data-line-end>）の内側にあるか。 */
function caretInsideCodeBlock(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const node = window.getSelection()?.anchorNode ?? null;
    const el = node instanceof Element ? node : node?.parentElement;
    return !!el?.closest("pre[data-line-end]");
  });
}

test.describe("IME 変換の確定・取消", () => {
  test("compositionend で確定文字列がキャレット位置へ挿入され、キャレットが直後に立つ", async ({ openNote }) => {
    const page = await openNote({ content: "" });
    await placeCaret(page, 0, 0);

    await dispatchComposition(page, "あいう");

    expect(await getContent(page)).toBe("あいう");
    expect(await caretLine(page)).toBe(0);
    expect(await caretRawColumn(page)).toBe(3);
  });

  test("行の途中に確定文字列が挿入される", async ({ openNote }) => {
    const page = await openNote({ content: "abc" });
    await placeCaret(page, 0, 1);

    await dispatchComposition(page, "X");

    expect(await getContent(page)).toBe("aXbc");
  });

  test("確定後は performUndo で 1 手戻る", async ({ openNote }) => {
    const page = await openNote({ content: "ab" });
    await placeCaret(page, 0, 1);

    await dispatchComposition(page, "X");
    expect(await getContent(page)).toBe("aXb");

    await page.evaluate(() => (window as unknown as { performUndo(): Promise<void> }).performUndo());
    expect(await getContent(page)).toBe("ab");
  });

  test("data が空（変換取消）→ 内容・キャレット位置とも変わらない", async ({ openNote }) => {
    const page = await openNote({ content: "abc" });
    await placeCaret(page, 0, 1);

    await dispatchComposition(page, "");

    expect(await getContent(page)).toBe("abc");
    expect(await caretLine(page)).toBe(0);
    expect(await caretRawColumn(page)).toBe(1);
  });

  test("選択（非 collapsed）から始めた変換の確定は選択範囲を置き換える", async ({ openNote }) => {
    const page = await openNote({ content: "abcd" });
    await selectMarkdownRange(page, 0, 1, 0, 3); // "bc" を選択

    await dispatchComposition(page, "XY");

    expect(await getContent(page)).toBe("aXYd");
  });
});

test.describe("composing 中は編集ハンドラが介入しない", () => {
  test("beforeinput の insertText に介入しない（preventDefault しない）", async ({ openNote }) => {
    const page = await openNote({ content: "" });
    await placeCaret(page, 0, 0);

    const notCanceled = await page.evaluate(() => {
      const view = document.getElementById("markdown-view")!;
      view.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const e = new InputEvent("beforeinput", {
        inputType: "insertText", data: "a", cancelable: true, bubbles: true,
      });
      return view.dispatchEvent(e);
    });

    expect(notCanceled).toBe(true);
    // beforeinput に介入していない（splice もしていない）ので rawContent は変わらない
    expect(await getContent(page)).toBe("");
  });

  test("keydown の Backspace フォールバック（編集領域絶対先頭）にも介入しない", async ({ openNote }) => {
    const page = await openNote({ content: "# abc" });
    await placeCaret(page, 0, 2); // 見出しマーカー直後 = 編集領域の絶対先頭

    await compositionStart(page);
    const prevented = await dispatchComposingBackspaceKeydown(page);
    expect(prevented).toBe(false);
    // フォールバックが発動していれば見出しマーカーが消えるが、composing 中は不介入のため残る
    expect(await getContent(page)).toBe("# abc");

    await compositionEnd(page, ""); // 後片付け（取消として閉じる）
  });
});

test.describe("composition 中のネイティブ DOM 書き込みは巻き戻される", () => {
  test("WebKit が composition 中に書いた DOM は compositionend の再描画で捨てられる", async ({ openNote }) => {
    const page = await openNote({ content: "ab" });
    await placeCaret(page, 0, 1);

    await compositionStart(page);
    // WebKit が変換候補を DOM へ直接書き込む状態を模擬する（rawContent には無関係）
    await insertNativeCompositionText(page, "あいう");
    await compositionEnd(page, "X"); // 確定文字列は模擬した書き込みとあえて別にする

    // 確定文字列（"X"）だけが退避位置へ反映され、模擬した中間表示（"あいう"）は残らない
    expect(await getContent(page)).toBe("aXb");
  });
});

test.describe("変換中の Backspace", () => {
  test("平文: composition 継続のまま文字が減って確定 → 最終 data だけが反映される", async ({ openNote }) => {
    const page = await openNote({ content: "abcd" });
    await placeCaret(page, 0, 2);

    await compositionStart(page);
    await insertNativeCompositionText(page, "XY");
    const prevented = await dispatchComposingBackspaceKeydown(page);
    expect(prevented).toBe(false); // composing 中は note.js 側が介入しない
    await removeLastNativeChar(page); // WebKit 自身が "Y" を消した結果を模擬（"X" が残る）
    await compositionEnd(page, "X");

    expect(await getContent(page)).toBe("abXcd");
  });

  test("コードブロック内: composition 継続のまま文字が減って確定 → 内容もキャレットもブロック内に収まる", async ({ openNote }) => {
    const page = await openNote({ content: "```\nhello\n```" });
    await placeCaret(page, 1, 2); // "he|llo"

    await compositionStart(page);
    await insertNativeCompositionText(page, "んg");
    await removeLastNativeChar(page); // "ん" だけが残る
    await compositionEnd(page, "ん");

    // applyLines の ensureTrailingLineAfterClosedFence が、閉じフェンスが最終行のままだと
    // 入力先を確保するため空行を 1 行足す（splice を経由する編集全般に共通する挙動）
    expect(await getContent(page)).toBe("```\nheんllo\n```\n");
    expect(await caretInsideCodeBlock(page)).toBe(true);
  });

  test("コードブロック内: composition 継続のまま文字が減って変換取消 → 内容不変・キャレットがブロック外へ飛び出さない", async ({ openNote }) => {
    // 報告されていた不具合（コードブロック内で変換中に Backspace → キャレットがブロック外へ
    // 飛び出す）の回帰テスト。取消（data 空）で再描画のみのパスは compositionend の退避位置への
    // キャレット復元が無いとブロック外（編集領域の先頭）へ着地してしまう
    const page = await openNote({ content: "```\nhello\n```" });
    await placeCaret(page, 1, 2); // "he|llo"

    await compositionStart(page);
    await insertNativeCompositionText(page, "ん");
    await removeLastNativeChar(page); // 全て消え、composition が自動取消される想定
    await compositionEnd(page, "");

    expect(await getContent(page)).toBe("```\nhello\n```");
    expect(await caretInsideCodeBlock(page)).toBe(true);
  });
});

test.describe("確定 Enter の二重処理ガード", () => {
  test("compositionend 直後・同一マイクロタスク窓内の insertParagraph は無視される", async ({ openNote }) => {
    const page = await openNote({ content: "ab" });
    await placeCaret(page, 0, 1);

    // WebKit の確定 Enter が compositionend の直後にもう一度送ってくる beforeinput を模擬する。
    // suppressPostCompositionInput の窓内で届くよう、同じ page.evaluate（同一タスク）内で送る
    await page.evaluate(() => {
      const view = document.getElementById("markdown-view")!;
      view.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      view.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "X" }));
      view.dispatchEvent(new InputEvent("beforeinput", {
        inputType: "insertParagraph", cancelable: true, bubbles: true,
      }));
    });

    // 改行が入らず、確定文字列だけが反映されている
    expect(await getContent(page)).toBe("aXb");
  });

  test("compositionend 直後・同一マイクロタスク窓内の insertText は無視される", async ({ openNote }) => {
    const page = await openNote({ content: "ab" });
    await placeCaret(page, 0, 1);

    await page.evaluate(() => {
      const view = document.getElementById("markdown-view")!;
      view.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      view.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "X" }));
      view.dispatchEvent(new InputEvent("beforeinput", {
        inputType: "insertText", data: "X", cancelable: true, bubbles: true,
      }));
    });

    expect(await getContent(page)).toBe("aXb"); // "aXXb" になっていれば二重挿入
  });

  test("マイクロタスクを跨いだ次の入力はガードされない", async ({ openNote }) => {
    const page = await openNote({ content: "ab" });
    await placeCaret(page, 0, 1);

    await dispatchComposition(page, "X");
    expect(await getContent(page)).toBe("aXb");

    // 別の page.evaluate 呼び出し（別タスク）なので suppressPostCompositionInput は既に解除済み
    const notCanceled = await page.evaluate(() => {
      const view = document.getElementById("markdown-view")!;
      const e = new InputEvent("beforeinput", {
        inputType: "insertText", data: "Y", cancelable: true, bubbles: true,
      });
      return view.dispatchEvent(e);
    });

    expect(notCanceled).toBe(false); // 通常どおり preventDefault されて splice される
    expect(await getContent(page)).toBe("aXYb");
  });
});

test.describe("装飾・行頭マーカー・コードブロック内での確定", () => {
  test("太字装飾の内部で確定する", async ({ openNote }) => {
    const page = await openNote({ content: "**abc**" });
    await placeCaret(page, 0, 4); // "**ab" | "c**"

    await dispatchComposition(page, "X");

    expect(await getContent(page)).toBe("**abXc**");
  });

  test("行頭マーカー（リスト）付きの行で確定する", async ({ openNote }) => {
    const page = await openNote({ content: "- abc" });
    await placeCaret(page, 0, 4); // "- ab" | "c"

    await dispatchComposition(page, "X");

    expect(await getContent(page)).toBe("- abXc");
  });

  test("コードブロック内で確定する", async ({ openNote }) => {
    const page = await openNote({ content: "```\nhello\n```" });
    await placeCaret(page, 1, 2); // "he|llo"

    await dispatchComposition(page, "X");

    // 末尾の空行は ensureTrailingLineAfterClosedFence によるもの（前のテストと同じ）
    expect(await getContent(page)).toBe("```\nheXllo\n```\n");
    expect(await caretInsideCodeBlock(page)).toBe(true);
  });
});

// ── 実機でしか確認できない残り ──────────────────────
// 合成 CompositionEvent は WKWebView 実機の以下の挙動までは再現できない:
// - compositionend 前後の実際の描画・ペイントのタイミング（「確定直後に入力済みテキストが
//   一瞬消えて見える」系の見た目の遷移）
// - IME の実装依存な beforeinput/compositionend の発火順そのもの（確定 Enter の二重発火が
//   本当に同一マイクロタスク窓に収まるか）
// - Esc キーでの変換取消時に WebKit が実際にどう compositionend を発火させるか（data 空での
//   取消として扱う前提が実機と一致するか）
// これらは実機での目視・ログ確認が必要（note.js の dbg/dbgNode を参照）。
