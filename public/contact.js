(() => {
  const form = document.getElementById('contact-form');
  const status = document.getElementById('form-status');
  const button = form.querySelector('button[type="submit"]');
  let formToken = '';
  let botToken = '';
  let widgetId;
  let sending = false;
  let readyAt = 0;
  let timer;

  function updateButton() {
    button.disabled = sending || !formToken || !botToken || Date.now() < readyAt;
  }
  function verificationFailed(message) {
    botToken = '';
    status.textContent = message;
    updateButton();
  }
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }
  async function prepare() {
    formToken = '';
    botToken = '';
    updateButton();
    const response = await fetch('/api/contact/config', { cache: 'no-store' });
    const config = await response.json();
    if (!response.ok) throw new Error(config.message);
    formToken = config.formToken;
    readyAt = Date.now() + 3000;
    clearTimeout(timer);
    timer = setTimeout(updateButton, 3000);
    await loadTurnstile();
    if (widgetId !== undefined) window.turnstile.remove(widgetId);
    widgetId = window.turnstile.render('#contact-turnstile', {
      sitekey: config.siteKey,
      action: 'contact',
      theme: 'dark',
      size: 'flexible',
      appearance: 'interaction-only',
      callback: (token) => { botToken = token; updateButton(); },
      'expired-callback': () => verificationFailed('The bot protection check expired. Please complete it again.'),
      'error-callback': () => verificationFailed('Bot protection could not load. Please refresh the page or email studio@dovetaildigital.co.uk.'),
      'timeout-callback': () => verificationFailed('The bot protection check timed out. Please try again.'),
    });
    updateButton();
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (sending) return;
    if (!formToken || !botToken || Date.now() < readyAt) {
      status.textContent = 'Please take a moment to complete the form and bot protection check.';
      return;
    }
    const data = Object.fromEntries(new FormData(form).entries());
    data.formToken = formToken;
    data['cf-turnstile-response'] = botToken;
    sending = true;
    updateButton();
    form.setAttribute('aria-busy', 'true');
    status.textContent = 'Sending…';
    let sent = false;
    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await response.json();
      status.textContent = result.message || 'We couldn’t send your enquiry just now. Please try again shortly.';
      sent = response.ok;
      if (sent) form.reset();
    } catch {
      status.textContent = 'We couldn’t send your enquiry just now. Please try again shortly.';
    } finally {
      form.setAttribute('aria-busy', 'false');
      // Siteverify tokens are single-use, including when email delivery fails.
      try { await prepare(); }
      catch (error) {
        status.textContent = `${sent ? 'Your enquiry was sent. ' : ''}${error.message || 'Please refresh the page or email studio@dovetaildigital.co.uk.'}`;
      }
      sending = false;
      updateButton();
    }
  });
  prepare().catch((error) => {
    status.textContent = error.message || 'Please refresh the page or email studio@dovetaildigital.co.uk.';
  });
})();
