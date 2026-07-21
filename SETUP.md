# Setup & Deployment (for Patrick)

One-time setup to take TeacherWyatt live on Cloudflare Pages with the Sveltia
CMS at `/admin`. Day-to-day content editing is done by Kristin — see
`docs/KRISTIN-GUIDE.md`.

The site lives at **https://teacherwyatt.pages.dev** (no custom domain yet;
see "Adding a custom domain later" below). It runs in its own Cloudflare
account, owned by a shared admin Gmail address, so it belongs to Kristin
rather than to Patrick's personal account.

## 0. Prerequisites

- A GitHub repo with this code pushed to `main`.
- Tools: `scripts/setup` installs `zola`, `jq`, `htmltest`, `wrangler`, etc.
  Also `gh` (`brew install gh`, then `gh auth login`).

## 1. Shared admin email

Create a Gmail account for site administration (e.g.
`teacherwyatt.admin@gmail.com`). Turn on 2-Step Verification and keep the
password and recovery codes somewhere both Patrick and Kristin can get to
(a shared password manager is ideal). Losing this account means losing the
Cloudflare account.

## 2. Cloudflare account

1. Open https://dash.cloudflare.com/sign-up and sign up with the shared Gmail
   address. Verify the email Cloudflare sends.
2. If it offers onboarding ("add a domain", pick a plan), skip it — Pages
   on `*.pages.dev` needs no domain and is free.
3. **Turn on 2FA**: profile icon → My Profile → Authentication → Two-Factor
   Authentication. Save the recovery codes with the Gmail password.
4. **Account ID**: the long hex string in the dashboard URL
   (`dash.cloudflare.com/<account-id>/...`), also shown on the account's
   Overview / Workers & Pages page. Put it in `.env` as `CLOUDFLARE_ACCOUNT_ID`.
5. **API token**: prefer an *account-owned* token (Manage Account → Account
   API Tokens → Create Token) so it keeps working if Patrick's membership
   is removed. If that page isn't available, use My Profile → API Tokens
   while signed in as the shared Gmail user. Either way:
   - Custom token, permission **Account → Cloudflare Pages → Edit**
   - Account resources: include only this account
   - Put it in `.env` as `CLOUDFLARE_API_TOKEN`.

## 3. Environment variables

```bash
cp .env.example .env    # then fill in values
direnv allow            # .envrc sources .env
```

## 4. Create the Pages project

```bash
scripts/setup-pages-project
```

It must report `https://teacherwyatt.pages.dev`. pages.dev names are global;
if Cloudflare hands back a suffixed name (e.g. `teacherwyatt-abc.pages.dev`),
find/replace `teacherwyatt.pages.dev` in `site/config.toml`,
`site/static/admin/config.yml`, `site/static/{robots.txt,humans.txt}`,
and `.github/workflows/deploy.yml`.

## 5. GitHub OAuth App (for the CMS login)

1. github.com → Settings → Developer settings → **OAuth Apps** → New.
2. Homepage: `https://teacherwyatt.pages.dev`
   Authorization callback URL: `https://teacherwyatt.pages.dev/oauth/callback`
3. Copy the **Client ID** and generate a **Client Secret** into `.env`
   (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`). Add Kristin's GitHub login to
   `ALLOWED_GITHUB_USERS` once she has one. She also needs write access to
   the repo, since the CMS commits as the signed-in user.

## 6. Pages environment variables

```bash
scripts/setup-secrets
```

This sets `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ALLOWED_GITHUB_USERS`
and a freshly generated `SESSION_SECRET` on the Pages project. These are read
by `functions/oauth/[[path]].js` (the GitHub login) and
`functions/admin/_middleware.js` (gates `/admin`). Re-run it whenever you
change `ALLOWED_GITHUB_USERS`; it also rotates the session secret, which
signs everyone out.

## 7. CI secrets and first deploy

```bash
scripts/set-gh-secrets   # pushes CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
git push origin main     # triggers .github/workflows/deploy.yml
```

`set-gh-secrets` overwrites any existing secrets of the same name, so CI now
deploys to the new account. If the old personal account has a `teacherwyatt`
Pages project or `teacherwyatt-oauth` Worker, delete them there.

## 8. Verify

```bash
scripts/check                                          # build + htmltest locally
curl -sSI https://teacherwyatt.pages.dev/              # 200
curl -sSI https://teacherwyatt.pages.dev/admin/        # 302 -> /oauth/auth
# visit /admin and confirm GitHub login works and you can edit a page
```

## 9. Keep the site private (for now)

`scripts/setup-cloudflare-access` puts `teacherwyatt.pages.dev` (and every
preview deployment) behind Cloudflare Access, so only the listed emails can
view anything — including `/admin`. Visitors get a Cloudflare login page and
sign in with a one-time code emailed to them.

1. **Enable Zero Trust** (once): dashboard sidebar → Zero Trust. Pick a team
   name (e.g. `teacherwyatt`) and the **Free** plan. Cloudflare may ask for a
   payment card even on the free plan.
2. **Login method**: Zero Trust → Settings → Authentication → Login methods.
   Make sure **One-time PIN** is listed; add it if not.
3. **Token**: edit the API token from step 2 and, under
   **Cloudflare One / Zero Trust**, tick **Edit** on the row named
   **Access** ("Can read Cloudflare Access applications and policies").
   Older dashboards call it "Access: Apps and Policies".
4. Set `ACCESS_ALLOWED_EMAILS` in `.env` (comma-separated), then run:

```bash
scripts/setup-cloudflare-access
curl -sSI https://teacherwyatt.pages.dev/   # 302 -> *.cloudflareaccess.com
```

Re-run it after editing `ACCESS_ALLOWED_EMAILS`; the email list is replaced
each time, so removed addresses lose access. To make the site public, delete
the application under Zero Trust → Access → Applications. (Once there's a
custom domain, keep it instead: it then only locks the raw pages.dev URLs.)

## Deployment (ongoing)

Push to `main` → GitHub Actions builds with Zola and deploys `site/public`
plus `functions/` to Cloudflare Pages.

## Adding a custom domain later

1. Register the domain (Cloudflare Registrar in this account is simplest) or
   add an existing one to this account.
2. Pages project → Custom domains → add it (e.g. `www.teacherwyatt.com` and
   `teacherwyatt.com`).
3. Replace `https://teacherwyatt.pages.dev` with the new URL in the files
   listed in step 4, and update the OAuth App's homepage + callback URL
   (an OAuth App has only one callback URL).
4. Widen the API token with the extra scopes listed in `.env.example`, set
   `CLOUDFLARE_ZONE_ID`, then run `scripts/setup-apex-redirect` (apex → www).
   Check the hostnames hard-coded in that script first. The Access lock from
   step 9 stays on the raw pages.dev hostnames.
