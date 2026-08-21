// ── Markdown rendering utilities ─────────────────────────────
// Shared by note.html (preview) and tests (via window.renderMarkdown).
// Depends on escapeHtml() from utils.js (loaded before this script).
/* exported renderMarkdown */

// Note: inlineMarkdown receives escapeHtml-processed strings.
// This is intentional — HTML entities (e.g. &amp;) are treated as plain text
// within Markdown syntax, and code blocks store the escaped form as-is,
// avoiding double-escaping when placed inside <code> tags.
function inlineMarkdown(escaped) {
  // `code` → placeholder (protect from bold/italic/strikethrough)
  const codeBlocks = [];
  escaped = escaped.replace(/`([^`]+)`/g, (_, c) => {
    codeBlocks.push(c);
    return '\x00CODE' + (codeBlocks.length - 1) + '\x00';
  });
  // **bold** → <strong>
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // *italic* → <em> (after bold to avoid conflict)
  escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // ~~strikethrough~~ → <del>
  escaped = escaped.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // [text](url) → <a>
  escaped = escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" data-url="$2">$1</a>'
  );
  // Bare URLs → <a> (skip URLs already inside an <a> tag)
  escaped = escaped.replace(
    /((?:^|[^"=]))((https?:\/\/)[^\s<]+)/g,
    (_, pre, url) => `${pre}<a href="${url}" data-url="${url}">${url}</a>`
  );
  // Restore code blocks
  // eslint-disable-next-line no-control-regex -- \x00 is the placeholder marker
  escaped = escaped.replace(/\x00CODE(\d+)\x00/g, (_, i) => '<code>' + codeBlocks[i] + '</code>');
  return escaped;
}

function renderMarkdown(text) {
  if (!text) {
    // window.I18N を読み込まずに renderMarkdown 単体を呼ぶ場面（テスト・node 環境等）でも壊れないようフォールバックする
    const placeholder = (typeof window !== 'undefined' && window.I18N) ? window.I18N.t('notePlaceholder') : 'メモを入力…';
    return `<div class="md-placeholder">${placeholder}</div>`;
  }
  // Normalize non-breaking spaces (contenteditable often inserts \u00A0)
  const lines = text.replace(/\u00A0/g, ' ').split('\n');
  const result = [];
  let inCodeBlock = false;
  let codeLines = [];
  let codeStart = 0;
  const orderedCounters = {}; // track counters per indent level
  let lastOrderedLevel = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inCodeBlock && /^```\S*\s*$/.test(line)) {
      inCodeBlock = true;
      codeLines = [];
      codeStart = i;
      continue;
    }
    if (inCodeBlock && /^```\s*$/.test(line)) {
      result.push(`<pre class="md-codeblock" data-line="${codeStart}" data-line-end="${i}"><code>` + codeLines.map(l => escapeHtml(l)).join('\n') + '</code></pre>');
      inCodeBlock = false;
      codeLines = [];
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }
    // Measure and strip indent for nested lists
    // Indent level is based on 2-space units; odd spaces are truncated (e.g. 3 spaces = level 1)
    // Note: only spaces are considered; tab characters are not supported and will be ignored
    const indentMatch = line.match(/^( +)/);
    const spaces = indentMatch ? indentMatch[1].length : 0;
    const level = Math.floor(spaces / 2);
    const trimmedLine = spaces > 0 ? line.slice(spaces) : line;
    const indentClass = level > 0 ? ` md-indent-${Math.min(level, 5)}` : '';

    // Reset ordered list counters when line is not a numbered list
    if (!/^\d+\. /.test(trimmedLine)) {
      lastOrderedLevel = -1;
      Object.keys(orderedCounters).forEach(k => delete orderedCounters[k]);
    }

    if (/^[-*] \[x\] /i.test(trimmedLine)) {
      result.push(`<div class="md-check checked${indentClass}" data-line="${i}"><input type="checkbox" checked data-line="${i}"><span>${inlineMarkdown(escapeHtml(trimmedLine.slice(6)))}</span></div>`);
      continue;
    }
    if (/^[-*] \[ \] /.test(trimmedLine)) {
      result.push(`<div class="md-check${indentClass}" data-line="${i}"><input type="checkbox" data-line="${i}"><span>${inlineMarkdown(escapeHtml(trimmedLine.slice(6)))}</span></div>`);
      continue;
    }
    if (level === 0 && trimmedLine.startsWith('### ')) {
      result.push(`<div class="md-h3" data-line="${i}">${inlineMarkdown(escapeHtml(trimmedLine.slice(4)))}</div>`);
      continue;
    }
    if (level === 0 && trimmedLine.startsWith('## ')) {
      result.push(`<div class="md-h2" data-line="${i}">${inlineMarkdown(escapeHtml(trimmedLine.slice(3)))}</div>`);
      continue;
    }
    if (level === 0 && trimmedLine.startsWith('# ')) {
      result.push(`<div class="md-h1" data-line="${i}">${inlineMarkdown(escapeHtml(trimmedLine.slice(2)))}</div>`);
      continue;
    }
    if (level === 0 && /^([-*_])\s*(?:\1\s*){2,}$/.test(trimmedLine)) {
      result.push(`<hr class="md-hr" data-line="${i}">`);
      continue;
    }
    if (/^[-*] /.test(trimmedLine)) {
      result.push(`<div class="md-bullet${indentClass}" data-line="${i}">${inlineMarkdown(escapeHtml(trimmedLine.slice(2)))}</div>`);
      continue;
    }
    if (/^> /.test(trimmedLine)) {
      result.push(`<div class="md-blockquote${indentClass}" data-line="${i}">${inlineMarkdown(escapeHtml(trimmedLine.slice(2)))}</div>`);
      continue;
    }
    if (/^\d+\. /.test(trimmedLine)) {
      const m = trimmedLine.match(/^(\d+)\. (.*)/);
      // Auto-increment: reset counter only for new deeper nesting or new list block
      if (lastOrderedLevel < 0) {
        // New ordered list block after non-list line
        orderedCounters[level] = 1;
      } else if (level > lastOrderedLevel) {
        // Going deeper — start new sub-list
        orderedCounters[level] = 1;
      } else {
        // Same level or returning from deeper — continue counting
        orderedCounters[level] = (orderedCounters[level] || 0) + 1;
      }
      lastOrderedLevel = level;
      const displayNum = orderedCounters[level];
      result.push(`<div class="md-ordered${indentClass}" data-line="${i}"><span class="md-order-num">${displayNum}.</span> ${inlineMarkdown(escapeHtml(m[2]))}</div>`);
      continue;
    }
    if (line === '') {
      result.push(`<div class="md-empty" data-line="${i}"></div>`);
      continue;
    }
    result.push(`<div class="md-line${indentClass}" data-line="${i}">${inlineMarkdown(escapeHtml(trimmedLine))}</div>`);
  }
  // Handle unclosed code block
  if (inCodeBlock) {
    result.push(`<pre class="md-codeblock" data-line="${codeStart}" data-line-end="${lines.length - 1}"><code>` + codeLines.map(l => escapeHtml(l)).join('\n') + '</code></pre>');
  }
  return result.join('');
}

// ブラウザでは module が未定義なので、この行は classic script の読み込みに影響しない
if (typeof module !== 'undefined') {
  module.exports = { renderMarkdown };
}
