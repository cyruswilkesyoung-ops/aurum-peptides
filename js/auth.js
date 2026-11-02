/* auraa — account pages (login / signup / password reset) and logout.
   Sessions live in an HttpOnly cookie set by the server; this file only
   drives the forms and redirects. Nothing here is a security boundary —
   the edge gate and the functions verify every request server-side. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const qs = new URLSearchParams(location.search);

  /* Only same-site relative paths may be used as a post-login destination. */
  const safeNext = () => {
    const n = qs.get('next') || '';
    return /^\/(?!\/)/.test(n) ? n : '/shop/';
  };

  /* Keep ?next= across the login/signup cross-links so the round trip
     back to the product the visitor wanted survives switching forms. */
  const n = qs.get('next');
  if (n) {
    document.querySelectorAll('[data-keep-next]').forEach((a) => {
      const u = new URL(a.getAttribute('href'), location.origin);
      u.searchParams.set('next', n);
      a.setAttribute('href', u.pathname + u.search);
    });
  }

  const api = async (action, body) => {
    const res = await fetch('/api/auth/' + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  };

  const showErr = (el, msg) => { if (el) { el.textContent = msg; el.hidden = false; } };
  const busy = (btn, is, label) => {
    if (!btn) return;
    btn.disabled = is;
    if (is) { btn.dataset.was = btn.innerHTML; btn.textContent = label; }
    else if (btn.dataset.was) btn.innerHTML = btn.dataset.was;
  };

  /* ---- logout (any page) ------------------------------------------------ */
  document.querySelectorAll('[data-logout]').forEach((b) =>
    b.addEventListener('click', async () => {
      try { await api('logout'); } catch { /* cookie is cleared server-side */ }
      try { localStorage.removeItem('auraa.cart.v2'); } catch { /* fine */ }
      location.assign('/');
    })
  );

  /* ---- signed-in state on login/signup ---------------------------------- */
  const stateBox = $('#accountState');
  const loginForm = $('#authLogin');
  const signupForm = $('#authSignup');
  if (stateBox && (loginForm || signupForm)) {
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.ok) {
          $('#accountEmail') && ($('#accountEmail').textContent = d.user.email);
          stateBox.hidden = false;
          const forms = $('#authForms');
          if (forms) forms.hidden = true;
        }
      })
      .catch(() => {});
  }

  /* ---- login ------------------------------------------------------------ */
  loginForm &&
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#authError');
      err && (err.hidden = true);
      busy($('#authSubmit'), true, 'Logging in…');
      try {
        await api('login', { email: $('#loEmail').value, password: $('#loPass').value });
        location.assign(safeNext());
      } catch (ex) {
        busy($('#authSubmit'), false);
        showErr(err, ex.message);
      }
    });

  /* ---- signup ------------------------------------------------------------ */
  signupForm &&
    signupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#authError');
      err && (err.hidden = true);
      busy($('#authSubmit'), true, 'Creating your account…');
      try {
        await api('signup', {
          name: $('#suName').value,
          email: $('#suEmail').value,
          password: $('#suPass').value,
        });
        location.assign(safeNext());
      } catch (ex) {
        busy($('#authSubmit'), false);
        showErr(err, ex.message);
      }
    });

  /* ---- password reset ----------------------------------------------------
     Same page serves both steps: with ?token= it shows the new-password form,
     otherwise the send-me-a-link form. */
  const resetRequest = $('#authResetRequest');
  const resetConfirm = $('#authResetConfirm');
  const token = qs.get('token') || '';
  if (resetConfirm && token) {
    resetRequest.hidden = true;
    resetConfirm.hidden = false;
  }

  resetRequest &&
    resetRequest.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#authError');
      const okEl = $('#authOk');
      err && (err.hidden = true);
      busy($('#authSubmit'), true, 'Sending…');
      try {
        const d = await api('reset-request', { email: $('#rrEmail').value });
        busy($('#authSubmit'), false);
        if (okEl) { okEl.textContent = d.message || 'If an account exists for that address, a reset link is on its way.'; okEl.hidden = false; }
      } catch (ex) {
        busy($('#authSubmit'), false);
        showErr(err, ex.message);
      }
    });

  resetConfirm &&
    resetConfirm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#authErrorConfirm');
      err && (err.hidden = true);
      busy($('#authSubmitConfirm'), true, 'Saving…');
      try {
        await api('reset-confirm', { token, password: $('#rcPass').value });
        location.assign('/shop/');
      } catch (ex) {
        busy($('#authSubmitConfirm'), false);
        showErr(err, ex.message);
      }
    });
})();
