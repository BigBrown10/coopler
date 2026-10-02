import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultRegistry, detectAts } from '../src/ats/detect.mjs';
import { resolveAdapter, resolveBoard } from '../src/ats/registry.mjs';
import { assertAdapter } from '../src/ats/contract.mjs';
import { ashbyAdapter } from '../src/ats/ashby/adapter.mjs';
import { leverAdapter } from '../src/ats/lever/adapter.mjs';
import { smartRecruitersAdapter } from '../src/ats/smartrecruiters/adapter.mjs';
import { teamtailorAdapter } from '../src/ats/teamtailor/adapter.mjs';
import { recruiteeAdapter } from '../src/ats/recruitee/adapter.mjs';
import { workdayAdapter } from '../src/ats/workday/adapter.mjs';

/**
 * Every board this build claims to support is pinned down here: the URL shapes
 * that must resolve, the host matching that must not be fooled by a lookalike,
 * and the endpoints the run will actually load. A board that silently resolves
 * to the wrong job id is worse than a board that refuses.
 */

const BOARDS = [
  {
    ats: 'ashby',
    adapter: ashbyAdapter,
    url: 'https://jobs.ashbyhq.com/openai/staff-engineer-abc123',
    expect: { boardToken: 'openai', jobId: 'staff-engineer-abc123', company: 'openai' },
  },
  {
    label: 'ashby (company subdomain)',
    ats: 'ashby',
    adapter: ashbyAdapter,
    url: 'https://monzo.jobs.ashbyhq.com/1234',
    expect: { boardToken: '1234', jobId: '1234', company: '1234' },
  },
  {
    ats: 'lever',
    adapter: leverAdapter,
    url: 'https://jobs.lever.co/stripe/abc-123-data-engineer',
    expect: { boardToken: 'stripe', jobId: 'abc-123-data-engineer', company: 'stripe' },
  },
  {
    ats: 'smartrecruiters',
    adapter: smartRecruitersAdapter,
    url: 'https://jobs.smartrecruiters.com/smartrecruiters/744000148454651',
    expect: { boardToken: 'smartrecruiters', jobId: '744000148454651', company: 'smartrecruiters' },
  },
  {
    label: 'smartrecruiters (legacy careers host, department segment)',
    ats: 'smartrecruiters',
    adapter: smartRecruitersAdapter,
    url: 'https://careers.smartrecruiters.com/Bosch/Engineering/743999-title',
    expect: { boardToken: 'Bosch', jobId: '743999-title', company: 'Bosch' },
  },
  {
    ats: 'teamtailor',
    adapter: teamtailorAdapter,
    url: 'https://acme.teamtailor.com/jobs/423019-backend-engineer',
    expect: { boardToken: 'acme', jobId: '423019-backend-engineer', company: 'acme' },
  },
  {
    ats: 'recruitee',
    adapter: recruiteeAdapter,
    url: 'https://acme.recruitee.com/o/senior-devops-xyz',
    expect: { boardToken: 'acme', jobId: 'senior-devops-xyz', company: 'acme' },
  },
  {
    ats: 'workday',
    adapter: workdayAdapter,
    url: 'https://nhs.wd3.myworkdayjobs.com/en-GB/External/job/London-Data-Engineer_R-1234',
    expect: { boardToken: 'nhs', jobId: 'London-Data-Engineer_R-1234', company: 'nhs' },
  },
  {
    label: 'workday (location segment before the id)',
    ats: 'workday',
    adapter: workdayAdapter,
    url: 'https://workday.wd5.myworkdayjobs.com/en-US/Workday/job/Sweden-Stockholm/Engagement-Manager_JR-0110460',
    expect: { boardToken: 'workday', jobId: 'Engagement-Manager_JR-0110460', company: 'workday' },
  },
];

for (const b of BOARDS) {
  test(`${b.label || b.ats}: the posting URL resolves to a usable board context`, () => {
    const ctx = b.adapter.resolve(b.url);
    assert.equal(ctx.ats, b.ats);
    assert.equal(ctx.host, new URL(b.url).hostname);
    assert.equal(ctx.jobUrl, b.url, 'the user\'s URL is used verbatim');
    for (const [k, v] of Object.entries(b.expect)) assert.equal(ctx[k], v, k);
  });

  test(`${b.label || b.ats}: endpoints are callable and public HTTPS`, () => {
    const ctx = b.adapter.resolve(b.url);
    const eps = b.adapter.endpoints(ctx);
    for (const key of ['jobPage', 'application', 'submit']) {
      const value = eps[key]();
      assert.equal(typeof value, 'string', key);
      const u = new URL(value);
      assert.equal(u.protocol, 'https:', `${key} must be https`);
    }
  });

  test(`${b.label || b.ats}: registered in the default registry and found by URL`, () => {
    const found = resolveAdapter(defaultRegistry, b.url);
    assert.equal(found.name, b.ats);
    assert.equal(detectAts(b.url).jobId, b.expect.jobId);
  });
}

test('lever declares its documented API endpoint; the rest submit on the page', () => {
  const lever = leverAdapter.endpoints(leverAdapter.resolve(BOARDS[2].url));
  assert.equal(lever.submitIsPublicApi, true);
  assert.equal(lever.submit(), 'https://api.lever.co/v1/postings/stripe/abc-123-data-engineer/apply');
  assert.equal(lever.application(), 'https://jobs.lever.co/stripe/abc-123-data-engineer/apply');

  for (const a of [ashbyAdapter, smartRecruitersAdapter, teamtailorAdapter, recruiteeAdapter, workdayAdapter]) {
    const b = BOARDS.find((x) => x.adapter === a);
    const eps = a.endpoints(a.resolve(b.url));
    assert.equal(eps.submitIsPublicApi, false, a.name);
    assert.equal(eps.submit(), b.url.replace(/\/$/, ''), `${a.name} submits from the posting page`);
  }
});

test('boards that split the form onto its own route say so', () => {
  // Ashby's posting page has no form; the apply form is /application.
  const ashby = ashbyAdapter.endpoints(ashbyAdapter.resolve('https://jobs.ashbyhq.com/openai/abc123'));
  assert.equal(ashby.jobPage(), 'https://jobs.ashbyhq.com/openai/abc123');
  assert.equal(ashby.application(), 'https://jobs.ashbyhq.com/openai/abc123/application');
  // Lever also has a separate apply route.
  const lever = leverAdapter.endpoints(leverAdapter.resolve('https://jobs.lever.co/stripe/abc'));
  assert.equal(lever.application(), 'https://jobs.lever.co/stripe/abc/apply');
  // The rest render the form on the posting page itself.
  for (const a of [smartRecruitersAdapter, teamtailorAdapter, recruiteeAdapter, workdayAdapter]) {
    const b = BOARDS.find((x) => x.adapter === a);
    const eps = a.endpoints(a.resolve(b.url));
    assert.equal(eps.application(), eps.jobPage(), `${a.name} has one page for both`);
  }
});

test('workday declares its iframe reality rather than pretending to be plain', () => {
  assert.equal(workdayAdapter.capabilities.iframeForms, true);
  assert.equal(ashbyAdapter.capabilities.iframeForms, false);
});

test('a lookalike host does not get a board it does not own', () => {
  for (const url of [
    'https://jobs.ashbyhq.com.evil.test/openai/123',
    'https://notjobs.lever.co/stripe/123',
    'https://careers.smartrecruiters.com.evil.test/acme/1',
    'https://acme.teamtailor.com.evil.test/jobs/1',
    'https://acme.recruitee.com.evil.test/o/1',
    'https://nhs.wd3.myworkdayjobs.com.evil.test/en-GB/x/job/1',
  ]) {
    assert.throws(() => resolveAdapter(defaultRegistry, url), /no adapter/, url);
  }
  assert.throws(() => resolveAdapter(defaultRegistry, 'https://boards.example.com/jobs/1'), /no adapter/);
});

test('a real subdomain matches, a suffix-lookalike does not', () => {
  assert.equal(ashbyAdapter.matches('monzo.jobs.ashbyhq.com'), true);
  assert.equal(ashbyAdapter.matches('jobs.ashbyhq.com'), true);
  assert.equal(ashbyAdapter.matches('www.jobs.ashbyhq.com'), true);
  assert.equal(ashbyAdapter.matches('jobs.ashbyhq.com.evil.test'), false);
  assert.equal(ashbyAdapter.matches('eviljobs.ashbyhq.com'), false, 'the suffix must be a domain boundary');
});

test('a board URL with no job id is refused, not guessed', () => {
  for (const url of [
    'https://jobs.lever.co/stripe',
    'https://jobs.ashbyhq.com/openai',
    'https://careers.smartrecruiters.com/Bosch',
    'https://acme.teamtailor.com/',
    'https://acme.recruitee.com/',
    'https://nhs.wd3.myworkdayjobs.com/en-GB/External',
  ]) {
    assert.throws(() => resolveBoard(defaultRegistry, url), /could not read a job id/, url);
  }
});

test('a talent-pool placeholder is not a posting', () => {
  for (const url of [
    'https://intent.recruitee.com/o/cant-find-the-job-for-you',
    'https://acme.recruitee.com/o/talent-pool',
  ]) {
    assert.throws(() => resolveBoard(defaultRegistry, url), /could not read a job id/, url);
  }
});

test('the registry holds every board this build claims, and no duplicates', () => {
  const names = defaultRegistry.map((a) => a.name);
  assert.deepEqual(names, ['greenhouse', 'ashby', 'lever', 'smartrecruiters', 'teamtailor', 'recruitee', 'workday']);
  assert.equal(new Set(names).size, names.length);
});

test('SmartRecruiters declares its DataDome block so no run is wasted on it', () => {
  const sr = defaultRegistry.find((a) => a.name === 'smartrecruiters');
  // Live on 2026-09-30 the apply flow answered with "Access is temporarily
  // restricted" and never rendered a form, so the declaration must be a
  // blocking one, not a captcha we claim to solve.
  assert.equal(sr.capabilities.botCheck, 'datadome');
  assert.equal(sr.capabilities.botCheckBlocksSubmit, true);
});

test('Workday declares the consent wall and modal that stop an automated apply', () => {
  const wd = defaultRegistry.find((a) => a.name === 'workday');
  assert.equal(wd.capabilities.needsConsentWall, true);
  assert.equal(wd.capabilities.applyIsModal, true);
  // A plain board must not inherit those excuses.
  const gh = defaultRegistry.find((a) => a.name === 'greenhouse');
  assert.equal(gh.capabilities.needsConsentWall, undefined);
});

test('the contract accepts datadome as a declared vendor, so the board can say so', () => {
  assert.doesNotThrow(() => assertAdapter(defaultRegistry.find((a) => a.name === 'smartrecruiters')));
});
