// ── Shared utilities ─────────────────────────────────────────
// Common functions used across note.html, trash.html, settings.html.
/* exported escapeHtml, showToast */

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Inject toast CSS once (avoids duplicating styles across HTML files)
(function injectToastStyle() {
  if (document.getElementById('toast-style')) return;
  const style = document.createElement('style');
  style.id = 'toast-style';
  style.textContent = `
    .toast {
      position: fixed;
      bottom: 16px;
      right: 16px;
      background: #D32F2F;
      color: #fff;
      font-size: 13px;
      padding: 8px 16px;
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.25);
      opacity: 0;
      transition: opacity 0.3s ease;
      z-index: 99999;
      pointer-events: none;
    }
    .toast.show { opacity: 1; }
  `;
  document.head.appendChild(style);
})();

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    el.addEventListener('transitionend', () => el.remove());
  }, 3000);
}
