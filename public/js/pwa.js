/* OVJU PWA: nur die Service-Worker-Registrierung (Offline-Fallback, Caching).
   Das frühere Install-Banner („OVJU als App installieren“ samt nativem Install-Prompt, Styles, Schließen-Logik und
   localStorage-Merker) wurde auf Wunsch des Betreibers komplett entfernt. */
(function () {
  'use strict';
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
  });
})();
