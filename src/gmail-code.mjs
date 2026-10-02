/**
 * gmail-code.mjs — Read Greenhouse security codes from Gmail via IMAP.
 * Uses imapflow. Only reads unread security code emails from greenhouse.io.
 * Greenhouse format: <h1>CODE</h1> after "Copy and paste this code"
 */

import { ImapFlow } from 'imapflow';

/**
 * Read the newest Greenhouse security code from Gmail via IMAP.
 *
 * `since` matters: a failed attempt also emails a code, so callers pass the
 * submit moment and only a code emailed for *this* attempt is accepted.
 *
 * @param {{user: string, password: string, since?: Date}} opts
 * @returns {Promise<string|null>} the code, or null when none qualifies
 */
export async function fetchGreenhouseCode({ user, password, since = new Date(Date.now() - 60 * 60000) }) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass: password },
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Find recent greenhouse security code emails
      const sinceDay = new Date(since);
      sinceDay.setHours(0, 0, 0, 0);
      const uids = [];
      for await (const msg of client.fetch(
        { from: 'greenhouse', since: sinceDay },
        { uid: true, envelope: true },
      )) {
        if (!/security code/i.test(msg.envelope?.subject || '')) continue;
        // IMAP SINCE is date-granular; the envelope carries the real time.
        if (new Date(msg.envelope?.date || 0) < since) continue;
        uids.push(msg.uid);
      }
      if (!uids.length) return null;

      // Fetch body of the latest security code email
      const latest = uids[uids.length - 1];
      let source = '';
      for await (const msg of client.fetch(
        { uid: latest },
        { uid: true, source: true },
      )) {
        source = msg.source?.toString() || '';
      }
      if (!source) return null;

      // Greenhouse puts the code in <h1>CODE</h1> after "Copy and paste this code"
      const m = source.match(/Copy and paste this code[^<]*<\/p>\s*<h1[^>]*>([A-Za-z0-9]{6,12})<\/h1>/i);
      if (m) return m[1];
      // Fallback: any <h1> containing 6-12 alphanumeric after "Copy and paste"
      const idx = source.indexOf('Copy and paste this code');
      if (idx >= 0) {
        const after = source.slice(idx);
        const m2 = after.match(/<h1[^>]*>([A-Za-z0-9]{6,12})<\/h1>/i);
        if (m2) return m2[1];
        // Plain text: find 6-12 char alphanumeric after the phrase
        const match3 = after.match(/Copy and paste this code[^A-Za-z0-9]*([A-Za-z0-9]{6,12})/i);
        if (match3) return match3[1];
      }
      return null;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}