# TeacherWyatt

Website for **TeacherWyatt** — Kristin Wyatt, who teaches English & Spanish
to English/Spanish/French/Italian speakers, online and in person in Nigrán,
Galicia, Spain.

## Stack

- **Site**: [Zola](https://www.getzola.org/) static site generator (`site/`), multilingual (EN default, ES under `/es/`)
- **CMS**: [Sveltia CMS](https://github.com/sveltia/sveltia-cms) at `/admin` — so Kristin can edit both languages herself
- **Hosting**: Cloudflare Pages (https://teacherwyatt.pages.dev)
- **CMS auth**: Pages Functions (`functions/`) — GitHub OAuth proxy + `/admin` gate

## Multilingual

English is the default language (served at `/`); Spanish is served under `/es/`.
Each content file has a default `.md` (English) and an `.es.md` twin
(e.g. `about.md` + `about.es.md`). To add a language later (Italian, French):
add a `[languages.xx]` block to `site/config.toml`, add its prefix to the
`known` list in the `lang_toggle` macro (`site/templates/macros.html`), and
create `.xx.md` twins.

## Development

```bash
scripts/run       # local dev server (zola serve)
scripts/build     # build site to site/public/
scripts/check     # build + htmltest link/anchor validation
scripts/validate  # alias for check
```

## Content

- **Home** — long single page: hero, about, lessons, pricing, reviews, contact
- **Blog** (`/blog`) — reading recommendations (blog engine)
- **About** — Kristin's bio

## Deployment

GitHub Actions builds and deploys to Cloudflare Pages on push to `main`,
including the Pages Functions that handle CMS login. See `SETUP.md`.

## License

Proprietary — all rights reserved. This project is not open source. See [`LICENSE.md`](LICENSE.md).
