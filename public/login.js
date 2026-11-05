'use strict';
const $ = (s) => document.querySelector(s);
let mode = 'login';

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

function setMode(m) {
  mode = m;
  document.querySelectorAll('.auth-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  const signup = m === 'signup';
  $('#confirm-wrap').hidden = !signup;
  $('#auth-form [name="confirm"]').required = signup;
  $('#auth-form [name="password"]').autocomplete = signup ? 'new-password' : 'current-password';
  $('#auth-submit').textContent = signup ? 'Créer mon compte' : 'Se connecter';
  $('#auth-error').hidden = true;
}

(async function main() {
  // Déjà connecté ? On file sur l'appli.
  const me = await fetch('/api/auth/me');
  if (me.ok) { location.replace('/'); return; }

  const opts = await (await fetch('/api/auth/options')).json();
  if (!opts.signup) $('.auth-tabs [data-mode="signup"]').hidden = true;
  if (opts.firstAccount) { $('#first-hint').hidden = false; setMode('signup'); }

  document.querySelectorAll('.auth-tabs button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target).entries());
    const err = $('#auth-error');
    err.hidden = true;
    if (mode === 'signup' && f.password !== f.confirm) { err.textContent = 'Les deux mots de passe ne correspondent pas.'; err.hidden = false; return; }
    const btn = $('#auth-submit');
    btn.disabled = true;
    try {
      await post(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', { email: f.email, password: f.password });
      location.replace('/');
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
    } finally { btn.disabled = false; }
  });
})();
