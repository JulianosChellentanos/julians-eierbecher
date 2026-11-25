// formsam — Prüfung der Betriebsskripte unter deploy/ (ohne echten Server, ohne root-Änderungen am System)
//   node tools/test-betrieb.mjs          → Exit 0 = alles ok, 1 = Fehler
// Arbeitet in tmp-tests/test-betrieb-<pid>/ und räumt danach auf:
//   • bash -n für alle Skripte
//   • formsam-backup (APP/ZIEL umgebogen): Erfolg → Exit 0 + geprüftes Archiv; fehlender Ordner → Exit 1, kein Archiv;
//     Aufräumen nach 14 Tagen
//   • prod-update.sh in einer Attrappe (eigenes Git-Repo, Stubs für sudo, systemctl, curl, journalctl, install, sleep):
//     Sicherung schlägt fehl → Abbruch; Update; --zurueck; Syntaxfehler → zurück ohne Neustart; Fehlstart → automatisch zurück;
//     beschädigte Datendatei → Update und Rückweg brechen ab; Update mit dem alten Skript (ohne letztes-update) → --zurueck nennt
//     den Stand laut git reflog, --pruefen trägt ihn nach; --zurueck <commit>; --pruefen meldet zu kleine nginx-Uploadgrenze und fehlendes HSTS
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, utimesSync, existsSync, cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = path.join(ROOT, 'tmp-tests', `test-betrieb-${process.pid}`);
let pass = 0, fail = 0;
const check = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`, extra !== undefined ? String(extra).slice(0, 600) : ''); }
};
const bash = (args, env = {}, cwd = '/') => spawnSync('bash', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
const schreib = (f, inhalt, x = false) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, inhalt); if (x) chmodSync(f, 0o755); };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

try {
  console.log('Syntax');
  for (const f of ['formsam-backup', 'prod-update.sh', 'stalwart-backup', 'stalwart-zertifikat.sh', 'mail-dns-pruefen.sh']) {
    if (!existsSync(path.join(ROOT, 'deploy', f))) continue;
    const r = bash(['-n', path.join(ROOT, 'deploy', f)]);
    check(r.status === 0, `bash -n deploy/${f}`, r.stderr);
  }

  console.log('formsam-backup');
  const app = path.join(T, 'app'), ziel = path.join(T, 'ziel'), backup = path.join(ROOT, 'deploy/formsam-backup');
  schreib(path.join(app, 'data/settings.json'), '{}'); schreib(path.join(app, 'orders/FS-1/order.json'), '{}'); mkdirSync(path.join(app, 'public/img/gallery'), { recursive: true });
  // Mail-Outbox ab Version 2: Kopfdaten in data/mail-outbox.json, Inhalte nicht zugestellter Mails in data/mail-outbox/<id>.json
  schreib(path.join(app, 'data/mail-outbox.json'), '{"version":2,"entries":[]}'); schreib(path.join(app, 'data/mail-outbox/abc123.json'), '{}');
  mkdirSync(ziel, { recursive: true });
  // logger als Attrappe — Testläufe sollen nicht im echten Journal (journalctl -t formsam-backup) landen
  const still = path.join(T, 'still');
  schreib(path.join(still, 'logger'), '#!/usr/bin/env bash\nexit 0\n', true);
  const sichern = () => bash([backup], { APP: app, ZIEL: ziel, PATH: `${still}:${process.env.PATH}` });
  const alt = (name, tage) => { const f = path.join(ziel, name); writeFileSync(f, ''); const t = (Date.now() - tage * 864e5) / 1000; utimesSync(f, t, t); };
  alt('formsam-alt-14.tar.gz', 14); alt('formsam-alt-13.tar.gz', 13);
  let r = sichern();
  let dateien = readdirSync(ziel);
  const neu = dateien.find((f) => /^formsam-\d{4}-\d{2}-\d{2}-\d{4}\.tar\.gz$/.test(f));
  check(r.status === 0 && neu, 'Sicherung: Exit 0, Archiv angelegt', r.stderr + dateien.join(' '));
  if (neu) {
    const liste = execFileSync('tar', ['-tzf', path.join(ziel, neu)], { encoding: 'utf8' });
    check(liste.includes('orders/FS-1/order.json'), 'Archiv enthält die Bestellungen');
    check(liste.includes('data/settings.json') && liste.includes('data/mail-outbox.json') && liste.includes('data/mail-outbox/abc123.json'), 'Archiv enthält data/ samt Mail-Outbox (data/mail-outbox/)');
  }
  check(!dateien.includes('formsam-alt-14.tar.gz') && dateien.includes('formsam-alt-13.tar.gz'), 'Sicherung von vor 14 Tagen gelöscht, von vor 13 Tagen bleibt', dateien.join(' '));
  check(!dateien.some((f) => f.endsWith('.unfertig')), 'keine halbe Datei');
  rmSync(path.join(app, 'public/img/gallery'), { recursive: true });
  for (const f of readdirSync(ziel)) rmSync(path.join(ziel, f));
  r = sichern();
  dateien = readdirSync(ziel);
  check(r.status === 1 && /FEHLER/.test(r.stderr) && dateien.length === 0, 'Fehler (Ordner fehlt): Exit 1, Meldung, kein Archiv', `${r.status} ${r.stderr} ${dateien}`);

  console.log('prod-update.sh (Attrappe)');
  const st = path.join(T, 'stubs'), p = path.join(T, 'p');
  mkdirSync(p, { recursive: true });
  schreib(path.join(st, 'sudo'), '#!/usr/bin/env bash\n[ "$1" = -u ] && shift 2\nexec "$@"\n', true);
  schreib(path.join(st, 'systemctl'), `#!/usr/bin/env bash
case "$1" in
  is-active) [ -e "${p}/aktiv" ];;
  restart) echo restart >> "${p}/restarts"; if grep -q STARTET_NICHT "${p}/app/server.js"; then rm -f "${p}/aktiv"; else touch "${p}/aktiv"; fi;;
  *) exit 0;;
esac
`, true);
  // läuft im Wartungsmodus: 503 mit X-Formsam-Wartung zählt als „läuft“
  schreib(path.join(st, 'curl'), `#!/usr/bin/env bash\n[ -e "${p}/aktiv" ] || exit 7\nprintf 'HTTP/1.1 503 Service Unavailable\\r\\nX-Formsam-Wartung: 1\\r\\n\\r\\n'\n`, true);
  schreib(path.join(st, 'journalctl'), '#!/usr/bin/env bash\necho "(journal)"\n', true);
  schreib(path.join(st, 'install'), '#!/usr/bin/env bash\necho "(install $*)"\n', true);
  schreib(path.join(st, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', true);
  schreib(path.join(p, 'backup'), '#!/usr/bin/env bash\nexit ${BACKUP_RC:-0}\n', true);
  git(T, 'init', '-q', '--bare', 'origin.git');
  git(T, 'clone', '-q', path.join(T, 'origin.git'), 'work');
  const work = path.join(T, 'work');
  git(work, 'config', 'user.email', 't@example.test'); git(work, 'config', 'user.name', 'test');
  cpSync(path.join(ROOT, 'deploy'), path.join(work, 'deploy'), { recursive: true });
  const commit = (msg, server) => {
    schreib(path.join(work, 'server.js'), server); schreib(path.join(work, 'lib/x.js'), 'export const x = 1;\n');
    git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', msg); git(work, 'push', '-q', 'origin', 'HEAD:main');
    return git(work, 'rev-parse', 'HEAD');
  };
  const A = commit('A', '// Stand A\n');
  git(p, 'clone', '-q', '-b', 'main', path.join(T, 'origin.git'), 'app');
  writeFileSync(path.join(p, 'aktiv'), '');
  const kopf = () => git(path.join(p, 'app'), 'rev-parse', 'HEAD');
  // nginx-Seite wie auf Prod nach certbot (Vorlage + 443/80-Blöcke); --pruefen meldet zu kleine Uploadgrenze und fehlendes HSTS
  const nginxSeite = path.join(p, 'nginx-formsam');
  schreib(nginxSeite, readFileSync(path.join(ROOT, 'deploy/nginx-formsam.conf'), 'utf8').replace('listen 80;', 'listen 443 ssl; # managed by Certbot')
    + '\nserver {\n    listen 80;\n    server_name www.formsam.com formsam.com;\n    return 301 https://$host$request_uri; # managed by Certbot\n}\n');
  const lauf = (args = [], env = {}) => bash([path.join(ROOT, 'deploy/prod-update.sh'), ...args],
    { PATH: `${st}:${process.env.PATH}`, APP: path.join(p, 'app'), BACKUP: path.join(p, 'backup'), ZUSTAND: path.join(p, 'letztes-update'), NGINX_SITE: nginxSeite, ...env });
  const B = commit('B', '// Stand B\n');
  r = lauf([], { BACKUP_RC: '1' });
  check(r.status === 1 && kopf() === A && /Sicherung fehlgeschlagen/.test(r.stdout), 'Sicherung schlägt fehl → Abbruch, nichts geändert', r.stdout + r.stderr);
  r = lauf();
  check(r.status === 0 && kopf() === B && readFileSync(path.join(p, 'letztes-update'), 'utf8').startsWith(`${A} ${B} `), 'Update A → B (Wartungsmodus zählt als läuft), alter Stand gemerkt', r.stdout + r.stderr);
  check(/\(install -m 755 .*formsam-backup/.test(r.stdout), 'geändertes formsam-backup wird eingespielt', r.stdout);
  r = lauf(['--zurueck']);
  check(r.status === 0 && kopf() === A, '--zurueck → Stand A', r.stdout + r.stderr);
  git(path.join(p, 'app'), 'reset', '-q', '--hard', B);
  commit('C', 'const = kaputt;\n');
  writeFileSync(path.join(p, 'restarts'), '');
  r = lauf();
  check(r.status === 1 && kopf() === B && readFileSync(path.join(p, 'restarts'), 'utf8') === '' && /Syntaxfehler/.test(r.stdout), 'Syntaxfehler → zurück auf B, ohne Neustart', r.stdout + r.stderr);
  commit('D', '// STARTET_NICHT\n');
  r = lauf();
  check(r.status === 1 && kopf() === B && existsSync(path.join(p, 'aktiv')) && /alter Stand/.test(r.stdout), 'Fehlstart → automatisch zurück auf B, läuft wieder', r.stdout + r.stderr);
  r = lauf(['--quatsch']);
  check(r.status === 2, 'unbekannte Option → Exit 2', r.status);

  // Beschädigte Datendatei: weder Update noch Rückweg (eine ältere Fassung liefe mit Standardwerten los und überschriebe sie)
  const E = commit('E', '// Stand E\n');
  const einst = path.join(p, 'app/data/settings.json'), zustand = path.join(p, 'letztes-update');
  schreib(einst, '{"adminKey": "abgeschn');
  schreib(path.join(p, 'app/data/users.json'), '[]');
  writeFileSync(path.join(p, 'restarts'), '');
  const zustandVorher = readFileSync(zustand, 'utf8');
  r = lauf();
  check(r.status === 1 && kopf() === B && /Beschädigte Datendatei.*settings\.json/.test(r.stdout) && readFileSync(path.join(p, 'restarts'), 'utf8') === '' && readFileSync(zustand, 'utf8') === zustandVorher,
    'beschädigte settings.json → Update bricht ab, nichts geändert', r.stdout + r.stderr);
  r = lauf(['--zurueck']);
  check(r.status === 1 && kopf() === B && /Beschädigte Datendatei/.test(r.stdout) && readFileSync(path.join(p, 'restarts'), 'utf8') === '', 'beschädigte settings.json → kein Rückweg', r.stdout + r.stderr);
  schreib(einst, '{"ok": true}');

  // Update mit dem alten Skript (git fetch + reset --hard origin/main, kein letztes-update)
  rmSync(zustand);
  git(path.join(p, 'app'), 'fetch', '-q', 'origin', 'main');
  git(path.join(p, 'app'), 'reset', '-q', '--hard', 'origin/main');
  r = lauf(['--zurueck']);
  check(r.status === 1 && kopf() === E && r.stdout.includes(`--zurueck ${B}`) && /laut git reflog/.test(r.stdout), 'ohne letztes-update: --zurueck ändert nichts, nennt den Stand laut git reflog', r.stdout + r.stderr);
  r = lauf(['--pruefen']);
  check(r.status === 0 && existsSync(zustand) && readFileSync(zustand, 'utf8').startsWith(`${B} ${E} `) && /aus git reflog gemerkt/.test(r.stdout), '--pruefen trägt den Stand vor dem Update aus git reflog nach', r.stdout + r.stderr);
  r = lauf(['--pruefen']);
  check(r.status === 0 && !/gemerkt/.test(r.stdout), '--pruefen ein zweites Mal: nichts nachzutragen', r.stdout);
  r = lauf(['--zurueck']);
  check(r.status === 0 && kopf() === B, '--zurueck mit nachgetragenem Stand → B', r.stdout + r.stderr);
  r = lauf(['--zurueck', E]);
  check(r.status === 0 && kopf() === E, '--zurueck <commit> → E', r.stdout + r.stderr);
  r = lauf(['--zurueck', 'gibtsnicht']);
  check(r.status === 1 && kopf() === E && /Unbekannter Stand/.test(r.stdout), '--zurueck mit unbekanntem Stand → Exit 1, nichts geändert', r.stdout + r.stderr);

  // nginx-Seite: Uploadgrenze (≥ 200 MB) und HSTS — nur Hinweise, Exit bleibt 0
  r = lauf(['--pruefen']);
  check(r.status === 0 && !/nginx: Uploadgrenze|HSTS-Kopfzeile fehlt|nicht gefunden/.test(r.stdout), '--pruefen: nginx-Seite wie deploy/nginx-formsam.conf → kein nginx-Hinweis', r.stdout);
  const seite = readFileSync(nginxSeite, 'utf8');
  schreib(nginxSeite, seite.replace('client_max_body_size 200m;', 'client_max_body_size 100m;').replace(/^\s*add_header Strict-Transport-Security.*$/m, '    # add_header Strict-Transport-Security "max-age=31536000" always;'));
  r = lauf(['--pruefen']);
  check(r.status === 0 && /nginx: Uploadgrenze für Druckdateien unter 200 MB/.test(r.stdout) && /HSTS-Kopfzeile fehlt/.test(r.stdout), '--pruefen: client_max_body_size 100m und auskommentiertes HSTS → beide Hinweise', r.stdout);
  schreib(nginxSeite, seite.replace('client_max_body_size 200m;', 'client_max_body_size 1g;'));
  r = lauf(['--pruefen']);
  check(r.status === 0 && !/nginx: Uploadgrenze/.test(r.stdout), '--pruefen: client_max_body_size 1g reicht', r.stdout);
  schreib(nginxSeite, seite.replace(/^\s*client_max_body_size.*$/m, ''));
  r = lauf(['--pruefen']);
  check(r.status === 0 && /nginx: Uploadgrenze/.test(r.stdout), '--pruefen: ohne client_max_body_size (nginx-Standard 1 MB) → Hinweis', r.stdout);
  r = lauf(['--pruefen'], { NGINX_SITE: path.join(p, 'gibtsnicht') });
  check(r.status === 0 && /nginx-Seite .* nicht gefunden/.test(r.stdout), '--pruefen: nginx-Seite fehlt → Hinweis, Exit 0', r.stdout);
} catch (e) {
  fail++; console.log('  ✗ Abbruch:', e?.stack || e);
} finally {
  rmSync(T, { recursive: true, force: true });
}
console.log(`\n${pass} ok, ${fail} Fehler`);
process.exit(fail ? 1 : 0);
