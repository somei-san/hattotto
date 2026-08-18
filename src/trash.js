const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const listEl = document.getElementById('list');

function colorVar(color) {
  const map = {
    yellow: '#F9E97A', blue: '#7FB3E0', green: '#8CC98F',
    pink: '#E88FAB', purple: '#C48DD0', gray: '#B8B8B8',
  };
  return map[color] || map.yellow;
}

function formatDeletedAt(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString(I18N.lang() === 'ja' ? 'ja-JP' : 'en-US', {
    month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const countEl = document.getElementById('trash-count');

async function render() {
  let items, trashMax;
  try {
    [items, trashMax] = await Promise.all([
      invoke('get_trash'),
      invoke('get_trash_max'),
    ]);
  } catch (e) {
    console.error('render trash failed:', e);
    listEl.innerHTML = `<div class="empty-msg">${I18N.t('toastLoadFailed')}</div>`;
    return;
  }
  countEl.textContent = `(${items.length} / ${trashMax})`;
  if (items.length === 0) {
    listEl.innerHTML = `<div class="empty-msg">${I18N.t('trashEmptyMessage')}</div>`;
    return;
  }
  // Show newest first
  listEl.innerHTML = items.slice().reverse().map(note => {
    const preview = note.content.slice(0, 120) || I18N.t('emptyNotePlaceholder');
    return `<div class="item" role="listitem">
      <div class="item-color" style="background:${colorVar(note.color)}"></div>
      <div class="item-body">
        <div class="item-preview">${escapeHtml(preview)}</div>
        ${note.deleted_at ? `<div class="item-date">${formatDeletedAt(note.deleted_at)}</div>` : ''}
      </div>
      <div class="item-actions">
        <button class="btn-restore" data-id="${note.id}" aria-label="${I18N.t('restoreButton')}">${I18N.t('restoreButton')}</button>
      </div>
    </div>`;
  }).join('');
}

listEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-restore');
  if (!btn) return;
  try {
    await invoke('restore_note', { id: btn.dataset.id });
    render();
  } catch (e) {
    console.error('restore failed:', e);
    showToast(I18N.t('toastRestoreFailed'));
  }
});

document.getElementById('btn-empty').addEventListener('click', async () => {
  const ok = await window.__TAURI__.dialog.confirm(
    I18N.t('confirmEmptyTrashMessage'),
    { title: I18N.t('appName'), okLabel: I18N.t('delete'), cancelLabel: I18N.t('cancel') }
  );
  if (!ok) return;
  try {
    await invoke('empty_trash');
    render();
  } catch (e) {
    console.error('empty trash failed:', e);
    showToast(I18N.t('toastEmptyTrashFailed'));
  }
});

// ── ⌘W to close window ─────────────────────────────
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
    e.preventDefault();
    window.__TAURI__.webviewWindow.getCurrentWebviewWindow().close();
  }
});

// ── Listen for settings changes ──────────────────
listen('settings-changed', (e) => {
  I18N.setLang(I18N.resolve(e.payload.language));
  // 復元ボタン・空メッセージ・日付書式は render() が生成する DOM なので
  // applyDom では届かない
  render();
});

// ── Init ──────────────────────────────────────────
async function init() {
  let settings = null;
  try {
    settings = await invoke('get_settings');
  } catch (e) {
    console.error('get_settings failed:', e);
  }
  I18N.setLang(I18N.resolve(settings?.language));
  render();
}

init();
