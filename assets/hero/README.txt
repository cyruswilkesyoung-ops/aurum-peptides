Hero banner image
=================

index.html expects ONE file here:

    assets/hero/hero.webp        6336 x 2688, WebP, ~198 KB

Where to get it
---------------
Higgsfield serves a full-resolution WebP of the generated frame directly. Download it
and save it under the name above — no resizing or conversion needed. The PNG next to
it is 24.4 MB and must NOT be used on the page.

The file is deliberately absent from the repo rather than replaced with a placeholder:
a 404 is visible and self-correcting, and the hero falls back to the branded dark
ground with the headline still readable on it. A committed placeholder ships silently.

About the frame
---------------
21:9. The composition reserves the left two thirds as near-black negative space for
the headline and puts the vials in the right third. Measured on the source:

    mean luminance, left third   0.075
    mean luminance, right third  0.360
    headline zone (left 44%)     mean 0.079, brightest pixel 0.262, stddev 0.045

That is why css/main.css pins object-position to 72% — a centre crop on a phone would
frame the empty half and lose the product. It is also why the scrim, not the
photograph, is what guarantees contrast under the type.

Worth doing later
-----------------
One 6336px file is only ~198 KB, so bytes are not the problem, but a phone still has
to decode it at full size (~68 MB in memory). Adding 1280 and 2560 variants behind a
<picture> srcset would fix that. Left out for now because a partially-present srcset
renders a broken image rather than falling back.

No text is baked into the image. The headline is real HTML over it, so it stays
selectable, translatable and readable to a screen reader.
