// OVJU — Design-Codes: kurzer Code ⇄ komplettes Design (Form, Muster, Gravur, Farbe …)
// Server vergibt den Code deterministisch (gleiches Design → gleicher Code), speichert die Konfiguration.
const $ = (s) => document.querySelector(s);

export const formatCode = (c) => c ? String(c).replace(/(.{3})(?=.)/g, '$1-') : '';
export const normalizeCode = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^OVJU/, '');
/** HTML-Sonderzeichen maskieren — Pflicht für alles, was aus Nutzer-/Serverdaten per innerHTML gerendert wird
 *  (Gravurtext, Farbnamen, Codes …); geteilte Design-Codes/Listen bringen fremde Eingaben in den eigenen Browser. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Design speichern → Code */
export async function saveDesign(config) {
  const r = await (await fetch('/api/design', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }),
  })).json();
  if (!r.ok) throw new Error(r.error || 'Design konnte nicht gespeichert werden');
  return r.code;
}

/** Code → Konfiguration */
export async function loadDesign(code) {
  const c = normalizeCode(code);
  if (c.length < 4) throw new Error('Bitte einen Design-Code eingeben (z. B. K7P-3QX).');
  const r = await (await fetch(`/api/design/${encodeURIComponent(c)}`)).json();
  if (!r.ok) throw new Error(r.error || 'Code unbekannt');
  return { code: r.code, config: r.config };
}

export const designLink = (code) => `${location.origin}${location.pathname}?d=${code}`;

/** Vorschaubild (JPEG data-URL) zu einem Design-Code hochladen — für Listen & Warenkorb */
export async function uploadThumb(code, dataURL) {
  if (!code || !dataURL || !dataURL.startsWith('data:image/jpeg')) return false;
  try { const r = await fetch(`/api/design/${code}/thumb`, { method: 'PUT', body: dataURL }); return r.ok; }
  catch { return false; }
}

let getThumb = null;    // () => JPEG data-URL der aktuellen Vorschau (optional)
let getConfig = null;   // () => config des aktuellen Designs
let applyConfig = null; // (config) => Design in den Konfigurator laden
let lastCode = null;
let onListCode = null;  // (code) => Liste öffnen, wenn ein Listen-Code eingegeben wird
let lastSig = null;

async function showCurrent() {
  const cfg = getConfig();
  const sig = JSON.stringify(cfg);
  const out = $('#dc-code'); const link = $('#dc-link');
  if (sig !== lastSig) {
    out.textContent = '…'; out.classList.add('busy');
    try { lastCode = await saveDesign(cfg); lastSig = sig; if (getThumb) uploadThumb(lastCode, getThumb()); }
    catch (e) { out.textContent = '—'; $('#dc-err').textContent = e.message; return; }
  }
  out.classList.remove('busy');
  out.textContent = formatCode(lastCode);
  link.value = designLink(lastCode);
}

export function openCodeDialog(mode = 'show') {
  $('#dc-err').textContent = '';
  $('#dc-msg').textContent = '';
  $('#dc-input').value = '';
  $('#code-modal').showModal();
  if (mode === 'enter') { $('#dc-input').focus(); return; }
  showCurrent();
}

/** Text in die Zwischenablage — mit Fallback für http:// (Clipboard-API gibt es nur auf https/localhost) */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* weiter mit Fallback */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  // In einen offenen modalen Dialog hängen — alles außerhalb ist „inert“ und ließe sich nicht selektieren
  const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
  host.appendChild(ta);
  ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

async function copy(text, btn) {
  const ok = await copyText(text);
  const old = btn.textContent;
  btn.textContent = ok ? '✓ Kopiert' : 'Bitte markieren & kopieren';
  btn.classList.toggle('ok', ok);
  if (!ok) { const out = $('#dc-code'); const r = document.createRange(); r.selectNodeContents(out); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
  setTimeout(() => { btn.textContent = old; btn.classList.remove('ok'); }, 1800);
}

async function loadFromInput() {
  const err = $('#dc-err'); err.textContent = '';
  const btn = $('#dc-load'); btn.disabled = true;
  try {
    const raw = normalizeCode($('#dc-input').value);
    if (/^L[A-Z0-9]{6}$/.test(raw) && onListCode) { // Listen-Code → Liste öffnen
      $('#code-modal').close();
      await onListCode(raw);
    } else {
      const { code, config } = await loadDesign(raw);
      await applyConfig(config, code);
      $('#code-modal').close();
      history.replaceState(null, '', `${location.pathname}?d=${code}#konfigurator`);
    }
  } catch (e) { err.textContent = e.message; }
  btn.disabled = false;
}

/** Beim Laden mit ?d=CODE bzw. #d=CODE das Design direkt öffnen */
export async function loadFromURL() {
  const m = (location.search + location.hash).match(/[?&#]d=([A-Za-z0-9-]{4,40})/);
  if (!m) return false;
  try {
    const { code, config } = await loadDesign(m[1]);
    await applyConfig(config, code);
    return code;
  } catch { return false; }
}

export function initDesignCodes(opts) {
  getConfig = opts.getConfig; applyConfig = opts.applyConfig; getThumb = opts.getThumb || null;
  if (opts.onListCode) onListCode = opts.onListCode;
  $('#dc-close').addEventListener('click', () => $('#code-modal').close());
  $('#dc-copy').addEventListener('click', (e) => { if (lastCode) copy(formatCode(lastCode), e.currentTarget); });
  $('#dc-copylink').addEventListener('click', (e) => { if (lastCode) copy(designLink(lastCode), e.currentTarget); });
  $('#dc-share').addEventListener('click', async (e) => {
    if (!lastCode) return;
    if (navigator.share) {
      try { await navigator.share({ title: 'Mein OVJU-Design', text: `Design-Code ${formatCode(lastCode)}`, url: designLink(lastCode) }); } catch { /* abgebrochen */ }
    } else copy(designLink(lastCode), e.currentTarget);
  });
  $('#dc-load').addEventListener('click', loadFromInput);
  $('#dc-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadFromInput(); } });
  $('#dc-input').addEventListener('input', (e) => {
    const v = normalizeCode(e.target.value);
    e.target.value = formatCode(v);
  });
  if (!navigator.share) $('#dc-share').hidden = true;
  document.querySelectorAll('[data-open-code]').forEach((b) => b.addEventListener('click', () => openCodeDialog(b.dataset.openCode || 'show')));
}
