# Assets

Every image the site uses. All of them are hand-authored SVG: they scale to any
screen without a second file, weigh a few kilobytes each, and carry no external
requests, which matters because the Content-Security-Policy in `src/app.js`
allows images from `'self'` and `data:` only.

Colours in the larger artwork are hard-coded to the palette in
`public/css/app.css`. If the brand colour changes, those files change with it —
that is the trade for keeping the artwork as flat files rather than inline
markup.

The icons in `icons/` are the exception. They are drawn with
`stroke="currentColor"` and used as CSS **masks** rather than images, so the
stylesheet decides their colour: a field's mark is grey at rest, indigo while
the field has focus, red when the field is invalid, all from one file. Anything
new in `icons/` should follow the same rule — 24×24 viewBox, `currentColor`,
1.8 stroke — so it can be tinted the same way.

| File | Where it is used |
| --- | --- |
| `logo.svg` | Masthead mark on every page (`.masthead__logo`) |
| `favicon.svg` | Browser tab icon, linked from every page's `<head>` |
| `hero-worship.svg` | Homepage hero artwork (`.hero__art`) |
| `wave.svg` | The curve at the foot of the hero, as a CSS background |
| `poster.svg` | Concert poster on `concert.html` (`.poster`) |
| `church.svg` | Fixed page decoration on the sign-in, register, recovery, verify and 404 pages |
| `sprig.svg` | The other half of that decoration, bottom left |
| `crowd.svg` | Welcome banner on the attendee dashboard |
| `ticket-banner.svg` | Masthead strip on the printable ticket, and the head of the confirmation page — the same image in both so screen and paper match |
| `ticket-crest.svg` | Crest beside the "on the night" notes on the ticket |
| `auth-backdrop.svg` | Full-bleed backdrop on the staff sign-in page |
| `icons/*.svg` | 24px line icons. `calendar`, `clock` and `pin` label the hero details as CSS backgrounds; `pin` also marks a concert card's venue. The rest are masks: `check` draws `.success-mark` on the confirmation page, `chevron` the arrow on every custom select, `eye`/`eye-off` the password reveal, and `user`, `mail`, `phone`, `whatsapp`, `lock`, `key`, `home`, `identity`, `lifebuoy`, `shield`, `calendar`, `clock`, `pin`, `seat`, `ticket`, `note`, `music`, `users` the leading marks inside form fields (`.field__icon[data-icon="…"]`). `search` and `info` are spare stock. |

## Adding an image

1. Drop the file in here (`icons/` for anything 24px and line-drawn).
2. Reference it by absolute URL — `/assets/name.svg` — from CSS or markup.
3. Decorative artwork gets `alt=""` and `aria-hidden="true"`; artwork that
   carries meaning gets a real `alt`.
4. Photographs, if any are ever added, belong here as well, but keep them under
   ~200 KB and reference them the same way.
