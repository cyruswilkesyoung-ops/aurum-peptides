HERO BANNER

Current file: assets/hero/hero-20261104b.webp (2688 x 1520, WebP), referenced from
css/main.css (desktop background + mobile Image-CDN variant) and two preloads in
index.html. The front vial label carries the real Auraa logo, composited from the
traced vector assets/auraa-logo-20261104.svg (monogram + wordmark + gold rule,
stacked, dark bronze).

Everything under /assets/ is served with Cache-Control: immutable, max-age = 1 year
(netlify.toml). A browser that has seen a file keeps it for a year. So a replacement
hero, og image or packshot MUST get a NEW filename (date-stamp it) and the references
updated; replacing the bytes under the same name looks like nothing changed to every
returning visitor. This is why hero.webp became hero-20260918.webp on 2026-09-18,
and hero-20261023.webp became hero-20261104b.webp on 2026-11-04.
