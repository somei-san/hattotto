const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { createHistory, firstDiffLine, diffColumn } = require("../../src/history.js");

describe("createHistory: commit", () => {
  test("historyLast と同値の commit は積まない（undo できない）", () => {
    const h = createHistory("a");
    h.commit("a");
    assert.equal(h.undo("a"), null);
  });

  test("異なる内容の commit は undo できるようにする", () => {
    const h = createHistory("a");
    h.commit("b");
    assert.equal(h.undo("b"), "a");
  });
});

describe("createHistory: undo/redo の往復", () => {
  test("commit → undo で 1 手戻る", () => {
    const h = createHistory("a");
    h.commit("b");
    assert.equal(h.undo("b"), "a");
  });

  test("undo → redo で元に戻る", () => {
    const h = createHistory("a");
    h.commit("b");
    const undone = h.undo("b");
    assert.equal(h.redo(undone), "b");
  });

  test("複数回 commit → 複数回 undo で段階的に戻る", () => {
    const h = createHistory("a");
    h.commit("b");
    h.commit("c");
    assert.equal(h.undo("c"), "b");
    assert.equal(h.undo("b"), "a");
  });

  test("戻れる先が無い undo は null", () => {
    const h = createHistory("a");
    assert.equal(h.undo("a"), null);
  });

  test("進める先が無い redo は null", () => {
    const h = createHistory("a");
    h.commit("b");
    assert.equal(h.redo("b"), null);
  });
});

describe("createHistory: redo(currentContent) の同値/非同値", () => {
  test("currentContent が historyLast と同値 → 通常どおり redo する", () => {
    const h = createHistory("a");
    h.commit("b");
    const undone = h.undo("b"); // historyLast === "a"
    assert.equal(h.redo(undone), "b");
  });

  test("currentContent が historyLast と異なる（未 commit の変更がある）→ その場で commit され、"
    + "redoStack が空になった状態として null を返す（巻き戻し防止）", () => {
    const h = createHistory("a");
    h.commit("b");
    h.undo("b"); // historyLast === "a"、redoStack には "b" が積まれている
    // "a" から見て未 commit の別の変更（例: saveNow を経由しない画像削除）が rawContent にある状態
    assert.equal(h.redo("z"), null);
    // "z" は commit 済みになっているので、そこへは undo で戻れる
    assert.equal(h.undo("z"), "a");
  });
});

describe("createHistory: redo クリア", () => {
  test("undo 後に新しい commit をすると redo が消える", () => {
    const h = createHistory("a");
    h.commit("b");
    const undone = h.undo("b");
    h.commit("c");
    assert.equal(h.redo(undone), null);
  });
});

describe("createHistory: 上限", () => {
  test("上限を超えて commit すると最も古い履歴から破棄される", () => {
    const h = createHistory("0");
    for (let i = 1; i <= 101; i++) h.commit(String(i));
    // 上限 100 なので、最も古い "0" まで undo し切れない（"1" までしか戻れない）
    let content = String(101);
    let steps = 0;
    for (let cur = content; ; steps++) {
      const prev = h.undo(cur);
      if (prev == null) break;
      cur = prev;
      content = prev;
    }
    assert.equal(steps, 100);
    assert.equal(content, "1");
  });
});

describe("firstDiffLine", () => {
  test("同一内容なら null", () => {
    assert.equal(firstDiffLine("a\nb", "a\nb"), null);
  });

  test("1 行だけ変わった場合はその行番号", () => {
    assert.equal(firstDiffLine("a\nb\nc", "a\nX\nc"), 1);
  });

  test("末尾に行が追加された場合は追加位置", () => {
    assert.equal(firstDiffLine("a\nb", "a\nb\nc"), 2);
  });

  test("末尾の行が削除された場合は境界位置（呼び出し側でクランプする想定）", () => {
    assert.equal(firstDiffLine("a\nb\nc", "a\nb"), 2);
  });

  test("末尾行だけ差分がある場合はその行番号", () => {
    assert.equal(firstDiffLine("a\nb", "a\nc"), 1);
  });
});

describe("diffColumn", () => {
  test("行末に文字が追加された場合は追加後の行末（redo-of-insert 相当）", () => {
    assert.equal(diffColumn("abc", "abcdef"), 6);
  });

  test("行の途中に文字が挿入された場合は挿入文字の後ろ（redo-of-insert 相当）", () => {
    assert.equal(diffColumn("abcdef", "abcXdef"), 4);
  });

  test("行の途中の文字が削除された場合は削除位置（undo-of-insert 相当）", () => {
    assert.equal(diffColumn("abcXdef", "abcdef"), 3);
  });

  test("行末の文字が削除され undo で復元される場合は復元文字の後ろ（undo-of-delete 相当）", () => {
    assert.equal(diffColumn("ab", "abc"), 3);
  });

  test("行の途中の文字が削除され undo で復元される場合は復元文字の後ろ（undo-of-delete 相当）", () => {
    assert.equal(diffColumn("acdef", "abcdef"), 2);
  });

  test("先頭から全く異なる場合（完全置換）は置換後の行末", () => {
    assert.equal(diffColumn("abc", "xyz"), 3);
  });

  test("完全一致なら行の長さ", () => {
    assert.equal(diffColumn("abc", "abc"), 3);
  });

  test("片方が空文字なら 0", () => {
    assert.equal(diffColumn("abc", ""), 0);
  });

  test("戻り値は newLine の長さを超えない（呼び出し側の行境界クランプと独立に安全）", () => {
    assert.equal(diffColumn("abcdefgh", "abc"), 3);
  });
});
