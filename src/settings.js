const { invoke } = window.__TAURI__.core;
const { emit, listen } = window.__TAURI__.event;
const { getCurrentWebviewWindow } = window.__TAURI__.webviewWindow;

let currentColor   = 'yellow';
let currentOpacity = 100;
let currentBringAll = true;
let currentShowPin = true;
let currentShowNew = true;
let currentShowColor = true;
let currentConfirmDelete = true;
let currentAutostart = false;
let currentLanguage = 'auto';

// ── Change Detection ──────────────────────────────
let saved = {
  color: currentColor,
  opacity: currentOpacity,
  bringAll: currentBringAll, showPin: currentShowPin,
  showNew: currentShowNew, showColor: currentShowColor,
  confirmDelete: currentConfirmDelete,
  autostart: currentAutostart,
  language: currentLanguage,
};
const saveBtn = document.getElementById('save-btn');
const saveFooter = document.getElementById('save-footer');

function checkDirty() {
  const dirty = currentColor !== saved.color
    || currentOpacity !== saved.opacity
    || currentBringAll !== saved.bringAll
    || currentShowPin !== saved.showPin
    || currentShowNew !== saved.showNew
    || currentShowColor !== saved.showColor
    || currentConfirmDelete !== saved.confirmDelete
    || currentAutostart !== saved.autostart
    || currentLanguage !== saved.language;
  saveBtn.disabled = !dirty;
}

function snapshotSaved() {
  saved = {
    color: currentColor,
    opacity: currentOpacity,
    bringAll: currentBringAll, showPin: currentShowPin,
    showNew: currentShowNew, showColor: currentShowColor,
    confirmDelete: currentConfirmDelete,
    autostart: currentAutostart,
    language: currentLanguage,
  };
}

// ── Tabs ────────────────────────────────────────────
function activateTab(tab) {
  document.querySelectorAll('.tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); t.setAttribute('tabindex', '-1'); });
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  tab.classList.add('active');
  tab.setAttribute('aria-selected', 'true');
  tab.setAttribute('tabindex', '0');
  document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
  saveFooter.style.display = tab.dataset.tab === 'settings' ? '' : 'none';
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => activateTab(tab));
  tab.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const tabs = [...document.querySelectorAll('.tab')];
      const idx = tabs.indexOf(tab);
      const next = e.key === 'ArrowRight'
        ? tabs[(idx + 1) % tabs.length]
        : tabs[(idx - 1 + tabs.length) % tabs.length];
      activateTab(next);
      next.focus();
    }
  });
});

// ── Color Picker ────────────────────────────────────
document.querySelectorAll('#color-picker .color-dot').forEach(dot => {
  dot.addEventListener('click', () => {
    document.querySelectorAll('#color-picker .color-dot').forEach(d => { d.classList.remove('active'); d.setAttribute('aria-checked', 'false'); d.setAttribute('tabindex', '-1'); });
    dot.classList.add('active');
    dot.setAttribute('aria-checked', 'true');
    dot.setAttribute('tabindex', '0');
    currentColor = dot.dataset.color;
    checkDirty();
  });
  dot.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dot.click(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const group = [...document.querySelectorAll('#color-picker .color-dot')];
      const idx = group.indexOf(dot);
      const next = e.key === 'ArrowRight'
        ? group[(idx + 1) % group.length]
        : group[(idx - 1 + group.length) % group.length];
      dot.setAttribute('tabindex', '-1');
      next.setAttribute('tabindex', '0');
      next.focus();
    }
  });
});

// ── Save ─────────────────────────────────────────────
saveBtn.addEventListener('click', async () => {
  try {
    await invoke('update_settings', {
      defaultColor: currentColor,
      opacity: currentOpacity,
      bringAllToFront: currentBringAll,
      showPinButton: currentShowPin,
      showNewButton: currentShowNew,
      showColorButton: currentShowColor,
      confirmBeforeDelete: currentConfirmDelete,
      language: currentLanguage,
    });
    // autostart の状態が変わっていたら反映
    if (currentAutostart !== saved.autostart) {
      try {
        if (currentAutostart) {
          await invoke('plugin:autostart|enable');
        } else {
          await invoke('plugin:autostart|disable');
        }
      } catch (e) {
        console.error('autostart toggle failed:', e);
        // 失敗したらトグルを元に戻す
        currentAutostart = saved.autostart;
        autostartToggle.checked = currentAutostart;
      }
    }
    emit('settings-changed', {
      default_color: currentColor,
      opacity: currentOpacity,
      bring_all_to_front: currentBringAll,
      show_pin_button: currentShowPin,
      show_new_button: currentShowNew,
      show_color_button: currentShowColor,
      confirm_before_delete: currentConfirmDelete,
      language: currentLanguage,
    });
    snapshotSaved();
    getCurrentWebviewWindow().close();
  } catch (e) {
    console.error('設定の保存に失敗しました:', e);
    showToast(I18N.t('toastSettingsSaveFailed'));
  }
});

// ── Opacity Slider ────────────────────────────────────
const opacitySlider = document.getElementById('opacity-slider');
const opacityValue  = document.getElementById('opacity-value');

opacitySlider.addEventListener('input', () => {
  currentOpacity = parseInt(opacitySlider.value, 10);
  opacityValue.textContent = `${currentOpacity}%`;
  checkDirty();
});

// ── Bring All Toggle ──────────────────────────────
const bringAllToggle = document.getElementById('bring-all-toggle');
bringAllToggle.addEventListener('change', () => {
  currentBringAll = bringAllToggle.checked;
  checkDirty();
});

// ── Show Pin Toggle ──────────────────────────────
const showPinToggle = document.getElementById('show-pin-toggle');
showPinToggle.addEventListener('change', () => {
  currentShowPin = showPinToggle.checked;
  checkDirty();
});

// ── Show New Toggle ──────────────────────────────
const showNewToggle = document.getElementById('show-new-toggle');
showNewToggle.addEventListener('change', () => {
  currentShowNew = showNewToggle.checked;
  checkDirty();
});

// ── Show Color Toggle ──────────────────────────────
const showColorToggle = document.getElementById('show-color-toggle');
showColorToggle.addEventListener('change', () => {
  currentShowColor = showColorToggle.checked;
  checkDirty();
});

// ── Confirm Delete Toggle ──────────────────────────────
const confirmDeleteToggle = document.getElementById('confirm-delete-toggle');
confirmDeleteToggle.addEventListener('change', () => {
  currentConfirmDelete = confirmDeleteToggle.checked;
  checkDirty();
});

// ── Autostart Toggle ─────────────────────────────────
const autostartToggle = document.getElementById('autostart-toggle');

autostartToggle.addEventListener('change', () => {
  currentAutostart = autostartToggle.checked;
  checkDirty();
});

// ── Language Select ──────────────────────────────────
// 保存を待たず選択直後に UI へ反映する（プレビュー。保存せず閉じても次回は保存値から読み直すので巻き戻しは不要）
const languageSelect = document.getElementById('language-select');
languageSelect.addEventListener('change', () => {
  currentLanguage = languageSelect.value;
  I18N.setLang(I18N.resolve(currentLanguage));
  checkDirty();
});

// ── Load current settings ────────────────────────────
async function init() {
  const [s, autostartEnabled] = await Promise.all([
    invoke('get_settings'),
    invoke('plugin:autostart|is_enabled'),
  ]);

  currentLanguage = s.language ?? 'auto';
  I18N.setLang(I18N.resolve(currentLanguage));
  languageSelect.value = currentLanguage;

  currentColor = s.default_color;

  document.querySelectorAll('#color-picker .color-dot').forEach(d => {
    const isActive = d.dataset.color === currentColor;
    d.classList.toggle('active', isActive);
    d.setAttribute('aria-checked', isActive ? 'true' : 'false');
    d.setAttribute('tabindex', isActive ? '0' : '-1');
  });

  currentOpacity = s.opacity ?? 100;
  opacitySlider.value = currentOpacity;
  opacityValue.textContent = `${currentOpacity}%`;

  currentBringAll = s.bring_all_to_front !== false;
  bringAllToggle.checked = currentBringAll;

  currentShowPin = s.show_pin_button !== false;
  showPinToggle.checked = currentShowPin;

  currentShowNew = s.show_new_button !== false;
  showNewToggle.checked = currentShowNew;

  currentShowColor = s.show_color_button !== false;
  showColorToggle.checked = currentShowColor;

  currentConfirmDelete = s.confirm_before_delete !== false;
  confirmDeleteToggle.checked = currentConfirmDelete;

  currentAutostart = !!autostartEnabled;
  autostartToggle.checked = currentAutostart;

  snapshotSaved();

  // Open help tab if requested via query parameter
  const params = new URLSearchParams(window.location.search);
  if (params.get('tab') === 'help') {
    switchToTab('help');
  }

  // Version badge
  if (window.__TAURI__.app) {
    window.__TAURI__.app.getVersion().then(v => {
      document.getElementById('version-badge').textContent = `v${v}`;
    }).catch(() => {
      document.getElementById('version-badge').textContent = 'v?.?.?';
    });
  } else {
    document.getElementById('version-badge').textContent = 'v?.?.?';
  }
}

function switchToTab(name) {
  if (!/^[a-z]+$/.test(name)) return;
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (!tab || !document.getElementById(`panel-${name}`)) {
    switchToTab('settings');
    return;
  }
  activateTab(tab);
}

// ── ⌘W to close window ─────────────────────────────
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
    e.preventDefault();
    getCurrentWebviewWindow().close();
  }
});

// Listen for switch-tab event from Rust
listen('switch-tab', (event) => {
  switchToTab(event.payload);
});

init().catch(e => console.error('settings init failed:', e));
