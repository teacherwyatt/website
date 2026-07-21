// Cloudflare Pages Function: gate /admin/* behind an HMAC session cookie.
//
// The cookie is minted by functions/oauth/[[path]].js at /oauth/callback
// after GitHub OAuth + allowlist check. This middleware verifies the cookie
// on every /admin/* request and bounces unauthenticated users into the flow.
//
// Required Pages environment variable (set by scripts/setup-secrets):
//   SESSION_SECRET - shared with functions/oauth/[[path]].js

const COOKIE_NAME = "admin_session";

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  const cookie = parseCookie(request.headers.get("Cookie") || "", COOKIE_NAME);
  if (cookie && (await verifySession(cookie, env.SESSION_SECRET))) {
    const response = await next();
    // Override CSP for admin pages so Sveltia CMS can load external
    // stylesheets and connect to GitHub APIs.
    const newResponse = new Response(response.body, response);
    newResponse.headers.set(
      "Content-Security-Policy",
      "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; " +
        "font-src 'self' https://fonts.gstatic.com; " +
        "img-src 'self' data: blob:; " +
        "connect-src 'self' https://api.github.com https://www.githubstatus.com https://github.com; " +
        "frame-src 'none'; " +
        "object-src 'none'; " +
        "upgrade-insecure-requests"
    );
    // The site-wide COOP of same-origin (from _headers) severs window.opener
    // once the login popup navigates to github.com, so the popup could never
    // postMessage the token back. Allow popups to keep their opener here.
    newResponse.headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    return newResponse;
  }

  // Unauthenticated: bounce to OAuth start, asking it to return us here.
  const returnTo = url.pathname + url.search;
  const redirect = `/oauth/auth?return=${encodeURIComponent(returnTo)}`;
  return new Response(null, {
    status: 302,
    headers: { Location: redirect, "Cache-Control": "no-store" },
  });
}

function parseCookie(header, name) {
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

async function verifySession(token, secret) {
  if (!secret) return false;
  const dot = token.lastIndexOf(".");
  if (dot === -1) return false;

  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let payload;
  try {
    payload = b64urlDecode(payloadB64);
  } catch {
    return false;
  }

  const expected = await hmacHex(secret, payload);
  if (!timingSafeEqual(sig, expected)) return false;

  const [, expStr] = payload.split("|");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;

  return true;
}

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}
