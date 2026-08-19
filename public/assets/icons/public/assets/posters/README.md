# Concert posters

`concerts.poster_path` points at one of these. It is always a path under
`/assets`, never a URL — the CSP allows images from `'self'` and `data:` only,
so an off-origin poster would simply not load.

* The `*.svg` files here are the bundled artwork. A concert with no poster of
  its own falls back to one of them, chosen from the concert id so a given
  concert always draws the same picture rather than shuffling on reload.
* `uploads/` holds real photographs uploaded through the console
  (`POST /api/admin/concerts/:id/poster`). PNG, JPEG and WebP only, 2 MB cap.
  SVG uploads are refused on purpose: an SVG is a document that can carry
  script, and these are served same-origin.

`uploads/` is in `.gitignore` — uploaded artwork is deployment data, not source.
