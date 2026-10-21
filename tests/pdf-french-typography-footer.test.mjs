// tests/pdf-french-typography-footer.test.mjs — #3961's print-side additions:
// (1) French espace insécable survives the ATS normalisation pass, and
// (2) the opt-in running footer says "N sur TOTAL" for a French CV.
//
// (1) is a regression guard for a trade-off that is easy to "simplify" away:
// normalizeTextForATS() flattens every NBSP because some ATS extractors glue
// the words around one together. French typography puts an NBSP before :;!? on
// purpose, and that pass runs BEFORE page.setContent(), so flattening it there
// means no later step can make the space unbreakable again.
//
// (2) is unit-tested rather than rendered: runningFooterTemplate() reads the
// document through page.evaluate() and returns a Chromium footer template.
// Asserting on that string covers escaping, the localised counter word, and the
// email/phone fallback without needing a browser.
import { pass, fail } from './helpers.mjs';
import { normalizeTextForATS, escapeFooterText, runningFooterTemplate } from '../generate-pdf.mjs';

console.log('\ngenerate-pdf.mjs — French NBSP + running footer (#3961)');

const nbsp = normalizeTextForATS('<p>Motif\u00A0: test\u00A0ici et fin\u00A0!</p>');
if (nbsp.html.includes('Motif\u00A0:') && nbsp.html.includes('fin\u00A0!')) {
  pass('an NBSP before French punctuation (: and !) is preserved for the print engine');
} else {
  fail(`an NBSP before :/! was flattened: ${JSON.stringify(nbsp.html)}`);
}
if (nbsp.html.includes('test ici') && nbsp.replacements.nbsp === 1) {
  pass('an NBSP between ordinary words is still flattened for ATS extractors');
} else {
  fail(`a non-typographic NBSP was not flattened (count ${nbsp.replacements.nbsp}): ${JSON.stringify(nbsp.html)}`);
}
const semi = normalizeTextForATS('<p>\u00AB\u00A0guillemets\u00A0\u00BB\u00A0; suite\u00A0? suite\u00A0!</p>');
if (semi.html.includes('\u00A0;') && semi.html.includes('\u00A0?') && semi.html.includes('\u00A0!')) {
  pass('the same holds before ; ? and !, not just :');
} else {
  fail(`NBSP before ;/?/! was flattened: ${JSON.stringify(semi.html)}`);
}

const escaped = escapeFooterText('R&D <team> "lead"');
if (escaped === 'R&amp;D &lt;team&gt; &quot;lead&quot;') {
  pass('footer text is escaped before it reaches the print engine');
} else {
  fail(`footer text was not escaped: ${escaped}`);
}

const identity = (over = {}) => ({
  evaluate: async () => ({
    name: 'Jane Doe',
    email: 'jane@example.com',
    phone: '+44 20 7946 0000',
    lang: 'en',
    ...over,
  }),
});

const en = await runningFooterTemplate(identity());
const fr = await runningFooterTemplate(identity({ lang: 'fr' }));
const phoneOnly = await runningFooterTemplate(identity({ email: '' }));

const cases = [
  ['footer pairs the name with the email', en.includes('Jane Doe') && en.includes('jane@example.com')],
  ['footer carries Chromium page-number placeholders', en.includes('class="pageNumber"') && en.includes('class="totalPages"')],
  ['English footer reads "N of TOTAL"', en.includes(' of ') && !en.includes(' sur ')],
  ['French footer reads "N sur TOTAL"', fr.includes(' sur ') && !fr.includes(' of ')],
  ['footer falls back to the phone when there is no email', phoneOnly.includes('+44 20 7946 0000')],
  ['footer sets an explicit font size (print templates default to 0px)', en.includes('font-size: 8px')],
];
for (const [what, ok] of cases) ok ? pass(what) : fail(what);

const hostile = await runningFooterTemplate(identity({ name: '<img src=x onerror=alert(1)>' }));
if (!hostile.includes('<img') && hostile.includes('&lt;img')) {
  pass('footer markup from the document is escaped, not injected');
} else {
  fail('footer template let markup through unescaped');
}
