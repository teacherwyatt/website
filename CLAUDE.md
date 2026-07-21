# TeacherWyatt — a website

Website for Kristin Wyatt (English & Spanish teacher, Nigrán, Spain).

## Stack
- **Site**: Zola static site generator, multilingual (EN default at `/`, ES at `/es/`)
- **CMS**: Sveltia CMS at `/admin` (Kristin self-edits both languages)
- **CMS auth**: Pages Functions in `functions/` (GitHub OAuth + `/admin` gate)
- **Deployment**: Cloudflare Pages (teacherwyatt.pages.dev) on push to `main`

## Multilingual
Default-language (English) files are `page.md`; other languages use
`page.<lang>.md` twins (e.g. `about.md` + `about.es.md`). Every section
`_index.md` needs an `_index.<lang>.md` twin — Zola has no language fallback.
Nav labels and the language toggle live in `site/templates/macros.html`.

## Tools
Use `scripts/build` to build and `scripts/check` (htmltest) to validate links
before notifying the user of success. Use `tree-me` for git worktrees.
