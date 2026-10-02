/**
 * Careers-pipeline driver. Builds the review payload. The driver itself does NOT
 * click submit on its own: the run() orchestration calls submitApplication()
 * ONLY after gate approval.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

export class AtsDriver {
  constructor({ page, archive, browser }) {
    this.page = page;
    this.archive = archive || null;
    this.browser = browser || null;
  }

  static async launch({ browser, channel, profileDir, headless = false }) {
    const { chromium } = await import('playwright');
    const launched = await chromium.launchPersistentContext(profileDir, {
      channel: channel || 'chrome',
      headless,
      viewport: { width: 1280, height: 900 },
      // Mask headless detection by removing the HeadlessChrome UA token.
      userAgent: headless
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        : undefined,
    });
    const page = launched.pages()[0] || (await launched.newPage());
    return new AtsDriver({ page, browser: launched });
  }

  async goto(url) {
    // Hide automation markers before navigating so reCAPTCHA sees a normal
    // browser. Runs on every navigation automatically.
    await this.page.context().addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // Chrome headless reports no plugins; give it a plausible set.
      Object.defineProperty(navigator, 'plugins', { get: () => {
        return { length: 3, 0: { name: 'Chrome PDF Plugin' }, 1: { name: 'Chrome PDF Viewer' }, 2: { name: 'Native Client' }, item: () => null, namedItem: () => null, refresh: () => {} };
      }});
    });
    const resp = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await this.page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    // Ensure JS widgets (react-select etc.) are hydrated before we interact.
    await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await this.page.waitForTimeout(500).catch(() => {});
    return resp;
  }

  async extractFields() {
    const { classifyFields, inferQuestionFromOptions } = await import('../ats/guard.mjs');
    // Collect from this frame. Kept as its own function so it can run against
    // the main document and every iframe — Workday and some others render the
    // application form inside a frame, where page.evaluate alone sees nothing.
    const collect = () => {
      // Inline extraction: mirrors extractFieldsFromDom but runs in browser context.
      const KIND_BY_TYPE = { text:'text', email:'text', tel:'text', url:'text', number:'text',
        password:'text', search:'text', textarea:'textarea', select:'select', checkbox:'checkbox',
        radio:'radio', file:'file', hidden:'skip', submit:'skip', button:'skip', image:'skip', reset:'skip' };
      const SKIP_NAME_RE = /_html$|utm_|token|csrf|remember|captcha|secret/i;
      const clean = (s) => String(s || '').replace(/[*â˜…âœ¦]/gu, '').replace(/\s+/g, ' ').trim();
      const labelFrom = (el) => {
        const aria = clean(el.getAttribute('aria-label'));
        if (aria) return aria;
        const id = el.getAttribute('id');
        if (id) {
          const lb = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lb && clean(lb.textContent)) return clean(lb.textContent);
        }
        // Greenhouse/react-select question text: prompt lives in a wrapper
        // (.field / .select__container); aria-labelledby only points at "Select...".
        const wrap = el.closest('.field, .form-field, .application-question, .form_group, fieldset, .select__container, .select');
        if (wrap) {
          const inner = wrap.querySelector('label, legend');
          if (inner && clean(inner.textContent)) {
            // A label that WRAPS the control also contains its text, so a select
            // came back labelled "Veteran Status I identify as one or more ...".
            // Strip the control out of the clone before reading the question.
            const bare = inner.cloneNode(true);
            bare.querySelectorAll('select, option, input, textarea').forEach((n) => n.remove());
            const q = clean(bare.textContent);
            return q || clean(inner.textContent);
          }
          const clone = wrap.cloneNode(true);
          clone.querySelectorAll('.select-shell, .select__input-container, .select__control, [role="listbox"]').forEach((n) => n.remove());
          const lead = clean(clone.textContent);
          if (lead) return lead.slice(0, 300);
        }
        for (const attr of ['aria-labelledby', 'aria-describedby']) {
          const refs = (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
          for (const ref of refs) {
            const n = document.getElementById(ref);
            const t = clean(n && n.textContent);
            if (t && !/^select\.?\.?\.?$/i.test(t)) return t;
          }
        }
        // Ashby and friends render the question in a sibling div inside a
        // wrapper whose class name is hashed per release, so no stable selector
        // can match it. The question is simply the wrapper's own text once the
        // control itself is taken out — so climb a few levels and read that.
        let node = el;
        for (let depth = 0; depth < 4 && node.parentElement; depth++) {
          node = node.parentElement;
          if (node.matches('body, main, section, article')) break;
          const clone = node.cloneNode(true);
          const id = el.getAttribute('id');
          const self = id ? clone.querySelector(`#${CSS.escape(id)}`) : null;
          if (self) self.remove();
          clone.querySelectorAll('.select-shell, .select__input-container, .select__control, [role="listbox"], [role="option"], [class*="searchInput" i]')
            .forEach((n) => n.remove());
          const lead = clean(clone.textContent);
          // A question, not a paragraph: anything longer is the page, not a label.
          if (lead && lead.length <= 240) return lead;
        }
        const ph = clean(el.getAttribute('placeholder'));
        if (ph) return ph;
        return (el.getAttribute('name') || '').replace(/^job_application\[|\]$/g, '').replace(/[[\]]/g, ' ').trim();
      };
      const isCombobox = (el) => el.classList.contains('select__input') ||
        el.getAttribute('aria-haspopup') === 'listbox' || el.getAttribute('aria-autocomplete') === 'list';
      const isRequired = (el) => el.hasAttribute('required') || el.getAttribute('aria-required') === 'true' || isCombobox(el);
      const optionsOf = (el) => {
        if (el.tagName === 'SELECT') return Array.from(el.options||[]).map(o=>o.text||o.value).filter(Boolean);
        return null;
      };
      // Radios are identified by name, but some boards generate names per option
      // (or none at all). The enclosing question is the only stable handle then.
      const fieldsetId = (el) => {
        const fs = el.closest('fieldset,[role="radiogroup"],[data-question],.application-question');
        const id = (fs && (fs.getAttribute('name') || fs.getAttribute('data-question') || fs.id)) || '';
        return id ? id.toLowerCase().replace(/\s+/g, '_') : null;
      };
      // The question a radio belongs to. A radio's own label is just the option
      // ("female"), so without this the mapper cannot tell which question it is
      // answering, and EOI answers land on the wrong option.
      const questionOf = (el, name) => {
        const fs = el.closest('fieldset,[role="radiogroup"]');
        const legend = fs && fs.querySelector('legend, .application-label, label, [class*=label]');
        const txt = (legend && (legend.innerText || legend.textContent) || '').trim();
        if (txt) return txt.replace(/\s+/g, ' ').slice(0, 120);
        // No legend: the board names the question in the input's name. Lever uses
        // name="eeo[race]", which is the question and nothing else. But a survey
        // name can also be a UUID (surveysResponses[8dfb36ea-...]), which is not a
        // question anyone can answer, so it is better to admit there is no
        // question text than to print a UUID as one.
        const fromName = String(name || '')
          .replace(/\[\s*([^\]]+)\s*\]\s*$/, '$1')   // eeo[race] -> race
          .replace(/[_\-.]+/g, ' ')
          .trim();
        if (!fromName) return null;
        if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(fromName)) return null;
        if (fromName.length > 60) return null;
        return fromName.slice(0, 120);
      };
      // The text of the option this radio itself represents. Deliberately does
      // NOT climb to the group wrapper, which would return every option at once.
      const ownLabelText = (el) => {
        const own = el.closest('label');
        const t = own && clean(own.textContent);
        if (t) return t;
        const byFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        return byFor ? clean(byFor.textContent) : '';
      };
      const fields = [];
      // Scope to wherever the application form actually lives. Boards disagree:
      // Greenhouse wraps in a <form>, Ashby renders no form element at all. So
      // pick the candidate root holding the most fillable fields rather than
      // assuming one shape, and fall back to the whole page minus chrome.
      const CANDIDATE_ROOTS = [
        '#application_form', '.job_application', 'form', '[role="form"]',
        '.application-form', 'main', 'body',
      ];
      const CHROME_RE = /^(header|nav|footer|aside)$/i;
      const NOISE_RE = /newsletter|subscribe|sign[\s_-]?up|coupon|discount|promo|cookie|consent|accept[\s_-]?all|search|filter|sort/i;
      const fillableIn = (root) => root.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select',
      ).length;
      const root = CANDIDATE_ROOTS
        .map((sel) => document.querySelector(sel))
        .filter(Boolean)
        .sort((a, b) => fillableIn(b) - fillableIn(a))[0] || document.body;
      const inChrome = root === document.body;
      root.querySelectorAll('input, textarea, select').forEach((el) => {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || (tag==='textarea'?'textarea':tag==='select'?'select':'text')).toLowerCase();
        const kind = KIND_BY_TYPE[type] || 'text';
        if (kind === 'skip') return;
        if (type === 'search') return;
        // Without a form to scope to, page chrome can look like a question.
        if (inChrome) {
          if (el.closest('header, nav, footer, aside')) return;
          // Hidden junk (share widgets, collapsed panels, beacon inputs) is not
          // a question anyone is being asked. A real field is on screen.
          const box = el.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) return;
        }
        const name = el.getAttribute('name') || '';
        if (SKIP_NAME_RE.test(name)) return;
        // A radio's own text is the OPTION, never the question. Boards that give
        // every option the same name (Lever: name="eeo[race]", no id) otherwise
        // collapse all six options into one field whose label is the entire
        // group, e.g. "veteran status I identify as ... I decline to ...".
        const isRadio = type === 'radio';
        // Checkbox groups need the same treatment: Lever's race question is eight
        // unticked boxes sharing one name, which read as eight separate questions.
        const isCheckbox = type === 'checkbox';
        // An option's own text is the OPTION, never the question. Read it the same
        // way for a checkbox as for a radio: Lever's eight race boxes carry their
        // text in the wrapping label or the value attribute, and without this they
        // all fell back to the same UUID name and deduped down to one field.
        let optionText = isRadio || isCheckbox
          ? (ownLabelText(el) || el.value || '')
          : '';
        // Unless the "text" is just the boolean itself. Recruitee renders a yes/no
        // open question as a checkbox whose entire content is the value "false",
        // and calling that a question tells the user nothing. ("Yes"/"No" are real
        // answer words and are left alone.)
        if (isCheckbox && /^(true|false)$/i.test(String(optionText).trim())) optionText = '';
        const label = (optionText || labelFrom(el) || name).toLowerCase();
        if (inChrome && !label) return;
        if (NOISE_RE.test(`${label} ${name} ${el.getAttribute('placeholder') || ''}`)) return;
        // A group's options share a name and usually have no id, so the key needs
        // the option too or every option in the group collides on one key — and
        // then filling "black or african american" would tick whichever box
        // happened to come first.
        const keyBase = el.getAttribute('id')
          || ((isRadio || isCheckbox) ? `${name || fieldsetId(el) || 'group'}__${optionText || label}` : name)
          || label;
        const key = keyBase.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'_');
        fields.push({
          key, kind, label,
          name,
          // Radios and checkbox groups in one question share a name. Without that
          // identity the mapper sees "female" and "male" as two unrelated
          // questions and will happily answer both of them — and, on Lever's
          // checkbox race question, reports every unticked option as its own gap
          // when in fact one tick answers the whole thing.
          group: isRadio || isCheckbox ? (name || fieldsetId(el)) : null,
          question: isRadio || isCheckbox ? questionOf(el, name) : null,
          required: isRequired(el),
          options: optionsOf(el),
          node: tag,
          kindRef: isCombobox(el) ? 'combobox' : (el.getAttribute('focus-on') ? 'focus-on' : null),
          id: el.getAttribute('id'),
        });
      });
      return fields;
    };
    // react-select renders an internal type-to-search input plus a shadow input
    // alongside the real control; both resolve to the same question label. Keep
    // the first of each label pair and drop the pure search boxes.
    const isSearchBox = (f) => /search_input$/i.test(f.key || '') || /^(search|filter)$/i.test(f.label || '');
    // Runs here, not inside collect(): a radio group whose name carries no
    // question (Lever names its surveys surveysResponses[8dfb36ea-...]) can still
    // be identified from its own options — "male / female / non-binary" is a
    // gender question whoever wrote the markup — but the matcher is a Node
    // function and the page has never heard of it.
    const nameUnnamedGroups = (list) => {
      const byGroup = new Map();
      for (const f of list) {
        if (f.kind !== 'radio' && f.kind !== 'checkbox') continue;
        if (!f.group || f.question) continue;
        if (!byGroup.has(f.group)) byGroup.set(f.group, []);
        byGroup.get(f.group).push(f);
      }
      for (const members of byGroup.values()) {
        const inferred = inferQuestionFromOptions(members.map((m) => m.label));
        for (const m of members) m.question = inferred;
      }
      return list;
    };
    const finish = (result) => {
      const seen = new Set();
      const deduped = result.filter((f) => {
        if (isSearchBox(f)) return false;
        const sig = `${f.kind}|${f.label}|${f.required}`;
        if (!f.label || seen.has(sig)) return false;
        seen.add(sig);
        return true;
      });
      return classifyFields(nameUnnamedGroups(deduped));
    };
    // First frame that yields fields wins: the main document normally, an
    // iframe only when the form really lives in one.
    let firstError = null;
    for (const frame of this.page.frames()) {
      // A throw inside collect() used to be swallowed here and reported as "the
      // form exposed no fields", which points the reader at the board when the
      // fault is ours. Keep the cause, and only blame the page if there really
      // was nothing to find.
      let result = null;
      try {
        result = await frame.evaluate(collect);
      } catch (e) {
        if (!firstError) firstError = e;
        continue;
      }
      if (!Array.isArray(result) || result.length === 0) continue;
      const final = finish(result);
      if (final.length) {
        if (frame !== this.page.mainFrame()) this.frameUrl = frame.url();
        await this.captureSelectOptions(final);
        return final;
      }
    }
    if (firstError) {
      throw new Error(
        `extraction failed in the page: ${firstError?.message || String(firstError)}`,
        { cause: firstError },
      );
    }
    return [];
  }

  /**
   * react-select options do not exist in the DOM until the menu is opened, so
   * the static pass sees none. Open each combobox once and snapshot the real
   * option text, so the mapper can choose the board's own wording instead of
   * guessing (and so the review summary shows what can actually be picked).
   */
  async captureSelectOptions(fields) {
    for (const f of fields) {
      if (f.kindRef !== 'combobox' || (f.options && f.options.length)) continue;
      const sel = this.fieldLocators(f)[0];
      if (!sel) continue;
      const el = this.page.locator(sel).first();
      if (!(await el.count().catch(() => 0))) continue;
      try {
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ force: true }).catch(() => {});
        await this.page.waitForSelector('.select__option', { state: 'attached', timeout: 4000 }).catch(() => {});
        const opts = await this.page.evaluate(() =>
          Array.from(document.querySelectorAll('.select__option'))
            .map((o) => o.textContent.trim()).filter(Boolean));
        if (opts.length) f.options = opts;
        await this.page.keyboard.press('Escape').catch(() => {});
      } catch { /* menu did not open; leave options empty */ }
    }
  }

  async fillFields(answers) {
    for (const a of answers) {
      if (!a.value) continue; // empty -> never filled
      // needs_confirmation fields are skipped UNLESS explicitly guard-autofilled
      // (user opted into auto-answering work-auth from their profile stance).
      if (a.needs_confirmation && !a.guard_autofilled) continue;
      await this.setField(a.field, a.value);
    }
  }

  fieldLocators(field) {
    const locators = [];
    if (field.id) locators.push(cssAttr('id', field.id));
    if (field.name) locators.push(cssAttr('name', field.name));
    return locators;
  }

  async setField(field, value) {
    const p = this.page;
    const locators = this.fieldLocators(field);
    if (field.kind === 'checkbox') return this.setCheckbox(field, value);
    // react-select is not a native <select>: selectOption/fill do nothing, the
    // value must be committed through the component's onChange. But a plain
    // text input is never a select wrapper, and the check costs a page
    // round-trip per locator.
    if (field.kind === 'select' || field.kindRef === 'combobox') {
      if (await this.isReactSelect(locators)) return this.setSelectOption(field, value);
    }
    if (field.kind === 'select' && field.name) {
      for (const sel of locators) {
        const done = await p.selectOption(sel, { label: value }).then(() => true).catch(() => false);
        if (done) return;
        // fallback: match by value
        await p.selectOption(sel, { value }).catch(() => {});
      }
      return;
    }
    // Prefer Playwright's fill(): it drives the native setter + events that
    // controlled (React) inputs require. Only fall back to evaluate.
    for (const sel of locators) {
      const el = p.locator(sel).first();
      if (!(await el.count().catch(() => 0))) continue;
      const filled = await el.fill(value, { timeout: 8000 }).then(() => true).catch(() => false);
      if (filled) return;
    }
    // Last resort: native setter + bubbling events for stubborn controlled inputs.
    for (const sel of locators) {
      const ok = await p.locator(sel).first().evaluate((el, v) => {
        if (el.disabled) return false;
        try {
          const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        } catch { return false; }
      }, value).catch(() => false);
      if (ok) return;
    }
  }

  async isReactSelect(locators) {
    for (const sel of locators) {
      const el = this.page.locator(sel).first();
      if (!(await el.count().catch(() => 0))) continue;
      const hit = await el.evaluate((n) => !!n.closest('.select__container')).catch(() => false);
      if (hit) return sel;
    }
    return null;
  }

  /**
   * Tick or untick a real <input type=checkbox>. Playwright's setChecked drives
   * the native setter + change event that React listens for, and we verify the
   * resulting state rather than assuming the click landed.
   */
  async setCheckbox(field, value) {
    const p = this.page;
    const v = String(value ?? '').trim().toLowerCase();
    const want = !(v === 'no' || v === 'false' || v === '0' || v === 'off' || v === 'unchecked' || v === '');
    for (const sel of this.fieldLocators(field)) {
      const el = p.locator(sel).first();
      if (!(await el.count().catch(() => 0))) continue;
      if ((await el.getAttribute('type').catch(() => '')) !== 'checkbox') continue;
      try {
        await el.scrollIntoViewIfNeeded().catch(() => {});
        if ((await el.isChecked().catch(() => false)) !== want) {
          await el.setChecked(want, { timeout: 3000 }).catch(async () => {
            await el.click({ force: true });
          });
        }
        const after = await el.isChecked();

    if (process.env.AUTOAPPLY_DEBUG) {
          console.error(`[debug] setCheckbox ${field.key} want=${want} -> checked=${after}`);
        }
        return after === want;
      } catch (e) {
        if (process.env.AUTOAPPLY_DEBUG) console.error(`[debug] setCheckbox ${field.key} threw: ${e.message.split('\n')[0]}`);
      }
    }
    return false;
  }

  /**
   * Commit a choice in a react-select combobox (the EOI dropdowns Greenhouse
   * renders). Types the value, waits for options, then commits the matching
   * option through the Select's onChange via its React fiber.
   *
   * Deliberately STRICT: if no option matches the requested value we commit
   * nothing and return false. Guessing an option on a protected-characteristic
   * question would be far worse than leaving it blank.
   */
  async setSelectOption(field, text) {
    const p = this.page;
    const want = String(text || '').trim();
    if (!want) return false;
    for (const sel of this.fieldLocators(field)) {
      const el = p.locator(sel).first();
      if (!(await el.count().catch(() => 0))) continue;
      try {
        await el.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ force: true }).catch(() => {});
        await el.fill(want).catch(() => {});
        await p.waitForSelector('.select__option', { state: 'attached', timeout: 8000 }).catch(() => {});
        const res = await p.evaluate(({ fieldId, wantText }) => {
          const w = wantText.trim().toLowerCase();
          const optEls = Array.from(document.querySelectorAll('.select__option'));
          if (!optEls.length) return 'no-options';
          const target = optEls.find((o) => o.textContent.trim().toLowerCase() === w)
            || optEls.find((o) => o.textContent.trim().toLowerCase().includes(w))
            || null;
          if (!target) return `no-match(${optEls.map((o) => o.textContent.trim()).join('/')})`;
          let data = null;
          let f = target[Object.keys(target).find((k) => k.startsWith('__reactFiber'))];
          let hops = 0;
          while (f && hops < 30) { if (f.memoizedProps && f.memoizedProps.data) { data = f.memoizedProps.data; break; } f = f.return; hops++; }
          if (!data) return 'no-data';
          const input = document.getElementById(fieldId);
          if (!input) return 'no-input';
          let fiber = input[Object.keys(input).find((k) => k.startsWith('__reactFiber'))];
          let h2 = 0;
          while (fiber && h2 < 50) {
            const props = fiber.memoizedProps;
            if (props && typeof props.onChange === 'function' && 'inputValue' in props) {
              props.onChange(data, { action: 'select-option', option: data });
              return 'committed:' + (data.label || '');
            }
            fiber = fiber.return; h2++;
          }
          return 'no-select';
        }, { fieldId: field.id || '', wantText: want }).catch((e) => 'err:' + e.message.split('\n')[0]);
        if (process.env.AUTOAPPLY_DEBUG) console.error(`[debug] setSelectOption ${field.key} "${want}" -> ${res}`);
        if (typeof res === 'string' && res.startsWith('committed:')) {
          await p.waitForTimeout(250).catch(() => {});
          return true;
        }
        // No exact option: leave it blank rather than risk the wrong value.
        await p.keyboard.press('Escape').catch(() => {});
        return false;
      } catch (e) {
        if (process.env.AUTOAPPLY_DEBUG) console.error(`[debug] setSelectOption ${field.key} threw: ${e.message.split('\n')[0]}`);
      }
    }
    return false;
  }

  /**
   * React-select / places autocomplete. Robust path: type the city to load the
   * async geocoder options, grab the matching option's data object, then call the
   * Select component's onChange DIRECTLY via its React fiber. This bypasses the
   * flaky menu-open/click interaction entirely (which fails headless) and commits
   * the value into React state â€” which is what Greenhouse reads on submit.
   * Falls back to keyboard Enter if the fiber path is unavailable.
   */
  async setAutocomplete(field, text, pick) {
    const p = this.page;
    const locators = this.fieldLocators(field);
    for (const sel of locators) {
      const el = p.locator(sel).first();
      if (!(await el.count().catch(() => 0))) continue;
      try {
        await el.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ force: true }).catch(() => {});
        const fragment = (pick || text).split(',')[0].trim();
        await el.type(fragment, { delay: 80 });
        // wait for async options to load into the DOM (attached is enough)
        await p.waitForSelector('.select__option', { state: 'attached', timeout: 8000 });

        // Fiber path: commit via onChange with the real option object.
        const committed = await p.evaluate(({ fieldId, pickText }) => {
          const optEls = Array.from(document.querySelectorAll('.select__option'));
          if (!optEls.length) return 'no-options';
          const targetEl = optEls.find((o) => new RegExp(`${pickText}.*(England|United Kingdom|UK)`, 'i').test(o.textContent))
            || optEls.find((o) => o.textContent.toLowerCase().includes(pickText.toLowerCase()))
            || optEls[0];
          let data = null;
          let f = targetEl[Object.keys(targetEl).find((k) => k.startsWith('__reactFiber'))];
          let hops = 0;
          while (f && hops < 30) { if (f.memoizedProps && f.memoizedProps.data) { data = f.memoizedProps.data; break; } f = f.return; hops++; }
          if (!data) return 'no-data';
          const input = document.getElementById(fieldId);
          if (!input) return 'no-input';
          let fiber = input[Object.keys(input).find((k) => k.startsWith('__reactFiber'))];
          let h2 = 0;
          while (fiber && h2 < 50) {
            const props = fiber.memoizedProps;
            if (props && typeof props.onChange === 'function' && 'inputValue' in props) {
              props.onChange(data, { action: 'select-option', option: data });
              return 'committed:' + (data.label || data.placeName || '');
            }
            fiber = fiber.return; h2++;
          }
          return 'no-select';
        }, { fieldId: field.id || '', pickText: fragment }).catch((e) => 'err:' + e.message.split('\n')[0]);

        if (process.env.AUTOAPPLY_DEBUG) console.error(`[debug] setAutocomplete fiber -> ${committed}`);
        if (typeof committed === 'string' && committed.startsWith('committed:')) {
          await p.waitForTimeout(300).catch(() => {});
          return true;
        }
        // Fallback: keyboard Enter on the highlighted option.
        await p.keyboard.press('Enter').catch(() => {});
        await p.waitForTimeout(300).catch(() => {});
        return true;
      } catch (e) {
        if (process.env.AUTOAPPLY_DEBUG) console.error(`[debug] setAutocomplete ${sel} threw: ${e.message.split('\n')[0]}`);
      }
    }
    return false;
  }

  /** Attach a file to a file-input field (resume/CV uploads). */
  async uploadFile(field, filePath) {
    const p = this.page;
    const locators = [];
    if (field.name) locators.push(`input[type=file]${cssAttr('name', field.name)}`);
    if (field.id) locators.push(`input[type=file]${cssAttr('id', field.id)}`);
    locators.push('input[type=file]');

    // Lever's React dropzone wraps a hidden file input — the wrapper listens
    // for the change event, not the input itself. Try the file-chooser path
    // first: click the visible dropzone, handle the dialog, which triggers
    // the React handler natively.
    const dropzone = p.locator('[class*=dropzone], [class*=file-upload], [class*=upload-area], [class*=file-picker], label:has(input[type=file])').first();
    const dropCount = await dropzone.count().catch(() => 0);
    if (dropCount > 0) {
      try {
        const [fc] = await Promise.all([
          p.waitForEvent('filechooser', { timeout: 5000 }),
          dropzone.click({ force: true }).catch(() => {}),
        ]);
        await fc.setFiles(filePath);
        await p.waitForTimeout(10000);
        return true;
      } catch { /* dropzone did not open a file chooser; fall through */ }
    }

    for (const sel of locators) {
      const el = p.locator(sel).first();
      if (await el.count().catch(() => 0)) {
        try {
          await el.setInputFiles(filePath);
          // Many ATS boards wrap their file input in a React component that only
          // triggers the S3 pre-upload when it sees a native 'change' event.
          // setInputFiles dispatches the event, but a controlled component may
          // need a second, explicit dispatch to react.
          await el.dispatchEvent('change').catch(() => {});
          await el.dispatchEvent('input').catch(() => {});
          const uploaded = await el.evaluate((el) => Array.from(el.files || []).map((f) => `${f.name}:${f.size}`)).catch(() => []);
          if (!uploaded.length) {
            if (process.env.AUTOAPPLY_DEBUG) console.error('[file-warn] no files registered after setInputFiles');
          } else if (process.env.AUTOAPPLY_DEBUG) {
            console.error(`[file-ok] uploaded: ${uploaded.join(', ')}`);
          }
        // S3 upload takes ~1.5s. Wait generously for the POST to complete and
        // the react-select state to re-render with the committed file. Probe
        // confirmed the dropzone consumes the input within 1.5s, but the form's
        // validation read may lag slightly behind the DOM update. Lever's S3
        // pre-upload can lag further.
        await p.waitForTimeout(15000);
        return true;
        } catch { /* try next */ }
      }
    }
    return false;
  }

  async screenshot(label) {
    await this.page.evaluate(() => {
      const f = document.querySelector('#application_form, .job_application, form');
      if (f) f.scrollIntoView({ block: 'start' });
    }).catch(() => {});
    await this.page.waitForTimeout(400).catch(() => {});
    const buf = await this.page.screenshot({ type: 'jpeg', quality: 42, fullPage: false });
    return { label, buffer: buf };
  }

  /**
   * Fill Greenhouse react-select comboboxes that have no name attributes and get
   * missed by the extractor/guard pipeline. Detects them by their label text in
   * the page body, then commits via React-fiber onChange.
   * Handles: authorization, sponsorship, restrictive covenants, London office,
   * technical skills, and earliest start date combos.
   */
  async fillCombos(profile) {
    const p = this.page;
    const wa = profile.work_authorization;
    // Map each known label to the answer we want.
    const rules = [
      { re: /authori[sz]ed.*work|legally.*work|right to work/i, answer: wa?.legally_authorized_uk ? 'Yes' : 'No' },
      { re: /sponsor/i, answer: wa?.requires_sponsorship ? 'Yes' : 'No' },
      { re: /bound by.*agreements|restrict|covenant|non.compete/i, answer: 'No' },
      { re: /open to.*london.*office|working in person.*london/i, answer: 'Yes', fragment: 'Yes' },
      { re: /characterize your technical skills/i, answer: 'I worked as a Software Engineer (either full time or internship)' },
      { re: /earliest.*start/i, answer: 'Nov 27' },
      // Monzo-specific combos (right-to-work, US tax resident, GDPR consent)
      { re: /right to work|citizen.*permanent.*residency|visa.*sponsor/i, answer: 'I have a visa which gives me temporary right to work', arrows: 3, fragment: 'temporary' },
      { re: /us tax resident/i, answer: 'No' },
      { re: /data privacy|candidate.*privacy/i, answer: 'Yes' },
    ];
    if (!wa?.auto_answer) {
      // Without auto_answer, only fill the generic combos, not auth/sponsor.
      rules.splice(0, 2);
    }
    const combos = await p.evaluate(() => {
      return Array.from(document.querySelectorAll('input[role="combobox"]')).map((el) => ({
        id: el.getAttribute('id'),
        label: (() => {
          const wrap = el.closest('[class*="field"]');
          const lbl = wrap ? wrap.querySelector('label, [class*="label"]') : null;
          return lbl ? lbl.textContent.trim() : '';
        })(),
      }));
    });
    if (process.env.AUTOAPPLY_DEBUG) console.error(`[debug] fillCombos: ${combos.length} combos on page`);
    for (const combo of combos) {
      if (!combo.id) continue;
      const rule = rules.find((r) => r.re.test(combo.label));
      if (!rule) continue;
      // Try the fiber-commit path first; fall back to keyboard Enter.
      const committed = await commitReactSelectById(p, combo.id, rule.fragment || rule.answer, rule.arrows || 0);
      if (process.env.AUTOAPPLY_DEBUG) {
        const reason = typeof committed === 'string' && committed.startsWith('committed:') ? committed : committed || 'skip';
        console.error(`[debug] fillCombos ${combo.id.slice(-6)} ${combo.label.slice(0,30)} -> ${reason}`);
      }
    }
  }

async renderPdf(html, outputPath) {
    const newPage = await this.browser.newPage();
    await newPage.setContent(html, { waitUntil: 'load' });
    await newPage.pdf({ path: outputPath, format: 'A4', margin: { top: '12mm', bottom: '12mm', left: '16mm', right: '16mm' } });
    await newPage.close();
    return outputPath;
  }

  async captchaDetection() {
    const { classifyCaptchaFromUrls } = await import('../captcha/classifier.mjs');
    const urls = await this.page.evaluate(() => {
      return Array.from(document.querySelectorAll('iframe')).map((f) => f.getAttribute('src') || '');
    });
    return classifyCaptchaFromUrls(urls);
  }

  /**
   * The page's reCAPTCHA details, or an empty sitekey when there is none.
   *
   * Reads live attribute values rather than serialized HTML: the anchor iframe
   * that carries the sitekey renders after load, and serialized HTML also
   * escapes `&` to `&amp;` in its URL. One short retry, because the widget
   * can legitimately be a moment behind the page.
   */
  async getRecaptchaInfo() {
    const { extractSitekeyFromHtml, isEnterpriseRecaptchaHtml } = await import('../captcha/solver.mjs');
    const collect = () => this.page.evaluate(() => ({
      srcs: Array.from(document.querySelectorAll('iframe[src], script[src]'))
        .map((e) => e.getAttribute('src') || ''),
      keys: Array.from(document.querySelectorAll('[data-sitekey]'))
        .map((e) => e.getAttribute('data-sitekey') || ''),
    }));

    let { srcs, keys } = await collect();
    let sitekey = extractSitekeyFromHtml(srcs.join('\n'))
      || keys.find((k) => /^[A-Za-z0-9_-]{20,}$/.test(k)) || '';
    if (!sitekey) {
      await this.page.waitForTimeout(2500).catch(() => {});
      ({ srcs, keys } = await collect());
      sitekey = extractSitekeyFromHtml(srcs.join('\n'))
        || keys.find((k) => /^[A-Za-z0-9_-]{20,}$/.test(k)) || '';
    }
    return { sitekey, enterprise: isEnterpriseRecaptchaHtml(srcs.join('\n')) };
  }

  /**
   * Write a solved token into the form's `g-recaptcha-response` field.
   *
   * The board reads this field server-side on its POST, so the token has to be
   * present in the DOM before the submit click. The checkbox turning green is
   * cosmetic by comparison.
   */
  async injectRecaptchaToken(token) {
    return this.page.evaluate((t) => {
      const targets = document.querySelectorAll('#g-recaptcha-response, [name="g-recaptcha-response"]');
      targets.forEach((el) => { el.value = t; });
      return targets.length;
    }, token);
  }

  async clickCheckboxCaptcha() {
    const clicked = await this.page.evaluate(async () => {
      const iframes = Array.from(document.querySelectorAll('iframe'));
      const pick = iframes.find((f) => /recaptcha\/api2\/anchor|hcaptcha/.test(f.getAttribute('src') || ''));
      if (!pick) return false;
      try {
        const frame = pick.contentWindow && pick.contentWindow.document;
        const box = frame && frame.querySelector('.recaptcha-checkbox, .checkbox');
        if (box) { box.click(); return true; }
      } catch { /* cross-origin */ }
      return false;
    });
    return clicked;
  }

  async runVisionCaptcha({ baseUrl, apiKey, model }) {
    const { visionCompletion } = await import('../llm/provider.mjs');
    const shot = await this.page.screenshot({ type: 'jpeg', quality: 60 });
    const imageDataUri = `data:image/jpeg;base64,${shot.toString('base64')}`;
    const out = await visionCompletion({
      baseUrl, apiKey, model,
      prompt: 'This is a captcha image. Return the indices (0-based) of the tiles that match the hint, as a JSON array: [0,2]. If the challenge is a text puzzle, return the text. Only JSON.',
      imageDataUri,
      temperature: 0,
    });
    return out;
  }

  /**
   * Direct API POST when the board documents a public submit endpoint.
   * Lever's POST to …/apply returns 200 on success or 400+ with JSON error.
   * Done from Node, not the page, so file uploads work natively.
   */
  async submitViaApi(endpoint, { method, headers, body, cvFieldName, cvPath } = {}) {
    const outcome = { clicked: true, success: false, boardError: null, url: endpoint };
    try {
      const fd = new FormData();
      if (body) {
        for (const [k, v] of new URLSearchParams(body)) fd.append(k, v);
      }
      if (cvFieldName && cvPath && existsSync(cvPath)) {
        const buf = readFileSync(cvPath);
        const blob = new Blob([buf], { type: 'application/pdf' });
        fd.append(cvFieldName, blob, basename(cvPath));
      }
      const res = await fetch(endpoint, { method: method || 'POST', body: fd });
      const text = await res.text().catch(() => '');
      outcome.success = res.ok && /thank|success|received|submitted|confirmation|successfully/i.test(text);
      if (!res.ok) {
        let payload = null;
        try { payload = JSON.parse(text); } catch {}
        outcome.boardError = {
          status: res.status,
          code: payload?.code || `HTTP ${res.status}`,
          message: payload?.message || text?.slice(0, 200) || '',
        };
      }
    } catch (e) {
      outcome.clicked = false;
      outcome.boardError = { status: 0, code: 'network', message: e?.message || String(e) };
    }
    return outcome;
  }

  async submitApplication() {
    // When the form has moved to its security-code step, the real submit
    // control can sit disabled until the code registers — and clicking a
    // page-header stand-in outside the form does nothing. Wait for the code
    // field's own form to have an enabled control first.
    await this.page.waitForFunction(() => {
      const input = Array.from(document.querySelectorAll('input, textarea'))
        .find((i) => /code/i.test(`${i.id} ${i.name} ${i.placeholder}`));
      if (!input) return true; // no code step; nothing to wait for
      const scope = input.closest('form') || document;
      return Array.from(scope.querySelectorAll('button, input[type=submit]'))
        .some((b) => !b.disabled && /\b(submit|verify|apply|send|finish|complete)\b/i.test(b.textContent || b.value || ''));
    }, { timeout: 10000 }).catch(() => {});

    // Score candidates rather than taking the first textual match: a form can
    // carry "Submit" and "Submit application", and only the latter is the real
    // one. Returns an index into the scored list.
    const ranked = await this.page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a[role=button]'))
        .filter((b) => b && !b.disabled);
      const strong = /\b(submit application|send application|finish( application)?|complete application|apply (and|&) submit|verify( and| &)? (submit|application)?|enviar|finalizar)\b/i;
      const weak = /\b(submit|apply|verify|send)\b/i;
      // On the security-code step, only the code field's own form carries the
      // control that submits; anything else (a page-header "Apply") must not
      // win on text alone.
      const codeInput = Array.from(document.querySelectorAll('input, textarea'))
        .find((i) => /code/i.test(`${i.id} ${i.name} ${i.placeholder}`));
      const scope = codeInput ? (codeInput.closest('form') || document) : null;
      const scored = btns.map((b, i) => {
        const t = ((b.textContent || b.getAttribute('value') || b.getAttribute('aria-label') || '') + '').trim();
        let score = 0;
        if (strong.test(t)) score = 2;
        else if (weak.test(t)) score = 1;
        if (scope && scope.contains(b)) score += 2;
        return { i, score, t };
      }).filter((x) => x.score > 0);
      if (!scored.length) return null;
      scored.sort((a, b) => b.score - a.score);
      return { index: scored[0].i, text: scored[0].t };
    });
    if (!ranked) return { clicked: false, errors: [] };
    if (process.env.AUTOAPPLY_DEBUG) console.error(`[debug] submitApplication -> "${ranked.text}"`);

    // Watch for the board's own submission request: the response body says
    // exactly why a submit was rejected, which the DOM alone often does not.
    const netLog = [];
    const onResponse = async (resp) => {
      try {
        const req = resp.request();
        if (req.method() === 'GET') return;
        if (netLog.length >= 8) return;
        let body = '';
        try { body = (await resp.text()).slice(0, 600); } catch { /* not readable */ }
        // The request body answers "was the token we injected actually the one
        // sent?" — if the widget regenerated it at click time, this shows it.
        let postData = '';
        try { postData = (req.postData() || '').slice(0, 1500); } catch { /* not readable */ }
        netLog.push({ status: resp.status(), url: resp.url(), body, postData });
      } catch { /* ignore */ }
    };
    this.page.on('response', onResponse);

    // Click via Playwright, not el.click(), so React's synthetic handlers fire.
    const btn = this.page.locator('button, input[type=submit], input[type=button], a[role=button]')
      .nth(ranked.index);
    await btn.click({ timeout: 8000 }).catch(async () => {
      await btn.click({ force: true }).catch(() => {});
    });
    await this.page.waitForTimeout(2500).catch(() => {});
    // Some boards navigate to a separate thank-you page; give that a moment.
    await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await this.page.waitForTimeout(1500).catch(() => {});
    this.page.off('response', onResponse);
    if (process.env.AUTOAPPLY_DEBUG) {
      for (const n of netLog) {
        console.error(`[debug] post-submit ${n.status} ${n.url} :: ${n.body.replace(/\s+/g, ' ').slice(0, 300)}`);
        if (n.postData) {
          const pd = n.postData.replace(/\s+/g, ' ');
          console.error(`[debug] post-submit request :: ${pd.slice(0, 2500)}`);
          const captchaFields = pd.match(/[A-Za-z_-]*recaptcha[A-Za-z_-]*[^,}\]]{0,140}/gi);
          if (captchaFields) console.error(`[debug] request captcha fields :: ${captchaFields.join(' || ').slice(0, 800)}`);
        }
      }
      if (!netLog.length) console.error('[debug] post-submit no non-GET requests observed');
    }
    // The board's own API verdict is the most reliable signal available: a
    // Greenhouse rejection looks nothing like a success page in the DOM.
    let boardError = null;
    let boardSuccess = false;
    for (const n of netLog) {
      // A 2xx or 3xx response with a confirm/success/id payload means the
      // board accepted the application. Teamtailor returns JSON {status:"ok"}
      // or {data:{id:...}}; Lever returns the posting page with "Success!".
      if (n.status >= 200 && n.status < 400) {
        let json = null;
        try { json = JSON.parse(n.body); } catch {}
        if (json && (json.status === 'ok' || json.success || json.id || json.data?.id)) {
          boardSuccess = true;
        }
        if (/thank|submitted|received|confirmed|success|created/i.test(n.body)) {
          boardSuccess = true;
        }
      }
      if (n.status < 400 && !/error|exceed|invalid|reject/i.test(n.body)) continue;
      let payload = null;
      try { payload = JSON.parse(n.body); } catch { /* text body */ }
      if (payload && (payload.code || payload.message)) {
        boardError = {
          status: n.status,
          code: payload.code || null,
          message: payload.message || null,
          // A captcha-failed 428 that names a recipient is the emailed-code
          // step, not a rejection: the board wants the code as the final
          // verification of the submit.
          securityCodeRecipient: payload.security_code_recipient || null,
        };
        break;
      }
    }

    // The emailed-code UI can render a moment after the 428 arrives; without
    // the extra wait the run would miss it and report a rejection.
    if (boardError?.code === 'captcha-failed') {
      await this.page.waitForTimeout(6000).catch(() => {});
    }

    const errors = await this.page.evaluate(() => {
      const msgs = [];
      // A cookie banner can reappear on the page that loads after a form POST,
      // hiding the confirmation message underneath. Dismiss it first so the
      // body text used for success detection is the actual page, not the
      // cookie-consent popup.
      const norm = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
      for (const el of document.querySelectorAll('button, a, [role="button"]')) {
        const t = norm(el.textContent || '');
        if (/(accept|decline|deny|reject).*cookie|cookie.*(accept|decline|deny|reject)/i.test(t)) {
          try { el.click(); } catch {}
          break;
        }
      }
      document.querySelectorAll('.field-error, .error, [class*="error"], [aria-invalid="true"]').forEach((e) => {
        const t = (e.textContent || '').trim();
        if (t && t.length < 120 && /required|enter your|please|invalid|must/i.test(t)) msgs.push(t);
      });
      const body = document.body.innerText || '';
      // Only a genuine emailed-code challenge counts. "captcha" is deliberately
      // NOT in here: captchas are handled separately, and treating one as a
      // "security code" used to make the tool type page text into the form.
      const securityCode = /security code|verification code|enter the code you (were )?sent/i.test(body)
        && !!document.querySelector('input[name*="code"], input[id*="code"], input[placeholder*="code"]');
// A confirmation counts on either signal: the board's own thank-you
      // wording, or a dedicated confirmation URL. "Success!" covers boards
      // that return to the same page with a success banner (Lever).
      const success = /thank(s| you)|we('ve| have) (got|received) your application|application (has been|was) (submitted|received)|we('ll| will) be in touch|submitted successfully|success!|your application (was|has been) sent|application received|application successful|thanks for applying/i.test(body)
      || /\/(confirmation|thank_you|thanks|complete|applied|submitted)\b/i.test(location.href)
      || location.href !== (new URL(document.querySelector('form')?.action || location.href, location.href)).href;
      // Diagnostics: without these, "clicked but unconfirmed" is undebuggable.
      const stillOnForm = !!document.querySelector('input[type=file]');
      const labelOf = (i) => {
        const label = i.closest('label') || (i.id ? document.querySelector(`label[for="${i.id}"]`) : null);
        return (label && label.textContent || '').trim().slice(0, 60);
      };
      const looksLikeCodeField = (i) => /code/i.test(
        `${i.name} ${i.id} ${i.placeholder} ${i.getAttribute('aria-label') || ''} ${labelOf(i)}`,
      );
      const codeInputs = Array.from(document.querySelectorAll('input, textarea'))
        .filter(looksLikeCodeField)
        .map((i) => ({ name: i.name, id: i.id, placeholder: i.placeholder, label: labelOf(i) }));
      return {
        errors: Array.from(new Set(msgs)).slice(0, 12),
        success,
        securityCode,
        stillOnForm,
        codeInputs,
        url: location.href,
        title: document.title,
        text: body.replace(/\s+/g, ' ').trim().slice(0, 400),
      };
    });
    // The cookie-consent click in the evaluate block fires instantly but the DOM
    // may take a moment to re-render. Give it that moment before the debug log
    // and the rest of the pipeline read whatever the banner was hiding.
    await this.page.waitForTimeout(1500).catch(() => {});
    if (process.env.AUTOAPPLY_DEBUG) {
      console.error(`[debug] post-submit url=${errors.url}`);
      console.error(`[debug] post-submit title=${errors.title}`);
      console.error(`[debug] post-submit stillOnForm=${errors.stillOnForm} success=${errors.success}`);
      if (errors.codeInputs?.length) console.error(`[debug] post-submit codeInputs=${JSON.stringify(errors.codeInputs)}`);
      console.error(`[debug] post-submit text=${errors.text}`);
      if (errors.errors.length) console.error(`[debug] post-submit errors=${errors.errors.join(' | ')}`);
    }
    return {
      clicked: true, errors: errors.errors, success: errors.success || boardSuccess, securityCode: errors.securityCode,
      url: errors.url, text: errors.text, stillOnForm: errors.stillOnForm, codeInputs: errors.codeInputs,
      boardError, boardSuccess,
    };
  }

  /**
   * Type the emailed security code into the board's code field.
   *
   * Typed key by key rather than set in one shot: the board's app tracks the
   * code through its own input handlers, and a bulk value assignment can leave
   * its state — and therefore the submit control — untouched.
   *
   * @returns {Promise<boolean>} false when no code input is on the page
   */
  async fillSecurityCode(code) {
    const sel = await this.page.evaluate(() => {
      const labelOf = (i) => {
        const label = i.closest('label') || (i.id ? document.querySelector(`label[for="${i.id}"]`) : null);
        return (label && label.textContent || '').trim().slice(0, 60);
      };
      const input = Array.from(document.querySelectorAll('input, textarea'))
        .find((i) => /code/i.test(`${i.name} ${i.id} ${i.placeholder} ${i.getAttribute('aria-label') || ''} ${labelOf(i)}`));
      if (!input) return null;
      if (input.name) return `${input.tagName.toLowerCase()}[name="${input.name}"]`;
      if (input.id) return `${input.tagName.toLowerCase()}#${input.id}`;
      return null;
    });
    if (!sel) return false;
    const field = this.page.locator(sel).first();
    await field.click({ timeout: 5000 }).catch(() => {});
    await field.fill('', { timeout: 5000 }).catch(() => {});
    try {
      await field.pressSequentially(code, { delay: 60 });
    } catch {
      await field.fill(code, { timeout: 5000 });
    }
    return true;
  }

  async close() {
    if (this.browser) await this.browser.close();
  }
}

/**
 * Commit a value to a react-select combobox by typing the search term then
 * calling its Select onChange directly via the React fiber. Returns 'committed:X'
 * on success, or a diagnostic string on failure.
 */
async function commitReactSelectById(page, fieldId, answer, extraArrows = 0) {
  try {
    const el = page.locator('#' + fieldId.replace(/[^a-zA-Z0-9_-]/g, '\\$&')).first();
    if (!(await el.count().catch(() => 0))) return 'not-found';

    // Approach: click the dropdown to open, then click the matching option.
    // Typing is unreliable â€” some react-selects filter on type, others don't open
    // their menu at all. Simple-click-find works for all react-select variants.
    await page.keyboard.press('Escape').catch(() => {});
    await el.click({ force: true });
    await page.waitForTimeout(800);

    // Try clicking an option by text match (role=option or class=select__option)
    const optionClicked = await page.evaluate((ans) => {
      const opts = Array.from(document.querySelectorAll('[role="option"], .select__option'));
      // Exact match first, then fuzzy
      const exact = opts.find((o) => o.textContent.trim() === ans);
      const fuzzy = opts.find((o) => o.textContent.trim().includes(ans)) || opts.find((o) => ans.includes(o.textContent.trim()));
      const target = exact || fuzzy;
      if (!target) return false;
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.click();
      return true;
    }, answer).catch(() => false);
    if (optionClicked) { await page.waitForTimeout(300); return 'simple-click'; }

    // If no options appeared yet (slow network), try keyboard navigation
    await page.keyboard.press('ArrowDown');
    for (let i = 0; i < (extraArrows || 2); i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    return 'keyboard-select';
  } catch (e) {
    return 'err:' + e.message.split('\n')[0];
  }
}

/**
 * Last-resort: find the hidden native <select> that a custom combobox widget
 * wraps (common in Greenhouse forms with custom dropdowns). Change its value
 * and dispatch a change event so the form validator sees the selection.
 */
async function commitNativeSelect(page, fieldId, answer) {
  try {
    return await page.evaluate(({ fieldId, answer }) => {
      const input = document.getElementById(fieldId);
      if (!input) return 'no-input';
      let container = input.closest('[class*="field"]') || input.closest('[class*="select"]');
      if (!container) {
        // walk up to any wrapper
        let el = input.parentElement;
        for (let i = 0; i < 10 && el; i++) { if (el.querySelector('select')) { container = el; break; } el = el.parentElement; }
      }
      if (!container) return 'no-container';
      const select = container.querySelector('select');
      if (!select) return 'no-select';
      const opts = Array.from(select.options);
      const exact = opts.find((o) => o.textContent.trim() === answer.trim());
      const fuzzy = opts.find((o) => o.textContent.includes(answer) || answer.includes(o.textContent));
      const match = exact || fuzzy || opts[0];
      if (!match) return 'no-match';
      select.value = match.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.dispatchEvent(new Event('input', { bubbles: true }));
      return 'native-select:' + match.textContent.trim().slice(0, 30);
    }, { fieldId, answer });
  } catch (e) {
    return 'native-err:' + e.message.split('\n')[0];
  }
}

async function checkRequiredCheckboxes(page) {
  try {
    return await page.evaluate(() => {
      const cbs = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      let n = 0;
      for (const cb of cbs) {
        if (cb.required && !cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          cb.dispatchEvent(new Event('input', { bubbles: true }));
          n++;
        }
      }
      return 'checked:' + n;
    });
  } catch (e) {
    return 'cb-err:' + e.message.split('\n')[0];
  }
}

function cssIdent(s) {
  return s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}
/**
 * Attribute-selector form. Greenhouse ids can be bare numbers ("627"), and
 * `#627` is an invalid CSS selector (cannot start with a digit), so an id
 * locator must go through [id="..."] instead.
 */
function cssAttr(name, s) {
  return `[${name}="${String(s).replace(/(["\\])/g, '\\$1')}"]`;
}
function cssFieldNameRe(s) {
  return s.replace(/[^a-zA-Z0-9_[]\]-]/g, '\\$&');
}