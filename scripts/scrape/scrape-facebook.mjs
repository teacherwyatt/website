// One-time scrape of Kristin's Facebook Page into tmp/fb-export/.
//
// Facebook's markup is deliberately obfuscated and changes often, so this
// script is intentionally FORGIVING: it does not depend on specific CSS class
// names. Instead it:
//   1. Uses a PERSISTENT browser profile so you log in (and clear 2FA) once,
//      then re-runs reuse the session.
//   2. Scrolls to load lazy content, then saves EVERYTHING raw:
//        - full-page screenshot(s)          (fb-export/screenshots/)
//        - the rendered HTML of the page     (fb-export/html/)
//        - every image URL it can see + downloaded copies (fb-export/images/)
//        - a best-effort structured posts.json extracted heuristically
//   3. Never throws away raw data — even if the heuristic extraction misses
//      something, the HTML + screenshots let us recover it offline without
//      re-scraping (and without hammering Facebook again).
//
// Usage (see scripts/scrape-facebook wrapper):
//   node scrape-facebook.mjs [pageUrl]
//
// Env knobs:
//   FB_HEADFUL=1          run with a visible browser (default; needed for login)
//   FB_SCROLLS=40         how many scroll steps to attempt (default 40)
//   FB_PROFILE=...        persistent profile dir (default tmp/fb-profile)
//   FB_VISIT_PERMALINKS=1 also open each post's permalink for full text/photos
//                         (slower, more requests; off by default)

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import process from 'node:process';

const PAGE_URL = process.argv[2] || 'https://www.facebook.com/thewyattteacher';
const ROOT = path.resolve(process.cwd());               // scripts/scrape when run via wrapper
const OUT = path.resolve(ROOT, '../../tmp/fb-export');   // repo-root/tmp/fb-export
const PROFILE =
  process.env.FB_PROFILE || path.resolve(ROOT, '../../tmp/fb-profile');
const SCROLLS = Number(process.env.FB_SCROLLS || 40);
const HEADFUL = process.env.FB_HEADFUL !== '0';

const dirs = {
  screenshots: path.join(OUT, 'screenshots'),
  html: path.join(OUT, 'html'),
  images: path.join(OUT, 'images'),
};

const log = (...a) => console.error('[scrape]', ...a);

async function ensureDirs() {
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });
}

// Download a URL to a file, tolerating failures (we keep going).
async function download(url, dest) {
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) return false;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await ensureDirs();
  log(`Output dir : ${OUT}`);
  log(`Profile dir: ${PROFILE}`);
  log(`Page       : ${PAGE_URL}`);

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: !HEADFUL,
    viewport: { width: 1280, height: 1600 },
    locale: 'es-ES',
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });

  // Give the user a chance to log in / clear 2FA on first run.
  log('');
  log('  If you see a login screen, log in now in the opened browser.');
  log('  When the Page content is visible, come back here and press ENTER.');
  log('');
  await waitForEnter();

  // Dismiss common cookie / login popups if present (best-effort, non-fatal).
  for (const label of [
    /allow all cookies/i, /permitir todas/i, /aceptar todas/i,
    /only allow essential/i, /close/i, /cerrar/i,
  ]) {
    try {
      const btn = page.getByRole('button', { name: label }).first();
      if (await btn.isVisible({ timeout: 500 })) await btn.click({ timeout: 1000 });
    } catch { /* ignore */ }
  }

  // The Facebook feed is VIRTUALIZED — it unmounts posts that scroll out of
  // view — so a single extraction at the end only sees a handful of posts.
  // Instead we HARVEST INCREMENTALLY: on every scroll step we expand any
  // in-view "See more" and grab whatever posts are currently mounted, merging
  // them into `harvested` keyed by content so nothing is lost to unmounting.
  const SEE_MORE = /^(see more|ver más|ver mas|voir plus|mostra altro|mehr anzeigen|see original)$/i;

  // Runs in the page: expand in-view "See more", then return the mounted posts.
  const harvestInPage = (rxSrc) => {
    const rx = new RegExp(rxSrc, 'i');
    const clean = (s) => (s || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

    // Expand any visible "See more" so post bodies are complete in the DOM.
    let expanded = 0;
    for (const el of document.querySelectorAll('[role="button"], div[tabindex="0"]')) {
      if (rx.test((el.textContent || '').trim()) && el.offsetParent !== null) {
        try { el.click(); expanded++; } catch { /* ignore */ }
      }
    }

    // Post body lives in [data-ad-comet-preview="message"] (fallback: article).
    let roots = [...document.querySelectorAll('[data-ad-comet-preview="message"]')];
    const useArticle = roots.length === 0;
    if (useArticle) roots = [...document.querySelectorAll('[role="article"]')];

    // Page posts aren't always wrapped in role="article"; the reliable post
    // boundary is the nearest ancestor that contains the post's permalink
    // (a /stories/… or /posts/… link). Walk up until we find one.
    const PERMALINK_SEL = 'a[href*="/stories/"], a[href*="/posts/"], a[href*="/photos/"], a[href*="permalink"], a[href*="story_fbid"], a[href*="/videos/"]';
    const enclosingPost = (node) => {
      let el = node;
      for (let i = 0; i < 16 && el; i++) {
        if (el.getAttribute && el.getAttribute('role') === 'article') return el;
        if (el.querySelector && el.querySelector(PERMALINK_SEL)) return el;
        el = el.parentElement;
      }
      return node.closest('div[class]') || node;
    };

    const out = [];
    for (const node of roots) {
      const text = clean(node.innerText);
      if (text.length < 20) continue;
      const post = useArticle ? node : enclosingPost(node);
      const images = [...new Set(
        [...post.querySelectorAll('img')]
          .map((im) => im.currentSrc || im.src)
          .filter((u) => u && u.startsWith('http') && !u.includes('data:'))
      )];
      // Permalink: the timestamp link on a Page post now points at
      // /stories/<pageId>/<encodedId>/ (older markup used /posts/ or /photos/).
      let url = '', when = '';
      for (const a of post.querySelectorAll(PERMALINK_SEL)) {
        const href = a.getAttribute('href') || '';
        if (href && !href.startsWith('#')) {
          // Keep the ?view_single=... query for /stories/ links (needed to load
          // the single story), but drop tracking params (__cft__, __tn__).
          const u = new URL(href, location.origin);
          for (const k of [...u.searchParams.keys()]) {
            if (k.startsWith('__') ) u.searchParams.delete(k);
          }
          url = u.href;
          when = a.getAttribute('aria-label') || a.getAttribute('title') || a.textContent || '';
          break;
        }
      }
      out.push({ text, images, url, when: clean(when), truncated: rx.test(text) || text.includes('See more') });
    }
    return { posts: out, expanded };
  };

  log(`Scrolling + harvesting (${SCROLLS} steps) ...`);
  const harvested = new Map();          // key -> post (accumulates across scroll)
  const allImagesSet = new Set();
  const keyOf = (p) => (p.url || p.text.slice(0, 80));
  let lastHeight = 0, totalExpanded = 0;

  const mergeBatch = (batch) => {
    for (const p of batch.posts) {
      const k = keyOf(p);
      const prev = harvested.get(k);
      // Keep the longest text we've seen for this post (expanded > preview).
      if (!prev || p.text.length > prev.text.length) {
        harvested.set(k, { ...prev, ...p, images: [...new Set([...(prev?.images || []), ...p.images])] });
      } else if (prev) {
        for (const im of p.images) if (!prev.images.includes(im)) prev.images.push(im);
        if (!prev.url && p.url) prev.url = p.url;
      }
    }
    totalExpanded += batch.expanded;
  };

  for (let i = 0; i < SCROLLS; i++) {
    // Harvest before scrolling further (posts about to leave the viewport).
    mergeBatch(await page.evaluate(harvestInPage, SEE_MORE.source));
    const pageImgs = await page.evaluate(() =>
      [...document.querySelectorAll('img')].map((im) => im.currentSrc || im.src)
        .filter((u) => u && u.startsWith('http') && !u.includes('data:image')));
    pageImgs.forEach((u) => allImagesSet.add(u));

    if (i % 8 === 0) {
      log(`  step ${i}: ${harvested.size} posts so far`);
      await page.screenshot({ path: path.join(dirs.screenshots, `scroll-${String(i).padStart(3, '0')}.png`) }).catch(() => {});
    }

    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(1100);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === lastHeight) {
      await page.waitForTimeout(1500);
      const h2 = await page.evaluate(() => document.body.scrollHeight);
      if (h2 === lastHeight) { log(`Reached end at scroll ${i}.`); break; }
    }
    lastHeight = h;
  }
  // One final harvest at the bottom.
  mergeBatch(await page.evaluate(harvestInPage, SEE_MORE.source));
  log(`Harvested ${harvested.size} posts while scrolling; expanded ${totalExpanded} "See more".`);

  // Save the fully-rendered HTML at the bottom (partial due to virtualization,
  // but still a useful artifact).
  const html = await page.content();
  await writeFile(path.join(dirs.html, 'page.html'), html, 'utf8');
  await page.screenshot({ path: path.join(dirs.screenshots, 'full-page.png'), fullPage: true }).catch(() => {});

  // --- Optional second pass: visit each post's permalink for full text + all
  // photos. The incremental harvest above already expands "See more" in the
  // feed and usually captures everything, so this is OFF by default — the FB
  // "stories" viewer is interactive/flaky and adds one page load per post
  // (rate-limit risk). Enable with FB_VISIT_PERMALINKS=1 when the feed harvest
  // leaves posts truncated or short on photos.
  const VISIT_PERMALINKS = process.env.FB_VISIT_PERMALINKS === '1';
  const withUrls = VISIT_PERMALINKS ? [...harvested.values()].filter((p) => p.url) : [];
  if (VISIT_PERMALINKS) log(`Visiting ${withUrls.length} post permalinks for full text + photos ...`);
  else log('Skipping permalink pass (set FB_VISIT_PERMALINKS=1 to enable).');
  let visited = 0;
  for (const p of withUrls) {
    try {
      await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1200);
      // Expand "See more" on the permalink page (loop a few times).
      for (let k = 0; k < 4; k++) {
        const n = await page.evaluate((rxSrc) => {
          const rx = new RegExp(rxSrc, 'i');
          let c = 0;
          for (const el of document.querySelectorAll('[role="button"], div[tabindex="0"]')) {
            if (rx.test((el.textContent || '').trim()) && el.offsetParent !== null) { try { el.click(); c++; } catch {} }
          }
          return c;
        }, SEE_MORE.source);
        if (!n) break;
        await page.waitForTimeout(500);
      }
      const detail = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        const node = document.querySelector('[data-ad-comet-preview="message"]')
          || document.querySelector('[role="article"]');
        const text = node ? clean(node.innerText) : '';
        const scope = node ? (node.closest('[role="article"]') || node.parentElement || node) : document;
        const images = [...new Set(
          [...scope.querySelectorAll('img')].map((im) => im.currentSrc || im.src)
            .filter((u) => u && u.startsWith('http') && !u.includes('data:'))
        )];
        return { text, images };
      });
      if (detail.text && detail.text.length > p.text.length) p.text = detail.text;
      for (const im of detail.images) { if (!p.images.includes(im)) p.images.push(im); allImagesSet.add(im); }
      visited++;
      if (visited % 5 === 0) log(`  visited ${visited}/${withUrls.length}`);
      await page.waitForTimeout(600); // be gentle
    } catch (e) {
      log(`  (permalink failed: ${p.url} — ${e.message.split('\n')[0]})`);
    }
  }
  log(`Permalink pass done (${visited}/${withUrls.length}).`);

  // Final post list.
  const posts = [...harvested.values()].map((p) => ({
    text: p.text, images: p.images, url: p.url || '', when: p.when || '',
  }));

  const extracted = {
    allImages: [...allImagesSet],
    metaDesc: '',
    title: PAGE_URL,
  };

  log(`Extracted ${posts.length} unique posts, ${extracted.allImages.length} image URLs.`);

  // Download images (dedup, cap to keep it sane; raw URLs saved regardless).
  const imgUrls = [...new Set([...extracted.allImages, ...posts.flatMap((p) => p.images)])];
  const downloaded = [];
  let n = 0;
  for (const url of imgUrls) {
    n += 1;
    const ext = (url.split('?')[0].match(/\.(jpg|jpeg|png|webp|gif)$/i) || [, 'jpg'])[1];
    const name = `img-${String(n).padStart(3, '0')}.${ext.toLowerCase()}`;
    const ok = await download(url, path.join(dirs.images, name));
    if (ok) downloaded.push({ file: name, url });
  }
  log(`Downloaded ${downloaded.length}/${imgUrls.length} images.`);

  // Write the structured export.
  const out = {
    scrapedFrom: PAGE_URL,
    title: extracted.title,
    metaDescription: extracted.metaDesc,
    postCount: posts.length,
    posts,
    imageUrls: imgUrls,
    downloadedImages: downloaded,
  };
  await writeFile(path.join(OUT, 'posts.json'), JSON.stringify(out, null, 2), 'utf8');
  await writeFile(path.join(OUT, 'image-urls.txt'), imgUrls.join('\n'), 'utf8');

  log('');
  log('Done. Raw export written to tmp/fb-export/:');
  log('  posts.json           structured best-effort posts + image map');
  log('  html/page.html       full rendered HTML (source of truth)');
  log('  screenshots/         visual record');
  log('  images/              downloaded images');
  log('');
  log('Leave the browser open or close it — the session is saved for re-runs.');

  await ctx.close();
}

function waitForEnter() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
  });
}

main().catch((err) => {
  console.error('[scrape] FATAL:', err);
  process.exit(1);
});
