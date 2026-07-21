// Turn tmp/fb-export/posts.json (from scrape-facebook.mjs) into DRAFT Book
// Review markdown files under tmp/fb-import/ for you to review before moving
// any into site/content/blog/.
//
// This does NOT write directly into site/content — Facebook post text is messy
// (reactions, "See more", comment counts), so a human should vet each draft.
//
// Usage (via wrapper): scripts/import-fb-posts
//
// It writes:
//   tmp/fb-import/<slug>.md        one draft per kept post
//   tmp/fb-import/_INDEX.md        a summary list with links to review

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(process.cwd());              // scripts/scrape
const EXPORT = path.resolve(ROOT, '../../tmp/fb-export');
const OUT = path.resolve(ROOT, '../../tmp/fb-import');
const IMAGES_SRC = path.join(EXPORT, 'images');

const log = (...a) => console.error('[import]', ...a);

function slugify(s) {
  return (s || 'post')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'post';
}

// Trim common Facebook UI cruft from a post's innerText.
function cleanText(t) {
  let s = t || '';
  // Remove an inline "See more"/"Ver más" that can appear mid-text when a post
  // was (or wasn't) expanded — collapse the ellipsis + control into nothing.
  s = s.replace(/…*\s*(see more|ver más|ver mas|voir plus|mostra altro|mehr anzeigen)\s*/gi, ' ');
  // Remove a trailing "See less"/"Ver menos" that appears after expansion.
  s = s.replace(/\s*(see less|ver menos|voir moins|mostra meno|weniger anzeigen)\s*$/gi, '');
  // Drop standalone UI lines like reactions/like/comment/share and counts.
  const dropLine = /^(see more|ver más|like|me gusta|comment|comentar|share|compartir|reply|responder|\d+\s*(comments?|comentarios?|shares?|reactions?|likes?)|all reactions?|todas las reacciones)$/i;
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !dropLine.test(l));
  return lines.join('\n').replace(/[ \t]{2,}/g, ' ').trim();
}

// Guess a title from the first sentence/line.
function guessTitle(text) {
  const first = (text.split('\n')[0] || '').trim();
  const sentence = first.split(/(?<=[.!?])\s/)[0];
  return (sentence || first).slice(0, 80).replace(/["""]/g, '').trim() || 'Untitled';
}

// Very light heuristic: a "book-ish" post mentions a book/reading/story word.
function looksBookish(text) {
  return /\b(libro|libros|cuento|cuentos|book|books|read|reading|leer|lectura|story|stories|álbum|album|kalandraka|editorial|autor|author|ilustr)/i.test(
    text
  );
}

async function main() {
  const postsFile = path.join(EXPORT, 'posts.json');
  if (!existsSync(postsFile)) {
    log(`No export found at ${postsFile}.`);
    log('Run scripts/scrape-facebook first.');
    process.exit(1);
  }
  const data = JSON.parse(await readFile(postsFile, 'utf8'));
  const posts = data.posts || [];
  log(`Read ${posts.length} posts from export.`);

  await mkdir(OUT, { recursive: true });

  const availableImages = existsSync(IMAGES_SRC)
    ? (await readdir(IMAGES_SRC)).filter((f) => /\.(jpg|jpeg|png|webp|gif)$/i.test(f))
    : [];

  const kept = [];
  const usedSlugs = new Set();
  let idx = 0;

  for (const p of posts) {
    idx += 1;
    const text = cleanText(p.text);
    if (text.length < 40) continue;                 // skip trivial blurbs

    const bookish = looksBookish(text);
    const title = guessTitle(text);
    let slug = slugify(title);
    while (usedSlugs.has(slug)) slug = `${slug}-${idx}`;
    usedSlugs.add(slug);

    // We can't reliably map scraped image URLs to downloaded filenames per post,
    // so we just note how many images the post had and leave hero_image blank.
    const imgCount = (p.images || []).length;

    const fm = [
      '+++',
      `title = ${JSON.stringify(title)}`,
      `# date = 2025-01-01   # TODO set the real date (FB said: ${JSON.stringify(p.when || 'unknown')})`,
      `description = ""`,
      '',
      '[extra]',
      `# hero_image = ""     # ${imgCount} image(s) were attached; pick one from tmp/fb-export/images/`,
      `draft = true`,
      '+++',
      '',
      text,
      '',
      `<!-- imported from Facebook; bookish=${bookish}; review & edit before publishing`,
      p.url ? `     source: ${p.url}` : '     source: (no permalink captured)',
      `-->`,
    ].join('\n');

    await writeFile(path.join(OUT, `${slug}.md`), fm, 'utf8');
    kept.push({ slug, title, bookish, imgCount });
  }

  // Summary index, book-ish first.
  kept.sort((a, b) => Number(b.bookish) - Number(a.bookish));
  const index = [
    '# Imported Facebook posts (drafts)',
    '',
    `Generated ${kept.length} drafts from ${posts.length} posts. All are marked`,
    '`draft = true`. Review each, set a real `date`, add a `hero_image` from',
    '`tmp/fb-export/images/`, then move the good ones into `site/content/blog/`',
    '(and write a Spanish twin `<slug>.es.md`).',
    '',
    '| Book-ish | Title | Images | File |',
    '| --- | --- | --- | --- |',
    ...kept.map((k) => `| ${k.bookish ? '📚' : ''} | ${k.title} | ${k.imgCount} | \`${k.slug}.md\` |`),
  ].join('\n');
  await writeFile(path.join(OUT, '_INDEX.md'), index, 'utf8');

  log(`Wrote ${kept.length} drafts to ${OUT}`);
  log(`Review tmp/fb-import/_INDEX.md, then move good ones into site/content/blog/.`);
}

main().catch((err) => {
  console.error('[import] FATAL:', err);
  process.exit(1);
});
