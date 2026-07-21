# Facebook scrape (one-time content import)

Pulls Kristin's Facebook Page content into `tmp/fb-export/` so we can seed the
new site's blog posts and photos. **Run locally** — it opens a real browser
you log into.

## Run it

```bash
scripts/scrape-facebook
# or a different page:
scripts/scrape-facebook https://www.facebook.com/thewyattteacher
```

On first run it installs Playwright + Chromium into `scripts/scrape/node_modules`
(git-ignored), then opens a browser:

1. If a **login screen** appears, log in (handle 2FA). Your session is saved to
   `tmp/fb-profile` so later runs skip this.
2. When the Page content is visible, return to the terminal and press **ENTER**.
3. It scrolls to load posts, then writes everything to `tmp/fb-export/`.

## Output (`tmp/fb-export/`)

| Path | What |
| --- | --- |
| `posts.json` | Best-effort structured posts (text, dates, image refs) + image map |
| `html/page.html` | Full rendered HTML — the **source of truth** if extraction misses something |
| `screenshots/` | Visual record (periodic + full-page) |
| `images/` | Downloaded images |
| `image-urls.txt` | Flat list of every image URL seen |

Nothing here is committed (`tmp/` is git-ignored). Hand the folder to Claude and
we'll turn it into draft blog posts in Phase 4.

## Knobs (env vars)

- `FB_SCROLLS=60` — more scroll steps for a long history (default 40)
- `FB_HEADFUL=0` — headless (only after you've logged in once)
- `FB_PROFILE=/path` — alternate persistent profile dir

## If Facebook blocks it

The markup is obfuscated and changes; if extraction comes back thin, fall back
to Facebook's official export: **Settings → Your information → Download your
information** (choose Posts + Photos, HTML or JSON), and hand that to Claude
instead. The `html/page.html` we saved is still useful either way.
