import { readFileSync, existsSync } from 'node:fs';
import { load } from 'js-yaml';
import { defaultCfgPath, defaultCvPath } from './env.js';

export class ProfileError extends Error {}

/**
 * Load the user profile (YAML) and freeform CV (markdown).
 * Returns { identity, education, experience, skills, preferences, cvText }.
 */
export function loadProfile(cfgPath = defaultCfgPath(), cvPath = defaultCvPath()) {
  if (!existsSync(cfgPath)) {
    throw new ProfileError(
      `No profile at ${cfgPath}\n` +
        'Copy config/profile.example.yml to config/profile.yml and fill it in first.',
    );
  }
  let doc;
  try {
    doc = load(readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    throw new ProfileError(`Failed to parse profile YAML ${cfgPath}: ${e.message}`);
  }
  if (!doc || typeof doc !== 'object' || !doc.identity) {
    throw new ProfileError(`Profile ${cfgPath} must have an "identity" section.`);
  }
  const cvText = existsSync(cvPath) ? readFileSync(cvPath, 'utf8') : '';
  return {
    ...doc,
    cvText,
    _cfgPath: cfgPath,
    _cvPath: cvPath,
  };
}

/** Flatten profile fields into a { label-key -> value } map for matching. */
export function profileFieldMap(profile) {
  const id = profile.identity || {};
  const map = {
    // high-confidence exact-match candidates
    'full name': [id.first_name, id.last_name].filter(Boolean).join(' ').trim(),
    'first name': id.first_name || '',
    'last name': id.last_name || '',
    email: id.email || '',
    phone: id.phone || '',
    'current location': id.location || '',
    city: (id.location || '').split(',')[0].trim(),
    country: id.country || 'United Kingdom',
    linkedin: id.linkedin || '',
    github: id.github || '',
    website: id.website || '',
    portfolio: id.portfolio || id.website || '',
  };
  return map;
}

/** Company + title context of the role being applied for (used to ground answers). */
export function currentRoleContext(profile) {
  const exp = profile.experience || [];
  if (exp.length === 0) return null;
  const recent = exp[0];
  return `${recent.title} at ${recent.company} (${recent.start} → ${recent.end || 'present'})`;
}