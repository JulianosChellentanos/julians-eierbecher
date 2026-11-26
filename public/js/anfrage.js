// formsam — Anfrageformular (ein Dialog für „Farbe anfragen“ und „Individuelles Angebot“; Desktop und Handy)
//   openAnfrage({ anlass: 'farbe', farbe: { id, name }, code? })  — Farbe, die es nur auf Anfrage gibt (Konfigurator; Warenkorb und Listen
//                                                                    geben den Design-Code ihrer Position mit, sonst das aktuelle Design)
//   openAnfrage({ anlass: 'angebot' })                      — Sonderwunsch (Hinweis im Konfigurator, FAQ, Fußzeile, Adresse #angebot)
// Name, E-Mail, Nachricht (je Anlass vorausgefüllt), bei Farben „Gib mir Bescheid, sobald die Farbe bestellbar ist“; das aktuelle Design
// geht als Design-Code mit (dieselbe Code-Funktion wie „Design-Code anzeigen“, abwählbar). Unsichtbares Fallen-Feld „website“ gegen Bots.
// POST /api/anfrage → Meldung an den Shop (Antwort kommt von Hand von der Antwortadresse — es gibt bewusst keine automatische Mail an
// die angegebene Adresse). Elemente mit data-anfrage="angebot" (oder Links auf #angebot) öffnen den Dialog ohne eigenes Skript.
import { getUser, emailLokalFehler } from './auth.js';
import { getPricing } from './pricing.js';
import { formatCode } from './designcode.js';

const $ = (s) => document.querySelector(s);
let getDesign = null;      // async () => { code, config } — vom Konfigurator (app.js)
let stand = null;          // { anlass, farbe } des offenen Dialogs
let codeLauf = null;       // Promise des Design-Codes für den offenen Dialog
let code = null;
let oeffnung = 0;          // zählt jedes Öffnen — ein spät fertiger Code eines früheren Öffnens überschreibt nichts

/** Antwortadresse aus /api/pricing → kontakt.email (Reply-To der Shop-Mails, sonst Firmen-E-Mail) — '' ohne */
export const kontaktEmail = () => String(getPricing()?.kontakt?.email || '').trim();

const TEXTE = {
  farbe: {
    titel: '✉️ Farbe anfragen',
    lead: (f) => `„${f}“ gibt es gerade nur auf Anfrage. Schreib mir kurz – ich sage dir, ab wann und zu welchem Preis ich deine Vase in dieser Farbe drucken kann.`,
    nachricht: (f) => `Hallo, ich hätte meine Vase gern in „${f}“. Ab wann wäre das möglich, und wie lange würde es dauern?`,
  },
  angebot: {
    titel: '💬 Individuelles Angebot',
    lead: () => 'Andere Größe, mehr Stück, eine besondere Farbe oder eine ganz eigene Form? Beschreib mir deinen Wunsch – ich melde mich mit einem individuellen Angebot.',
    nachricht: () => 'Hallo, ich hätte gern ein individuelles Angebot. Mein Wunsch: ',
  },
};

function fehler(text, feld = null) {
  const el = $('#anf-error');
  el.textContent = text || '';
  el.hidden = !text;
  if (feld) $(`#anf-${feld}`)?.focus();
}
/** Hinweis zum angehängten Design: „Mein aktuelles Design mitschicken (Design-Code K7P-3QX)“ */
function codeZeile(text) { const el = $('#anf-code-name'); if (el) el.textContent = text; }

export function openAnfrage({ anlass = 'angebot', farbe = null, code: designCode = null } = {}) {
  const dlg = $('#anfrage-modal');
  if (!dlg) return;
  const a = anlass === 'farbe' && farbe ? 'farbe' : 'angebot';
  stand = { anlass: a, farbe: a === 'farbe' ? { id: farbe.id, name: farbe.name } : null };
  const t = TEXTE[a];
  $('#anf-title').textContent = t.titel;
  $('#anf-lead').textContent = t.lead(stand.farbe?.name || '');
  const mail = kontaktEmail();
  const direkt = $('#anf-direkt');
  if (direkt) { direkt.hidden = !mail; $('#anf-direkt-mail').textContent = mail; }
  // Nachricht nur neu vorausfüllen, wenn sie leer ist oder noch der Vorschlag eines Anlasses — Getipptes bleibt stehen
  const msg = $('#anf-nachricht');
  const vorschlaege = new Set(Object.values(TEXTE).map((x) => x.nachricht(stand.farbe?.name || '')));
  if (!msg.value.trim() || vorschlaege.has(msg.value) || msg.dataset.vorschlag === msg.value) {
    msg.value = t.nachricht(stand.farbe?.name || '');
    msg.dataset.vorschlag = msg.value;
  }
  $('#anf-notify-row').hidden = a !== 'farbe';
  const u = getUser();
  if (u && !$('#anf-name').value) $('#anf-name').value = u.name || '';
  if (u && !$('#anf-email').value) $('#anf-email').value = u.email || '';
  $('#anfrage-form').hidden = false;
  $('#anf-done').hidden = true;
  fehler('');
  $('#anf-submit').disabled = false;
  // Design-Code des aktuellen Designs vorbereiten (gleich beim Öffnen — beim Absenden ist er dann meist schon da)
  const lauf = ++oeffnung;
  // designCode: fester Code (Liste, Warenkorbzeile mit Code) oder Funktion → Promise<Code> (Warenkorbzeile ohne Code); sonst das aktuelle Design
  code = typeof designCode === 'string' && designCode ? designCode : null;
  const holen = typeof designCode === 'function' ? designCode : getDesign ? () => getDesign().then((d) => d?.code || null) : null;
  $('#anf-code').checked = true;
  $('#anf-code-row').hidden = !code && !holen;
  const was = $('#anf-code-was'); if (was) was.textContent = designCode ? 'Das Design' : 'Mein aktuelles Design';
  if (code) { codeZeile(`Design-Code ${formatCode(code)}`); codeLauf = Promise.resolve(code); }
  else {
    codeZeile('wird vorbereitet …');
    codeLauf = holen ? Promise.resolve().then(holen).then((c) => {
      if (lauf !== oeffnung) return null;
      code = c || null; codeZeile(code ? `Design-Code ${formatCode(code)}` : 'nicht verfügbar'); return code;
    }).catch(() => { if (lauf === oeffnung) codeZeile('gerade nicht verfügbar'); return null; }) : Promise.resolve(null);
  }
  if (!dlg.open) dlg.showModal();
  setTimeout(() => ($('#anf-name').value ? msg : $('#anf-name')).focus(), 60);
}

async function absenden(e) {
  e.preventDefault();
  const btn = $('#anf-submit');
  if (btn.disabled || !stand) return;
  const name = $('#anf-name').value.trim(), email = $('#anf-email').value.trim(), nachricht = $('#anf-nachricht').value.trim();
  if (name.length < 2) return fehler('Bitte gib deinen Namen an.', 'name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fehler('Bitte gib eine gültige E-Mail-Adresse an – dorthin bekommst du meine Antwort.', 'email');
  const lokal = emailLokalFehler(email);
  if (lokal) return fehler(lokal, 'email');
  if (!nachricht) return fehler('Bitte schreib mir kurz, was du dir wünschst.', 'nachricht');
  btn.disabled = true;
  fehler('');
  const mitCode = !$('#anf-code-row').hidden && $('#anf-code').checked;
  const c = mitCode ? await Promise.race([codeLauf, new Promise((r) => setTimeout(() => r(code), 8000))]) : null;
  let r;
  try {
    const res = await fetch('/api/anfrage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anlass: stand.anlass, farbe: stand.farbe?.id || undefined, name, email, nachricht,
        benachrichtigen: stand.anlass === 'farbe' && $('#anf-notify').checked, code: c || undefined, website: $('#anf-website').value,
      }),
    });
    r = await res.json().catch(() => ({ ok: false, error: 'Der Shop antwortet gerade nicht – bitte versuch es gleich noch einmal.' }));
  } catch { r = { ok: false, error: 'Keine Verbindung zum Shop – bitte prüf deine Internetverbindung und versuch es noch einmal.' }; }
  btn.disabled = false;
  if (!r?.ok) return fehler(r?.error || 'Das hat gerade nicht geklappt – bitte versuch es noch einmal.', ['name', 'email', 'nachricht'].includes(r?.feld) ? r.feld : null);
  const von = String(r.antwortVon || kontaktEmail() || '').trim();
  $('#anf-done-text').textContent = `Danke! Ich melde mich per E-Mail bei dir${von ? ` (von ${von})` : ''}.`;
  $('#anfrage-form').hidden = true;
  $('#anf-done').hidden = false;
  $('#anf-nachricht').value = ''; delete $('#anf-nachricht').dataset.vorschlag;
  $('#anf-done-close')?.focus();
}

/** Einmal beim Start: Dialog verdrahten, Klicks auf [data-anfrage] und Links auf #angebot abfangen, #angebot in der Adresse öffnen */
export function initAnfrage(opts = {}) {
  getDesign = typeof opts.getDesign === 'function' ? opts.getDesign : null;
  const dlg = $('#anfrage-modal');
  if (!dlg) return;
  $('#anfrage-form').addEventListener('submit', absenden);
  for (const id of ['#anf-close', '#anf-cancel', '#anf-done-close']) $(id)?.addEventListener('click', () => dlg.close());
  for (const f of ['name', 'email', 'nachricht']) $(`#anf-${f}`)?.addEventListener('input', () => { if (!$('#anf-error').hidden) fehler(''); });
  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-anfrage="angebot"], a[href="#angebot"]');
    if (!el) return;
    e.preventDefault();
    openAnfrage({ anlass: 'angebot' });
  });
  if (location.hash === '#angebot') openAnfrage({ anlass: 'angebot' });
}
