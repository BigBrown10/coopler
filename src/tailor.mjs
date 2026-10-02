/**
 * tailor.mjs — Per-role CV tailoring with keyword matching.
 *
 * 1. Extracts keywords from the JD (skills, tools, concepts)
 * 2. Scores each experience bullet against the JD
 * 3. Reorders bullets: matching ones first, then lower-priority ones
 * 4. Generates a role-specific summary AND a "Key Skills Match" section
 * 5. Uses OpenRouter llama-3.3-70b for quality text
 */

import { writeFileSync } from 'node:fs';
import { chatCompletion, parseJsonLoose } from './llm/provider.mjs';

/** JD keywords we care about — extracted from the job description. */
function extractJdKeywords(jdText) {
  const jd = jdText.toLowerCase();
  const keywords = [];
  // Skills/tools common in PM JDs
  const skillPatterns = [
    'agentic', 'orchestration', 'llm', 'rag', 'langchain', 'llamaindex',
    'python', 'sql', 'sas', 'api', 'jira', 'confluence', 'agile', 'scrum',
    'kanban', 'roadmap', 'backlog', 'prd', 'discovery', 'stakeholder',
    'cross-functional', 'data-driven', 'analytics', 'prototyping',
    'enterprise', 'saas', 'b2b', 'fintech', 'payments', 'ai/ml',
    'generative ai', 'genai', 'evaluation', 'benchmarking', 'model',
    'leadership', 'delivery', 'product strategy', 'user research',
    'sprint', 'okr', 'kpi', 'prioriti', 'wireframe', 'prototype',
    'forward deployed', 'customer-facing', 'embedded',
  ];
  for (const kw of skillPatterns) {
    if (jd.includes(kw)) keywords.push(kw);
  }
  return keywords;
}

/** Score a bullet against the JD keywords. Higher = more relevant. */
function bulletScore(bullet, keywords) {
  const b = bullet.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (b.includes(kw)) score += 2;
  }
  return score;
}

export async function tailorForRole({ jdText, cvText, profile, openRouterKey }) {
  const keywords = extractJdKeywords(jdText);
  const keySkillMatch = keywords.length ? keywords.slice(0, 10).join(', ') : null;

  // Prompt for summary and email (fact-grounded)
  const prompt = `Write a 3-sentence professional summary for a job application.
Match the candidate's experience to this specific role. Never invent numbers.

CANDIDATE:
${cvText.slice(0, 3000)}

JOB (key skills found: ${keywords.slice(0, 15).join(', ')}):
${jdText.slice(0, 2000)}

Reply with ONLY JSON:
{"summary": "...", "email": "Subject: ...\\n\\nHi [Name],\\n\\n...\\n\\nBest regards,\\nOsamudiamen Edogun\\n+44 7939366092"}`;

  const content = await chatCompletion({
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: openRouterKey,
    model: 'meta-llama/llama-3.3-70b-instruct',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 800,
    temperature: 0.2,
    // Ask for JSON properly *and* parse defensively: this model answers with
    // "Here is your summary..." prose often enough that a bare JSON.parse
    // failed live on a Recruitee run and cost the whole tailoring step.
    json: true,
  });
  const result = parseJsonLoose(content, { kind: 'object', what: 'tailored summary/email' });
  result.keywords = keywords;
  result.keySkillMatch = keySkillMatch;
  return result;
}

function fmtDate(d) {
  if (!d || d === 'present') return 'Present';
  const [y, m] = d.split('-');
  if (!m) return y;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[Number(m)-1]} ${y}`;
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

export function buildTailoredHtml({ summary, profile, keywords }) {
  const exp = profile.experience || [];
  // Score and sort bullets within each role
  const ranked = exp.map((r) => {
    const bullets = (r.bullets || []).map((b) => ({ text: b, score: bulletScore(b, keywords) }));
    return { ...r, bullets: bullets.sort((a, b) => b.score - a.score) };
  });

  const expHtml = ranked.map((r) => `
    <div class="role">${esc(r.company)} - ${esc(r.title)}</div>
    <div class="date">${fmtDate(r.start)} to ${fmtDate(r.end)}</div>
    <ul>${r.bullets.map((b) => `<li>${esc(b.text)}</li>`).join('\n')}</ul>
  `).join('\n');

  const edu = (profile.education || []).map((e) => `
    <div class="role">${esc(e.school)} - ${esc(e.degree)}, ${esc(e.field)}</div>
    <div class="date">${fmtDate(e.start)} to ${fmtDate(e.end || '')}</div>
  `).join('\n');

  const skillLists = (profile.skills || []).flatMap((cat) => Object.values(cat));
  const allSkills = [...new Set(skillLists.flat().filter(Boolean))].join(', ');

  const keyMatchLine = keywords.length
    ? `<h2>Key Skills Match</h2><div class="skills"><b>Matched keywords from JD:</b> ${esc(keywords.slice(0, 15).join(', '))}</div>`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: Helvetica, Arial, sans-serif; font-size: 10pt; margin: 36px 48px; line-height: 1.45; color: #111; }
  h1 { font-size: 17pt; color: #1a3a5c; margin-bottom: 2px; }
  .contact { font-size: 8pt; color: #555; margin-bottom: 14px; }
  h2 { font-size: 11pt; color: #1a3a5c; border-bottom: 1px solid #1a3a5c; padding-bottom: 3px; margin-top: 16px; }
  .role { font-weight: bold; margin-top: 6px; }
  .date { font-style: italic; color: #666; font-size: 9pt; margin-bottom: 2px; }
  ul { margin: 2px 0 4px 0; padding-left: 18px; }
  li { margin-bottom: 1px; }
  .skills { margin: 4px 0; font-size: 9pt; }
</style></head><body>
<h1>${esc(profile.identity?.first_name || '')} ${esc(profile.identity?.last_name || '')}</h1>
<div class="contact">AI Product Manager | ${esc(profile.identity?.location || '')} | ${esc(profile.identity?.phone || '')} | ${esc(profile.identity?.email || '')} | ${esc(profile.identity?.linkedin || '')} | ${esc(profile.identity?.github || '')}</div>

<h2>Professional Summary</h2>
<p>${summary.replace(/[\u2013\u2014]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')}</p>

${keyMatchLine}

<h2>Experience</h2>
${expHtml}

<h2>Education</h2>
${edu}

<h2>Skills</h2>
<div class="skills">${esc(allSkills)}</div>
</body></html>`;
}

export function saveTailored({ summary, email, profile, outDir, keywords }) {
  const html = buildTailoredHtml({ summary, profile, keywords });
  writeFileSync(outDir + '/cv-tailored.html', html);
  writeFileSync(outDir + '/outreach-email.txt', email);
  return outDir + '/cv-tailored.html';
}