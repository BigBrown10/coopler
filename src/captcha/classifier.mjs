/**
 * Captcha classification (pure, testable). Mirrors the capability boundaries:
 *   level-1: interactive checkbox (reCAPTCHA v2 anchor, hCaptcha checkbox) -> agent clicks
 *   level-2: image-grid challenge -> bounded vision attempt, then human
 *   level-3: managed challenge (Cloudflare/Datadome/Radware) -> human handoff
 * Returns { level: 0|1|2|3, kind: 'none'|'recaptcha'|'hcaptcha'|'cloudflare'|'datadome'|'radware', refs: string[] }
 */
export function classifyCaptchaFromUrls(urls) {
  const joined = urls.join(' ');
  const refs = (re) => urls.filter((u) => re.test(u));
  if (/__cf_chl|challenges\.cloudflare\.com|\/cdn-cgi\//.test(joined)) {
    return { level: 3, kind: 'cloudflare', refs: refs(/__cf_chl|challenges\.cloudflare\.com|\/cdn-cgi\//) };
  }
  if (/datadome|px-captcha|perimeterx|captcha-delivery\.com/.test(joined)) {
    return { level: 3, kind: 'datadome', refs: refs(/datadome|px-captcha|perimeterx|captcha-delivery\.com/) };
  }
  if (/radware|secureserver/.test(joined)) {
    return { level: 3, kind: 'radware', refs: refs(/radware|secureserver/) };
  }
  if (/recaptcha\/api2\/anchor|g-recaptcha|gre\.recaptcha/.test(joined)) {
    return { level: 1, kind: 'recaptcha', refs: refs(/recaptcha/) };
  }
  if (/hcaptcha\.com[^)]*frame=checkbox|^hcaptcha|h-captcha/.test(joined)) {
    return { level: 1, kind: 'hcaptcha', refs: refs(/hcaptcha/) };
  }
  return { level: 0, kind: 'none', refs: [] };
}

export function captchaPromptFor(level) {
  switch (level) {
    case 1: return 'A checkbox captcha is present; the agent will click it once (the warm browser profile is the real test).';
    case 2: return 'An image-grid captcha is present; bounded vision attempts will run, capped, then human handoff.';
    case 3: return 'A managed challenge is present; the human must complete it (or skip the application).';
    default: return '';
  }
}