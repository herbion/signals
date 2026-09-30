import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplateContext, renderTemplate } from '../src/rules/templateRenderer.js';

test('buildTemplateContext exposes flattened relation names and a "_from" for changed fields', () => {
  const snapshot = {
    id: 42,
    subject: 'Fix the bug',
    type: { id: 1, name: 'Bug' },
    status: { id: 2, name: 'Closed' },
    project: { id: 1, name: 'Demo' },
    assignee: null,
    priority: { id: 8, name: 'Normal' },
    url: '/api/v3/work_packages/42',
    customFields: { customField1: 'Some value' },
  };
  const changeSet = [{ field: 'status', from: { id: 1, name: 'New' }, to: { id: 2, name: 'Closed' }, changed: true }];

  const context = buildTemplateContext(snapshot, changeSet);
  assert.equal(context.id, 42);
  assert.equal(context.status, 'Closed');
  assert.equal(context.status_from, 'New');
  assert.equal(context.assignee, '');
  assert.equal(context.customField1, 'Some value');
});

test('renderTemplate substitutes known variables', () => {
  const output = renderTemplate('{type} #{id} "{subject}" was closed', { type: 'Bug', id: 42, subject: 'Fix the bug' });
  assert.equal(output, 'Bug #42 "Fix the bug" was closed');
});

test('renderTemplate leaves unknown placeholders untouched instead of blanking them', () => {
  const output = renderTemplate('Hello {unknownVar}', { id: 1 });
  assert.equal(output, 'Hello {unknownVar}');
});
