import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const script = readFileSync(new URL('../public/contact.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
async function browser({ fails = false, configFails = false } = {}) {
  const button = {}, status = {}, attributes = {};
  let submit, options, resets = 0, removed = 0, now = 1000;
  const calls = [], timers = [];
  const form = { querySelector: () => button, addEventListener: (_, fn) => { submit = fn; },
    setAttribute: (key, value) => { attributes[key] = value; }, reset: () => { resets++; } };
  const context = vm.createContext({
    document: { getElementById: id => id === 'contact-form' ? form : status },
    window: { turnstile: { render: (_, value) => { options = value; return 1; }, remove: () => { removed++; } } },
    Date: { now: () => now },
    FormData: class { entries() { return Object.entries({ name: 'Jane', email: 'jane@example.org', message: 'Hello', organisation: 'Charity', website: 'https://example.org' }); } },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: url.endsWith('config') ? !configFails : !fails,
        json: async () => url.endsWith('config') ? { siteKey: 'public', formToken: 'signed', message: 'Unavailable' } : { message: fails ? 'Try again' : 'Sent' } };
    },
  });
  vm.runInContext(script, context);
  await settle();
  return { button, status, calls, attributes, get options() { return options; },
    get resets() { return resets; }, get removed() { return removed; },
    submit: () => submit({ preventDefault() {} }),
    wait: () => { now += 3000; timers.at(-1)(); },
  };
}
test('client waits for signed token, three seconds and bot check, then sends optional fields', async () => {
  const b = await browser();
  assert.equal(b.button.disabled, true);
  b.options.callback('bot-token');
  assert.equal(b.button.disabled, true);
  b.wait();
  assert.equal(b.button.disabled, false);
  const pending = b.submit();
  assert.equal(b.attributes['aria-busy'], 'true');
  await pending;
  const sent = JSON.parse(b.calls[1].init.body);
  assert.equal(sent.organisation, 'Charity');
  assert.equal(sent.website, 'https://example.org');
  assert.equal(sent.formToken, 'signed');
  assert.equal(sent['cf-turnstile-response'], 'bot-token');
  assert.equal(b.resets, 1);
  assert.equal(b.removed, 1);
  assert.equal(b.status.textContent, 'Sent');
  assert.equal(b.attributes['aria-busy'], 'false');
  assert.equal(b.button.disabled, true);
});
test('failed delivery preserves fields and prepares fresh verification for retry', async () => {
  const b = await browser({ fails: true });
  b.options.callback('bot-token'); b.wait();
  await b.submit();
  assert.equal(b.resets, 0);
  assert.equal(b.removed, 1);
  assert.equal(b.status.textContent, 'Try again');
  b.options.callback('fresh-token'); b.wait();
  assert.equal(b.button.disabled, false);
});
test('expired and failed checks disable submit and announce the problem', async () => {
  const b = await browser();
  b.options.callback('bot-token'); b.wait();
  b.options['expired-callback']();
  assert.equal(b.button.disabled, true);
  assert.match(b.status.textContent, /expired/);
  b.options['error-callback']();
  assert.match(b.status.textContent, /email/);
});
test('missing deployment configuration reports status and prevents posting', async () => {
  const b = await browser({ configFails: true });
  assert.equal(b.button.disabled, true);
  assert.equal(b.status.textContent, 'Unavailable');
  await b.submit();
  assert.equal(b.calls.length, 1);
});
