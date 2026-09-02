import { test, expect, placeCaret, getContent, waitForReveal, selectMarkdownRange } from "./fixtures";

// renderAll() はブロック単位の DOM パッチ（patchMarkdownView）を経由する。前回描画の
// mdView.children と新しい HTML のブロック列を、data-line[-end] の値を無視した内容キーで
// 先頭・末尾から一致比較し、変化した区間だけ入れ替える。無変化のブロックは data-line[-end] の
// 振り直しだけで DOM ノードを再利用する（img の作り直し・キャレット/選択破壊の回避が目的）。
//
// ノードが「同一インスタンスのまま」であることは、DOM 属性ではなく JS プロパティ（__probe）で
// 検証する。置換（remove + 新規挿入）されたノードはこのプロパティを引き継がない。

/** mdView 直下の各ブロック（[data-line]）に __probe プロパティを立てる。 */
async function markBlocks(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    document.querySelectorAll("#markdown-view > [data-line]").forEach((el) => {
      (el as unknown as { __probe: boolean }).__probe = true;
    });
  });
}

/** ブロックごとの { line, text, marked }（__probe が残っているか）を、DOM の並び順で返す。 */
function readBlocks(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("#markdown-view > [data-line]")).map((el) => ({
      line: el.getAttribute("data-line"),
      text: el.textContent,
      marked: (el as unknown as { __probe?: boolean }).__probe === true,
    })));
}

/** mdView 内の全 [data-line]（子孫含む）が、それを含む mdView 直下のブロックと同じ data-line を
 * 持つか。syncLineAttrs がブロック直下だけでなく子孫の data-line（チェックボックスの input 等）も
 * 正しく振り直せているかの不変条件チェック。 */
function lineAttrsConsistent(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("#markdown-view [data-line]")).every((el) => {
      const block = el.closest("#markdown-view > [data-line]");
      return block === el || block?.getAttribute("data-line") === el.getAttribute("data-line");
    }));
}

test.describe("ブロック単位 DOM パッチ", () => {
  test("タイピングで無関係な行の DOM ノードは同一インスタンスのまま残る", async ({ openNote }) => {
    const page = await openNote({ content: "line0\nline1\nline2" });
    await markBlocks(page);

    await placeCaret(page, 1, 4); // "line" | "1"
    await page.keyboard.type("X");
    expect(await getContent(page)).toBe("line0\nlineX1\nline2");

    const blocks = await readBlocks(page);
    expect(blocks.find((b) => b.line === "0")).toMatchObject({ text: "line0", marked: true });
    expect(blocks.find((b) => b.line === "2")).toMatchObject({ text: "line2", marked: true });
    // 編集した行自身は内容が変わるため新しいノードに置き換わる（__probe を引き継がない）
    expect(blocks.find((b) => b.text === "lineX1")?.marked).toBe(false);
  });

  test("画像行は無関係な行の編集で作り直されない", async ({ openNote }) => {
    const imagePath = "images/00000000-0000-4000-8000-000000000001.png";
    const page = await openNote({ content: `text0\n![](${imagePath})\ntext2` });
    await page.evaluate(() => {
      (document.querySelector("img") as unknown as { __probe: boolean }).__probe = true;
    });

    await placeCaret(page, 2, 5); // "text2" の行末
    await page.keyboard.type("X");
    expect(await getContent(page)).toBe(`text0\n![](${imagePath})\ntext2X`);

    const imgUnchanged = await page.evaluate(() =>
      (document.querySelector("img") as unknown as { __probe?: boolean } | null)?.__probe === true);
    expect(imgUnchanged).toBe(true);
  });

  test("行の挿入で後続行の DOM ノードは再利用され data-line だけ振り直される", async ({ openNote }) => {
    const page = await openNote({ content: "a\nb\nc" });
    await markBlocks(page);

    await placeCaret(page, 0, 1); // "a" の行末
    await page.keyboard.press("Enter");
    expect(await getContent(page)).toBe("a\n\nb\nc");

    const blocks = await readBlocks(page);
    // b・c は内容不変のまま位置だけ 1 行ずつ後ろへずれる。ノードは再利用され data-line だけ振り直る
    expect(blocks.find((b) => b.text === "b")).toMatchObject({ line: "2", marked: true });
    expect(blocks.find((b) => b.text === "c")).toMatchObject({ line: "3", marked: true });
  });

  test("行の削除で後続行の DOM ノードは再利用され data-line だけ振り直される", async ({ openNote }) => {
    const page = await openNote({ content: "a\n\nb\nc" });
    await markBlocks(page);

    await placeCaret(page, 1, 0); // 空行の行頭
    await page.keyboard.press("Backspace"); // 空行を削除して "a\nb\nc" になる
    expect(await getContent(page)).toBe("a\nb\nc");

    const blocks = await readBlocks(page);
    expect(blocks.find((b) => b.text === "b")).toMatchObject({ line: "1", marked: true });
    expect(blocks.find((b) => b.text === "c")).toMatchObject({ line: "2", marked: true });
  });

  test("インライン生表示の切替は対象行だけ差し替わり、他の行は同一ノードのまま残る", async ({ openNote }) => {
    const page = await openNote({ content: "other0\npre **bold** post\nother2" });
    await markBlocks(page);

    await placeCaret(page, 1, 8); // "pre **bo|ld** post"（装飾内部）
    await waitForReveal(page, { line: 1, start: 4, end: 12 });

    const revealed = await readBlocks(page);
    expect(revealed.find((b) => b.line === "0")).toMatchObject({ text: "other0", marked: true });
    expect(revealed.find((b) => b.line === "2")).toMatchObject({ text: "other2", marked: true });
    expect(await page.locator("#markdown-view .md-reveal").textContent()).toBe("**bold**");

    await placeCaret(page, 0, 0); // 装飾の外へ離れる → reveal 解除でその行だけ再び差し替わる
    await waitForReveal(page, null);

    const cleared = await readBlocks(page);
    expect(cleared.find((b) => b.line === "0")).toMatchObject({ text: "other0", marked: true });
    expect(cleared.find((b) => b.line === "2")).toMatchObject({ text: "other2", marked: true });
    expect(await page.locator("#markdown-view strong").textContent()).toBe("bold");
  });
});

// 内容キー（blockContentKey）は data-line[-end] の値を無視して比較するため、ブロックが
// 「無変化」と判定されて DOM ノードを再利用しても、そのブロック直下だけでなく子孫が独自に
// data-line を持つ場合（チェックボックスの input。change ハンドラが e.target.dataset.line を
// 直接読む）は、振り直しもルートだけでなく子孫まで揃えないと古い行番号が残る。
test.describe("再利用ブロックの子孫 data-line の振り直し", () => {
  test("空行削除で再利用されたチェックボックスの input data-line も振り直り、クリックが正しい行を切り替える", async ({ openNote }) => {
    const page = await openNote({ content: "\n- [ ] task" });
    const pageErrors: Error[] = [];
    page.on("pageerror", (e) => pageErrors.push(e));

    // 0 行目（空行）の先頭から 1 行目（チェックボックス行）の可視先頭（マーカー直後）まで選択して
    // Backspace。単純に 1 行目の行頭で Backspace すると、まず自身のマーカーを剥がす段階解除が
    // 先に効いてチェックボックスごと消えてしまう（backspaceAtLineStart）ため、行をまたぐ選択削除
    // （spliceSelectionRange）でチェックボックスを残したまま空行だけを取り除く
    await selectMarkdownRange(page, 0, 0, 1, 0);
    await page.keyboard.press("Backspace");
    expect(await getContent(page)).toBe("- [ ] task");
    expect(await lineAttrsConsistent(page)).toBe(true);

    await page.locator('input[type="checkbox"]').click();

    expect(pageErrors).toEqual([]);
    expect(await getContent(page)).toBe("- [x] task");
  });

  test("行末 Enter で行番号がずれても再利用されたチェックボックスの input data-line が振り直り、クリックが正しい行を切り替える", async ({ openNote }) => {
    const page = await openNote({ content: "hello\n- [ ] task" });

    await placeCaret(page, 0, 5); // "hello" の行末
    await page.keyboard.press("Enter");
    expect(await getContent(page)).toBe("hello\n\n- [ ] task");
    expect(await lineAttrsConsistent(page)).toBe(true);

    await page.locator('input[type="checkbox"]').click();
    expect(await getContent(page)).toBe("hello\n\n- [x] task");
  });
});

test.describe("パッチの自己修復性・選択中ブロックの再利用", () => {
  test("mdView 直下に紛れ込んだテキストノードは次の renderAll で除去される", async ({ openNote }) => {
    const page = await openNote({ content: "line0\nline1" });

    await page.evaluate(() => {
      document.getElementById("markdown-view")!.appendChild(document.createTextNode("stray"));
    });
    const strayBefore = await page.evaluate(() =>
      Array.from(document.getElementById("markdown-view")!.childNodes)
        .some((n) => n.nodeType !== Node.ELEMENT_NODE));
    expect(strayBefore).toBe(true);

    await placeCaret(page, 1, 5); // "line1" の行末
    await page.keyboard.type("X");
    expect(await getContent(page)).toBe("line0\nline1X");

    const strayAfter = await page.evaluate(() =>
      Array.from(document.getElementById("markdown-view")!.childNodes)
        .some((n) => n.nodeType !== Node.ELEMENT_NODE));
    expect(strayAfter).toBe(false);
  });

  test("選択中の画像ブロックは無関係な行への画像ドロップでも同一ノードのまま残り選択も維持される", async ({ openNote }) => {
    const imagePath = "images/00000000-0000-4000-8000-000000000001.png";
    const page = await openNote({ content: `![](${imagePath})\ntext1` });

    // asset:// URL はテスト環境で解決できず img はレイアウトサイズ 0 になるため、
    // Playwright の click() ではなく mouseup を直接発火する。
    // 別行への caret 移動（placeCaret 等）は clearImageSelection を経由して選択自体を解いてしまう
    // （画像選択とキャレットは排他な状態のため、これは仕様どおり）ため、選択を維持したまま
    // renderAll() を起こす編集として、キャレットを動かさない画像ドロップ（pasteImage）を使う
    await page.evaluate(() => {
      const img = document.querySelector("img")!;
      img.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      (img as unknown as { __probe: boolean }).__probe = true;
    });
    await expect(page.locator(".img-selected")).toHaveCount(1);

    await page.evaluate(() => {
      const target = document.querySelector('[data-line="1"]')!;
      const file = new File([new Uint8Array([137, 80, 78, 71])], "dropped.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect.poll(() => getContent(page)).toBe(`![](${imagePath})\ntext1![](${imagePath})`);

    const state = await page.evaluate(() => {
      const img = document.querySelector("img") as (HTMLImageElement & { __probe?: boolean }) | null;
      return { unchanged: img?.__probe === true, selected: img?.classList.contains("img-selected") ?? false };
    });
    expect(state.unchanged).toBe(true);
    expect(state.selected).toBe(true);
  });
});
