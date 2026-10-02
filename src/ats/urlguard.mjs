import { lookup } from 'node:dns';

const LOOPBACK_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function isReservedV4(node) {
  if (/^[0-9.]+$/.test(node)) {
    if (LOOPBACK_RE.test(node)) return true;
    if (node === '0.0.0.0') return true;
  }
  return false;
}

async function dnsLookup(host) {
  return new Promise((resolve) => {
    lookup(host, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return resolve([]);
      const hosts = Array.isArray(addresses) ? addresses : [{ address: addresses }];
      resolve(hosts.map((h) => h.address));
    });
  });
}

async function isPrivateHost(host) {
  // Literal IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && isReservedV4(host)) return true;
  try {
    const addresses = await dnsLookup(host);
    for (const addr of addresses) {
      const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
      if (isReservedV4(v4)) return true;
      // IPv6 loopback/unspecified
      if (v4 === '::1' || v4 === '::') return true;
    }
  } catch {
    /* lookup error treated as not-private; caller decides */
  }
  return false;
}

/**
 * SSRF guard mirroring the provenance of providers/_ip-guard.mjs.
 * Only explicit http/https public URLs are allowed for navigation/submission.
 */
export async function assertPublicHttpsUrl(url, { allowHttp = false } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Rejecting malformed URL: ${url}`);
  }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) {
    throw new Error(`Rejecting non-https URL: ${url}`);
  }
  if (u.hostname === 'localhost') throw new Error(`Rejecting localhost URL: ${url}`);
  if (await isPrivateHost(u.hostname)) {
    throw new Error(`Rejecting private/loopback host: ${url}`);
  }
  return u;
}