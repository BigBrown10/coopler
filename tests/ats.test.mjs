import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicHttpsUrl } from '../src/ats/urlguard.mjs';
import { detectAts } from '../src/ats/detect.mjs';

test('SSRF guard rejects private hosts', async () => {
  await assert.rejects(() => assertPublicHttpsUrl('https://127.0.0.1/x'));
  await assert.rejects(() => assertPublicHttpsUrl('https://localhost/x'));
  await assert.rejects(() => assertPublicHttpsUrl('https://10.0.0.1/x'));
  await assert.rejects(() => assertPublicHttpsUrl('http://example.com/x')); // not https
  await assert.rejects(() => assertPublicHttpsUrl('ftp://example.com/x'));
});

test('SSRF guard allows public https', async () => {
  const u = await assertPublicHttpsUrl('https://boards.greenhouse.io/acme/jobs/3');
  assert.equal(u.hostname, 'boards.greenhouse.io');
});

test('detectAts resolves a greenhouse URL to a full board context', () => {
  const d = detectAts('https://boards.greenhouse.io/acme/jobs/12345');
  assert.equal(d.ats, 'greenhouse');
  assert.equal(d.boardToken, 'acme');
  assert.equal(d.jobId, '12345');
  assert.equal(d.company, 'acme');
  assert.equal(d.role, 'job-12345');
});

test('detectAts handles the modern host and the gh_jid query form', () => {
  const d = detectAts('https://job-boards.greenhouse.io/monzo/jobs/8222576');
  assert.equal(d.boardToken, 'monzo');
  assert.equal(d.jobId, '8222576');

  const viaQuery = detectAts('https://boards.greenhouse.io/monzo?gh_jid=8222576');
  assert.equal(viaQuery.jobId, '8222576');
  assert.equal(viaQuery.boardToken, 'monzo');
});

test('detectAts rejects unsupported boards', () => {
  assert.throws(() => detectAts('https://www.linkedin.com/jobs/1'));
});