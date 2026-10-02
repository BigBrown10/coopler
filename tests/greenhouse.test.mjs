import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFields } from '../src/ats/guard.mjs';

test('classifyFields flags guard words in label/name', () => {
  const fields = [
    { key: 'a', label: 'visa sponsorship', name: 'v', kindRef: null },
    { key: 'b', label: 'email', name: 'email', kindRef: null },
    { key: 'c', label: 'salary range', name: 's', kindRef: null },
  ];
  const out = classifyFields(fields);
  assert.equal(out[0].guard, true);
  assert.equal(out[1].guard, false);
  assert.equal(out[2].guard, true);
});