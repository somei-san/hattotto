import {
  test, expect, placeCaret, getContent, selectMarkdownRange, waitForReveal, getRevealState, getCaretPosition,
  extendSelectionTo,
} from "./fixtures";

// インライン生表示（reveal）。キャレット（collapsed）が装飾（太字/斜字/取り消し線/インラインコード/
// リンク）の中・境界にあるあいだ、その要素だけ生マーカー付きで表示する（Typora 方式）。表示だけの
// 状態で rawContent・undo・保存には影響しない。selectionchange 駆動で、キャレット位置から毎回
// reveal 対象を再計算する（src/note.js の computeRevealTarget/revealState 参照）。
//
// マーカーの内側（例: "**bold**" の 2 つの "*" の間）は、装飾が reveal されて初めて可視 = raw が
// 1:1 になり到達できる DOM 位置になる（reveal 前は "**" の 2 文字とも同じ可視位置に潰れており、
// window.placeCaretAtRaw で直接そこへテレポートすることはできない）。そのため、そうした位置は
// reveal 済みの到達可能な境界（可視先頭・可視末尾）から矢印キーで 1 歩ずつ動いて到達する
// （実際のユーザー操作と同じ経路）。矢印キー1回ごとに selectionchange の再描画が決着するまで
// 少し待つ（stepRight/stepLeft）。reveal の切替はキー入力ごとのフル再描画なので、待たずに
// 連打すると再描画の途中に次のキーが割り込み得る（Playwright の高速な合成入力ならではの
// 現象で、本テストの検証対象ではない）。

/** ArrowRight/ArrowLeft を押し、selectionchange 駆動の再描画・reveal 再判定が決着するまで待つ。 */
async function stepRight(page: import("@playwright/test").Page) {
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(50);
}
async function stepLeft(page: import("@playwright/test").Page) {
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(50);
}

test.describe("キャレットが装飾の中・境界にあるとマーカーが見える", () => {
  test("装飾の内部にキャレットがあると生マーカーが見え、離れると隠れる", async ({ openNote }) => {
    const page = await openNote({ content: "pre **bold** post" });

    await placeCaret(page, 0, 8); // "pre **bo|ld** post"
    await waitForReveal(page, { line: 0, start: 4, end: 12 });
    expect(await page.locator("#markdown-view .md-reveal").textContent()).toBe("**bold**");
    expect(await page.locator("#markdown-view strong").count()).toBe(0);

    await placeCaret(page, 0, 0); // 装飾の外（行頭）
    await waitForReveal(page, null);
    expect(await page.locator("#markdown-view .md-reveal").count()).toBe(0);
    expect(await page.locator("#markdown-view strong").textContent()).toBe("bold");
  });

  test("斜字・取り消し線・インラインコード・リンクも同様に反応する", async ({ openNote }) => {
    const page = await openNote({ content: "*it* ~~de~~ `co` [la](https://e.com)" });

    await placeCaret(page, 0, 2); // "*i|t*" の内部
    await waitForReveal(page, { line: 0, start: 0, end: 4 });
    expect(await page.locator("#markdown-view .md-reveal").textContent()).toBe("*it*");

    await placeCaret(page, 0, 7); // "~~|de~~" の内部
    await waitForReveal(page, { line: 0, start: 5, end: 11 });
    expect(await page.locator("#markdown-view .md-reveal").textContent()).toBe("~~de~~");

    await placeCaret(page, 0, 14); // "\`c|o\`" の内部
    await waitForReveal(page, { line: 0, start: 12, end: 16 });
    expect(await page.locator("#markdown-view .md-reveal").textContent()).toBe("`co`");

    await placeCaret(page, 0, 20); // "[la|](https://e.com)" の内部
    await waitForReveal(page, { line: 0, start: 17, end: 36 });
    expect(await page.locator("#markdown-view .md-reveal").textContent()).toBe("[la](https://e.com)");
  });

  test("見出し・リストのブロックマーカー自体は reveal の対象外", async ({ openNote }) => {
    const page = await openNote({ content: "# heading" });
    await placeCaret(page, 0, 0); // マーカー "# " の直後（行頭）
    await waitForReveal(page, null);
  });

  test("画像・裸URLは reveal しない", async ({ openNote }) => {
    const page1 = await openNote({ content: "![alt](images/00000000-0000-4000-8000-000000000001.png)" });
    await placeCaret(page1, 0, 3); // 画像記法の内部相当（画像自体はキャレットを持たない選択状態）
    await waitForReveal(page1, null);

    const page2 = await openNote({ content: "see https://example.com here" });
    await placeCaret(page2, 0, 10); // 裸URLの内部
    await waitForReveal(page2, null);
  });
});

test.describe("reveal 中の編集は raw に正しく反映される", () => {
  test("reveal 中の任意位置への挿入が raw にそのまま入る（開きマーカーの内側も含む）", async ({ openNote }) => {
    const page = await openNote({ content: "**bold**" });
    await placeCaret(page, 0, 0); // 可視先頭（reveal 前から到達できる境界）
    await waitForReveal(page, { line: 0, start: 0, end: 8 });
    await stepRight(page); // reveal 済みの raw 1:1 表示を 1 歩進み、開きマーカーの内側（"*" と "*" の間）へ
    expect(await getCaretPosition(page)).toEqual({ line: 0, col: 1 });

    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("*X*bold**");
  });

  test("マーカー文字を直接削除すると装飾が解除される（自然に平文へフォールバック）", async ({ openNote }) => {
    const page = await openNote({ content: "`code`" });
    await placeCaret(page, 0, 0); // 可視先頭
    await waitForReveal(page, { line: 0, start: 0, end: 6 });
    await stepRight(page); // 開く backtick の直後へ
    expect(await getCaretPosition(page)).toEqual({ line: 0, col: 1 });

    await page.keyboard.press("Backspace"); // 開く backtick を消す → 対応する閉じ backtick が無くなる
    expect(await getContent(page)).toBe("code`");
    await waitForReveal(page, null); // 装飾として成立しなくなり reveal も解除される
    expect(await page.locator("#markdown-view code").count()).toBe(0);
  });

  test("末尾マーカーの内側への入力は閉じマーカーの中に割り込む", async ({ openNote }) => {
    const page = await openNote({ content: "**bold** x" });
    await placeCaret(page, 0, 8); // 可視末尾（閉じマーカーの直後、reveal 前から到達できる境界）
    await waitForReveal(page, { line: 0, start: 0, end: 8 });
    await stepLeft(page); // 閉じマーカー "**" の内側（1文字目と2文字目の間）へ 1 歩戻る
    expect(await getCaretPosition(page)).toEqual({ line: 0, col: 7 });

    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("**bold*X* x");
  });

  test("末尾マーカーの外側への入力は装飾の外（後続のプレーン部分）に入る", async ({ openNote }) => {
    const page = await openNote({ content: "**bold** x" });
    await placeCaret(page, 0, 8); // 閉じマーカーの直後（可視末尾の境界）
    await waitForReveal(page, { line: 0, start: 0, end: 8 });
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("**bold**X x");
  });

  test("リンクの URL 部分を直接編集できる", async ({ openNote }) => {
    const page = await openNote({ content: "[label](https://example.com)" });
    await placeCaret(page, 0, 28); // 可視末尾（reveal 前から到達できる境界）
    await waitForReveal(page, { line: 0, start: 0, end: 28 });
    for (let i = 0; i < 12; i++) await stepLeft(page); // "https://" の直後（"example.com)" の手前）まで戻る
    expect(await getCaretPosition(page)).toEqual({ line: 0, col: 16 });

    // 1 文字打つたびに reveal 範囲（リンクの raw 範囲）が伸びる。applyLines が再描画前に
    // reveal 対象を同期的に確定させるため、間を空けずに連続入力しても崩れない
    await page.keyboard.type("www.", { delay: 10 });
    expect(await getContent(page)).toBe("[label](https://www.example.com)");

    // 生 raw で見えている表示にも反映される
    expect(await page.locator("#markdown-view .md-reveal").textContent()).toBe("[label](https://www.example.com)");
  });
});

test.describe("矢印キーでの通過はキャレットを 1 raw 文字ずつ動かす（飛ばない）", () => {
  test("装飾の手前から末尾まで ArrowRight で raw 位置が 1 ずつ単調に増える", async ({ openNote }) => {
    const page = await openNote({ content: "ab**cd**ef" }); // 装飾外[0,2) 装飾[2,8) 装飾外[8,10)
    await placeCaret(page, 0, 1); // "a|b**cd**ef"（装飾の外）
    expect(await getCaretPosition(page)).toEqual({ line: 0, col: 1 });
    await waitForReveal(page, null);

    let prev = 1;
    for (let i = 0; i < 9; i++) {
      await stepRight(page);
      const pos = await getCaretPosition(page);
      expect(pos).toEqual({ line: 0, col: prev + 1 });
      prev = pos!.col;
    }
    expect(prev).toBe(10); // 行末まで到達
  });
});

test.describe("非 collapsed の選択中は reveal しない", () => {
  test("装飾をまたぐ選択中は reveal 状態のまま変化せず、装飾タグの表示も維持される", async ({ openNote }) => {
    const page = await openNote({ content: "pre **bold** post" });
    // 可視 "pre bold post" のうち "e " の直後 〜 "bold" の途中（装飾をまたぐ非 collapsed 選択）
    await selectMarkdownRange(page, 0, 2, 0, 7);
    expect(await getRevealState(page)).toBeNull();
    expect(await page.locator("#markdown-view .md-reveal").count()).toBe(0);
    expect(await page.locator("#markdown-view strong").textContent()).toBe("bold");
  });
});

test.describe("選択の開始・拡張は reveal を解除しつつ選択そのものを保持する", () => {
  // "pre **bold** post" の raw col 7〜9（"**b|o|l|d**" の内部、装飾の可視先頭・可視末尾のどちらの
  // 境界にも触れない位置）を使う。可視末尾ちょうど（srcEnd）は raw 位置として本来あいまい
  // （閉じマーカーの直前・直後のどちらもそこへ丸められる、既存の丸め規約）になるため、選択範囲の
  // 復元そのものを検証したいこのテストでは avoid し、あいまいさの無い装飾内部の 2 点を使う。

  test("装飾内部の collapsed キャレットから Shift+矢印で選択を開始しても選択範囲が保持される", async ({ openNote }) => {
    // reveal 中に選択が非 collapsed になると selectionchange ハンドラが reveal を解除して
    // 再描画するが、その前後で選択の両端が raw 位置として保存・復元されることを検証する
    const page = await openNote({ content: "pre **bold** post" });
    await placeCaret(page, 0, 7); // "pre **b|old** post"（装飾内部）
    await waitForReveal(page, { line: 0, start: 4, end: 12 });

    // stepRight と同様、selectionchange 駆動の再描画が決着するまで待ってから次のキーを送る
    // （待たずに連打すると再描画の途中に次のキーが割り込みうる。ファイル冒頭のコメント参照）
    await page.keyboard.down("Shift");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(50);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(50);
    await page.keyboard.up("Shift");

    expect(await getRevealState(page)).toBeNull(); // 非 collapsed の間 revealState は必ず null
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe("ol");

    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("pre **bXd** post");
  });

  test("装飾内部の collapsed キャレットから ⌘A で選択しても全文が選択され、続く Backspace が反映される", async ({ openNote }) => {
    const page = await openNote({ content: "**bold** text" });
    await placeCaret(page, 0, 4); // "**bo|ld** text"（装飾内部）
    await waitForReveal(page, { line: 0, start: 0, end: 8 });

    await page.keyboard.press("Meta+a");
    await waitForReveal(page, null);

    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe("bold text");

    await page.keyboard.press("Backspace");
    expect(await getContent(page)).toBe("");
  });

  test("装飾内部の collapsed キャレットからのドラッグ選択でも選択範囲が正しく成立する", async ({ openNote }) => {
    const page = await openNote({ content: "pre **bold** post" });
    await placeCaret(page, 0, 7); // "pre **b|old** post"（装飾内部、ドラッグの mousedown 相当）
    await waitForReveal(page, { line: 0, start: 4, end: 12 });

    // reveal 中は可視 = raw が 1:1 なので、可視オフセット 9 は raw col 9 と一致する
    // （ドラッグの mousemove/mouseup で focus が伸びる様子を Selection.extend() で模す）
    await extendSelectionTo(page, 0, 9);

    expect(await getRevealState(page)).toBeNull();
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe("ol");

    await page.keyboard.press("Delete");
    expect(await getContent(page)).toBe("pre **bd** post");
  });
});

test.describe("非 collapsed の選択中は revealState が必ず null（不変条件）", () => {
  /** document へ cut の ClipboardEvent を dispatch し、text/plain と削除の可否を返す。 */
  function dispatchCut(page: import("@playwright/test").Page) {
    return page.evaluate(() => {
      const dt = new DataTransfer();
      const ev = new ClipboardEvent("cut", { bubbles: true, cancelable: true, clipboardData: dt });
      const notCanceled = document.dispatchEvent(ev);
      return { notCanceled, plain: dt.getData("text/plain") };
    });
  }

  test("reveal 中に選択を広げてから ⌘X → クリップボードの text/plain と削除された範囲が一致する", async ({ openNote }) => {
    const page = await openNote({ content: "pre **bold** post" });
    await placeCaret(page, 0, 7); // "pre **b|old** post"（装飾内部）
    await waitForReveal(page, { line: 0, start: 4, end: 12 });

    await page.keyboard.down("Shift");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(50);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(50);
    await page.keyboard.up("Shift");
    expect(await getRevealState(page)).toBeNull();

    const { notCanceled, plain } = await dispatchCut(page);
    expect(notCanceled).toBe(false); // preventDefault された（note.js 側で処理した）
    expect(plain).toBe("ol");
    // クリップボードに載った範囲と、実際に消えた範囲が一致する（コピーされる範囲 = 削除される範囲）
    expect(await getContent(page)).toBe("pre **bd** post");
  });
});

test.describe("待ちなしの連打でも rawContent は壊れない", () => {
  test("装飾境界を跨いで矢印キーを連打（selectionchange の再描画を待たない）しても最終状態は整合する", async ({ openNote }) => {
    const page = await openNote({ content: "ab**cd**ef" }); // 装飾外[0,2) 装飾[2,8) 装飾外[8,10)
    await placeCaret(page, 0, 0);

    // stepRight と違い selectionchange の再描画完了を待たずに連打する（キーリピート相当）。
    // 表示が連打の途中でどう乱れるかは問わず、最終的にキャレットが行末に達し、続く入力が
    // その位置に正しく反映されることだけを確認する
    for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.type("X", { delay: 0 });

    expect(await getContent(page)).toBe("ab**cd**efX");
  });
});

test.describe("undo で内容が戻っても表示が整合する", () => {
  test("reveal 中に入力 → undo で戻ると raw・表示のどちらも入力前の状態に一致する", async ({ openNote }) => {
    const page = await openNote({ content: "**bold**" });
    await placeCaret(page, 0, 4); // "**bo|ld**"
    await waitForReveal(page, { line: 0, start: 0, end: 8 });
    await page.keyboard.type("X", { delay: 10 });
    expect(await getContent(page)).toBe("**boXld**");
    await page.waitForTimeout(400); // 保存デバウンスを確定させ history へ積ませる

    await page.evaluate(() => (window as unknown as { performUndo(): void }).performUndo());
    expect(await getContent(page)).toBe("**bold**");

    // undo 後のキャレットは差分行の行末（applyHistoryContent の仕様）＝装飾の可視末尾の境界に
    // 一致するため、reveal は確定的に再度有効になる
    await waitForReveal(page, { line: 0, start: 0, end: 8 });
    expect(await page.locator("#markdown-view .md-reveal").textContent()).toBe("**bold**");
    expect(await page.locator("#markdown-view strong").count()).toBe(0);
  });
});
