import {
  test, expect, placeCaret, waitForReveal, getRevealState, caretRect, charRect, expectCaretAtVisiblePosition,
} from "./fixtures";

// キャレットのジオメトリ（実際のピクセル位置）の回帰テスト。raw・DOM 上のキャレット位置が
// 正しくても、見た目の位置・可視性がそれとずれるバグ（行末スペースが white-space: normal で
// 潰れてキャレットが視覚的に進まない／空チェックボックス項目でキャレットがチェックボックスの
// 位置に見える／コードブロック末尾の空行が描画されずキャレットが動かないように見える、等）は
// DOM 構造だけを見ても分からない。caretRect/charRect で実際の getBoundingClientRect まで
// 見て機械的に検証する。

test.describe("行末・行内でのキャレットの視覚位置", () => {
  test("行末にスペースを打つたびにキャレットの x が進む", async ({ openNote }) => {
    const page = await openNote({ content: "hi" });
    await placeCaret(page, 0, 2); // "hi" の行末

    const before = (await caretRect(page))!;
    await page.keyboard.type(" ", { delay: 10 });
    const afterOne = (await caretRect(page))!;
    expect(afterOne.x).toBeGreaterThan(before.x);
    await expectCaretAtVisiblePosition(page, 0, 3);

    await page.keyboard.type(" ", { delay: 10 });
    const afterTwo = (await caretRect(page))!;
    expect(afterTwo.x).toBeGreaterThan(afterOne.x);
    await expectCaretAtVisiblePosition(page, 0, 4);
  });

  test("行頭から行末まで、スペースを挟んでも x は単調に増え y は変わらない", async ({ openNote }) => {
    const page = await openNote({ content: "ab cd" });

    let prevX: number | null = null;
    let firstY: number | null = null;
    for (let col = 0; col <= "ab cd".length; col++) {
      await placeCaret(page, 0, col);
      await expectCaretAtVisiblePosition(page, 0, col);
      const rect = (await caretRect(page))!;
      if (prevX !== null) expect(rect.x).toBeGreaterThan(prevX);
      if (firstY === null) firstY = rect.y;
      else expect(Math.abs(rect.y - firstY)).toBeLessThanOrEqual(2);
      prevX = rect.x;
    }
  });
});

test.describe("チェックボックス行のキャレットはチェックボックスの右に立つ", () => {
  test("空項目（内容なし）", async ({ openNote }) => {
    const page = await openNote({ content: "- [ ] " });
    await placeCaret(page, 0, 6); // "- [ ] " の直後（内容先頭）

    const checkbox = (await page.locator("#markdown-view input[type=checkbox]").boundingBox())!;
    const caret = (await caretRect(page))!;
    expect(caret.x).toBeGreaterThan(checkbox.x + checkbox.width);
    await expectCaretAtVisiblePosition(page, 0, 0); // 内容先頭 = &nbsp; フィラーの位置
  });

  test("内容ありの項目", async ({ openNote }) => {
    const page = await openNote({ content: "- [ ] task" });
    await placeCaret(page, 0, 6); // "- [ ] " の直後（内容先頭）

    const checkbox = (await page.locator("#markdown-view input[type=checkbox]").boundingBox())!;
    const caret = (await caretRect(page))!;
    expect(caret.x).toBeGreaterThan(checkbox.x + checkbox.width);
    await expectCaretAtVisiblePosition(page, 0, 0);
  });
});

test.describe("コードブロック末尾の空行のキャレットは見える位置に立つ", () => {
  test("最終内容行の行末で Enter すると、キャレットが前の行より下の見える位置に立つ", async ({ openNote }) => {
    const page = await openNote({ content: "```\ncode\n```" });
    await placeCaret(page, 1, "code".length); // "code" の行末
    const codeLineRect = (await caretRect(page))!;

    await page.keyboard.press("Enter");
    const emptyLineRect = await caretRect(page);
    expect(emptyLineRect, "コードブロック末尾の空行にキャレットの矩形が無い（<br> フィラー欠落の疑い）")
      .not.toBeNull();
    expect(emptyLineRect!.y).toBeGreaterThan(codeLineRect.y + codeLineRect.height * 0.5);
  });
});

test.describe("インライン生表示（reveal）の切替でキャレットが飛ばない", () => {
  test("装飾の外から内部へ移動しても reveal 確定後の位置は x が単調に進んだ範囲にとどまる", async ({ openNote }) => {
    const page = await openNote({ content: "pre **bold** post" });

    await placeCaret(page, 0, 3); // "pre| **bold** post"（装飾の外）
    await waitForReveal(page, null);
    const outside = (await caretRect(page))!;

    await placeCaret(page, 0, 8); // "pre **bo|ld** post"（装飾の内部）
    await waitForReveal(page, { line: 0, start: 4, end: 12 });
    const inside = (await caretRect(page))!;

    // reveal 確定後は可視 = raw が 1:1 になるため、raw col 8 は可視オフセット 8 と一致する
    await expectCaretAtVisiblePosition(page, 0, 8);
    expect(inside.x).toBeGreaterThan(outside.x);
    expect(Math.abs(inside.y - outside.y)).toBeLessThanOrEqual(2);
  });

  test("装飾境界を跨ぐ ArrowRight の 1 歩ごとに x は小刻みに進み、大きく飛ばない", async ({ openNote }) => {
    const page = await openNote({ content: "ab**cd**ef" }); // 装飾外[0,2) 装飾[2,8) 装飾外[8,10)
    await placeCaret(page, 0, 1); // "a|b**cd**ef"（装飾の外）
    await waitForReveal(page, null);

    // reveal の ON/OFF が切り替わる歩（マーカーが可視化・非可視化される歩）は、装飾ぶんの
    // 文字が可視テキストに出入りするため x が大きく動いても正常（バグではない）。同じ
    // reveal 状態を保っている歩どうしの間でだけ、小刻みな単調増加を検証する
    let prev = (await caretRect(page))!;
    let prevReveal = await getRevealState(page);
    for (let i = 0; i < 9; i++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(50); // selectionchange 駆動の reveal 再判定・再描画の決着待ち
      const rect = (await caretRect(page))!;
      const reveal = await getRevealState(page);
      if (JSON.stringify(reveal) === JSON.stringify(prevReveal)) {
        expect(rect.x, `${i} 歩目で x が進んでいない（キャレットが視覚的に停止した疑い）`).toBeGreaterThan(prev.x);
        expect(rect.x - prev.x, `${i} 歩目で x が大きく飛んだ（1 文字分を超える移動）`).toBeLessThan(20);
        expect(Math.abs(rect.y - prev.y)).toBeLessThanOrEqual(2);
      }
      prev = rect;
      prevReveal = reveal;
    }
  });
});

test.describe("折り返しがある長い行のキャレット位置", () => {
  test("折り返し後の行のキャレットは行頭より下の行に、charRect と一致する位置に立つ", async ({ openNote }) => {
    const longLine = "x".repeat(80);
    const page = await openNote({ content: longLine });

    await placeCaret(page, 0, 0);
    const firstRowRect = (await caretRect(page))!;

    await placeCaret(page, 0, 60);
    await expectCaretAtVisiblePosition(page, 0, 60);
    const wrappedRect = (await caretRect(page))!;

    expect(wrappedRect.y).toBeGreaterThan(firstRowRect.y + firstRowRect.height * 0.5);
  });
});

test.describe("charRect ヘルパ自身の健全性", () => {
  test("存在しない行では null を返す", async ({ openNote }) => {
    const page = await openNote({ content: "only line" });
    expect(await charRect(page, 5, 0)).toBeNull();
  });
});
