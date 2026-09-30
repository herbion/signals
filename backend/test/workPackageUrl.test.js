import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workPackageUrl, buildTemplateContext, renderTemplate } from '../src/rules/templateRenderer.js';

test('workPackageUrl builds an absolute link to the human-facing page', () => {
  assert.equal(workPackageUrl('http://192.168.88.88:9999', 42), 'http://192.168.88.88:9999/work_packages/42');
});

test('workPackageUrl tolerates a trailing slash on the base URL', () => {
  // OpenProject base URLs are commonly stored with one, as this install's is.
  assert.equal(workPackageUrl('http://192.168.88.88:9999/', 42), 'http://192.168.88.88:9999/work_packages/42');
  assert.equal(workPackageUrl('http://192.168.88.88:9999///', 42), 'http://192.168.88.88:9999/work_packages/42');
});

test('workPackageUrl returns empty when it has nothing to build from', () => {
  assert.equal(workPackageUrl(null, 42), '');
  assert.equal(workPackageUrl('http://op.local', null), '');
});

test('{url} renders the OpenProject page, not the relative API href', () => {
  const snapshot = {
    id: 42,
    subject: 'Fix the bug',
    customFields: {},
    url: '/api/v3/work_packages/42', // what the webhook payload actually carries
  };

  const context = buildTemplateContext(snapshot, [], { baseUrl: 'http://192.168.88.88:9999/' });
  assert.equal(context.url, 'http://192.168.88.88:9999/work_packages/42');
  assert.equal(
    renderTemplate('#{id} {subject} — {url}', context),
    '#42 Fix the bug — http://192.168.88.88:9999/work_packages/42'
  );
});

test('{url} falls back to the payload href when no base URL is configured', () => {
  const snapshot = { id: 42, customFields: {}, url: '/api/v3/work_packages/42' };
  assert.equal(buildTemplateContext(snapshot, []).url, '/api/v3/work_packages/42');
});
