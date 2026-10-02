/**
 * Reword an answer from the user's own words.
 *
 * "No, I don't like this — use this instead" often arrives as rough notes or a
 * voice transcript, not as a finished application answer. This turns those
 * words into a polished answer that keeps every fact the user gave and adds
 * nothing they did not: STAR structure (Situation, Task, Action, Result)
 * where the question suits it, plain competence where it does not.
 */

/**
 * @param {object} opts
 * @param {string} opts.label the question being answered
 * @param {string} opts.thoughts the user's own words (text or voice transcript)
 * @param {object} [opts.profile] the user's profile, for grounding
 * @param {string} [opts.jdText] the job description, for tailoring
 * @param {Function} opts.chat (messages) => string  OpenAI-compatible call
 * @param {number} [opts.maxWords=180] answers longer than this get cut by boards
 * @returns {Promise<string>} the polished answer
 */
export async function rewordAnswer({ label, thoughts, profile = {}, jdText = '', chat, maxWords = 180 }) {
  const system = [
    'You rewrite a job-application answer from the candidate\'s own words.',
    'Rules:',
    '- Keep every fact the candidate gave; add nothing they did not say.',
    `- When the question suits it, structure as STAR: Situation, Task, Action, Result.`,
    '- Plain, confident, specific. No buzzwords, no filler, no flattery.',
    `- At most ${maxWords} words unless the field is clearly a long-form essay.`,
    '- Answer in first person as the candidate.',
    '- Return ONLY the answer text, no preamble, no quotes, no markdown.',
  ].join('\n');

  const user = [
    `Question on the application form: "${label}"`,
    '',
    'Candidate\'s own words (may be rough notes or a voice transcript):',
    thoughts,
    '',
    profile.name ? `Candidate: ${profile.name}` : '',
    profile.experience ? `Experience notes: ${JSON.stringify(profile.experience).slice(0, 1200)}` : '',
    jdText ? `Job description excerpt: ${jdText.slice(0, 2500)}` : '',
  ].filter(Boolean).join('\n');

  const out = await chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);
  return String(out || '').trim().replace(/^["'`]|["'`]$/g, '');
}
