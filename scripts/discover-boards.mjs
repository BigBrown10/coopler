/**
 * Board discovery.
 *
 * Finds a real, live posting URL for each board we declare support for, using
 * that board's own public job API or board page. Guessing URL shapes is how you
 * end up testing a 404; this asks each ATS where its jobs actually are.
 *
 *   node scripts/discover-boards.mjs            # one posting per board
 *   node scripts/discover-boards.mjs lever      # just one board
 *
 * Prints `board<TAB>url` and nothing else. It never applies to anything.
 */

import { resolveBoard } from '../src/ats/registry.mjs';
import { defaultRegistry } from '../src/ats/detect.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function getText(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

/** First absolute posting URL on the page that our own resolver accepts. */
function firstPosting(html, base) {
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  for (const href of hrefs) {
    let abs;
    try { abs = new URL(href, base).toString(); } catch { continue; }
    if (!/^https:/i.test(abs)) continue;
    try {
      const { board } = resolveBoard(defaultRegistry, abs);
      if (board.jobId) return abs;
    } catch { /* not a posting */ }
  }
  return null;
}

/** Try each candidate company until one yields a posting. */
async function fromCandidates(candidates, fn) {
  const tried = [];
  for (const c of candidates) {
    try {
      const url = await fn(c);
      if (url) return { url, via: c };
      tried.push(`${c}: no posting`);
    } catch (e) {
      tried.push(`${c}: ${e.message}`);
    }
  }
  return { error: tried.join(' | ') };
}

const DISCOVERERS = {
  // Ashby's posting API is public and returns each job's canonical URL.
  async ashby() {
    const r = await fromCandidates(
      ['openai', 'anthropic', 'mercury', 'ramp', 'sentry', 'monzo', 'linear', 'notion', 'plaid', 'vercel', 'supabase', 'deel'],
      async (company) => {
        const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${company}`);
        const job = (data.jobs || []).find((j) => j.jobUrl);
        return job ? job.jobUrl : null;
      },
    );
    if (r.error) throw new Error(r.error);
    return r.url;
  },

  // Lever's postings API is documented and public.
  async lever() {
    const r = await fromCandidates(
      ['leverdemo', 'plaid', 'kraken', 'brex', 'n26', 'matchgroup', 'twilio', 'spotify', 'gopuff', 'attentive'],
      async (company) => {
        const data = await getJson(`https://api.lever.co/v0/postings/${company}?mode=json`);
        const job = (data || []).find((j) => j.hostedUrl);
        return job ? job.hostedUrl : null;
      },
    );
    if (r.error) throw new Error(r.error);
    return r.url;
  },

  // SmartRecruiters' company jobs API is public. Postings render on
  // jobs.smartrecruiters.com/{company}/{id}; older boards keep a department
  // segment under careers.smartrecruiters.com. Both put the id last, so link
  // to the id we were given and let the board redirect if it must.
  async smartrecruiters() {
    const r = await fromCandidates(
      ['smartrecruiters', 'Bosch', 'Siemens', 'Vodafone', 'Ericsson', 'Nokia', 'Volvo', 'WasteManagement', 'Andersen', 'Baxter'],
      async (company) => {
        const data = await getJson(`https://api.smartrecruiters.com/v1/companies/${company}/postings?limit=1`);
        const job = (data.content || [])[0];
        return job ? `https://jobs.smartrecruiters.com/${company}/${job.id}` : null;
      },
    );
    if (r.error) throw new Error(r.error);
    return r.url;
  },

  // Recruitee boards are per-customer subdomains. The offers endpoint path has
  // moved between versions, so read the board page and follow a posting.
  async recruitee() {
    const r = await fromCandidates(
      ['intent', 'recruitee3', 'kry', 'n26', 'wefox', 'tide', 'grandgames', 'solarisbank', 'vinted', 'bolt', 'sportradar'],
      async (company) => {
        for (const path of ['/l/en', '/']) {
          try {
            const base = `https://${company}.recruitee.com${path === '/' ? '' : path}`;
            const html = await getText(`${base}/`);
            const url = firstPosting(html, base);
            if (url) return url;
          } catch { /* try the next shape */ }
        }
        return null;
      },
    );
    if (r.error) throw new Error(r.error);
    return r.url;
  },

  // Teamtailor boards are per-customer subdomains (career.* and *.teamtailor.com).
  async teamtailor() {
    const r = await fromCandidates(
      ['career', 'thestudio.na', 'sibo', 'kry', 'northcode', 'tidal', 'raycast', 'weav', 'loop', 'betalab'],
      async (company) => {
        const base = `https://${company}.teamtailor.com`;
        const html = await getText(`${base}/jobs`);
        return firstPosting(html, base);
      },
    );
    if (r.error) throw new Error(r.error);
    return r.url;
  },

  // Workday's careers front end calls this JSON API for its own listings; the
  // HTML landing page 500s to a plain fetch. externalPath is site-relative, so
  // the {locale}/{site} prefix has to be put back on.
  async workday() {
    const r = await fromCandidates(
      [
        ['workday.wd5.myworkdayjobs.com', 'workday', 'Workday', 'en-US'],
        ['workday.wd1.myworkdayjobs.com', 'workday', 'Workday', 'en-US'],
        ['nhs.wd3.myworkdayjobs.com', 'nhs', 'External', 'en-GB'],
        ['ucl.wd3.myworkdayjobs.com', 'ucl', 'UCL_Careers', 'en-GB'],
        ['llc.wd5.myworkdayjobs.com', 'llc', 'LLC_Careers', 'en-US'],
      ],
      async ([host, tenant, site, locale]) => {
        const res = await fetch(`https://${host}/wday/cxs/${tenant}/${site}/jobs`, {
          method: 'POST',
          headers: { 'user-agent': UA, 'content-type': 'application/json' },
          body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const job = (await res.json())?.jobPostings?.[0];
        return job ? `https://${host}/${locale}/${site}${job.externalPath}` : null;
      },
    );
    if (r.error) throw new Error(r.error);
    return r.url;
  },
};

const wanted = process.argv[2] ? [process.argv[2]] : Object.keys(DISCOVERERS);
for (const name of wanted) {
  if (!DISCOVERERS[name]) {
    console.error(`unknown board "${name}" (have: ${Object.keys(DISCOVERERS).join(', ')})`);
    process.exit(1);
  }
  try {
    const url = await DISCOVERERS[name]();
    const { board } = resolveBoard(defaultRegistry, url); // prove it resolves
    console.log(`${name}\t${url}\t${board.jobId}`);
  } catch (e) {
    console.log(`${name}\tERROR\t${e.message}`);
  }
}
