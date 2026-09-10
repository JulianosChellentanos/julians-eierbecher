// OVJU — E-Mail-Vorlagen (deutsch, herzlich, knapp) im OVJU-Look.
// Jede Vorlage liefert { subject, text, html }. HTML ist E-Mail-tauglich: Tabellenlayout,
// Inline-CSS, max. 560 px, keine externen Bilder/Fonts. Alle Kundenstrings werden escaped.
//
//   Farben: Hintergrund #f4efe7 · Karte #fbf8f2 · Text #211d18 · Akzent #c86f4a · gedämpft #6b6257

const BG = '#f4efe7', CARD = '#fbf8f2', INK = '#211d18', SOFT = '#6b6257', ACCENT = '#c86f4a', LINE = '#e6ddd0';
const SANS = "Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function money(v, settings) {
  const cur = settings?.pricing?.currency || 'EUR';
  return (Number(v) || 0).toLocaleString('de-DE', { style: 'currency', currency: cur });
}
const dateDE = (iso) => { const d = new Date(iso || Date.now()); return isNaN(d) ? '' : d.toLocaleDateString('de-DE'); };
const firstName = (name) => (String(name || '').trim().split(/\s+/)[0] || 'du');
const greeting = (name) => { const f = firstName(name); return f === 'du' ? 'Hallo!' : `Hallo ${f},`; };

// Bezeichnungen (Spiegel von geometry.js — Mails laufen ohne Browser-Module)
const PRODUCT_LABEL = { vase: 'Vase', eierbecher: 'Eierbecher' };
const PRESET_LABEL = {
  flasche: 'Flasche', kugel: 'Kugel', tropfen: 'Tropfen', zylinder: 'Zylinder', kurve: 'Kurve',
  kelch: 'Kelch', schale: 'Schale', tulpe: 'Tulpe', eigene: 'Eigene Form',
};
const PATTERN_LABEL = {
  glatt: 'Glatt', rippen: 'Rippen', wellen: 'Wellen', lamellen: 'Lamellen', zickzack: 'Zickzack',
  querwellen: 'Querwellen', gehaemmert: 'Gehämmert', skelett: 'Voronoi', koralle: 'Fjordwelle',
};
const TEXT_STYLE_LABEL = { gestanzt: 'gestanzt', gepraegt: 'geprägt', gehaemmert: 'gehämmert', kissen: 'Kissen', farbe: 'Farbschrift' };
const FONT_LABEL = {
  helvetiker: 'Modern', optimer: 'Soft', gentilis: 'Fein', droid_sans: 'Kräftig', droid_serif: 'Klassisch', marcellus: 'Edel', greatvibes: 'Kalligrafie',
};
const PAYMENT_LABEL = { paypal: 'PayPal', vorkasse: 'Vorkasse (Überweisung)' };

// Paketverfolgung je Versender
export const CARRIERS = {
  dhl: { label: 'DHL', url: (n) => `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${encodeURIComponent(n)}` },
  hermes: { label: 'Hermes', url: (n) => `https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation#${encodeURIComponent(n)}` },
  dpd: { label: 'DPD', url: (n) => `https://tracking.dpd.de/status/de_DE/parcel/${encodeURIComponent(n)}` },
  gls: { label: 'GLS', url: (n) => `https://gls-group.eu/DE/de/paketverfolgung?match=${encodeURIComponent(n)}` },
  post: { label: 'Deutsche Post', url: (n) => `https://www.deutschepost.de/de/s/sendungsverfolgung.html?piececode=${encodeURIComponent(n)}` },
  sonstige: { label: '', url: null },
};
export function trackingUrl(carrier, trackingNo) {
  const c = CARRIERS[String(carrier || '').toLowerCase()];
  const n = String(trackingNo || '').trim();
  return c && c.url && n ? c.url(n) : '';
}
export function carrierLabel(carrier) {
  return CARRIERS[String(carrier || '').toLowerCase()]?.label || '';
}

// Status-Mails (neu bekommt keine Status-Mail — dafür gibt es die Bestellbestätigung)
export const STATUS_MAIL = {
  bezahlt: { label: 'Zahlung eingegangen', subjectSuffix: '— Zahlung eingegangen, dein Druck startet' },
  'im-druck': { label: 'Im Druck', subjectSuffix: 'liegt gerade auf dem Druckbett' },
  gedruckt: { label: 'Fertig gedruckt', subjectSuffix: 'ist fertig gedruckt und geht in den Versand' },
  versendet: { label: 'Versendet', subjectSuffix: 'ist unterwegs zu dir' },
  storniert: { label: 'Storniert', subjectSuffix: 'wurde storniert' },
  abgeschlossen: { label: 'Abgeschlossen', subjectSuffix: '— danke dir!' },
};
export const statusMailAllowed = (status) => Object.prototype.hasOwnProperty.call(STATUS_MAIL, String(status || ''));

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------
/** Beschreibung einer Bestellzeile als Teile (für „ · “-Verkettung) */
export function lineParts(l) {
  const c = l?.config || {};
  const parts = [
    `${PRODUCT_LABEL[l?.product] || 'Unikat'} „${PRESET_LABEL[c.preset] || c.preset || 'Form'}“`,
    PATTERN_LABEL[c.pattern] || c.pattern || 'Glatt',
    c.height ? `${c.height} mm` : '',
    l?.colorName || '',
  ];
  const text = String(c.text || '').trim();
  if (text) {
    const style = TEXT_STYLE_LABEL[c.textStyle] || '';
    const font = FONT_LABEL[c.font] || '';
    const color = c.textStyle === 'farbe' ? (l.textColorName || c.textColor || '') : '';
    const extra = [style, font ? `Schrift ${font}` : '', color ? `Schriftfarbe ${color}` : ''].filter(Boolean).join(', ');
    parts.push(`Gravur „${text}“${extra ? ` (${extra})` : ''}`);
  }
  if (l?.saucer) parts.push('mit Untersetzer');
  if (l?.code) parts.push(`Design-Code ${l.code}`);
  return parts.filter(Boolean);
}

const p = (html, extra = '') => `<p style="margin:0 0 12px;${extra}">${html}</p>`;
const h2 = (txt) => `<h2 style="margin:22px 0 8px;font-family:${SERIF};font-weight:normal;font-size:18px;line-height:1.3;color:${INK};">${esc(txt)}</h2>`;
const small = (html) => `<p style="margin:0 0 10px;font-size:13px;line-height:1.5;color:${SOFT};">${html}</p>`;
const box = (html) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 14px;"><tr><td style="background:${BG};border-radius:12px;padding:14px 16px;font-family:${SANS};font-size:14px;line-height:1.55;color:${INK};">${html}</td></tr></table>`;
const link = (href, label) => `<a href="${esc(href)}" style="color:${ACCENT};text-decoration:underline;">${esc(label)}</a>`;
// Innenabstand liegt auf dem <td>, nicht auf dem <a> — Outlook (Word-Engine) ignoriert padding/display auf Links
export function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 18px;"><tr><td style="background:${ACCENT};border-radius:999px;padding:12px 24px;">` +
    `<a href="${esc(href)}" style="display:inline-block;font-family:${SANS};font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">${esc(label)}</a></td></tr></table>`;
}
// Preheader-Auffüllung: verhindert, dass Gmail/Apple Mail in der Posteingangs-Vorschau den Kopf-/Anredetext anhängen
const PREHEADER_PAD = '&zwnj;&nbsp;'.repeat(100);
function companyLines(settings) {
  const co = settings?.company || {};
  return [co.name, co.owner, [co.street, [co.zip, co.city].filter(Boolean).join(' ')].filter(Boolean).join(', '), co.email, co.phone]
    .map((x) => String(x || '').trim()).filter(Boolean);
}
function orderLink(baseUrl) { return `${baseUrl}/`; }
function invoiceLink(baseUrl, order) { return `${baseUrl}/orders/${encodeURIComponent(order.orderId)}/rechnung.html`; }

/** Grundlayout (Kopf, Karte, Fußzeile) — bodyHtml kommt in die Karte */
export function renderLayout({ title, preheader = '', bodyHtml, settings, baseUrl }) {
  const brand = settings?.company?.name ? String(settings.company.name).split('—')[0].trim() : 'OVJU';
  const foot = companyLines(settings);
  return `<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${BG};-webkit-text-size-adjust:100%;">
<div style="display:none!important;visibility:hidden;opacity:0;font-size:1px;line-height:1px;color:${BG};max-height:0;max-width:0;overflow:hidden;mso-hide:all;">${esc(preheader)}${PREHEADER_PAD}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG};">
<tr><td align="center" style="padding:28px 12px 32px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">
<tr><td style="padding:0 10px 14px;font-family:${SERIF};font-size:22px;letter-spacing:0.16em;color:${INK};">${esc(brand.toUpperCase())}<span style="font-family:${SANS};font-size:12px;letter-spacing:0.04em;color:${SOFT};"> &nbsp;·&nbsp; Dein Design. Dein Unikat.</span></td></tr>
<tr><td style="background:${CARD};border-radius:18px;padding:30px 30px 24px;font-family:${SANS};font-size:15px;line-height:1.55;color:${INK};">
<h1 style="margin:0 0 16px;font-family:${SERIF};font-weight:normal;font-size:25px;line-height:1.25;color:${INK};">${esc(title)}</h1>
${bodyHtml}
</td></tr>
<tr><td style="padding:18px 12px 0;font-family:${SANS};font-size:12px;line-height:1.6;color:${SOFT};text-align:center;">
${foot.map(esc).join(' &nbsp;·&nbsp; ')}<br>
Diese E-Mail kommt automatisch aus dem OVJU-Shop &nbsp;·&nbsp; <a href="${esc(baseUrl || '')}/" style="color:${SOFT};">${esc(String(baseUrl || '').replace(/^https?:\/\//, ''))}</a>
</td></tr>
</table></td></tr></table>
</body></html>`;
}
function textFooter(settings, baseUrl) {
  return `\n\n— ${companyLines(settings).join(' · ')}\n${baseUrl}/`;
}

/** Positionsliste + Summen als HTML-Tabelle und Textzeilen */
function orderSummary(order, settings) {
  const lines = order.lines || [];
  const rowsHtml = lines.map((l) => {
    const parts = lineParts(l);
    return `<tr><td style="padding:9px 0;border-bottom:1px solid ${LINE};font-size:14px;line-height:1.5;vertical-align:top;">` +
      `<b>${esc(parts[0])}</b><br><span style="color:${SOFT};">${parts.slice(1).map(esc).join(' &nbsp;·&nbsp; ')}</span><br>` +
      `<span style="color:${SOFT};">${l.qty} × ${esc(money(l.unit, settings))}${l.off ? ` &nbsp;·&nbsp; Mengenrabatt −${esc(l.off)} %` : ''}</span></td>` +
      `<td align="right" style="padding:9px 0 9px 12px;border-bottom:1px solid ${LINE};font-size:14px;white-space:nowrap;vertical-align:top;"><b>${esc(money(l.line, settings))}</b></td></tr>`;
  }).join('');
  const sum = (label, value, bold) => `<tr><td style="padding:6px 0;font-size:14px;${bold ? 'font-weight:bold;font-size:16px;padding-top:10px;' : `color:${SOFT};`}">${esc(label)}</td>` +
    `<td align="right" style="padding:6px 0 6px 12px;font-size:14px;white-space:nowrap;${bold ? 'font-weight:bold;font-size:16px;padding-top:10px;' : ''}">${esc(value)}</td></tr>`;
  const coupon = order.coupon && order.coupon.off ? sum(`Gutschein ${order.coupon.code || ''}`, `−${money(order.coupon.off, settings)}`) : '';
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 4px;">${rowsHtml}` +
    sum('Zwischensumme', money(order.subtotal, settings)) + coupon +
    sum('Versand', order.shipping ? money(order.shipping, settings) : 'kostenlos') +
    sum('Gesamt', money(order.total, settings), true) + `</table>`;
  const text = lines.map((l) => `• ${lineParts(l).join(' · ')}\n  ${l.qty} × ${money(l.unit, settings)}${l.off ? ` · Mengenrabatt −${l.off} %` : ''} = ${money(l.line, settings)}`).join('\n') +
    `\n\nZwischensumme: ${money(order.subtotal, settings)}` +
    (order.coupon && order.coupon.off ? `\nGutschein ${order.coupon.code || ''}: −${money(order.coupon.off, settings)}` : '') +
    `\nVersand: ${order.shipping ? money(order.shipping, settings) : 'kostenlos'}` +
    `\nGesamt: ${money(order.total, settings)}`;
  return { html, text };
}
function addressBlock(order) {
  const c = order.customer || {};
  const lines = [c.name, c.street, [c.zip, c.city].filter(Boolean).join(' ')].map((x) => String(x || '').trim()).filter(Boolean);
  return { html: lines.map(esc).join('<br>'), text: lines.join('\n') };
}
function paymentBlock(order, settings) {
  const co = settings?.company || {};
  if (order.payment === 'paypal') {
    return {
      html: box(`✅ <b>Bezahlt via PayPal</b> am ${esc(dateDE(order.createdAt))} — der Druck kann direkt starten.`),
      text: `Zahlung: bezahlt via PayPal am ${dateDE(order.createdAt)} — der Druck kann direkt starten.`,
    };
  }
  const rows = [
    ['Empfänger', co.owner || co.name || ''], ['IBAN', co.iban || ''], ['BIC', co.bic || ''], ['Bank', co.bank || ''],
    ['Betrag', money(order.total, settings)], ['Verwendungszweck', order.orderId],
  ].filter(([, v]) => String(v || '').trim());
  return {
    html: box(`<b>Bitte überweise den Gesamtbetrag per Vorkasse:</b><br>` +
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">` +
      rows.map(([k, v]) => `<tr><td style="padding:2px 14px 2px 0;color:${SOFT};font-size:13px;">${esc(k)}</td><td style="padding:2px 0;font-size:14px;"><b>${esc(v)}</b></td></tr>`).join('') +
      `</table><p style="margin:10px 0 0;font-size:13px;color:${SOFT};">Der Druck startet, sobald deine Zahlung eingegangen ist — du bekommst dann Bescheid.</p>`),
    text: `Zahlung per Vorkasse — bitte überweise:\n` + rows.map(([k, v]) => `  ${k}: ${v}`).join('\n') +
      `\nDer Druck startet, sobald deine Zahlung eingegangen ist — du bekommst dann Bescheid.`,
  };
}

// ---------------------------------------------------------------------------
// Vorlagen
// ---------------------------------------------------------------------------
export function orderConfirmation({ order, settings, baseUrl }) {
  const name = order.customer?.name;
  const sum = orderSummary(order, settings);
  const pay = paymentBlock(order, settings);
  const addr = addressBlock(order);
  const inv = order.invoiceNo ? invoiceLink(baseUrl, order) : '';
  const note = String(order.customer?.note || '').trim();
  const bodyHtml =
    p(`${esc(greeting(name))}`) +
    p(`vielen Dank für deine Bestellung <b>${esc(order.orderId)}</b> vom ${esc(dateDE(order.createdAt))}! Dein Design ist bei uns angekommen und wird Schicht für Schicht zum Unikat. Hier ist alles auf einen Blick:`) +
    h2('Deine Bestellung') + sum.html +
    h2('Zahlung') + pay.html +
    h2('Lieferadresse') + p(addr.html) +
    (note ? h2('Deine Anmerkung') + p(esc(note), `color:${SOFT};`) : '') +
    (inv ? button(inv, '🧾 Rechnung ansehen') : '') +
    small(`Den aktuellen Stand deiner Bestellung siehst du jederzeit unter ${link(orderLink(baseUrl), 'Mein Konto')} im Shop — dort liegt auch die Rechnung.`) +
    p(`Fragen? Antworte einfach auf diese E-Mail.<br>Viele Grüße<br><span style="color:${ACCENT};">dein OVJU-Team</span>`, 'margin-top:14px;');
  const text = `${greeting(name)}\n\nvielen Dank für deine Bestellung ${order.orderId} vom ${dateDE(order.createdAt)}! Dein Design ist bei uns angekommen und wird Schicht für Schicht zum Unikat.\n\n` +
    `DEINE BESTELLUNG\n${sum.text}\n\nZAHLUNG\n${pay.text}\n\nLIEFERADRESSE\n${addr.text}\n` +
    (note ? `\nDEINE ANMERKUNG\n${note}\n` : '') +
    (inv ? `\nRechnung: ${inv}\n` : '') +
    `\nDen Stand deiner Bestellung siehst du jederzeit unter „Mein Konto“ im Shop: ${orderLink(baseUrl)}\n\nFragen? Antworte einfach auf diese E-Mail.\nViele Grüße, dein OVJU-Team` +
    textFooter(settings, baseUrl);
  return {
    subject: `Deine Bestellung ${order.orderId} bei OVJU — danke!`,
    text,
    html: renderLayout({ title: 'Danke für deine Bestellung!', preheader: `Bestellung ${order.orderId} ist eingegangen — ${money(order.total, settings)}`, bodyHtml, settings, baseUrl }),
  };
}

export function orderStatus({ order, status, settings, baseUrl }) {
  const st = String(status || order.status || '');
  const meta = STATUS_MAIL[st];
  if (!meta) throw new Error(`Für den Status „${st}“ gibt es keine Mail-Vorlage`);
  const name = order.customer?.name;
  const items = (order.lines || []).map((l) => `${l.qty} × ${lineParts(l).slice(0, 2).join(' ')}`);
  const trackNo = String(order.trackingNo || '').trim();
  const trackUrl = trackingUrl(order.carrier, trackNo);
  const carrier = carrierLabel(order.carrier);
  let title, lead, extraHtml = '', extraText = '';
  switch (st) {
    case 'bezahlt':
      title = 'Zahlung eingegangen — dein Druck startet';
      lead = `deine Zahlung für die Bestellung <b>${esc(order.orderId)}</b> ist da — danke! Das Filament ist eingelegt, dein Design geht jetzt in die Druckwarteschlange.`;
      break;
    case 'im-druck':
      title = 'Dein Unikat liegt auf dem Druckbett';
      lead = `gerade entsteht deine Bestellung <b>${esc(order.orderId)}</b> Schicht für Schicht — je nach Größe und Muster dauert ein Druck einige Stunden. Wir melden uns, sobald alles fertig ist.`;
      break;
    case 'gedruckt':
      title = 'Fertig gedruckt — geht in den Versand';
      lead = `dein Design aus Bestellung <b>${esc(order.orderId)}</b> ist fertig gedruckt, geprüft und wird jetzt sorgfältig verpackt. Die Sendungsnummer bekommst du, sobald das Paket unterwegs ist.`;
      break;
    case 'versendet':
      title = 'Dein Paket ist unterwegs';
      lead = `deine Bestellung <b>${esc(order.orderId)}</b> hat die Werkstatt verlassen und ist auf dem Weg zu dir.`;
      if (trackNo) {
        extraHtml = box(`📦 <b>Sendungsnummer${carrier ? ` (${esc(carrier)})` : ''}:</b> ${esc(trackNo)}` +
          (trackUrl ? `<br><a href="${esc(trackUrl)}" style="color:${ACCENT};">Paket verfolgen →</a>` : ''));
        extraText = `Sendungsnummer${carrier ? ` (${carrier})` : ''}: ${trackNo}${trackUrl ? `\nPaket verfolgen: ${trackUrl}` : ''}\n\n`;
      }
      break;
    case 'storniert':
      title = 'Deine Bestellung wurde storniert';
      lead = `deine Bestellung <b>${esc(order.orderId)}</b> haben wir storniert.` +
        (order.payment === 'paypal' && order.paymentStatus === 'bezahlt'
          ? ` Den bereits gezahlten Betrag von <b>${esc(money(order.total, settings))}</b> erstatten wir dir über PayPal zurück — das dauert je nach Bank ein paar Tage.`
          : order.payment === 'paypal' ? ' Falls du schon per PayPal bezahlt hast, erstatten wir dir den Betrag zurück.'
            // Vorkasse mit bestätigtem Zahlungseingang: Rückerstattung steht an, dafür brauchen wir die IBAN
            : order.paymentStatus === 'bezahlt'
              ? ` Den bereits überwiesenen Betrag von <b>${esc(money(order.total, settings))}</b> erstatten wir dir zurück — antworte bitte kurz auf diese E-Mail mit deiner IBAN.`
              : ' Falls du bereits überwiesen hast, melde dich kurz bei uns — wir überweisen den Betrag umgehend zurück.') +
        ' Schade, dass es diesmal nicht geklappt hat — dein Design wartet jederzeit wieder im Konfigurator auf dich.';
      break;
    case 'abgeschlossen':
      title = 'Danke — viel Freude mit deinem Unikat!';
      lead = `deine Bestellung <b>${esc(order.orderId)}</b> ist abgeschlossen. Wir hoffen, dein Design gefällt dir genauso gut wie uns beim Drucken!`;
      extraHtml = p(`Magst du uns ein Foto schicken oder kurz erzählen, wie es dir gefällt? Antworte einfach auf diese Mail — wir freuen uns über jedes Feedback.`);
      extraText = `Magst du uns ein Foto schicken oder kurz erzählen, wie es dir gefällt? Antworte einfach auf diese Mail.\n\n`;
      break;
    default:
      title = meta.label; lead = '';
  }
  const bodyHtml =
    p(esc(greeting(name))) + p(lead) + extraHtml +
    (items.length ? box(`<span style="color:${SOFT};">Inhalt:</span><br>${items.map(esc).join('<br>')}<br><span style="color:${SOFT};">Gesamt:</span> <b>${esc(money(order.total, settings))}</b>`) : '') +
    (st !== 'storniert' ? button(orderLink(baseUrl), 'Bestellung im Konto ansehen') : button(orderLink(baseUrl), 'Zurück zum Konfigurator')) +
    p(`Viele Grüße<br><span style="color:${ACCENT};">dein OVJU-Team</span>`);
  const text = `${greeting(name)}\n\n${lead.replace(/<[^>]+>/g, '')}\n\n${extraText}` +
    (items.length ? `Inhalt:\n${items.map((i) => `  ${i}`).join('\n')}\nGesamt: ${money(order.total, settings)}\n\n` : '') +
    `Bestellung im Konto ansehen: ${orderLink(baseUrl)}\n\nViele Grüße, dein OVJU-Team` + textFooter(settings, baseUrl);
  return {
    subject: `Deine Bestellung ${order.orderId} ${meta.subjectSuffix}`,
    text,
    html: renderLayout({ title, preheader: `${meta.label}: Bestellung ${order.orderId}`, bodyHtml, settings, baseUrl }),
  };
}

export function welcome({ user, settings, baseUrl }) {
  const name = user?.name;
  const bodyHtml =
    p(esc(greeting(name))) +
    p(`schön, dass du da bist! Dein OVJU-Konto ist angelegt (<b>${esc(user?.email || '')}</b>). Ab jetzt findest du unter „Mein Konto“:`) +
    `<ul style="margin:0 0 14px;padding-left:20px;"><li>den Status deiner Bestellungen — vom Druckbett bis zum Paket</li><li>deine Rechnungen</li><li>deine Lieferadresse, damit die Kasse schneller geht</li></ul>` +
    button(orderLink(baseUrl), 'Jetzt ein Design entwerfen') +
    p(`Viele Grüße<br><span style="color:${ACCENT};">dein OVJU-Team</span>`);
  const text = `${greeting(name)}\n\nschön, dass du da bist! Dein OVJU-Konto ist angelegt (${user?.email || ''}). Ab jetzt findest du unter „Mein Konto“:\n  • den Status deiner Bestellungen\n  • deine Rechnungen\n  • deine Lieferadresse\n\nJetzt ein Design entwerfen: ${orderLink(baseUrl)}\n\nViele Grüße, dein OVJU-Team` + textFooter(settings, baseUrl);
  return {
    subject: `Willkommen bei OVJU, ${firstName(name) === 'du' ? 'schön, dass du da bist' : firstName(name)}!`,
    text,
    html: renderLayout({ title: 'Willkommen bei OVJU!', preheader: 'Dein Konto ist angelegt — Bestellstatus, Rechnungen und Adresse an einem Ort.', bodyHtml, settings, baseUrl }),
  };
}

export function passwordReset({ user, link: resetLink, settings, baseUrl }) {
  const name = user?.name;
  const base = baseUrl || String(resetLink || '').replace(/\/[^/]*$/, '');
  const bodyHtml =
    p(esc(greeting(name))) +
    p(`du möchtest ein neues Passwort für dein OVJU-Konto (<b>${esc(user?.email || '')}</b>) setzen? Klick auf den Button — der Link ist <b>60 Minuten</b> gültig.`) +
    button(resetLink, 'Neues Passwort setzen') +
    small(`Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:<br>${link(resetLink, resetLink)}`) +
    small(`Du hast das nicht angefordert? Dann ignoriere diese E-Mail einfach — dein Passwort bleibt unverändert.`) +
    p(`Viele Grüße<br><span style="color:${ACCENT};">dein OVJU-Team</span>`);
  const text = `${greeting(name)}\n\ndu möchtest ein neues Passwort für dein OVJU-Konto (${user?.email || ''}) setzen? Öffne diesen Link — er ist 60 Minuten gültig:\n\n${resetLink}\n\nDu hast das nicht angefordert? Dann ignoriere diese E-Mail einfach — dein Passwort bleibt unverändert.\n\nViele Grüße, dein OVJU-Team` + textFooter(settings, base);
  return {
    subject: 'Dein neues Passwort für OVJU',
    text,
    html: renderLayout({ title: 'Neues Passwort setzen', preheader: 'Dein Link ist 60 Minuten gültig.', bodyHtml, settings, baseUrl: base }),
  };
}

export function adminNewOrder({ order, settings, baseUrl }) {
  const c = order.customer || {};
  const sum = orderSummary(order, settings);
  const pay = `${PAYMENT_LABEL[order.payment] || order.payment || '–'}${order.paymentStatus ? ` (${order.paymentStatus})` : ''}`;
  const note = String(c.note || '').trim();
  const adminUrl = `${baseUrl}/admin`;
  const bodyHtml =
    p(`<b>${esc(order.orderId)}</b> · ${esc(dateDE(order.createdAt))} · <b>${esc(money(order.total, settings))}</b> · ${esc(pay)}`) +
    box(`<b>${esc(c.name || '')}</b><br>${esc(c.email || '')}<br>${esc([c.street, [c.zip, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', '))}` +
      (order.userId ? `<br><span style="color:${SOFT};">Kundenkonto</span>` : `<br><span style="color:${SOFT};">Gastbestellung</span>`)) +
    sum.html +
    (note ? h2('Anmerkung des Kunden') + p(esc(note)) : '') +
    (order.payment === 'vorkasse' ? small('Vorkasse: Druck erst nach Zahlungseingang — Status im Admin auf „bezahlt“ setzen, sobald das Geld da ist.') : '') +
    button(adminUrl, 'Im Admin öffnen');
  const text = `Neue Bestellung ${order.orderId} (${dateDE(order.createdAt)})\nGesamt: ${money(order.total, settings)} · Zahlung: ${pay}\n\nKunde: ${c.name || ''} <${c.email || ''}>\n${[c.street, [c.zip, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')}\n\n${sum.text}\n` +
    (note ? `\nAnmerkung: ${note}\n` : '') + `\nAdmin: ${adminUrl}`;
  return {
    subject: `Neue Bestellung ${order.orderId} · ${money(order.total, settings)} · ${PAYMENT_LABEL[order.payment] || order.payment || ''}`,
    text,
    html: renderLayout({ title: 'Neue Bestellung 🎉', preheader: `${c.name || ''} · ${money(order.total, settings)} · ${pay}`, bodyHtml, settings, baseUrl }),
  };
}

/** Freitext (vom Admin) im Layout: Absätze durch Leerzeilen, Zeilenumbrüche bleiben erhalten */
export function customMessage({ order, subject, text, settings, baseUrl }) {
  const name = order?.customer?.name;
  const raw = String(text || '').replace(/\r\n?/g, '\n').trim();
  const paras = raw.split(/\n{2,}/).map((para) => p(esc(para).replace(/\n/g, '<br>')));
  const bodyHtml =
    p(esc(greeting(name))) + paras.join('') +
    (order?.orderId ? small(`Zu deiner Bestellung <b>${esc(order.orderId)}</b> — den Stand siehst du unter ${link(orderLink(baseUrl), 'Mein Konto')}.`) : '') +
    p(`Viele Grüße<br><span style="color:${ACCENT};">dein OVJU-Team</span>`);
  const plain = `${greeting(name)}\n\n${raw}\n\n` + (order?.orderId ? `Zu deiner Bestellung ${order.orderId} — Stand unter „Mein Konto“: ${orderLink(baseUrl)}\n\n` : '') +
    `Viele Grüße, dein OVJU-Team` + textFooter(settings, baseUrl);
  const subj = String(subject || '').trim() || (order?.orderId ? `Zu deiner Bestellung ${order.orderId}` : 'Nachricht von OVJU');
  return {
    subject: subj,
    text: plain,
    html: renderLayout({ title: subj, preheader: raw.slice(0, 110), bodyHtml, settings, baseUrl }),
  };
}
