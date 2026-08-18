# Assets

Every image the site uses. All of them are hand-authored SVG: they scale to any
screen without a second file, weigh a few kilobytes each, and carry no external
requests, which matters because the Content-Security-Policy in `src/app.js`
allows images from `'self'` and `data:` only.

Colours here are hard-coded to the palette in `public/css/app.css`. If the brand
blue changes, these files change with it — that is the trade for keeping the
artwork as flat files rather than inline markup.

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
| `icons/*.svg` | 24px line icons used as CSS backgrounds: `calendar`, `clock` and `pin` label the hero details; `pin` also marks a concert card's venue; `check` heads the booking confirmation. `seat`, `ticket`, `shield`, `users`, `whatsapp` and `info` are spare stock for future screens. |

## Adding an image

1. Drop the file in here (`icons/` for anything 24px and line-drawn).
2. Reference it by absolute URL — `/assets/name.svg` — from CSS or markup.
3. Decorative artwork gets `alt=""` and `aria-hidden="true"`; artwork that
   carries meaning gets a real `alt`.
4. Photographs, if any are ever added, belong here as well, but keep them under
   ~200 KB and reference them the same way.
