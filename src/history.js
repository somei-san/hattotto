// ── Undo/Redo History ────────────────────────────────────────
// rawContent の変遷を扱う純粋なロジック。DOM にもエディタの状態にも触らないため、
// node の単体テストから直接呼べる。note.html では note.js より先に読み込む。

// 無制限に積むとメモリを圧迫するため、undo 側だけ上限を設ける（redo は commit のたびに
// 消えるため、そもそも際限なく積み上がらない）
const HISTORY_LIMIT = 100;

/**
 * content の変遷を管理する履歴を作る。historyLast は直前に commit された内容で、
 * 「今の状態」の基準点として持ち続ける（undo/redo はここを起点に前後へ移動する）。
 */
function createHistory(initialContent) {
  let historyLast = initialContent;
  const undoStack = [];
  let redoStack = [];

  /** content が historyLast と異なるときだけ、historyLast を undo 側へ積んで進める。 */
  function commit(content) {
    if (content === historyLast) return;
    undoStack.push(historyLast);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    historyLast = content;
    redoStack = [];
  }

  /**
   * currentContent が historyLast 未 commit の変更を含んでいれば先に commit してから 1 手戻る。
   * 戻れる先が無ければ null。
   */
  function undo(currentContent) {
    commit(currentContent);
    if (undoStack.length === 0) return null;
    redoStack.push(historyLast);
    historyLast = undoStack.pop();
    return historyLast;
  }

  /**
   * currentContent が historyLast 未 commit の変更を含んでいれば先に commit してから 1 手進む。
   * commit が発生すると redoStack はその時点で空になる（＝新しい変更をした後は redo できない、
   * という一般的なエディタの挙動）ため、この場合は戻れる先が無く null を返す。
   */
  function redo(currentContent) {
    commit(currentContent);
    if (redoStack.length === 0) return null;
    undoStack.push(historyLast);
    historyLast = redoStack.pop();
    return historyLast;
  }

  return { commit, undo, redo };
}

/**
 * oldContent と newContent が最初に異なる行のインデックスを返す。差分が無ければ null。
 * 末尾で行数だけが増減した場合（追加・削除）は、共通する先頭部分の直後（新しい内容側の
 * 境界）を返す。呼び出し側で行数の範囲にクランプすること。
 */
function firstDiffLine(oldContent, newContent) {
  if (oldContent === newContent) return null;
  const a = oldContent.split('\n');
  const b = newContent.split('\n');
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return i;
  }
  return len;
}

// ブラウザでは module が未定義なので、この行は classic script の読み込みに影響しない
if (typeof module !== 'undefined') {
  module.exports = { createHistory, firstDiffLine };
}
