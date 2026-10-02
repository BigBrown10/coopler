/**
 * Human handover.
 *
 * Fill the form, then leave the browser open so a person can press the final
 * Submit themselves.
 *
 * This exists because some boards enforce a bot check server-side on submit:
 * the click reaches the API and is refused, no matter how correct the answers
 * are. The supported answer is a real person finishing a real submission in a
 * real browser, not trying to satisfy the check from the outside.
 */

const DEFAULT_WAIT_MS = 10 * 60 * 1000;

const CONFIRMATION_RE = /thank you|application (has been|was) (submitted|received)|we('ll| will) be in touch|submitted successfully/i;

export async function handOverToHuman(driver, { summary = '', waitMs = DEFAULT_WAIT_MS } = {}) {
  const line = '='.repeat(60);
  console.log(`\n${line}`);
  console.log('HANDOVER: the form is filled and the browser is open.');
  if (summary) console.log(summary);
  console.log(line);
  console.log('Press "Submit application" in the browser window yourself.');
  console.log('If the board emails a security code, paste it into the form there.');
  console.log(`Holding the browser open for up to ${Math.round(waitMs / 60000)} minutes, then closing.`);

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    // Close early if the human already finished: a confirmation means we're done.
    const done = await driver.page
      .evaluate((re) => new RegExp(re).test(document.body.innerText || ''), CONFIRMATION_RE.source)
      .catch(() => false);
    if (done) {
      console.log('\nConfirmation detected in the browser — the application went through.');
      return true;
    }
    await driver.page.waitForTimeout(2000).catch(() => {});
  }
  console.log('\nHandover window closed. Check the board to confirm whether it was sent.');
  return false;
}
