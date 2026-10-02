import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertAdapter, assertEndpoints, DEFAULT_CAPABILITIES, BOT_CHECK_VENDORS } from '../src/ats/contract.mjs';
import { createRegistry, register, resolveAdapter, resolveBoard } from '../src/ats/registry.mjs';
import { greenhouseAdapter, matchesGreenhouse, resolveGreenhouseBoard } from '../src/ats/greenhouse/adapter.mjs';
import { GREENHOUSE } from '../src/ats/greenhouse/endpoints.mjs';
import { StageFailure, REASON, REMEDIATION } from '../src/core/errors.mjs';

const goodAdapter = () => ({
  name: 'acme',
  matches: (h) => h === 'jobs.acme.test',
  resolve: () => ({ ats: 'acme', host: 'jobs.acme.test', boardToken: 'a', jobId: '1', jobUrl: 'x', role: 'job-1', company: 'a' }),
  endpoints: () => ({ jobPage: () => 'u', application: () => 'u', submit: () => 'u', submitIsPublicApi: true }),
  capabilities: { ...DEFAULT_CAPABILITIES },
  extractFields: async () => [],
  submit: async () => ({ clicked: false, success: false, errors: [] }),
  isConfirmed: () => false,
});

test('a well-formed adapter passes the contract', () => {
  assert.doesNotThrow(() => assertAdapter(goodAdapter()));
  assert.doesNotThrow(() => assertAdapter(greenhouseAdapter));
});

test('the contract rejects adapters missing required behaviour', () => {
  for (const key of ['matches', 'resolve', 'extractFields', 'submit', 'isConfirmed', 'endpoints']) {
    const a = goodAdapter();
    delete a[key];
    assert.throws(() => assertAdapter(a), /contract violation/i, `expected failure for missing ${key}`);
  }
});

test('the contract rejects an unknown bot-check vendor', () => {
  const a = goodAdapter();
  a.capabilities.botCheck = 'notarealcheck';
  assert.throws(() => assertAdapter(a), /botCheck must be false or one of/i);
});

test('the contract refuses a board that blocks on a bot check yet claims a public API', () => {
  const a = goodAdapter();
  a.capabilities.botCheck = 'recaptcha';
  a.capabilities.botCheckBlocksSubmit = true;
  // endpoints still advertise a public API — that combination is incoherent.
  assert.throws(() => assertEndpoints(a, { boardToken: 'a' }), /blocking bot check and a public submit API/i);
});

test('bot-check vendors are enumerated, not free text', () => {
  for (const v of BOT_CHECK_VENDORS) {
    const a = goodAdapter();
    a.capabilities.botCheck = v;
    assert.doesNotThrow(() => assertAdapter(a));
  }
});

test('registering the same adapter twice is refused', () => {
  const reg = createRegistry([greenhouseAdapter]);
  assert.throws(() => register(reg, greenhouseAdapter), /already registered/);
});

test('resolveAdapter picks the right adapter from a URL host', () => {
  const reg = createRegistry([greenhouseAdapter]);
  assert.equal(resolveAdapter(reg, 'https://job-boards.greenhouse.io/monzo/jobs/1').name, 'greenhouse');
  assert.equal(resolveAdapter(reg, 'https://boards.greenhouse.io/monzo/jobs/1').name, 'greenhouse');
  assert.equal(resolveAdapter(reg, 'https://www.greenhouse.io/x').name, 'greenhouse');
});

test('an unsupported board fails as a typed, actionable failure', () => {
  const reg = createRegistry([greenhouseAdapter]);
  try {
    resolveAdapter(reg, 'https://www.linkedin.com/jobs/1');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof StageFailure);
    assert.equal(e.reason, REASON.UNSUPPORTED_BOARD);
    assert.ok(REMEDIATION[REASON.UNSUPPORTED_BOARD], 'must tell the user what to do next');
  }
});

test('greenhouse endpoints are declared, resolved, and honest about being non-public', () => {
  const board = resolveGreenhouseBoard('https://job-boards.greenhouse.io/monzo/jobs/8222576');
  assert.equal(board.boardToken, 'monzo');
  assert.equal(board.jobId, '8222576');

  const ep = greenhouseAdapter.endpoints(board);
  assert.equal(ep.jobPage(), 'https://job-boards.greenhouse.io/monzo/jobs/8222576');
  assert.equal(ep.application(), 'https://job-boards.greenhouse.io/monzo/jobs/8222576#app');
  assert.equal(ep.submit(), 'https://boards.greenhouse.io/monzo/jobs/8222576');
  // The submit target is the board's own form endpoint, not a public API.
  assert.equal(ep.submitIsPublicApi, false);
});

test('greenhouse declares the bot check that blocks an automated submit', () => {
  // This is the fact that decides whether a human has to press the last button,
  // so it must be declared rather than discovered at runtime.
  assert.equal(greenhouseAdapter.capabilities.botCheck, 'recaptcha');
  assert.equal(greenhouseAdapter.capabilities.botCheckBlocksSubmit, true);
  assert.equal(greenhouseAdapter.capabilities.securityCodeStep, true);
  assert.equal(greenhouseAdapter.capabilities.fileUpload, true);
});

test('greenhouse resolves the gh_jid query form and rejects a non-job URL', () => {
  assert.equal(resolveGreenhouseBoard('https://boards.greenhouse.io/monzo?gh_jid=42').jobId, '42');
  assert.equal(resolveGreenhouseBoard('https://boards.greenhouse.io/monzo').jobId, '');

  const reg = createRegistry([greenhouseAdapter]);
  assert.throws(() => resolveBoard(reg, 'https://boards.greenhouse.io/monzo'), StageFailure);
});

test('greenhouse host matching does not match lookalike hosts', () => {
  assert.equal(matchesGreenhouse('job-boards.greenhouse.io'), true);
  assert.equal(matchesGreenhouse('www.greenhouse.io'), true);
  assert.equal(matchesGreenhouse('greenhouse.io.evil.test'), false);
  assert.equal(matchesGreenhouse('notgreenhouse.io'), false);
});

test('the endpoint template map is the single source for URL shapes', () => {
  assert.equal(GREENHOUSE.paths.jobPage, '/{board}/jobs/{jobId}');
  assert.equal(GREENHOUSE.paths.submit, '/{board}/jobs/{jobId}');
});
