'use strict';
// Enregistre le service worker et gère le bouton « Installer l'appli ».
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  document.querySelectorAll('[data-install]').forEach((b) => { b.hidden = false; });
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  document.querySelectorAll('[data-install]').forEach((b) => { b.hidden = true; });
});
document.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-install]') || !installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  document.querySelectorAll('[data-install]').forEach((b) => { b.hidden = true; });
});

// Bandeau hors ligne
function updateOnline() { document.documentElement.classList.toggle('is-offline', !navigator.onLine); }
window.addEventListener('online', updateOnline);
window.addEventListener('offline', updateOnline);
updateOnline();
