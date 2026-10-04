const MAX_BODY_BYTES = 12_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

const MIN_TIME_MS = 3000;
const MAX_TIME_MS = 2 * 60 * 60 * 1000;
const encoder = new TextEncoder();

async function signingKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function formToken(secret) {
  const payload = `${Date.now()}.${crypto.randomUUID()}`;
  const signature = await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(payload));
  return `${payload}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;
}

async function validFormToken(token, secret) {
  if (typeof token !== "string" || token.length > 200) return false;
  try {
    const [time, nonce, signature, extra] = token.split(".");
    if (extra || !/^\d+$/.test(time) || !nonce || !signature) return false;
    const valid = await crypto.subtle.verify("HMAC", await signingKey(secret),
      Uint8Array.from(atob(signature), c => c.charCodeAt(0)), encoder.encode(`${time}.${nonce}`));
    const age = Date.now() - Number(time);
    return valid && age >= MIN_TIME_MS && age <= MAX_TIME_MS;
  } catch { return false; }
}

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Invalid body");
  let size = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RangeError("Body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function limit(request, binding) {
  if (!binding) return json({ message: "The contact form is being set up. Please try again shortly." }, 503);
  try {
    // CF-Connecting-IP is supplied by Cloudflare; never trust X-Forwarded-For.
    const { success } = await binding.limit({ key: `dovetaildigital:contact:${request.headers.get("CF-Connecting-IP") || "local"}` });
    if (!success) return json({ message: "Too many attempts. Please wait a minute and try again." }, 429, { "Retry-After": "60" });
  } catch { return json({ message: "Please try again shortly." }, 503); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/contact/config") {
      if (request.method !== "GET") return json({ message: "Method not allowed." }, 405);
      const limited = await limit(request, env.CONTACT_CONFIG_RATE_LIMITER);
      if (limited) return limited;
      if (!env.CONTACT_FORM_SECRET || !env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY || !env.CONTACT_RATE_LIMITER || !env.RESEND_API_KEY)
        return json({ message: "The contact form is being set up. Please email studio@dovetaildigital.co.uk." }, 503);
      return json({ siteKey: env.TURNSTILE_SITE_KEY, formToken: await formToken(env.CONTACT_FORM_SECRET) });
    }

    if (url.pathname === "/api/contact") {
      if (request.method !== "POST") return json({ message: "Method not allowed." }, 405);
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return json({ message: "Invalid request origin." }, 403);

      const limited = await limit(request, env.CONTACT_RATE_LIMITER);
      if (limited) return limited;
      if (!env.CONTACT_FORM_SECRET || !env.TURNSTILE_SECRET_KEY || !env.RESEND_API_KEY)
        return json({ message: "The contact form is being set up. Please try again shortly." }, 503);
      if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json"))
        return json({ message: "Please submit the contact form." }, 415);

      const length = Number(request.headers.get("Content-Length") || 0);
      if (length > MAX_BODY_BYTES) return json({ message: "Your message is too long." }, 413);

      let data;
      try {
        data = await readBody(request);
      } catch (error) {
        if (error instanceof RangeError) return json({ message: "Your message is too long." }, 413);
        return json({ message: "Please check the form and try again." }, 400);
      }
      if (!data || typeof data !== "object") return json({ message: "Please check the form and try again." }, 400);
      if (!await validFormToken(data.formToken, env.CONTACT_FORM_SECRET))
        return json({ message: "Please take a moment to complete the form, or refresh the page if it has been open for a while." }, 400);
      const organisation = typeof data.organisation === "string" ? data.organisation.trim() : "";
      const website = typeof data.website === "string" ? data.website.trim() : "";
      if ((data.organisation != null && typeof data.organisation !== "string") || organisation.length > 160 ||
          (data.website != null && typeof data.website !== "string") || website.length > 2048)
        return json({ message: "Please check your organisation name and website." }, 400);
      if (website) {
        try {
          const parsed = new URL(website);
          if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
        } catch { return json({ message: "Please enter a website starting with https:// or http://." }, 400); }
      }

      const name = typeof data.name === "string" ? data.name.trim().slice(0, 120) : "";
      const email = typeof data.email === "string" ? data.email.trim().slice(0, 254) : "";
      const message = typeof data.message === "string" ? data.message.trim().slice(0, 8000) : "";
      if (!name || !EMAIL_RE.test(email) || !message) return json({ message: "Please enter your name, a valid email address and your enquiry." }, 400);
      if (new TextEncoder().encode(JSON.stringify(data)).length > MAX_BODY_BYTES) return json({ message: "Your message is too long." }, 413);
      if (!env.RESEND_API_KEY) return json({ message: "The contact form is being set up. Please try again shortly." }, 503);

      const token = data["cf-turnstile-response"];
      if (typeof token !== "string" || !token || token.length > 2048)
        return json({ message: "Please complete the bot protection check." }, 400);
      try {
        const verification = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token,
            remoteip: request.headers.get("CF-Connecting-IP") || undefined }),
          signal: AbortSignal.timeout(10000),
        });
        if (!verification.ok) throw new Error();
        const result = await verification.json();
        if (!result.success || result.action !== "contact" || result.hostname !== url.hostname)
          return json({ message: "The bot protection check expired or failed. Please try again." }, 400);
      } catch { return json({ message: "Bot protection is temporarily unavailable. Please try again shortly." }, 503); }

      const subject = `Website enquiry from ${name}`;
      const text = `Name: ${name}\nEmail: ${email}\nOrganisation: ${organisation || "Not provided"}\nWebsite: ${website || "Not provided"}\n\n${message}`;
      const html = `<p><strong>Name:</strong> ${escapeHtml(name)}</p><p><strong>Email:</strong> ${escapeHtml(email)}</p><p><strong>Organisation:</strong> ${escapeHtml(organisation || "Not provided")}</p><p><strong>Website:</strong> ${escapeHtml(website || "Not provided")}</p><p><strong>Enquiry:</strong></p><p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`;
      let response;
      try {
        response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          signal: AbortSignal.timeout(10000),
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: env.CONTACT_FROM || "Dovetail Digital <website@dovetaildigital.co.uk>",
            to: [env.CONTACT_TO || "studio@dovetaildigital.co.uk"],
            reply_to: email,
            subject,
            text,
            html,
          }),
        });
      } catch {
        return json({ message: "We couldn’t send your enquiry just now. Please try again shortly." }, 502);
      }
      if (!response.ok) return json({ message: "We couldn’t send your enquiry just now. Please try again shortly." }, 502);
      return json({ message: "Thanks, your enquiry has been sent. I’ll be in touch soon." });
    }

    const path = url.pathname.replace(/\/+$/, "") || "/";

    const redirects = new Set([
      "/ecommerce",
      "/portfolio",
      "/about",
      "/contact",
      "/website-development",
      "/website-design",
      "/search-engine-optimisation",
      "/custom-wordpress-websites",
    ]);

    if (redirects.has(path)) {
      return Response.redirect(`${url.origin}/`, 301);
    }
    const assetResponse = await env.ASSETS.fetch(request);
    if (url.pathname !== "/" && url.pathname !== "/index.html") return assetResponse;
    if (!assetResponse.headers.get("content-type")?.includes("text/html")) return assetResponse;
    return new HTMLRewriter()
      .on("head", { element(element) {
        element.append(
          '<style>.contact-form .button{cursor:pointer}.contact-form .button:disabled{cursor:wait;opacity:.75}</style>',
          { html: true }
        );
      } })
      .transform(assetResponse);
  },
};
