// OVJU — Design-Listen: Sammlungen von Designs (z. B. für eine Hochzeit) mit
// Vorschau, Design-Code und Menge. Eigene Listen liegen mit Bearbeitungs-Token
// im localStorage, geteilte Listen werden per Code/Link nur gelesen.
import { addToCart, itemTitle, itemSub } from './cart.js';
import { showToast, IS_MOBILE } from './mobile.js';
import { copyText, formatCode, normalizeCode } from './designcode.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const OCCASIONS = {
  hochzeit: { label: 'Hochzeit', icon: '💍' },
  geburtstag: { label: 'Geburtstag', icon: '🎂' },
  taufe: { label: 'Taufe', icon: '🕊️' },
  weihnachten: { label: 'Weihnachten', icon: '🎄' },
  firma: { label: 'Firma & Team', icon: '🏢' },
  sonstiges: { label: 'Sonstiges', icon: '📋' },
};

/** Listen-Code lesbar: LK7P3QX → L-K7P-3QX */
export const formatListCode = (c) => c ? `L-${String(c).slice(1).replace(/(.{3})(?=.)/g, '$1-')}` : '';
export const isListCode = (c) => /^L[A-Z0-9]{6}$/.test(normalizeCode(c));
export const listLink = (code) => `${location.origin}${location.pathname}?l=${code}`;

// --- eigene Listen (Code + Token) -------------------------------------------
const KEY = 'ovju-lists-v1';
let mine = [];
try { mine = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { mine = []; }
const saveMine = () => { try { localStorage.setItem(KEY, JSON.stringify(mine)); } catch { /* voll/gesperrt */ } };
const tokenFor = (code) => mine.find((l) => l.code === code)?.token || null;

let hooks = { getDesign: null, applyDesign: null, colorInfo: null };
let current = null;   // geöffnete Liste (Serverstand)
let view = 'home';

// --- API --------------------------------------------------------------------
async function api(path, method = 'GET', body) {
  const r = await fetch(path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({ ok: false, error: 'Serverfehler' }));
  if (!j.ok) throw new Error(j.error || 'Fehler');
  return j;
}

export async function createList({ name, occasion, note, items }) {
  const r = await api('/api/list', 'POST', { name, occasion, note, items });
  mine.unshift({ code: r.code, token: r.token, name: r.list.name });
  saveMine();
  return r.list;
}
export async function loadList(code) {
  const c = normalizeCode(code);
  const r = await api(`/api/list/${encodeURIComponent(c)}`);
  return r.list;
}
async function updateList(code, patch) {
  const token = tokenFor(code);
  if (!token) throw new Error('Diese Liste gehört jemand anderem — du kannst sie kopieren.');
  const r = await api(`/api/list/${encodeURIComponent(code)}`, 'PUT', { token, ...patch });
  const m = mine.find((l) => l.code === code); if (m && patch.name) { m.name = patch.name; saveMine(); }
  return r.list;
}
async function deleteList(code) {
  const token = tokenFor(code);
  if (!token) return;
  await api(`/api/list/${encodeURIComponent(code)}`, 'DELETE', { token });
  mine = mine.filter((l) => l.code !== code); saveMine();
}

/** Ein Design (Code + optional Vorschau) in eine Liste legen — gleiche Codes werden zusammengezählt */
export async function addDesignToList(code, designCode, qty = 1) {
  const list = await loadList(code);
  const items = list.items.slice();
  const ex = items.find((it) => it.code === designCode);
  if (ex) ex.qty = Math.min(50, (ex.qty || 1) + qty);
  else items.push({ code: designCode, qty });
  return updateList(code, { items });
}

// --- Rendering ----------------------------------------------------------------
const fakeItem = (it) => ({ product: it.config?.product || 'vase', config: it.config || {}, colorName: hooks.colorInfo?.(it.config?.color)?.name || '', saucer: !!it.config?.saucer });

function renderHome() {
  view = 'home'; current = null;
  const box = $('#ls-body');
  box.innerHTML = `
    <p class="dc-lead">Sammle Designs zu einer Liste — für die Hochzeitstafel, den Geburtstag oder das Team. Jede Liste hat einen Code zum Teilen; wer ihn hat, sieht alle Designs mit Vorschau und kann sie laden oder bestellen.</p>
    <div class="ls-new">
      <input id="ls-name" placeholder="Name der Liste, z. B. Hochzeit Anna & Tom" maxlength="60">
      <div class="ls-occ" id="ls-occ">${Object.entries(OCCASIONS).map(([id, o], i) => `<button class="occ-chip ${i === 0 ? 'active' : ''}" data-occ="${id}">${o.icon} ${o.label}</button>`).join('')}</div>
      <button class="btn btn-primary" id="ls-create">➕ Liste anlegen</button>
    </div>
    <div class="ls-open">
      <label class="dc-enter-label" for="ls-code">Liste per Code öffnen</label>
      <div class="dc-enter-row"><input id="ls-code" placeholder="z. B. L-K7P-3QX" autocomplete="off" autocapitalize="characters" spellcheck="false"><button class="btn btn-ghost" id="ls-openbtn">Öffnen</button></div>
      <div class="tiny err-msg" id="ls-err"></div>
    </div>
    <h3 class="ls-h3">Meine Listen</h3>
    <div class="ls-mine" id="ls-mine">${mine.length ? mine.map((l) => `
      <button class="ls-card" data-open="${l.code}"><span class="ls-card-name">${esc(l.name)}</span><span class="ls-card-code">${formatListCode(l.code)}</span></button>`).join('')
      : '<p class="tiny left">Noch keine Liste — leg oben deine erste an. 🎉</p>'}</div>`;
  let occ = 'hochzeit';
  box.querySelectorAll('.occ-chip').forEach((b) => b.addEventListener('click', () => {
    occ = b.dataset.occ; box.querySelectorAll('.occ-chip').forEach((x) => x.classList.toggle('active', x === b));
  }));
  $('#ls-create').addEventListener('click', async () => {
    const name = $('#ls-name').value.trim() || `${OCCASIONS[occ].label} ${new Date().getFullYear()}`;
    try { const l = await createList({ name, occasion: occ, items: [] }); await openList(l.code); showToast(`📋 Liste „${l.name}“ angelegt`); }
    catch (e) { $('#ls-err').textContent = e.message; }
  });
  const openFromInput = async () => {
    $('#ls-err').textContent = '';
    try { await openList($('#ls-code').value); } catch (e) { $('#ls-err').textContent = e.message; }
  };
  $('#ls-openbtn').addEventListener('click', openFromInput);
  $('#ls-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); openFromInput(); } });
  box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openList(b.dataset.open).catch((e) => { $('#ls-err').textContent = e.message; })));
}

function renderList(list) {
  view = 'list'; current = list;
  const own = !!tokenFor(list.code);
  const occ = OCCASIONS[list.occasion] || OCCASIONS.sonstiges;
  const total = list.items.reduce((s, it) => s + (it.qty || 1), 0);
  const box = $('#ls-body');
  box.innerHTML = `
    <button class="linkbtn ls-back" id="ls-back">← Meine Listen</button>
    <div class="ls-head">
      <div class="ls-title">
        <span class="ls-occ-badge">${occ.icon} ${occ.label}</span>
        ${own ? `<input class="ls-name-edit" id="ls-rename" value="${esc(list.name)}" maxlength="60" title="Name ändern">` : `<h2>${esc(list.name)}</h2>`}
        <div class="tiny left">${list.items.length} Design${list.items.length === 1 ? '' : 's'} · ${total} Stück${own ? '' : ' · geteilte Liste (nur lesen)'}</div>
      </div>
      <div class="ls-share">
        <span class="ls-codebig">${formatListCode(list.code)}</span>
        <div class="ls-share-btns">
          <button class="btn btn-ghost" id="ls-copycode">Code kopieren</button>
          <button class="btn btn-ghost" id="ls-copylink">🔗 Link</button>
          ${navigator.share ? '<button class="btn btn-ghost" id="ls-sharebtn">📤 Teilen</button>' : ''}
        </div>
      </div>
    </div>
    ${list.items.length ? `<div class="ls-grid">${list.items.map((it, i) => {
      const fi = fakeItem(it);
      const col = hooks.colorInfo?.(it.config?.color);
      return `<div class="ls-item" data-i="${i}">
        <div class="ls-thumb" style="--sw:${col?.hex || '#ddd'}"><img src="/api/design/${it.code}/thumb" alt="" loading="lazy" onerror="this.remove()"><span class="ls-thumb-fb">${it.config?.product === 'eierbecher' ? '🥚' : '🏺'}</span></div>
        <div class="ls-item-main">
          <b>${esc(itemTitle(fi))}</b>
          <small>${esc(itemSub(fi))}</small>
          <div class="ls-item-row">
            <button class="ci-code" data-code="${it.code}" title="Design-Code kopieren">🔖 ${formatCode(it.code)}</button>
            ${own ? `<span class="ci-step"><button data-q="${i}" data-d="-1">−</button><span>${it.qty || 1}</span><button data-q="${i}" data-d="1">+</button></span>` : `<span class="ls-qty">${it.qty || 1} ×</span>`}
          </div>
          <div class="ls-item-btns">
            <button class="btn btn-ghost" data-load="${i}">👁 Ansehen</button>
            <button class="btn btn-primary" data-cart="${i}">🛒 In den Warenkorb</button>
            ${own ? `<button class="btn btn-ghost ls-del" data-del="${i}" title="Aus der Liste entfernen">🗑</button>` : ''}
          </div>
        </div>
      </div>`; }).join('')}</div>`
      : `<p class="cart-empty">Noch leer.<br><small>${own ? 'Füge unten dein aktuelles Design hinzu oder gestalte im Konfigurator und wähle dort „Zu Liste hinzufügen“.' : 'Der Besitzer hat noch nichts hinzugefügt.'}</small></p>`}
    <div class="ls-foot">
      ${own ? `<button class="btn btn-ghost" id="ls-addcur">➕ Aktuelles Design hinzufügen</button>` : `<button class="btn btn-ghost" id="ls-copy">📋 Als eigene Liste kopieren</button>`}
      ${list.items.length ? `<button class="btn btn-primary" id="ls-allcart">🛒 Alle ${total} in den Warenkorb</button>` : ''}
      ${own ? `<button class="linkbtn ls-delete" id="ls-delete">Liste löschen</button>` : ''}
    </div>`;

  $('#ls-back').addEventListener('click', renderHome);
  $('#ls-copycode').addEventListener('click', (e) => flash(e.currentTarget, copyText(formatListCode(list.code))));
  $('#ls-copylink').addEventListener('click', (e) => flash(e.currentTarget, copyText(listLink(list.code))));
  $('#ls-sharebtn')?.addEventListener('click', async () => {
    try { await navigator.share({ title: `OVJU-Liste „${list.name}“`, text: `Design-Liste ${formatListCode(list.code)}`, url: listLink(list.code) }); } catch { /* abgebrochen */ }
  });
  $('#ls-rename')?.addEventListener('change', async (e) => {
    const name = e.target.value.trim(); if (!name) return;
    try { await updateList(list.code, { name }); showToast('✓ Name gespeichert'); } catch (err) { showToast(err.message); }
  });
  box.querySelectorAll('.ci-code').forEach((b) => b.addEventListener('click', (e) => flash(e.currentTarget, copyText(formatCode(b.dataset.code)), '✓ kopiert')));
  box.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
    // sofort lokal zählen (schnelles Tippen), Server-Abgleich gebündelt
    const it = list.items[+b.dataset.q]; it.qty = Math.max(0, Math.min(50, (it.qty || 1) + (+b.dataset.d)));
    list.items = list.items.filter((x) => x.qty > 0);
    renderList(list);
    syncItemsSoon(list);
  }));
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const items = list.items.filter((_, i) => i !== +b.dataset.del).map((it) => ({ code: it.code, qty: it.qty || 1 }));
    try { renderList(await updateList(list.code, { items })); } catch (e) { showToast(e.message); }
  }));
  box.querySelectorAll('[data-load]').forEach((b) => b.addEventListener('click', async () => {
    const it = list.items[+b.dataset.load];
    $('#lists-modal').close();
    await hooks.applyDesign(it.config, it.code);
    $('#konfigurator').scrollIntoView({ behavior: 'smooth' });
  }));
  const toCart = (it, silent) => {
    const col = hooks.colorInfo?.(it.config?.color);
    addToCart({
      config: it.config, code: it.code,
      colorName: col ? (col.finish && col.finish !== 'matt' ? `${col.name} (${col.finish === 'metall' ? 'metallic' : 'glänzend'})` : col.name) : '',
      colorHex: col?.hex || '#cccccc', thumb: `/api/design/${it.code}/thumb`,
    }, { qty: it.qty || 1, silent });
  };
  box.querySelectorAll('[data-cart]').forEach((b) => b.addEventListener('click', () => {
    $('#lists-modal').close(); toCart(list.items[+b.dataset.cart], false);
  }));
  $('#ls-allcart')?.addEventListener('click', () => {
    $('#lists-modal').close();
    list.items.forEach((it, i) => toCart(it, i < list.items.length - 1));
    showToast(`🛒 ${total} Stück im Warenkorb`);
  });
  $('#ls-addcur')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { renderList(await addCurrentDesign(list.code)); showToast('✓ Design zur Liste hinzugefügt'); }
    catch (err) { showToast(err.message); e.currentTarget.disabled = false; }
  });
  $('#ls-copy')?.addEventListener('click', async () => {
    try {
      const l = await createList({ name: list.name, occasion: list.occasion, items: list.items.map((it) => ({ code: it.code, qty: it.qty || 1 })) });
      renderList(l); showToast('📋 Kopie angelegt — jetzt deine Liste');
    } catch (err) { showToast(err.message); }
  });
  $('#ls-delete')?.addEventListener('click', async () => {
    if (!confirm(`Liste „${list.name}“ wirklich löschen?`)) return;
    await deleteList(list.code); renderHome(); showToast('Liste gelöscht');
  });
}

let syncTimer = null;
function syncItemsSoon(list) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try { await updateList(list.code, { items: list.items.map((it) => ({ code: it.code, qty: it.qty || 1 })) }); }
    catch (e) { showToast(e.message); }
  }, 350);
}

function flash(btn, p, txt = '✓ Kopiert') {
  const old = btn.textContent;
  Promise.resolve(p).then(() => { btn.textContent = txt; setTimeout(() => { btn.textContent = old; }, 1500); });
}

/** Aktuelles Konfigurator-Design (Code + Vorschau) in eine Liste legen */
async function addCurrentDesign(listCode) {
  const d = await hooks.getDesign(); // { code, config } — speichert Design & lädt Vorschau hoch
  return addDesignToList(listCode, d.code, 1);
}

// --- Öffnen -----------------------------------------------------------------
export async function openList(code) {
  const list = await loadList(code);
  if (!$('#lists-modal').open) $('#lists-modal').showModal();
  renderList(list);
  return list;
}
export function openLists() {
  $('#lists-modal').showModal();
  renderHome();
}

/** „Zu Liste hinzufügen“ aus dem Konfigurator: Liste wählen (oder anlegen) */
export async function addCurrentToListFlow() {
  $('#lists-modal').showModal();
  if (!mine.length) { renderHome(); showToast('Leg zuerst eine Liste an 👇'); return; }
  const box = $('#ls-body');
  box.innerHTML = `
    <p class="dc-lead">In welche Liste soll das aktuelle Design?</p>
    <div class="ls-mine">${mine.map((l) => `<button class="ls-card" data-pick="${l.code}"><span class="ls-card-name">${esc(l.name)}</span><span class="ls-card-code">${formatListCode(l.code)}</span></button>`).join('')}</div>
    <button class="linkbtn" id="ls-new-from-pick">➕ Neue Liste anlegen</button>`;
  $('#ls-new-from-pick').addEventListener('click', renderHome);
  box.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { renderList(await addCurrentDesign(b.dataset.pick)); showToast('✓ Zur Liste hinzugefügt'); }
    catch (e) { showToast(e.message); b.disabled = false; }
  }));
}

/** Warenkorb als Liste speichern */
export async function createListFromCart(cartItems) {
  const items = cartItems.filter((it) => it.code).map((it) => ({ code: it.code, qty: it.qty }));
  if (!items.length) throw new Error('Die Warenkorb-Designs haben noch keinen Code — bitte kurz warten.');
  const name = `Meine Auswahl ${new Date().toLocaleDateString('de-DE')}`;
  const l = await createList({ name, occasion: 'sonstiges', items });
  $('#cart-modal').close();
  await openList(l.code);
  showToast('📋 Warenkorb als Liste gespeichert');
}

export async function loadListFromURL() {
  const m = (location.search + location.hash).match(/[?&#]l=([A-Za-z0-9-]{4,20})/);
  if (!m) return false;
  try { await openList(m[1]); return true; } catch { return false; }
}

export function initLists(h) {
  hooks = { ...hooks, ...h };
  $('#ls-close').addEventListener('click', () => $('#lists-modal').close());
  document.querySelectorAll('[data-open-lists]').forEach((b) => b.addEventListener('click', openLists));
  document.querySelectorAll('[data-add-to-list]').forEach((b) => b.addEventListener('click', () => {
    $('#code-modal')?.close();
    addCurrentToListFlow();
  }));
  if (IS_MOBILE) $('#lists-modal').classList.add('sheet');
}
