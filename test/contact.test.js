import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const origin = 'https://dovetaildigital.co.uk';
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const allow = { limit: async () => ({ success: true }) };
const env = {
  CONTACT_FORM_SECRET: 'unit-test-signing-secret',
  TURNSTILE_SITE_KEY: 'unit-test-site-key',
  TURNSTILE_SECRET_KEY: 'unit-test-verification-secret',
  RESEND_API_KEY: 'unit-test-email-secret',
  CONTACT_RATE_LIMITER: allow,
  CONTACT_CONFIG_RATE_LIMITER: allow,
};
let calls;
function request(path, data, headers = {}) {
  return new Request(origin + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.1', 'Content-Type': 'application/json', ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
async function payload(age = 4000) {
  const now = originalNow();
  Date.now = () => now - age;
  const response = await worker.fetch(request('/api/contact/config'), env);
  Date.now = () => now;
  return { name: 'Jane', email: 'jane@example.org', message: 'Hello\nWorld',
    formToken: (await response.json()).formToken, 'cf-turnstile-response': 'verified-token' };
}
function mock(verification = { success: true, hostname: 'dovetaildigital.co.uk', action: 'contact' }, emailStatus = 200) {
  calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return url.includes('siteverify') ? Response.json(verification) : new Response('{}', { status: emailStatus });
  };
}
test.afterEach(() => { globalThis.fetch = originalFetch; Date.now = originalNow; });

test('optional organisation and website reach text and escaped HTML email', async () => {
  mock();
  const data = await payload();
  data.organisation = 'Charity <Friends>';
  data.website = 'www.dovetaildigital.co.uk';
  assert.equal((await worker.fetch(request('/api/contact', data), env)).status, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[1].body.text, /Organisation: Charity <Friends>/);
  assert.match(calls[1].body.text, /Website: www\.dovetaildigital\.co\.uk/);
  assert.match(calls[1].body.html, /Charity &lt;Friends&gt;/);
  assert.match(calls[1].body.html, /Hello<br>World/);
  assert.equal(calls[0].body.remoteip, '192.0.2.1');
});
test('optional fields may be omitted', async () => {
  mock();
  assert.equal((await worker.fetch(request('/api/contact', await payload()), env)).status, 200);
  assert.match(calls[1].body.text, /Website: Not provided/);
});
for (const [label, age] of [['too fast', 2999], ['expired', 7200001], ['future', -1000]]) {
  test(`rejects ${label} timing tokens before external calls`, async () => {
    mock();
    assert.equal((await worker.fetch(request('/api/contact', await payload(age)), env)).status, 400);
    assert.equal(calls.length, 0);
  });
}
test('rejects missing and tampered timing tokens', async () => {
  mock();
  const data = await payload();
  for (const token of [undefined, data.formToken.replace(/^\d/, '0'), data.formToken + '.extra']) {
    assert.equal((await worker.fetch(request('/api/contact', { ...data, formToken: token }), env)).status, 400);
  }
  assert.equal(calls.length, 0);
});
test('rate limit returns 429 and retry header without verification or email', async () => {
  mock();
  const data = await payload();
  const response = await worker.fetch(request('/api/contact', data), { ...env, CONTACT_RATE_LIMITER: { limit: async ({ key }) => {
    assert.equal(key, 'dovetaildigital:contact:192.0.2.1'); return { success: false };
  } } });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal(calls.length, 0);
});
for (const verification of [
  { success: false },
  { success: true, hostname: 'evil.example', action: 'contact' },
  { success: true, hostname: 'dovetaildigital.co.uk', action: 'login' },
]) {
  test(`rejects invalid Turnstile result ${JSON.stringify(verification)}`, async () => {
    mock(verification);
    assert.equal((await worker.fetch(request('/api/contact', await payload()), env)).status, 400);
    assert.equal(calls.length, 1);
  });
}
test('rejects missing bot token', async () => {
  mock();
  const data = await payload(); delete data['cf-turnstile-response'];
  assert.equal((await worker.fetch(request('/api/contact', data), env)).status, 400);
  assert.equal(calls.length, 0);
});
test('fails closed on unavailable configuration or limiter', async () => {
  const data = await payload();
  for (const binding of ['CONTACT_FORM_SECRET', 'TURNSTILE_SECRET_KEY', 'RESEND_API_KEY', 'CONTACT_RATE_LIMITER']) {
    assert.equal((await worker.fetch(request('/api/contact', data), { ...env, [binding]: undefined })).status, 503);
  }
  assert.equal((await worker.fetch(request('/api/contact', data), { ...env, CONTACT_RATE_LIMITER: { limit: async () => { throw new Error(); } } })).status, 503);
});
test('rejects invalid field types and oversized optional fields', async () => {
  mock();
  const data = await payload();
  for (const extra of [{ website: 'x'.repeat(2049) }, { website: {} }, { organisation: 'x'.repeat(161) }]) {
    assert.equal((await worker.fetch(request('/api/contact', { ...data, ...extra }), env)).status, 400);
  }
  assert.equal(calls.length, 0);
});
test('bounds request body even without Content-Length', async () => {
  mock();
  assert.equal((await worker.fetch(request('/api/contact', { message: 'x'.repeat(13000) }), env)).status, 413);
  assert.equal(calls.length, 0);
});
test('rejects bad origin, method and malformed JSON', async () => {
  assert.equal((await worker.fetch(request('/api/contact'), env)).status, 405);
  assert.equal((await worker.fetch(request('/api/contact', {}, { Origin: 'https://evil.example' }), env)).status, 403);
  assert.equal((await worker.fetch(new Request(origin + '/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }), env)).status, 400);
});
test('handles verification outage and failed email without success', async () => {
  const data = await payload();
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal((await worker.fetch(request('/api/contact', data), env)).status, 503);
  mock(undefined, 500);
  assert.equal((await worker.fetch(request('/api/contact', data), env)).status, 502);
});
test('bootstrap returns no secrets and uses no-store', async () => {
  const response = await worker.fetch(request('/api/contact/config'), env);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const data = await response.json();
  assert.deepEqual(Object.keys(data).sort(), ['formToken', 'siteKey']);
});
