/* OVJU PWA: Service-Worker-Registrierung + dezentes Install-Banner (klassisches Script, kein Modul) */
(function () {
  'use strict';

  var DISMISS_KEY = 'ovju-pwa-dismissed';
  var VISITS_KEY = 'ovju-pwa-visits';
  var DISMISS_DAYS = 14;

  function store(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  }
  function isMobile() {
    return window.matchMedia && window.matchMedia('(max-width: 980px)').matches;
  }
  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function recentlyDismissed() {
    var ts = parseInt(load(DISMISS_KEY) || '0', 10);
    return ts && (Date.now() - ts) < DISMISS_DAYS * 864e5;
  }
  function markDismissed() { store(DISMISS_KEY, String(Date.now())); }

  /* ---------- Service Worker ---------- */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
    });
  }

  /* ---------- Styles (inline injiziert, kein CSS-File) ---------- */
  function injectStyles() {
    if (document.getElementById('ovju-pwa-style')) return;
    var css = [
      '#ovju-pwa-banner{position:fixed;left:12px;right:12px;bottom:calc(100px + env(safe-area-inset-bottom,0px));z-index:9999;',
      'display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:18px;',
      'background:#fffdf9;color:#211d18;box-shadow:0 12px 36px rgba(33,29,24,.18),0 1px 0 rgba(33,29,24,.06);',
      'font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;',
      'transform:translateY(calc(100% + 40px));opacity:0;transition:transform .45s cubic-bezier(.2,.8,.2,1),opacity .3s}',
      '#ovju-pwa-banner.is-in{transform:none;opacity:1}',
      '#ovju-pwa-banner .ovju-pwa-icon{font-size:26px;line-height:1;flex:0 0 auto}',
      '#ovju-pwa-banner .ovju-pwa-text{flex:1 1 auto;min-width:0}',
      '#ovju-pwa-banner .ovju-pwa-text strong{display:block;font-weight:600}',
      '#ovju-pwa-banner .ovju-pwa-text span{display:block;opacity:.7;font-size:12.5px}',
      '#ovju-pwa-banner .ovju-pwa-install{flex:0 0 auto;background:#c86f4a;color:#fff;border:0;border-radius:999px;',
      'padding:9px 16px;font:600 14px system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer}',
      '#ovju-pwa-banner .ovju-pwa-install:active{transform:scale(.97)}',
      '#ovju-pwa-banner .ovju-pwa-close{flex:0 0 auto;background:transparent;border:0;color:inherit;opacity:.55;',
      'font-size:18px;line-height:1;padding:6px;margin:-6px -4px -6px 0;cursor:pointer;border-radius:50%}',
      '#ovju-pwa-banner .ovju-pwa-close:hover{opacity:1}',
      'html.dark #ovju-pwa-banner{background:#1f1a14;color:#f0e9dc;box-shadow:0 12px 36px rgba(0,0,0,.5),0 0 0 1px rgba(240,233,220,.08)}',
      '@media (min-width:981px){#ovju-pwa-banner{display:none}}',
      '@media (prefers-reduced-motion:reduce){#ovju-pwa-banner{transition:none}}'
    ].join('');
    var style = document.createElement('style');
    style.id = 'ovju-pwa-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ---------- Banner ---------- */
  function showBanner(opts) {
    if (document.getElementById('ovju-pwa-banner')) return;
    injectStyles();

    var banner = document.createElement('div');
    banner.id = 'ovju-pwa-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'OVJU als App installieren');

    var icon = document.createElement('div');
    icon.className = 'ovju-pwa-icon';
    icon.textContent = '📲';

    var text = document.createElement('div');
    text.className = 'ovju-pwa-text';
    var title = document.createElement('strong');
    title.textContent = opts.title;
    text.appendChild(title);
    if (opts.hint) {
      var hint = document.createElement('span');
      hint.textContent = opts.hint;
      text.appendChild(hint);
    }

    var close = document.createElement('button');
    close.className = 'ovju-pwa-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Schließen');
    close.textContent = '✕';

    banner.appendChild(icon);
    banner.appendChild(text);

    if (opts.onInstall) {
      var btn = document.createElement('button');
      btn.className = 'ovju-pwa-install';
      btn.type = 'button';
      btn.textContent = 'Installieren';
      btn.addEventListener('click', function () { opts.onInstall(); });
      banner.appendChild(btn);
    }
    banner.appendChild(close);

    function hide() {
      banner.classList.remove('is-in');
      setTimeout(function () { if (banner.parentNode) banner.parentNode.removeChild(banner); }, 500);
    }
    close.addEventListener('click', function () { markDismissed(); hide(); });
    banner._hide = hide;

    document.body.appendChild(banner);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { banner.classList.add('is-in'); });
    });
    return banner;
  }

  function mayShow() {
    return isMobile() && !isStandalone() && !recentlyDismissed();
  }

  /* Banner erst zeigen, wenn der Besucher gescrollt hat (nicht über die 3D-Bühne legen) — spätestens nach 25 s */
  function whenEngaged(fn) {
    var done = false;
    var go = function () { if (done) return; done = true; window.removeEventListener('scroll', check); fn(); };
    var check = function () { if (window.scrollY > 500) go(); };
    window.addEventListener('scroll', check, { passive: true });
    setTimeout(go, 25000);
    check();
  }

  /* Android / Chromium: natives Install-Prompt abfangen */
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (!mayShow()) return;
    var delay = function () {
      var banner = showBanner({
        title: '📲 OVJU als App installieren',
        hint: 'Schneller Zugriff direkt vom Home-Bildschirm.',
        onInstall: function () {
          if (!deferredPrompt) return;
          deferredPrompt.prompt();
          deferredPrompt.userChoice.then(function (choice) {
            if (!choice || choice.outcome !== 'accepted') markDismissed();
            deferredPrompt = null;
            if (banner && banner._hide) banner._hide();
          }).catch(function () { if (banner && banner._hide) banner._hide(); });
        }
      });
    };
    var start = function () { setTimeout(function () { whenEngaged(delay); }, 2500); };
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start);
  });

  window.addEventListener('appinstalled', function () {
    markDismissed();
    var b = document.getElementById('ovju-pwa-banner');
    if (b && b._hide) b._hide();
  });

  /* iOS Safari: kein beforeinstallprompt -> ab dem 2. Besuch Hinweis */
  function iosHint() {
    if (!isIOS() || isStandalone()) return;
    var visits = parseInt(load(VISITS_KEY) || '0', 10) + 1;
    store(VISITS_KEY, String(visits));
    if (visits < 2 || !mayShow()) return;
    setTimeout(function () {
      whenEngaged(function () {
        if (!mayShow()) return;
        showBanner({
          title: '📲 OVJU als App installieren',
          hint: 'Tippe auf „Teilen“ und dann „Zum Home-Bildschirm“.'
        });
      });
    }, 3000);
  }
  if (document.readyState === 'complete') iosHint();
  else window.addEventListener('load', iosHint);
})();
