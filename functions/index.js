// Cloudflare Pages Function: language negotiation for "/" only.
//
// "/" is both the English homepage and the site's entry point. Visitors
// arriving from outside the site (typed URL, bookmark, search result, shared
// link) are sent to their language's homepage; everyone else gets the static
// English page. Every other URL is a permalink and never redirects.
//
// Precedence: `lang` cookie (written only by explicit EN/ES toggle clicks, see
// base.html), then Accept-Language, then the default language.

// Keep in sync with default_language and [languages.*] in site/config.toml.
const DEFAULT_LANG = "en";
const SUPPORTED = ["en", "es"];

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);

  if (request.method !== "GET" && request.method !== "HEAD") return next();
  // Internal navigation (logo, nav links) must not renegotiate.
  if (isFromThisSite(request, url)) return next();

  const lang =
    validLang(parseCookie(request.headers.get("Cookie") || "", "lang")) ||
    matchAcceptLanguage(request.headers.get("Accept-Language") || "") ||
    DEFAULT_LANG;
  if (lang === DEFAULT_LANG) return next();

  // The browser carries any #fragment across the redirect itself.
  return new Response(null, {
    status: 302,
    headers: {
      Location: `/${lang}/${url.search}`,
      // Depends on per-visitor headers: never let a shared cache store it.
      "Cache-Control": "private, no-store",
    },
  });
}

// Sec-Fetch-Site is set by the browser and can't be stripped by referrer
// policies or extensions; fall back to Referer for browsers without it.
function isFromThisSite(request, url) {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site) return site === "same-origin";
  const referer = request.headers.get("Referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === url.origin;
  } catch {
    return false;
  }
}

function validLang(lang) {
  return SUPPORTED.includes(lang) ? lang : null;
}

// Return the highest-weighted supported language, matching on the primary
// subtag ("es-MX" -> "es"). Entries with q=0 mean "not acceptable".
function matchAcceptLanguage(header) {
  const prefs = header
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const q = qParam ? Number(qParam.trim().slice(2)) : 1;
      return { lang: tag.trim().toLowerCase().split("-")[0], q: Number.isFinite(q) ? q : 0, i };
    })
    .filter((p) => p.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const p of prefs) {
    if (SUPPORTED.includes(p.lang)) return p.lang;
  }
  return null;
}

function parseCookie(header, name) {
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}
