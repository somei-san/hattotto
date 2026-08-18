// ── i18n ──────────────────────────────────────────────────────
// 設定の language（"auto" | "ja" | "en"）を UI 表示言語に解決し、
// data-i18n 系属性を持つ要素へ文言を反映する。
// .lproj / NSLocalizedString 相当の仕組みを使わないのは、設定画面での
// 切り替えに再起動を要求しないため。
// utils.js と同じく <script src="i18n.js"> で読み込み、window にぶら下げる。

(function () {

const I18N_TABLE = {
  appName: { ja: '貼っとっと', en: 'Hattotto' },

  colorYellow: { ja: 'イエロー', en: 'Yellow' },
  colorBlue: { ja: 'ブルー', en: 'Blue' },
  colorGreen: { ja: 'グリーン', en: 'Green' },
  colorPink: { ja: 'ピンク', en: 'Pink' },
  colorPurple: { ja: 'パープル', en: 'Purple' },
  colorGray: { ja: 'グレー', en: 'Gray' },
  colorRandom: { ja: 'ランダム', en: 'Random' },

  delete: { ja: '削除', en: 'Delete' },
  cancel: { ja: 'キャンセル', en: 'Cancel' },
  newNote: { ja: '新しい付箋', en: 'New note' },
  color: { ja: '色', en: 'Color' },

  // ── settings.html ──────────────────────────────────
  settingsDocTitle: { ja: '貼っとっと — 設定 / ヘルプ', en: 'Hattotto — Settings / Help' },
  tabSettings: { ja: '設定', en: 'Settings' },
  tabHelp: { ja: 'ヘルプ', en: 'Help' },

  sectionDefaultColor: { ja: '新しい付箋のデフォルトカラー', en: 'Default Color for New Notes' },
  defaultColorGroupLabel: { ja: 'デフォルトカラー', en: 'Default Color' },

  sectionOpacity: { ja: '透過度', en: 'Opacity' },

  sectionDisplay: { ja: '表示', en: 'Display' },
  toggleBringAllToFront: { ja: '付箋をクリックしたら全付箋を前面に表示', en: 'Bring all notes to front when clicking a note' },
  toggleShowPin: { ja: 'ピン留めボタンを表示', en: 'Show pin button' },
  toggleShowNew: { ja: '新しい付箋ボタンを表示', en: 'Show new note button' },
  toggleShowColor: { ja: 'カラーボタンを表示', en: 'Show color button' },

  sectionConfirmDelete: { ja: '削除確認', en: 'Delete Confirmation' },
  toggleConfirmDelete: { ja: '付箋削除時に確認する', en: 'Confirm before deleting a note' },

  sectionSystem: { ja: 'システム', en: 'System' },
  toggleAutostart: { ja: 'ログイン時に自動起動', en: 'Start at login' },

  labelLanguage: { ja: '言語', en: 'Language' },
  languageAuto: { ja: 'システムに合わせる', en: 'Match System' },

  sectionBasicUsage: { ja: '基本操作', en: 'Basic Usage' },
  usageEdit: { ja: 'クリックした行だけ Markdown 記法で編集でき、フォーカスを外すとプレビューに戻ります。', en: 'Click a line to edit it in Markdown; click elsewhere to return to preview.' },
  usageColor: { ja: 'タイトルバー右の ● ボタンで付箋の色を変更できます。', en: 'Use the ● button on the title bar to change the note color.' },
  usageNew: { ja: '＋ ボタン / トレイメニュー / ⌘N で新しい付箋を作成。', en: 'Create a new note with the + button, the tray menu, or ⌘N.' },
  usageDelete: { ja: '✕ ボタンで付箋を削除。ゴミ箱から復元できます。', en: 'Delete a note with the ✕ button. Restore it from the trash.' },
  usageMove: { ja: 'タイトルバーをドラッグで移動、右下角をドラッグでリサイズ。', en: 'Drag the title bar to move, drag the bottom-right corner to resize.' },
  usageContextMenu: { ja: '右クリックで操作メニュー（編集・付箋操作・ズーム）。', en: 'Right-click for the action menu (edit, note actions, zoom).' },

  sectionMarkdownSyntax: { ja: 'Markdown記法', en: 'Markdown Syntax' },
  mdHeading: { ja: '<code># 見出し</code> <code>## 中見出し</code> <code>### 小見出し</code>', en: '<code># Heading</code> <code>## Subheading</code> <code>### Sub-subheading</code>' },
  mdBullet: { ja: '<code>- 箇条書き</code>（Enter で自動継続、空行で解除）', en: '<code>- Bullet</code> (Enter continues it, an empty line ends it)' },
  mdCheckbox: { ja: '<code>- [ ] タスク</code> / <code>- [x] 完了</code>（プレビューでクリック切替）', en: '<code>- [ ] Task</code> / <code>- [x] Done</code> (click to toggle in preview)' },
  mdOrdered: { ja: '<code>1. 番号リスト</code>（Enter で番号自動インクリメント）', en: '<code>1. Numbered list</code> (Enter auto-increments the number)' },
  mdQuote: { ja: '<code>> 引用</code>', en: '<code>> Quote</code>' },
  mdInline: { ja: '<code>**太字**</code> <code>*斜体*</code> <code>~~取消線~~</code> <code>`コード`</code>', en: '<code>**bold**</code> <code>*italic*</code> <code>~~strikethrough~~</code> <code>`code`</code>' },
  mdLink: { ja: '<code>[テキスト](URL)</code> — プレビューでクリックするとブラウザで開きます', en: '<code>[text](URL)</code> — click it in preview to open it in your browser' },
  mdHr: { ja: '<code>---</code> で区切り線', en: '<code>---</code> for a horizontal rule' },

  sectionShortcuts: { ja: 'ショートカット', en: 'Shortcuts' },
  shortcutNewNote: { ja: '新しい付箋', en: 'New note' },
  shortcutOpenTrash: { ja: 'ゴミ箱を開く', en: 'Open trash' },
  shortcutZoomIn: { ja: 'ズームイン', en: 'Zoom in' },
  shortcutZoomOut: { ja: 'ズームアウト', en: 'Zoom out' },
  shortcutZoomReset: { ja: 'ズームリセット', en: 'Reset zoom' },
  shortcutOpenSettings: { ja: '設定を開く', en: 'Open settings' },
  shortcutQuitApp: { ja: 'アプリを終了', en: 'Quit app' },

  sectionPaste: { ja: 'ペースト', en: 'Paste' },
  pasteLink: { ja: 'ブラウザからリンクをコピペすると自動でMarkdownリンクに変換されます。', en: 'Pasting a link copied from your browser converts it to a Markdown link automatically.' },
  pasteSelectionLink: { ja: 'テキストを選択してURLを貼り付けると <code>[選択テキスト](URL)</code> に変換。', en: 'Select text, then paste a URL to convert it to <code>[selected text](URL)</code>.' },
  pasteRichText: { ja: 'リッチテキスト（太字・リスト等）も Markdown に自動変換されます。', en: 'Rich text (bold, lists, etc.) is also converted to Markdown automatically.' },

  sectionVersion: { ja: 'バージョン情報', en: 'Version' },
  saveButton: { ja: '保存', en: 'Save' },
  toastSettingsSaveFailed: { ja: '設定の保存に失敗しました', en: 'Failed to save settings' },

  // ── trash.html ─────────────────────────────────────
  trashDocTitle: { ja: 'ゴミ箱', en: 'Trash' },
  trashHeading: { ja: 'ゴミ箱', en: 'Trash' },
  emptyTrashButton: { ja: 'すべて削除', en: 'Empty Trash' },
  trashListAriaLabel: { ja: '削除した付箋', en: 'Deleted notes' },
  toastLoadFailed: { ja: '読み込みに失敗しました', en: 'Failed to load' },
  trashEmptyMessage: { ja: 'ゴミ箱は空です', en: 'Trash is empty' },
  emptyNotePlaceholder: { ja: '(空の付箋)', en: '(Empty note)' },
  restoreButton: { ja: '復元', en: 'Restore' },
  confirmEmptyTrashMessage: { ja: 'ゴミ箱を空にしますか？\nこの操作は元に戻せません。', en: 'Empty the trash?\nThis action cannot be undone.' },
  toastRestoreFailed: { ja: '付箋の復元に失敗しました', en: 'Failed to restore note' },
  toastEmptyTrashFailed: { ja: 'ゴミ箱の削除に失敗しました', en: 'Failed to empty trash' },

  // ── note.html ──────────────────────────────────────
  pinButton: { ja: 'ピン留め', en: 'Pin' },
  unpinButton: { ja: 'ピン留め解除', en: 'Unpin' },
  noteColorAriaLabel: { ja: '付箋の色', en: 'Note color' },
  noteContentAriaLabel: { ja: '付箋の内容', en: 'Note content' },
  notePlaceholder: { ja: 'メモを入力…', en: 'Type a note…' },
  toastSaveFailed: { ja: '保存に失敗しました', en: 'Failed to save' },
  toastCreateFailed: { ja: '付箋の作成に失敗しました', en: 'Failed to create note' },
  toastDeleteFailed: { ja: '付箋の削除に失敗しました', en: 'Failed to delete note' },
};

// 訳の付け忘れ検出（キーを増やしたときに片方の言語が抜けていたら気づけるように）
for (const [key, entry] of Object.entries(I18N_TABLE)) {
  if (!entry.ja || !entry.en) {
    console.error(`I18N: "${key}" は ja/en の訳が揃っていません`);
  }
}

let currentLang = 'ja';

/** setting（"auto" | "ja" | "en"）を表示言語へ解決する。auto は navigator.language の primary subtag が ja なら日本語、それ以外は英語。 */
function resolve(setting) {
  if (setting === 'ja' || setting === 'en') return setting;
  const primary = (navigator.language || 'en').split('-')[0].toLowerCase();
  return primary === 'ja' ? 'ja' : 'en';
}

function t(key) {
  const entry = I18N_TABLE[key];
  if (!entry) {
    console.error(`I18N: 未知のキー "${key}"`);
    return key;
  }
  return entry[currentLang];
}

/** root 配下の data-i18n 系属性を持つ要素へ現在の言語の文言を反映する。 */
function applyDom(root) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  root.querySelectorAll('[data-i18n-aria-label]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel)); });
  root.querySelectorAll('[data-i18n-doc-title]').forEach(el => { document.title = t(el.dataset.i18nDocTitle); });
}

function setLang(lang) {
  currentLang = lang === 'ja' ? 'ja' : 'en';
  document.documentElement.lang = currentLang;
  applyDom(document);
}

/** 現在の表示言語（"ja" | "en"）。Intl へ渡すロケールを決めるのに使う。 */
function lang() {
  return currentLang;
}

window.I18N = { resolve, setLang, t, applyDom, lang };

})();
