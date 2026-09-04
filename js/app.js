/* Aurum Peptides — interaction layer. Vanilla, dependency-free, deferred.
   Everything degrades gracefully without JS: content and links work, the cart
   is an enhancement, reveals default to visible. */
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
  const CART_KEY = 'aurum.cart.v2';
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

  /* ---- reconstitution calculator -------------------------------------- */
  const calc = $('#calc');
  if (calc) {
    const massEl = $('#calcMass');
    const volEl = $('#calcVol');
    const conc = $('#calcConc');
    const ugul = $('#calcUgUl');
    const run = () => {
      const m = parseFloat(massEl.value) || 0;
      const v = parseFloat(volEl.value) || 0;
      const c = v > 0 ? m / v : 0;
      conc.textContent = c.toFixed(2);
      ugul.textContent = c.toFixed(2); // mg/mL === µg/µL
    };
    massEl.addEventListener('input', run);
    volEl.addEventListener('input', run);
    run();
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
     CHECKOUT — collects details, posts identifiers only, never prices.
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
    const THRESH = 150;
    const SHIP_FLAT = 9.95;

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
            <img src="${esc(l.img)}" alt="" width="40" height="52" loading="lazy">
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
        <p class="checkout__note">Final total is confirmed by our server when the order is placed.</p>`;
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
        address1: $('#coAddr1').value,
        address2: $('#coAddr2').value,
        city: $('#coCity').value,
        state: $('#coState').value,
        postal: $('#coPostal').value,
        country: $('#coCountry').value,
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
      submit.textContent = 'Placing order…';
      try {
        const res = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'We could not place this order.');

        // Hand the instructions to /order/ via sessionStorage — never the URL.
        sessionStorage.setItem('aurum.lastOrder', JSON.stringify(data));
        cart = [];
        writeCart(cart);
        location.assign('/order/');
      } catch (err) {
        submit.disabled = false;
        submit.innerHTML = 'Place order — pay manually';
        showErr(err.message || 'We could not place this order. Please try again.');
      }
    });

    function showErr(msg) {
      errEl.textContent = msg;
      errEl.hidden = false;
      errEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  /* =====================================================================
     ORDER — payment instructions, rendered from the server's response.
     ===================================================================== */
  const orderPane = $('#orderPane');
  if (orderPane) initOrder();

  function initOrder() {
    let data = null;
    try {
      data = JSON.parse(sessionStorage.getItem('aurum.lastOrder'));
    } catch {
      data = null;
    }
    if (!data || !data.order) return; // the empty state is already in the DOM

    $('#orderEmpty').hidden = true;
    orderPane.hidden = false;

    const o = data.order;
    $('#orderRef').textContent = o.ref;
    $('#orderRefBig').textContent = o.ref;
    $('#orderTotal').textContent = o.totalFormatted || fmt(o.total);
    $('#orderWindow').textContent = data.confirmWindow || '24 hours';
    const sup = $('#orderSupport');
    if (sup && data.supportEmail) {
      sup.textContent = data.supportEmail;
      sup.href = 'mailto:' + data.supportEmail;
    }
    $('#orderBreakdown').textContent =
      o.shipping > 0
        ? `${fmt(o.subtotal)} + ${fmt(o.shipping)} shipping`
        : `${fmt(o.subtotal)} · free shipping`;

    // payment method tabs
    const tabs = $('#payTabs');
    const panels = $('#payPanels');
    const methods = data.methods || [];
    tabs.innerHTML = methods
      .map(
        (m, i) =>
          `<button class="pay__tab${i === 0 ? ' is-active' : ''}" role="tab" data-pay="${esc(m.id)}">${esc(m.label)}</button>`
      )
      .join('');
    panels.innerHTML = methods.map((m, i) => renderMethod(m, i === 0)).join('');

    $$('.pay__tab', tabs).forEach((t) =>
      t.addEventListener('click', () => {
        $$('.pay__tab', tabs).forEach((x) => x.classList.toggle('is-active', x === t));
        $$('.pay__panel', panels).forEach((p) =>
          p.classList.toggle('is-active', p.dataset.pay === t.dataset.pay)
        );
      })
    );

    wireCopy(document);

    function renderMethod(m, active) {
      const cls = `pay__panel${active ? ' is-active' : ''}`;
      if (m.id === 'crypto') {
        return `<div class="${cls}" data-pay="crypto">
          ${m.coins
            .map(
              (c, i) => `<div class="pay__addr">
              <div class="pay__addr-main">
                <span class="eyebrow">${esc(c.label)} <small>· ${esc(c.network)}</small></span>
                <code id="addr-${esc(c.code)}">${esc(c.address)}</code>
                <button class="copy-btn" data-copy-target="addr-${esc(c.code)}">Copy ${esc(c.code)} address</button>
              </div>
              ${c.qr ? `<img class="pay__qr" src="${c.qr}" alt="QR code for the ${esc(c.label)} address" width="120" height="120">` : ''}
            </div>`
            )
            .join('')}
          <p class="pay__hint">Send the equivalent of the amount due. Include your order number in the transaction note where your wallet supports it.</p>
        </div>`;
      }
      if (m.id === 'cashapp') {
        return `<div class="${cls}" data-pay="cashapp">
          <div class="pay__addr">
            <div class="pay__addr-main">
              <span class="eyebrow">Cash App</span>
              <code id="addr-cashapp">${esc(m.handle)}</code>
              <button class="copy-btn" data-copy-target="addr-cashapp">Copy $cashtag</button>
            </div>
            ${m.qr ? `<img class="pay__qr" src="${m.qr}" alt="QR code for the Cash App handle" width="120" height="120">` : ''}
          </div>
          <p class="pay__hint">Put your order number in the “For” note so we can match the payment.</p>
        </div>`;
      }
      return `<div class="${cls}" data-pay="zelle">
        <div class="pay__addr">
          <div class="pay__addr-main">
            <span class="eyebrow">Zelle${m.name ? ` <small>· ${esc(m.name)}</small>` : ''}</span>
            <code id="addr-zelle">${esc(m.handle)}</code>
            <button class="copy-btn" data-copy-target="addr-zelle">Copy Zelle contact</button>
          </div>
          ${m.qr ? `<img class="pay__qr" src="${m.qr}" alt="QR code for the Zelle contact" width="120" height="120">` : ''}
        </div>
        <p class="pay__hint">Add your order number to the memo field.</p>
      </div>`;
    }
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
    const PASS_KEY = 'aurum.admin';
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
