/**
 * Cloudflare Pages Function: GitHub OAuth proxy for Sveltia CMS
 *
 * Handles the GitHub OAuth dance for Sveltia CMS and issues an HMAC-signed
 * `admin_session` cookie that gates /admin/* via a Pages Function middleware.
 *
 * Runs on the same host as the site (pages.dev or a custom domain), so the
 * host-only cookie it sets is visible to functions/admin/_middleware.js.
 *
 * Routes (this file's [[path]] name matches /oauth/*):
 *   GET  /oauth/auth      - starts GitHub OAuth
 *   GET  /oauth/callback  - GitHub redirects here
 *
 * Required Pages environment variables (set by scripts/setup-secrets):
 *   GITHUB_CLIENT_ID
 *   GITHUB_CLIENT_SECRET
 *   SESSION_SECRET       - random 32+ byte hex, used to HMAC session cookies
 *   ALLOWED_GITHUB_USERS - comma-separated GitHub logins allowed to sign in
 */

const GITHUB_AUTH_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

const COOKIE_NAME = "admin_session";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

export async function onRequest({ request, env }) {
  const url = new URL(request.url);

  if (url.pathname === "/oauth/auth") {
    return handleAuth(url, env);
  }

  if (url.pathname === "/oauth/callback") {
    return handleCallback(url, env);
  }

  return new Response("Not found", { status: 404 });
}

async function handleAuth(url, env) {
  // `return` lets the Pages middleware tell us where to bounce back to.
  const returnTo = url.searchParams.get("return") || "/admin/";
  const nonce = crypto.randomUUID();
  const statePayload = `${nonce}|${returnTo}`;
  const stateSig = await hmacHex(env.SESSION_SECRET, statePayload);
  const state = `${statePayload}|${stateSig}`;

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    scope: "repo,read:user",
    state,
  });
  return Response.redirect(`${GITHUB_AUTH_URL}?${params}`, 302);
}

async function handleCallback(url, env) {
  const code = url.searchParams.get("code");
  if (!code) {
    return new Response("Missing code", { status: 400 });
  }

  const state = url.searchParams.get("state") || "";
  const parts = state.split("|");
  if (parts.length !== 3) {
    return new Response("Invalid state", { status: 400 });
  }
  const [nonce, rawReturn, sig] = parts;
  const expectedSig = await hmacHex(env.SESSION_SECRET, `${nonce}|${rawReturn}`);
  if (!timingSafeEqual(sig, expectedSig)) {
    return new Response("Invalid state", { status: 400 });
  }
  const returnTo = sanitizeReturnPath(rawReturn);

  const tokenRes = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const data = await tokenRes.json();

  if (data.error || !data.access_token) {
    return postMessageResponse("error", data.error_description ?? data.error ?? "token_exchange_failed", "", null, "/admin/", url.origin);
  }

  // Identify the user and check the allowlist before issuing a session.
  const userRes = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `token ${data.access_token}`,
      "User-Agent": "teacherwyatt-oauth",
      Accept: "application/vnd.github+json",
    },
  });
  if (!userRes.ok) {
    return postMessageResponse("error", "user_lookup_failed", "", null, "/admin/", url.origin);
  }
  const user = await userRes.json();

  const allowed = (env.ALLOWED_GITHUB_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.includes(user.login)) {
    return new Response(`Forbidden: ${user.login} is not on the allowlist`, {
      status: 403,
    });
  }

  const cookie = await mintSessionCookie(user.login, env.SESSION_SECRET);

  // Two concerns at once:
  //   1. Sveltia's popup expects a postMessage with the GitHub token.
  //   2. We also need the admin_session cookie set on the site host so the
  //      Pages middleware will let /admin/* through.
  // This function is served on the same host as the admin UI, so this
  // response is same-host and Set-Cookie sticks host-only.
  return postMessageResponse("success", data.access_token, "github", cookie, returnTo, url.origin);
}

function postMessageResponse(status, token, provider = "", cookie = null, returnTo = "/admin/", targetOrigin = "/") {
  const content =
    status === "success"
      ? `authorization:${provider}:success:${JSON.stringify({ token })}`
      : `authorization:github:error:${token}`;

  const headers = { "Content-Type": "text/html" };
  if (cookie) headers["Set-Cookie"] = cookie;

  // After postMessage, Sveltia closes the popup itself. If the user opened
  // /admin/ directly (no popup opener), fall back to navigating there so the
  // initial login-redirect flow from the middleware completes.
  const body = `<!DOCTYPE html><html><body><script>
    (function () {
      var msg = ${JSON.stringify(content)};
      if (window.opener) {
        window.opener.postMessage(msg, ${JSON.stringify(targetOrigin)});
        window.close();
      } else {
        window.location.replace(${JSON.stringify(returnTo)});
      }
    })();
  <\/script></body></html>`;

  return new Response(body, { headers });
}

function sanitizeReturnPath(path) {
  if (!path || typeof path !== "string") return "/admin/";
  // Only allow same-origin paths under /admin/ to prevent open-redirect.
  if (path !== "/admin" && !path.startsWith("/admin/")) return "/admin/";
  return path;
}

// ---------- Session cookie (HMAC-SHA256) ----------

async function mintSessionCookie(user, secret) {
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  const exp = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE_SECONDS;
  const payload = `${user}|${exp}`;
  const sig = await hmacHex(secret, payload);
  const token = `${b64url(payload)}.${sig}`;
  return [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
  ].join("; ");
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

function b64url(s) {
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
