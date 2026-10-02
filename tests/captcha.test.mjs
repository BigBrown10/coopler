import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCaptchaFromUrls, captchaPromptFor } from '../src/captcha/classifier.mjs';

test('no captcha -> level 0', () => {
  const c = classifyCaptchaFromUrls(['https://example.com/x.js']);
  assert.equal(c.level, 0);
  assert.equal(c.kind, 'none');
});

test('recaptcha v2 anchor checkbox -> level 1', () => {
  const c = classifyCaptchaFromUrls(['https://www.google.com/recaptcha/api2/anchor?k=x']);
  assert.equal(c.level, 1);
  assert.equal(c.kind, 'recaptcha');
});

test('hcaptcha checkbox (quietly loaded frame) -> level 1', () => {
  const c = classifyCaptchaFromUrls(['https://newassets.hcaptcha.com/captcha/v1/1b0f8b/static/e4d0e861e1cb4c8/site.html?frame=checkbox']);
  assert.equal(c.level, 1);
  assert.equal(c.kind, 'hcaptcha');
});

test('cloudflare managed challenge -> level 3 handoff', () => {
  const c = classifyCaptchaFromUrls(['https://challenges.cloudflare.com/turnstile/v0/api.js']);
  assert.equal(c.level, 3);
  assert.equal(c.kind, 'cloudflare');
});

test('datadome -> level 3', () => {
  const c = classifyCaptchaFromUrls(['https://geo.captcha-delivery.com/fd4e04/async.js']);
  assert.equal(c.level, 3);
  assert.equal(c.kind, 'datadome');
});

test('captchaPromptFor gives per-level wording', () => {
  assert.match(captchaPromptFor(1), /click/);
  assert.match(captchaPromptFor(2), /vision/);
  assert.match(captchaPromptFor(3), /human/);
});