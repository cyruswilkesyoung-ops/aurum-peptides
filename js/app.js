/* auraa — interaction layer. Vanilla, dependency-free, deferred.
   Everything degrades gracefully without JS: content and links work, the cart
   is an enhancement, and reveals fall back to visible in CSS (see `.reveal` in
   main.css) rather than here — this file may never run. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const fmt = (n) =>
    '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /* ---- header stuck + scroll progress --------------------------------- */
  const header = $('.header');
  const progress = $('#scrollProgress');
  const onScroll = () => {
    if (header) header.classList.toggle('is-stuck', window.scrollY > 8);
    if (progress) {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      progress.style.width = (max > 0 ? (h.scrollTop / max) * 100 : 0) + '%';
    }
  };
  onScroll();
  addEventListener('scroll', onScroll, { passive: true });

  /* ---- scroll reveals -------------------------------------------------- */
  // Disarms the CSS failsafe in main.css. Must happen before any early return below,
  // and before the observer is wired: its only job is to say "app.js is running", so
  // that a page whose script never arrives still reveals itself after 3s.
  document.documentElement.classList.add('reveals-ready');
  const reveals = $$('.reveal');
  if (reveals.length && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('is-in');
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    );
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('is-in'));
  }

  /* ---- hero vial pointer tilt (fine pointers, motion allowed) ---------- */
  const heroVisual = $('.hero__visual');
  if (
    heroVisual &&
    matchMedia('(hover: hover) and (pointer: fine)').matches &&
    !matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    const vial = $('.hero-vial-svg', heroVisual);
    if (vial) {
      heroVisual.addEventListener('pointermove', (e) => {
        const r = heroVisual.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        vial.style.setProperty('--rx', (px * 10).toFixed(2) + 'deg');
        vial.style.setProperty('--ry', (-py * 8).toFixed(2) + 'deg');
      });
      heroVisual.addEventListener('pointerleave', () => {
        vial.style.setProperty('--rx', '0deg');
        vial.style.setProperty('--ry', '0deg');
      });
    }
  }

  /* ---- mobile nav ------------------------------------------------------ */
  const toggle = $('.nav-toggle');
  const menu = $('.mobile-menu');
  if (toggle && menu) {
    const setOpen = (open) => {
      toggle.classList.toggle('is-open', open);
      menu.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      document.body.style.overflow = open ? 'hidden' : '';
    };
    toggle.addEventListener('click', () => setOpen(!menu.classList.contains('is-open')));
    menu.addEventListener('click', (e) => {
      if (e.target.closest('a')) setOpen(false);
    });
  }

  /* ---- cart (localStorage) -------------------------------------------- */
  // v2 lines carry the identifiers the server needs to re-price the order
  // (slug / variant / bundleQty). Prices in the cart are display-only.
  const CART_KEY = 'auraa.cart.v2';
  const readCart = () => {
    try {
      return JSON.parse(localStorage.getItem(CART_KEY)) || [];
    } catch {
      return [];
    }
  };
  const writeCart = (c) => localStorage.setItem(CART_KEY, JSON.stringify(c));
  let cart = readCart();

  const countEl = $('[data-cart-count]');
  const renderCount = () => {
    const n = cart.reduce((s, l) => s + l.qty, 0);
    if (countEl) {
      countEl.textContent = n;
      countEl.style.display = n ? 'grid' : 'none';
    }
  };

  const drawer = $('#cartDrawer');
  const backdrop = $('#drawerBackdrop');
  const openDrawer = () => {
    renderDrawer();
    drawer && drawer.classList.add('is-open');
    backdrop && backdrop.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  };
  const closeDrawer = () => {
    drawer && drawer.classList.remove('is-open');
    backdrop && backdrop.classList.remove('is-open');
    document.body.style.overflow = '';
  };
  $$('[data-open-cart]').forEach((b) => b.addEventListener('click', openDrawer));
  $$('[data-close-cart]').forEach((b) => b.addEventListener('click', closeDrawer));
  backdrop && backdrop.addEventListener('click', closeDrawer);
  addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());

  function renderDrawer() {
    const body = $('#cartBody');
    const foot = $('#cartFoot');
    if (!body) return;
    if (!cart.length) {
      body.innerHTML =
        '<div class="drawer__empty"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 7h11v8H3z"/><path d="M14 10h4l3 3v2h-7z"/><circle cx="7" cy="17.5" r="1.6"/><circle cx="17.5" cy="17.5" r="1.6"/></svg><p>Your cart is empty.</p><p style="font-size:.82rem;margin-top:.4rem">Every order ships with batch documentation.</p></div>';
      if (foot) foot.hidden = true;
      return;
    }
    if (foot) foot.hidden = false;
    body.innerHTML = cart
      .map(
        (l, i) => `
      <div class="cart-line">
        <div class="cart-line__img"><img src="${l.img}" alt="" width="48" height="60" loading="lazy"></div>
        <div>
          <div class="cart-line__name">${l.name}</div>
          <div class="cart-line__meta">${l.meta}</div>
          <div class="cart-line__qty">
            <button data-qty="-1" data-i="${i}" aria-label="Decrease quantity">−</button>
            <span>${l.qty}</span>
            <button data-qty="1" data-i="${i}" aria-label="Increase quantity">+</button>
            <button class="cart-line__remove" data-remove="${i}">Remove</button>
          </div>
        </div>
        <div class="cart-line__price">${fmt(l.price * l.qty)}</div>
      </div>`
      )
      .join('');
    const subtotal = cart.reduce((s, l) => s + l.price * l.qty, 0);
    const THRESH = 150;
    const remain = Math.max(0, THRESH - subtotal);
    $('#cartSubtotal') && ($('#cartSubtotal').textContent = fmt(subtotal));
    const ship = $('#cartShip');
    if (ship)
      ship.textContent = remain
        ? `Add ${fmt(remain)} for free shipping`
        : 'You’ve unlocked free shipping';
    $$('[data-remove]', body).forEach((b) =>
      b.addEventListener('click', () => {
        cart.splice(+b.dataset.remove, 1);
        writeCart(cart);
        renderCount();
        renderDrawer();
      })
    );
    $$('[data-qty]', body).forEach((b) =>
      b.addEventListener('click', () => {
        const line = cart[+b.dataset.i];
        if (!line) return;
        line.qty = Math.max(1, Math.min(20, line.qty + +b.dataset.qty));
        writeCart(cart);
        renderCount();
        renderDrawer();
      })
    );
    syncAck();
  }

  function addToCart(line) {
    const existing = cart.find((l) => l.id === line.id);
    if (existing) existing.qty += line.qty;
    else cart.push(line);
    writeCart(cart);
    renderCount();
    openDrawer();
    toast(`${line.name} · ${line.meta} added`);
  }

  /* checkout acknowledgment gate — the drawer link stays inert until the
     research-use box is ticked; the same two acknowledgments are re-taken and
     re-validated server-side on the checkout page. */
  const ackBox = $('#cartAck');
  const checkoutBtn = $('#checkoutBtn');
  const syncAck = () => {
    if (!checkoutBtn || !ackBox) return;
    const ok = ackBox.checked && cart.length > 0;
    checkoutBtn.setAttribute('aria-disabled', String(!ok));
    checkoutBtn.classList.toggle('is-disabled', !ok);
  };
  ackBox && ackBox.addEventListener('change', syncAck);
  checkoutBtn &&
    checkoutBtn.addEventListener('click', (e) => {
      if (!ackBox || !ackBox.checked || !cart.length) {
        e.preventDefault();
        toast('Please confirm the research-use acknowledgment to continue.');
      }
    });

  /* ---- product page config ------------------------------------------- */
  const pdp = $('[data-pdp]');
  if (pdp) initPdp(pdp);

  function initPdp(root) {
    const data = JSON.parse(root.dataset.pdp);
    let variant = data.variants[0];
    let bundle = data.bundles[0];
    let qty = 1;

    const priceEl = $('#pdpPrice');
    const perEl = $('#pdpPer');

    const unit = () => variant.price * (1 - bundle.save);
    const render = () => {
      const total = unit() * bundle.qty * qty;
      if (priceEl) {
        priceEl.innerHTML =
          (variant.compareAt && !bundle.save
            ? `<s>${fmt(variant.compareAt)}</s>`
            : '') + fmt(total);
      }
      if (perEl)
        perEl.textContent = bundle.save
          ? `${fmt(unit())} per vial · ${Math.round(bundle.save * 100)}% saved`
          : `${fmt(variant.price)} per vial`;
      $$('.variant').forEach((v) =>
        v.classList.toggle('is-active', v.dataset.v === String(variant.mgKey))
      );
      $$('.bundle').forEach((b) =>
        b.classList.toggle('is-active', b.dataset.b === String(bundle.qty))
      );
      const qi = $('#qtyInput');
      if (qi) qi.value = qty;
      // refresh bundle prices for current variant
      $$('.bundle').forEach((b) => {
        const bq = +b.dataset.b;
        const bs = data.bundles.find((x) => x.qty === bq).save;
        const bp = variant.price * (1 - bs) * bq;
        const pe = $('.bundle__price b', b);
        if (pe) pe.textContent = fmt(bp);
      });
    };

    $$('.variant').forEach((v) =>
      v.addEventListener('click', () => {
        if (v.hasAttribute('disabled')) return;
        variant = data.variants.find((x) => String(x.mgKey) === v.dataset.v);
        render();
      })
    );
    $$('.bundle').forEach((b) =>
      b.addEventListener('click', () => {
        bundle = data.bundles.find((x) => String(x.qty) === b.dataset.b);
        render();
      })
    );
    $('#qtyMinus') && $('#qtyMinus').addEventListener('click', () => { qty = Math.max(1, qty - 1); render(); });
    $('#qtyPlus') && $('#qtyPlus').addEventListener('click', () => { qty = Math.min(20, qty + 1); render(); });

    const addBtn = $('#addToCart');
    addBtn &&
      addBtn.addEventListener('click', () => {
        if (data.soldOut) return;
        addToCart({
          id: `${data.slug}-${variant.mgKey}-${bundle.qty}`,
          slug: data.slug,
          name: data.name,
          meta: `${variant.label}${bundle.qty > 1 ? ' · ' + bundle.label : ''}`,
          // identifiers the server re-prices from — never trusted for money
          variant: String(variant.mgKey),
          bundleQty: bundle.qty,
          price: unit() * bundle.qty,
          qty,
          img: data.img,
        });
      });

    render();
  }

  /* ---- certificates filter -------------------------------------------- */
  const coaFilters = $$('[data-coa-filter]');
  if (coaFilters.length) {
    coaFilters.forEach((f) =>
      f.addEventListener('click', () => {
        const cat = f.dataset.coaFilter;
        coaFilters.forEach((x) => x.classList.toggle('is-active', x === f));
        $$('[data-coa-cat]').forEach((item) => {
          item.style.display =
            cat === 'all' || item.dataset.coaCat === cat ? '' : 'none';
        });
      })
    );
  }


  /* ---- toast ----------------------------------------------------------- */
  let toastTimer;
  function toast(msg, ms = 2600) {
    let t = $('#toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.setAttribute('role', 'status');
      t.style.cssText =
        'position:fixed;left:50%;bottom:1.6rem;transform:translateX(-50%) translateY(20px);z-index:400;background:#1a1813;color:#f6f2ea;padding:.85rem 1.3rem;border-radius:999px;font-size:.85rem;box-shadow:0 12px 30px -8px rgba(0,0,0,.4);opacity:0;transition:opacity .35s,transform .35s cubic-bezier(.16,1,.3,1);max-width:90vw;text-align:center';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    requestAnimationFrame(() => {
      t.style.opacity = '1';
      t.style.transform = 'translateX(-50%) translateY(0)';
    });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.style.opacity = '0';
      t.style.transform = 'translateX(-50%) translateY(20px)';
    }, ms);
  }

  /* ---- year stamp ------------------------------------------------------ */
  $$('[data-year]').forEach((el) => (el.textContent = new Date().getFullYear()));

  /* =====================================================================
     CHECKOUT — collects contact + consent, posts identifiers only (never
     prices), then redirects to TagadaPay's secure checkout. Shipping address
     and card details are collected there.
     ===================================================================== */
  const esc = (s = '') =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const checkoutRoot = $('#checkout');
  if (checkoutRoot) initCheckout();

  function initCheckout() {
    const itemsEl = $('#coItems');
    const totalsEl = $('#coTotals');
    const form = $('#checkoutForm');
    const errEl = $('#coError');
    const submit = $('#coSubmit');
    const submitLabel = submit.innerHTML;
    const THRESH = 150;
    const SHIP_FLAT = 9.95;

    // Prefill contact from the signed-in account (checkout is login-gated,
    // so this normally succeeds; a quiet failure just leaves the fields blank).
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || !d.user) return;
        const nameEl = $('#coName'), emailEl = $('#coEmail');
        if (nameEl && !nameEl.value) nameEl.value = d.user.name || '';
        if (emailEl && !emailEl.value) emailEl.value = d.user.email || '';
      })
      .catch(() => {});

    const drawTotals = () => {
      if (!cart.length) {
        itemsEl.innerHTML = '<p class="checkout__empty">Your cart is empty.</p>';
        totalsEl.innerHTML = '';
        submit.disabled = true;
        return;
      }
      itemsEl.innerHTML = cart
        .map(
          (l) => `<div class="checkout__item">
            <img src="${esc(l.img)}" alt="" width="40" height="50" loading="lazy">
            <div>
              <b>${esc(l.name)}</b>
              <span>${esc(l.meta)} · Qty ${l.qty}</span>
            </div>
            <em>${fmt(l.price * l.qty)}</em>
          </div>`
        )
        .join('');
      const subtotal = cart.reduce((s, l) => s + l.price * l.qty, 0);
      const shipping = subtotal >= THRESH ? 0 : SHIP_FLAT;
      totalsEl.innerHTML = `
        <div class="checkout__row"><span>Subtotal</span><span>${fmt(subtotal)}</span></div>
        <div class="checkout__row"><span>Shipping</span><span>${shipping ? fmt(shipping) : 'Free'}</span></div>
        <div class="checkout__row checkout__row--total"><span>Total due</span><span>${fmt(subtotal + shipping)}</span></div>
        <p class="checkout__note">This exact total is confirmed by our server and charged on the secure payment page.</p>`;
      submit.disabled = false;
    };
    drawTotals();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.hidden = true;

      if (!cart.length) return showErr('Your cart is empty.');
      if (!$('#coAge').checked) return showErr('Please confirm you are 21 years of age or older.');
      if (!$('#coResearch').checked)
        return showErr('Please confirm the laboratory research-use acknowledgment.');

      const payload = {
        name: $('#coName').value,
        email: $('#coEmail').value,
        notes: $('#coNotes').value,
        company: $('#coCompany').value, // honeypot
        ageConfirm: true,
        researchConfirm: true,
        items: cart.map((l) => ({
          slug: l.slug,
          variant: l.variant,
          bundleQty: l.bundleQty,
          qty: l.qty,
        })),
      };

      submit.disabled = true;
      submit.textContent = 'Preparing secure payment…';
      try {
        const res = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.status === 401) {
          // Session expired mid-checkout: sign back in, then return here.
          location.assign('/account/login/?next=%2Fcheckout%2F');
          return;
        }
        const data = await res.json();
        if (!res.ok || !data.ok) {
          const err = new Error(data.error || 'We could not start the payment.');
          err.retryable = data.retryable !== false;
          throw err;
        }

        // The cart survives until /order/ sees the payment settle, so a buyer
        // whose card is declined comes back to an intact cart.
        sessionStorage.setItem('auraa.pendingOrder', data.order.ref);
        submit.textContent = 'Redirecting to secure payment…';
        location.assign(data.url);
      } catch (err) {
        submit.disabled = false;
        submit.innerHTML = err.retryable === false ? submitLabel : 'Try again — continue to secure payment';
        showErr(err.message || 'We could not start the payment. Please try again.');
      }
    });

    function showErr(msg) {
      errEl.textContent = msg;
      errEl.hidden = false;
      errEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  /* =====================================================================
     ORDER — the thank-you page TagadaPay returns to. Reads ?ref= (set when
     the order was created), then polls the server while the payment webhook
     settles. All state comes from the server; nothing here trusts the URL
     beyond using the random ref as a lookup key.
     ===================================================================== */
  const orderPane = $('#orderPane');
  if (orderPane) initOrder();

  function initOrder() {
    const ref =
      new URLSearchParams(location.search).get('ref') ||
      sessionStorage.getItem('auraa.pendingOrder') ||
      '';
    if (!/^AUR-[A-Z0-9]{6}$/.test(ref)) return; // the empty state is already in the DOM

    $('#orderEmpty').hidden = true;
    orderPane.hidden = false;
    $('#orderRefBig').textContent = ref;
    wireCopy(document);

    const badgeText = $('#orderBadgeText');
    const title = $('#orderTitle');
    const lead = $('#orderLead');
    const next = $('#orderNext');

    let polls = 0;
    const MAX_POLLS = 20; // ~1 minute; webhooks normally land in seconds

    async function check() {
      polls++;
      let d = null;
      try {
        const res = await fetch(`/api/order-status?ref=${encodeURIComponent(ref)}`);
        d = res.ok ? await res.json() : null;
      } catch {
        d = null;
      }
      const o = d && d.ok ? d.order : null;
      if (o) {
        $('#orderTotal').textContent = o.totalFormatted || '$—';
        $('#orderItems').innerHTML = (o.items || [])
          .map((i) => `${i.qty} × ${esc(i.name)} <small>(${esc(i.meta)})</small>`)
          .join('<br>');
      }

      if (o && (o.status === 'paid' || o.status === 'shipped')) {
        badgeText.textContent = o.test ? 'Test payment confirmed' : 'Payment confirmed';
        title.textContent = 'Thank you — your order is confirmed';
        lead.innerHTML = `Payment for order <b class="order-ref-inline">${esc(ref)}</b> is confirmed. A receipt has been emailed to you.`;
        next.textContent = "Your order is being prepared. You'll receive a shipping confirmation with tracking by email.";
        // The sale is settled; now the cart can go.
        cart = [];
        writeCart(cart);
        renderCount();
        sessionStorage.removeItem('auraa.pendingOrder');
        return;
      }
      if (o && o.status === 'payment_failed') {
        badgeText.textContent = 'Payment not completed';
        title.textContent = 'Your payment did not go through';
        lead.innerHTML = `The payment for order <b class="order-ref-inline">${esc(ref)}</b> was not completed. Your cart is untouched — you can try again.`;
        next.innerHTML = '<a class="btn" href="/checkout/">Return to checkout</a>';
        return;
      }
      if (polls >= MAX_POLLS) {
        badgeText.textContent = 'Payment processing';
        title.textContent = 'Your payment is still processing';
        lead.innerHTML = `We haven't received the final confirmation for order <b class="order-ref-inline">${esc(ref)}</b> yet. You'll get an email the moment it settles — no need to pay again.`;
        return;
      }
      setTimeout(check, polls < 5 ? 2000 : 4000);
    }
    check();
  }

  function wireCopy(root) {
    $$('[data-copy-target]', root).forEach((btn) =>
      btn.addEventListener('click', async () => {
        const el = document.getElementById(btn.dataset.copyTarget);
        if (!el) return;
        try {
          await navigator.clipboard.writeText(el.textContent.trim());
          const was = btn.textContent;
          btn.textContent = 'Copied';
          btn.classList.add('is-copied');
          setTimeout(() => {
            btn.textContent = was;
            btn.classList.remove('is-copied');
          }, 1600);
        } catch {
          toast('Press Ctrl/Cmd + C to copy.');
        }
      })
    );
  }

  /* =====================================================================
     ADMIN — password is typed by the operator, held in sessionStorage only,
     and sent as a bearer token. It is never part of this bundle.
     ===================================================================== */
  const adminGate = $('#adminGate');
  if (adminGate) initAdmin();

  function initAdmin() {
    const PASS_KEY = 'auraa.admin';
    const panel = $('#adminPanel');
    const list = $('#adminList');
    const stats = $('#adminStats');
    const errEl = $('#adminError');
    let filter = 'all';
    let orders = [];

    const pass = () => sessionStorage.getItem(PASS_KEY) || '';
    const api = (url, body) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + pass() },
        body: JSON.stringify(body || {}),
      }).then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error(d.error || 'Request failed.');
        return d;
      });

    $('#adminLogin').addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.hidden = true;
      sessionStorage.setItem(PASS_KEY, $('#adminPass').value);
      try {
        await load();
        adminGate.hidden = true;
        panel.hidden = false;
      } catch (err) {
        sessionStorage.removeItem(PASS_KEY);
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    });

    $('#adminLogout').addEventListener('click', () => {
      sessionStorage.removeItem(PASS_KEY);
      location.reload();
    });
    $('#adminRefresh').addEventListener('click', () => load().catch(() => {}));
    $$('#adminFilters .tag-filter').forEach((b) =>
      b.addEventListener('click', () => {
        filter = b.dataset.status;
        $$('#adminFilters .tag-filter').forEach((x) => x.classList.toggle('is-active', x === b));
        draw();
      })
    );

    // resume a session after a refresh
    if (pass()) {
      load()
        .then(() => {
          adminGate.hidden = true;
          panel.hidden = false;
        })
        .catch(() => sessionStorage.removeItem(PASS_KEY));
    }

    async function load() {
      const d = await api('/api/admin/orders');
      orders = d.orders || [];
      stats.innerHTML = `<span><b>${d.totals.count}</b> orders</span>
        <span><b>${d.totals.pending_payment || 0}</b> pending</span>
        <span><b>${fmt(d.totals.revenue || 0)}</b> confirmed</span>`;
      draw();
    }

    function draw() {
      const rows = orders.filter((o) => filter === 'all' || o.status === filter);
      if (!rows.length) {
        list.innerHTML = '<p class="checkout__empty">No orders in this view yet.</p>';
        return;
      }
      list.innerHTML = rows.map(card).join('');
      $$('[data-action]', list).forEach((b) =>
        b.addEventListener('click', async () => {
          const ref = b.dataset.ref;
          const body = { ref, notify: false };
          if (b.dataset.action === 'status') {
            body.status = b.dataset.value;
            body.notify = b.dataset.value === 'paid' || b.dataset.value === 'shipped'
              ? confirm('Email the buyer a confirmation for ' + ref + '?')
              : false;
          }
          if (b.dataset.action === 'tracking') {
            const input = document.getElementById('trk-' + ref);
            if (!input || !input.value.trim()) return toast('Enter a tracking number first.');
            body.tracking = input.value.trim();
            body.status = 'shipped';
            body.notify = confirm('Email tracking to the buyer for ' + ref + '?');
          }
          b.disabled = true;
          try {
            const d = await api('/api/admin/orders/update', body);
            toast(d.emailed ? 'Updated — buyer emailed.' : 'Order updated.');
            await load();
          } catch (err) {
            toast(err.message);
            b.disabled = false;
          }
        })
      );
    }

    function card(o) {
      const when = new Date(o.createdAt).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      const items = o.items
        .map((i) => `<li>${i.qty} × ${esc(i.name)} <span>${esc(i.meta)}</span> <b>${fmt(i.lineTotal)}</b></li>`)
        .join('');
      const addr = [o.customer.address1, o.customer.address2, `${o.customer.city}, ${o.customer.state} ${o.customer.postal}`, o.customer.country]
        .filter(Boolean)
        .map(esc)
        .join('<br>');
      return `<article class="admin-order" data-status="${esc(o.status)}">
        <header class="admin-order__head">
          <div>
            <span class="admin-order__ref">${esc(o.ref)}</span>
            <span class="admin-status admin-status--${esc(o.status)}">${esc(o.status.replace('_', ' '))}</span>
          </div>
          <div class="admin-order__total">${fmt(o.total)}</div>
        </header>
        <div class="admin-order__grid">
          <div>
            <span class="eyebrow">Buyer</span>
            <p>${esc(o.customer.name)}<br><a href="mailto:${esc(o.customer.email)}">${esc(o.customer.email)}</a></p>
            <span class="eyebrow">Ship to</span>
            <p>${addr}</p>
            ${o.customer.notes ? `<span class="eyebrow">Notes</span><p>${esc(o.customer.notes)}</p>` : ''}
          </div>
          <div>
            <span class="eyebrow">Items</span>
            <ul class="admin-items">${items}</ul>
            <span class="eyebrow">Placed</span>
            <p class="mono">${esc(when)}</p>
            ${o.tracking ? `<span class="eyebrow">Tracking</span><p class="mono">${esc(o.tracking)}</p>` : ''}
          </div>
        </div>
        <div class="admin-order__actions">
          <button class="btn btn--sm" data-action="status" data-value="paid" data-ref="${esc(o.ref)}">Mark paid</button>
          <button class="btn btn--ghost btn--sm" data-action="status" data-value="shipped" data-ref="${esc(o.ref)}">Mark shipped</button>
          <button class="btn btn--ghost btn--sm" data-action="status" data-value="cancelled" data-ref="${esc(o.ref)}">Cancel</button>
          <span class="admin-track">
            <input id="trk-${esc(o.ref)}" placeholder="Tracking number" value="${esc(o.tracking || '')}">
            <button class="btn btn--sm" data-action="tracking" data-ref="${esc(o.ref)}">Save &amp; ship</button>
          </span>
        </div>
      </article>`;
    }
  }

  renderCount();
  syncAck();
})();
