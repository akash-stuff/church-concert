# Assets

Every image the site uses. All of them are hand-authored SVG: they scale to any
screen without a second file, weigh a few kilobytes each, and carry no external
requests, which matters because the Content-Security-Policy in `src/app.js`
allows images from `'self'` and `data:` only.

The one exception is `posters/uploads/`, which holds photographs uploaded by
staff through the console. Those are real raster files and are the only images
here nobody drew.

Colours in the larger artwork are hard-coded to the palette in
`public/css/app.css`. If the brand colour changes, those files change with it —
that is the trade for keeping the artwork as flat files rather than inline
markup.

The icons in `icons/` are the exception to that too. They are drawn with
`stroke="currentColor"` and used as CSS **masks** rather than images, so the
stylesheet decides their colour: a field's mark is grey at rest, navy while the
field has focus, red when the field is invalid, all from one file. Anything new
in `icons/` should follow the same rule — 24×24 viewBox, `currentColor`, 1.8
stroke — so it can be tinted the same way.

## Photographs

`photos/` holds the real imagery. They arrived as 2–17 MB originals and were
resized in the browser (canvas → JPEG) rather than by hand: long edge capped at
1800px for landscape and 1400px for portrait, quality 0.84, which brought the
set from roughly 35 MB to 1.1 MB with no visible loss at the sizes they render.

`cross-book-3d.png` and `rosary-violet.png` stay PNG because they are cut-outs
with transparent backgrounds; flattening those onto white puts a white rectangle
on the page. Everything else is a full-frame photograph and is saved as JPEG.

Alpha is expensive: `rosary-violet.png` is 374 KB at 1400px where the flattened
JPEG was 75 KB at 1800px. That is the price of the transparency, so cut-outs are
sized tighter than the photographs.

The hand-drawn artwork that used to stand in for these — `stage.svg`,
`worship.svg`, `auth-backdrop.svg` — has been deleted. Nothing references it.

| File | Where it is used |
| --- | --- |
| `logo.svg` | Masthead mark on every page (`.masthead__logo`) and the console rail |
| `favicon.svg` | Browser tab icon, linked from every page's `<head>` |
| `wave.svg` | The curve at the foot of the hero, as a CSS background |
| `ticket-banner.svg` | Masthead strip on the printable ticket |
| `ticket-crest.svg` | Crest beside the "on the night" notes on the ticket |
| `photos/rosary-violet.png` | Homepage hero (`.hero__art`). Cut-out on transparency, so its frame must not add a radius or box-shadow |
| `church.svg` | Welcome panel on the attendee sign-in page (`.auth-hero__art`). Flat-vector church at night, already on-palette. Full-bleed background, so its frame adds a radius and shadow — unlike the hero cut-out |
| `photos/hands-bibles.jpg` | The house concert image — every concert with no uploaded photo of its own, on `concert.html` and in the console |
| `photos/cross-missal.jpg` | Booking confirmation banner (`.confirm-art`) |
| `photos/crucifix-book.jpg` | Attendee dashboard welcome card (`.card__art--crop`) |
| `photos/rosary-hands.jpg` | The verify screen, while you wait for a code (`.verify-art`) |
| `photos/chalice.jpg` | Full-bleed backdrop on the staff sign-in page (`.auth__art`) |
| `photos/cross-book-3d.png` | Not currently placed. A transparent cut-out, so it suits a tinted panel rather than a cropped frame |
| `posters/uploads/*` | Photographs uploaded per concert through the console. Written by `POST /api/admin/concerts/:id/poster`, deleted by the matching `DELETE`. Nothing else writes here |
| `icons/*.svg` | 24px line icons. `calendar`, `clock` and `pin` label the hero details as CSS backgrounds and so carry a literal navy; `pin` also marks a concert card's venue. The rest are masks tinted by the stylesheet |

## Concert images

A concert shows exactly one image. If staff have uploaded a photograph it is
that; otherwise it is `photos/hands-bibles.jpg`. There is no gallery to pick from and no
per-concert artwork bundled with the app.

`poster_path` is only honoured when it points inside `posters/uploads/`.
Anything else is treated as absent, which is what lets old rows still pointing
at the deleted illustrations fall back cleanly instead of showing a gap.

## Optimising supplied SVG

Illustrator exports are big and compress badly on the wire — this app serves
static files with no compression middleware, so the raw byte count is the
transfer size. Two transforms are safe and measured pixel-identical:

- rewrite `style="fill:#xxx"` as a `fill` attribute
- collapse the line breaks Illustrator puts inside path data

**Do not round coordinate precision.** Illustrator omits the separator between
numbers in path data, so rounding can merge two numbers into one and move an
edge. Measured on `church.svg`: 3.5% of pixels wrong, worst channel off by 51.
It was backed out. Whatever you do, diff the render before and after rather
than trusting the byte count.

## Adding an image

1. Drop the file in here (`icons/` for anything 24px and line-drawn).
2. Reference it by absolute URL — `/assets/name.svg` — from CSS or markup.
3. Decorative artwork gets `alt=""` and `aria-hidden="true"`; artwork that
   carries meaning gets a real `alt`.
4. Per-concert photographs belong in `posters/uploads/` by upload rather than
   by hand. Site-wide imagery goes in `photos/`: cap the long edge at 1800px,
   save at quality ~0.84, and keep each file under ~300 KB.
