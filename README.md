# Dovetail Digital website

A static landing page deployed with Cloudflare Workers Static Assets. The configured Worker is `dovetaildigital` (see `wrangler.jsonc`).

## Develop and test

Requires Node.js 22 or newer.

```sh
npm ci
npm test
npm run check
npm run dev
```

The tests stub Turnstile and Resend: they never send real emails. `npm run check` validates and bundles the Worker without deploying it.

## Pull-request previews

Cloudflare uses `npx wrangler preview` for branch builds. The required `previews` block is declared in `wrangler.jsonc`. Static assets and compatibility settings remain at the top level. Preview runtime variables and bindings are not inherited from production. The empty block enables visual previews; contact sending remains unavailable until separate staging settings, rate-limit bindings, a hostname-approved widget and a test email configuration are provided. Production verification is never bypassed.

## Contact protection and setup

The optional organisation name and website fields are included in plain-text and HTML enquiry emails. Website is plain text, so addresses such as `www.dovetaildigital.co.uk` are accepted without a scheme. It is never a honeypot. User content is escaped in HTML emails.

Turnstile uses `interaction-only` appearance: background checks are hidden and the widget appears only when a visitor must interact. Server-side verification remains required.

The form fetches `/api/contact/config` to obtain the public Turnstile site key and an HMAC-signed start token. The server requires at least three seconds since token issuance and expires tokens after two hours. This is a lightweight speed check, not proof of human activity; bots can wait too. Tokens are not single-use; Turnstile's separate verification tokens are single-use and must pass verification before email is sent.

`CONTACT_RATE_LIMITER` limits POST attempts to five per IP per 60 seconds, including invalid submissions. The bootstrap endpoint has a separate limit of 30 per IP per 60 seconds. Only Cloudflare's `CF-Connecting-IP` header is used; missing IPs share a fallback bucket for local development. Cloudflare's native counters are approximate and local to each Cloudflare location, rather than a strict global quota. Visitors sharing an IP share the allowance. Rejected attempts return HTTP 429 with `Retry-After: 60`.

### Cloudflare configuration

The managed widget and encrypted `TURNSTILE_SECRET_KEY` and `CONTACT_FORM_SECRET` were configured on the `dovetaildigital` Worker for production and preview environments on 4 October 2026. Existing production `RESEND_API_KEY` was retained. The implementation still needs review and deployment via this pull request. Preview hostnames under `workers.dev` are not allowed by this production widget; use a separate staging widget for those hostnames.

### Before production deployment

1. Create a **managed Turnstile widget** in the Cloudflare account and allow `dovetaildigital.co.uk` and `www.dovetaildigital.co.uk`. Add any intentional staging hostname separately. The server requires the verified hostname to match the request hostname, and action to equal `contact`.
2. Set `vars.TURNSTILE_SITE_KEY` in `wrangler.jsonc` to the widget's **public** site key. The public key is configured for the “Dovetail Digital contact form” managed widget. Its root hostname `dovetaildigital.co.uk` also covers `www.dovetaildigital.co.uk`. Never put the secret key here.
3. Store secrets using the interactive Wrangler secret prompts (do not paste credentials into source or shell arguments):

   ```sh
   npx wrangler secret put TURNSTILE_SECRET_KEY
   npx wrangler secret put CONTACT_FORM_SECRET
   ```

   Use a cryptographically random value of at least 32 bytes for `CONTACT_FORM_SECRET`, stored in your password manager. Keep the existing `RESEND_API_KEY` Worker secret. If setting up a fresh environment, also run `npx wrangler secret put RESEND_API_KEY`. The signing secret and Turnstile secret are never returned to the browser.
4. Confirm the rate-limit namespace IDs `1001` and `1002` are unused by other bindings in this Cloudflare account; change them to distinct unused positive-integer strings if necessary. Wrangler creates native rate-limit bindings during deployment; no KV namespace or Durable Object is required. Use Wrangler 4.36.0 or newer. These bindings and variables must also be declared for any separately configured Wrangler environment.
5. Run the tests and dry run, then deploy through the existing GitHub integration or `npx wrangler deploy`. Review on staging with a real widget before production: keyboard navigation, mobile layout, successful enquiry delivery with both optional fields, expired challenges, blocked requests and retry behavior. A real email-delivery check requires the account's credentials and should use an agreed test recipient.

Optional `CONTACT_FROM` and `CONTACT_TO` Worker variables override the existing sender and recipient defaults.

### Local Turnstile testing

Use Cloudflare's documented [test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) in an ignored `.dev.vars` file together with a local-only signing secret and a Resend test configuration. Never deploy dummy keys to production. Local browser testing should stub Resend or use an agreed test recipient. Production checks enforce hostname and action; mocked verification responses must include both. No production bypass is provided.

References: [Turnstile server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) and [Workers rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
