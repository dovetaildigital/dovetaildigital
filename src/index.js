const MAX_BODY_BYTES = 12_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/contact") {
      if (request.method !== "POST") return json({ message: "Method not allowed." }, 405);
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return json({ message: "Invalid request origin." }, 403);

      const length = Number(request.headers.get("Content-Length") || 0);
      if (length > MAX_BODY_BYTES) return json({ message: "Your message is too long." }, 413);

      let data;
      try {
        data = await request.json();
      } catch {
        return json({ message: "Please check the form and try again." }, 400);
      }
      if (!data || typeof data !== "object") return json({ message: "Please check the form and try again." }, 400);
      if (typeof data.website === "string" && data.website.trim()) return json({ message: "Thanks, your enquiry has been received." });

      const name = typeof data.name === "string" ? data.name.trim().slice(0, 120) : "";
      const email = typeof data.email === "string" ? data.email.trim().slice(0, 254) : "";
      const message = typeof data.message === "string" ? data.message.trim().slice(0, 8000) : "";
      if (!name || !EMAIL_RE.test(email) || !message) return json({ message: "Please enter your name, a valid email address and your enquiry." }, 400);
      if (new TextEncoder().encode(JSON.stringify(data)).length > MAX_BODY_BYTES) return json({ message: "Your message is too long." }, 413);
      if (!env.RESEND_API_KEY) return json({ message: "The contact form is being set up. Please try again shortly." }, 503);

      const subject = `Website enquiry from ${name}`;
      const text = `Name: ${name}\nEmail: ${email}\n\n${message}`;
      const html = `<p><strong>Name:</strong> ${escapeHtml(name)}</p><p><strong>Email:</strong> ${escapeHtml(email)}</p><p><strong>Enquiry:</strong></p><p>${escapeHtml(message).replace(/\\n/g, "<br>")}</p>`;
      let response;
      try {
        response = await fetch("https://api.resend.com/emails", {
          method: "POST",
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

    const assetResponse = await env.ASSETS.fetch(request);
    if (url.pathname !== "/" && url.pathname !== "/index.html") return assetResponse;
    if (!assetResponse.headers.get("content-type")?.includes("text/html")) return assetResponse;
    return new HTMLRewriter()
      .on(".form-trap", { element(element) { element.remove(); } })
      .on("head", { element(element) {
        element.append(
          '<style>.contact-form .button{cursor:pointer}.contact-form .button:disabled{cursor:wait;opacity:.75}</style>',
          { html: true }
        );
      } })
      .transform(assetResponse);
  },
};
