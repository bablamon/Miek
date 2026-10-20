// Miek updates: a few seconds after start, ask whether a newer release is out and offer it in a
// pop-up; Settings → Updates checks by hand. Installing is done natively (src-tauri/src/update.rs):
// download, signature check against Miek's release key, install, restart.
// Loaded after app.js; uses its globals (invoke, h, $, toast, fail, closeModal).

const UPD = { busy: false };

async function checkForUpdate({ quiet = true } = {}) {
  try {
    const info = await invoke('update_check');
    if (info) updateDialog(info);
    else if (!quiet) toast(`You have the latest version (${await invoke('app_version')})`);
    return info;
  } catch (e) {
    if (!quiet) fail(e);
    return null;
  }
}

function updateDialog(info) {
  if (UPD.busy) return;
  const fill = h('div', { class: 'upd-fill' });
  const bar = h('div', { class: 'upd-bar hidden' }, fill);
  const status = h('p', { class: 'fine upd-status' });
  const later = h('button', { class: 'btn', text: 'Later', onclick: () => !UPD.busy && closeModal() });
  const now = h('button', { class: 'btn primary', text: 'Update now' });
  const box = h('div', { class: 'modal-card glass-solid upd' },
    h('h3', { text: `Miek ${info.version} is available` }),
    h('p', { text: `You have ${info.current}.${info.date ? ` Released ${info.date}.` : ''} Your music, likes and settings stay as they are.` }),
    info.notes ? h('div', { class: 'upd-notes', text: info.notes }) : null,
    bar, status,
    h('div', { class: 'modal-actions' }, later, now));
  now.onclick = async () => {
    UPD.busy = true;
    now.disabled = later.disabled = true;
    now.textContent = 'Downloading…';
    status.textContent = '';
    bar.classList.remove('hidden');
    const tick = setInterval(async () => {
      const [got, total] = await invoke('update_progress').catch(() => [0, 0]);
      fill.style.width = total ? `${Math.min(100, (100 * got) / total)}%` : '30%';
      if (total) status.textContent = `${fmtSize(got)} of ${fmtSize(total)}`;
    }, 200);
    try {
      await invoke('update_install'); // closes Miek on Windows; the installer starts it again
      clearInterval(tick);
      fill.style.width = '100%';
      now.textContent = 'Installing…';
      status.textContent = 'Miek restarts in a moment.';
    } catch (e) {
      clearInterval(tick);
      UPD.busy = false;
      bar.classList.add('hidden');
      status.textContent = String(e).replace(/^Error:\s*/, '');
      now.disabled = later.disabled = false;
      now.textContent = 'Try again';
    }
  };
  $('modal').replaceChildren(box);
  $('modal').classList.remove('hidden');
  $('modal').onmousedown = (e) => { if (e.target === $('modal') && !UPD.busy) closeModal(); };
  now.focus();
}

function updateSettings() {
  const label = h('div', { class: 'label', text: 'Miek' });
  const note = h('div', { class: 'fine', text: 'Miek checks for a new version when it starts.' });
  invoke('app_version').then((v) => (label.textContent = `Miek ${v}`)).catch(() => {});
  const btn = h('button', { class: 'btn', text: 'Check for updates' });
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Checking…';
    await checkForUpdate({ quiet: false });
    btn.disabled = false;
    btn.textContent = 'Check for updates';
  };
  return h('div', { class: 'panel' }, h('div', { class: 'setting' }, h('div', {}, label, note), btn));
}

setTimeout(() => checkForUpdate(), 6000); // after the intro, quietly
