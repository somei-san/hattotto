import js from "@eslint/js";
import globals from "globals";

// src/ の各 script が定義するトップレベル識別子。classic script なので、
// 先に読み込まれたファイルの識別子が後続のファイルからそのまま見える。
// 下の files ブロックは各 HTML の <script> の並びと一致させること。
// ずれていると no-undef が実行時の ReferenceError を見逃す。
const utils = { escapeHtml: "readonly", showToast: "readonly" };
const i18n = { I18N: "readonly" };
const markdown = {
  inlineMarkdown: "readonly",
  renderMarkdown: "readonly",
  inlineSegments: "readonly",
  parseImageAlt: "readonly",
};
const noteLines = {
  blockOffset: "readonly",
  markerLength: "readonly",
  LIST_PATTERNS: "readonly",
  stripIndent: "readonly",
  getAutoPrefix: "readonly",
  isEmptyListItem: "readonly",
  CHECKBOX_RE: "readonly",
  isImageOnlyLine: "readonly",
  visibleOffsetToRawOffset: "readonly",
};
const history = {
  createHistory: "readonly",
  firstDiffLine: "readonly",
};

export default [
  { ignores: ["playwright-report/", "test-results/", "src-tauri/target/"] },

  js.configs.recommended,

  {
    files: ["src/**/*.js"],
    languageOptions: { sourceType: "script", globals: globals.browser },
  },

  // module は tests/unit から require するためのガード（typeof module）で参照する
  // utils.js は最初に読まれるので追加の globals は module のみ
  { files: ["src/utils.js"], languageOptions: { globals: { module: "readonly" } } },
  { files: ["src/i18n.js"], languageOptions: { globals: { ...utils, module: "readonly" } } },
  { files: ["src/markdown.js"], languageOptions: { globals: { ...utils, ...i18n, module: "readonly" } } },
  {
    files: ["src/note-lines.js"],
    languageOptions: { globals: { ...utils, ...i18n, ...markdown, module: "readonly" } },
  },
  {
    files: ["src/history.js"],
    languageOptions: {
      globals: { ...utils, ...i18n, ...markdown, ...noteLines, module: "readonly" },
    },
  },
  {
    files: ["src/note.js"],
    languageOptions: { globals: { ...utils, ...i18n, ...markdown, ...noteLines, ...history } },
  },
  {
    files: ["src/settings.js", "src/trash.js"],
    languageOptions: { globals: { ...utils, ...i18n } },
  },

  {
    files: ["tests/unit/**/*.js"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
  },
];
