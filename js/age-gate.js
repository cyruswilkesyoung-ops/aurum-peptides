/* Aurum Peptides — entry gate.
   ---------------------------------------------------------------------------
   Loaded SYNCHRONOUSLY from <head>, before the stylesheet paints anything, so
   the storefront never flashes behind the gate.

   The arming is deliberately inverted. This script adds `gate-armed` to <html>
   the moment it runs, and main.css only hides the page when that class is
   present. So if the file 404s, fails to parse, or is blocked, the class is
   never set, nothing is hidden, and the site works exactly as it did before.
   A gate written the other way round — markup in the HTML, revealed by JS —
   turns any script failure into a permanently blank storefront. That is the
   same class of bug as the missing hero image, and it is not worth repeating
   for a component whose whole job is to be the first thing anyone sees.

   No email capture, no analytics, no network calls. The answer lives in this
   browser and nowhere else. */
(() => {
  'use strict';

  var KEY = 'aurum.entry.v1';
  var REMEMBER_DAYS = 30;
  var root = document.documentElement;

  /* Private browsing and locked-down storage settings both throw on access. A
     gate that cannot remember an answer should still let people in, so every
     read and write is wrapped and failure just means asking again. */
  function remembered() {
    try {
      var raw = window.localStorage.getItem(KEY);
      if (!raw) return false;
      return Number(raw) > Date.now();
    } catch (e) { return false; }
  }
  function remember() {
    try {
      window.localStorage.setItem(KEY, String(Date.now() + REMEMBER_DAYS * 864e5));
    } catch (e) { /* answered for this visit only */ }
  }

  /* The gate is a storefront thing. /admin/ is the owner's own order panel and
     is already behind a password; making Cyrus confirm his age to look at his
     own orders is friction with no purpose. */
  if (/^\/admin(\/|$)/.test(location.pathname)) return;

  if (remembered()) return;
  root.classList.add('gate-armed');

  function build() {
    var gate = document.createElement('div');
    gate.id = 'ageGate';
    gate.className = 'agegate';
    gate.setAttribute('role', 'dialog');
    gate.setAttribute('aria-modal', 'true');
    gate.setAttribute('aria-labelledby', 'ageGateTitle');
    gate.innerHTML = [
      '<div class="agegate__inner">',
      '  <p class="agegate__mark"><span>Aurum</span><b>Peptides</b></p>',
      '  <span class="agegate__rule" aria-hidden="true"></span>',
      '  <h1 class="agegate__title" id="ageGateTitle">For laboratory research use only.</h1>',
      '  <p class="agegate__lead">Everything sold here is a research compound. Nothing on this site is a drug, a supplement, or fit for human or veterinary consumption. You must be 21 or older to continue.</p>',
      '  <div class="agegate__actions">',
      '    <button type="button" class="btn agegate__yes">I am 21 or older</button>',
      '    <button type="button" class="btn btn--ghost agegate__no">I am under 21</button>',
      '  </div>',
      '  <p class="agegate__fine">By continuing you confirm you are a qualified researcher and accept our <a href="/terms/">terms</a> and <a href="/disclaimer/">disclaimer</a>.</p>',
      '</div>',
    ].join('');

    var declined =
      '<div class="agegate__inner">' +
      '  <p class="agegate__mark"><span>Aurum</span><b>Peptides</b></p>' +
      '  <span class="agegate__rule" aria-hidden="true"></span>' +
      '  <h1 class="agegate__title">You can’t continue.</h1>' +
      '  <p class="agegate__lead">This catalogue is restricted to researchers aged 21 and over. Thanks for stopping by.</p>' +
      '</div>';

    document.body.appendChild(gate);

    /* Keep the tab ring inside the gate. Without this you can tab into the
       storefront underneath it, which is both a bad look and a real bypass. */
    function trap(e) {
      if (e.key !== 'Tab') return;
      var focusable = gate.querySelectorAll('button, a[href]');
      if (!focusable.length) return;
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', trap, true);

    gate.querySelector('.agegate__yes').addEventListener('click', function () {
      remember();
      document.removeEventListener('keydown', trap, true);
      gate.classList.add('is-leaving');
      root.classList.remove('gate-armed');
      setTimeout(function () { gate.remove(); }, 260);
    });

    gate.querySelector('.agegate__no').addEventListener('click', function () {
      gate.innerHTML = declined;
      gate.classList.add('is-declined');
    });

    var yes = gate.querySelector('.agegate__yes');
    if (yes) yes.focus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
