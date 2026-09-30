import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkPackagePayload,
  resolveLinkHref,
  describeOpenProjectError,
  normalizeBaseUrl,
  fetchMetadata,
} from '../src/openproject/openprojectClient.js';
import {
  buildTicketFields,
  missingRequiredFields,
  describeUnmatched,
  normalizeFieldMapping,
  resolveConfirmRecipient,
} from '../src/signal/inboundActionExecutor.js';

// Modelled on the real schema of this install's "Довідка" type: OpenProject
// generates the subject from a pattern (so subject is NOT writable) and three
// custom fields are mandatory.
const dovidkaSchema = {
  fields: [
    { key: 'subject', name: 'Subject', type: 'String', required: true, hasDefault: true, writable: false, location: null },
    { key: 'description', name: 'Description', type: 'Formattable', required: false, hasDefault: false, writable: true, location: null },
    { key: 'status', name: 'Status', type: 'Status', required: true, hasDefault: true, writable: true, location: '_links' },
    { key: 'priority', name: 'Priority', type: 'Priority', required: true, hasDefault: true, writable: true, location: '_links' },
    {
      key: 'customField1',
      name: '🌀Тип довідки',
      type: '[]CustomOption',
      required: true,
      hasDefault: false,
      writable: true,
      location: '_links',
      allowedValues: [
        { href: '/api/v3/custom_options/1', id: 1, label: 'Форма 5' },
        { href: '/api/v3/custom_options/313', id: 313, label: 'Інше (Вкажу в описі)' },
      ],
    },
    {
      key: 'customField19',
      name: '👤Замовник',
      type: 'CustomField::Hierarchy::Item',
      required: true,
      hasDefault: false,
      writable: true,
      location: '_links',
      allowedValues: [{ href: '/api/v3/custom_fields/19/items/7', id: 7, label: 'Відділ кадрів' }],
    },
    { key: 'customField21', name: '🎯На кого', type: 'String', required: true, hasDefault: false, writable: true, location: null },
  ],
};

beforeEach(() => mock.restoreAll());

test('a subject OpenProject generates itself is never posted', () => {
  const { payload, skipped } = buildWorkPackagePayload({
    projectId: 3,
    typeId: 8,
    fields: { subject: 'anything', customField21: 'Іванов' },
    schema: dovidkaSchema,
  });
  assert.equal(payload.subject, undefined);
  assert.ok(skipped.includes('subject'));
  assert.equal(payload.customField21, 'Іванов');
});

test('link-typed fields go under _links, and multi-value ones as an array', () => {
  const { payload } = buildWorkPackagePayload({
    projectId: 3,
    typeId: 8,
    fields: { customField1: '313', customField19: '7' },
    schema: dovidkaSchema,
  });
  assert.deepEqual(payload._links.customField1, [{ href: '/api/v3/custom_options/313' }]);
  assert.deepEqual(payload._links.customField19, { href: '/api/v3/custom_fields/19/items/7' });
  assert.deepEqual(payload._links.project, { href: '/api/v3/projects/3' });
  assert.deepEqual(payload._links.type, { href: '/api/v3/types/8' });
});

test('a link value may be given as an id, a label, or a full href', () => {
  const field = dovidkaSchema.fields.find((f) => f.key === 'customField1');
  assert.equal(resolveLinkHref(field, '1'), '/api/v3/custom_options/1');
  assert.equal(resolveLinkHref(field, 'Форма 5'), '/api/v3/custom_options/1');
  assert.equal(resolveLinkHref(field, '/api/v3/custom_options/1'), '/api/v3/custom_options/1');
  assert.throws(() => resolveLinkHref(field, 'not a real option'), /not a valid value for 🌀Тип довідки/);
});

test('a multi-select accepts a comma separated list', () => {
  const { payload } = buildWorkPackagePayload({
    projectId: 3,
    typeId: 8,
    fields: { customField1: 'Форма 5, 313' },
    schema: dovidkaSchema,
  });
  assert.deepEqual(payload._links.customField1, [
    { href: '/api/v3/custom_options/1' },
    { href: '/api/v3/custom_options/313' },
  ]);
});

test('description is sent as a Formattable, not a bare string', () => {
  const { payload } = buildWorkPackagePayload({
    projectId: 3,
    typeId: 8,
    fields: { description: 'from Signal' },
    schema: dovidkaSchema,
  });
  assert.deepEqual(payload.description, { format: 'markdown', raw: 'from Signal' });
});

test('blank values are omitted rather than posted as empty', () => {
  const { payload } = buildWorkPackagePayload({
    projectId: 3,
    typeId: 8,
    fields: { customField21: '   ', description: '' },
    schema: dovidkaSchema,
  });
  assert.equal('customField21' in payload, false);
  assert.equal('description' in payload, false);
});

test('required fields with a default are not demanded from the rule', () => {
  // status and priority are `required` but OpenProject fills them in.
  const missing = missingRequiredFields(dovidkaSchema, { customField1: '1', customField19: '7', customField21: 'x' });
  assert.deepEqual(missing, []);
});

test('missing mandatory custom fields are reported by their OpenProject name', () => {
  const missing = missingRequiredFields(dovidkaSchema, { subject: 'hi' });
  assert.deepEqual(
    missing.map((f) => f.key),
    ['customField1', 'customField19', 'customField21']
  );
  assert.equal(missing[0].name, '🌀Тип довідки');
});

test('field templates render capture variables, but link values pass through', () => {
  const action = {
    subject_template: '{subject}',
    description_template: '{message}',
    field_templates: { customField21: 'For {sender}', customField1: '313' },
  };
  const context = { subject: 'Довідка', message: '!dovidka Довідка', sender: 'Ann', rest: 'Довідка', first_line: '!dovidka Довідка' };
  const { fields } = buildTicketFields(action, context, dovidkaSchema);

  assert.equal(fields.customField21, 'For Ann');
  // A dropdown-chosen id must not be mangled by the template renderer.
  assert.equal(fields.customField1, '313');
  assert.equal(fields.subject, 'Довідка');
});

test('an unknown customField is still passed through for instances we have no schema for', () => {
  const { payload } = buildWorkPackagePayload({
    projectId: 3,
    typeId: 1,
    fields: { customField99: 'value' },
    schema: { fields: [] },
  });
  assert.equal(payload.customField99, 'value');
});

test('OpenProject validation errors become a readable message', () => {
  const body = JSON.stringify({
    _type: 'Error',
    message: 'Multiple field constraints have been violated.',
    _embedded: {
      errors: [
        { message: '🌀Тип довідки can\'t be blank.' },
        { message: '🎯На кого can\'t be blank.' },
      ],
    },
  });
  assert.equal(
    describeOpenProjectError(422, body),
    'OpenProject rejected the work package: 🌀Тип довідки can\'t be blank.; 🎯На кого can\'t be blank.'
  );
  assert.match(describeOpenProjectError(500, 'not json at all'), /500.*not json at all/);
});

test('a trailing slash on the base URL does not produce a double slash', () => {
  assert.equal(normalizeBaseUrl('http://192.168.88.88:9999/'), 'http://192.168.88.88:9999');
  assert.equal(normalizeBaseUrl('http://192.168.88.88:9999'), 'http://192.168.88.88:9999');
});

test('metadata still loads when /api/v3/custom_fields is missing', async () => {
  // This 404s on this OpenProject version; Promise.all used to discard
  // types/statuses/projects along with it, leaving every dropdown empty.
  mock.method(globalThis, 'fetch', async (url) => {
    const path = String(url);
    if (path.includes('/custom_fields')) return { ok: false, status: 404, text: async () => 'not found' };
    if (path.includes('/types')) {
      return { ok: true, json: async () => ({ _embedded: { elements: [{ id: 10, name: 'Телеграма' }] } }) };
    }
    if (path.includes('/projects')) {
      return { ok: true, json: async () => ({ _embedded: { elements: [{ id: 3, name: 'Персонал', active: true }] } }) };
    }
    return { ok: true, json: async () => ({ _embedded: { elements: [] } }) };
  });

  const metadata = await fetchMetadata('http://openproject.test', 'key');
  assert.deepEqual(metadata.types, [{ id: 10, name: 'Телеграма' }]);
  assert.equal(metadata.projects[0].name, 'Персонал');
  assert.deepEqual(metadata.customFields, []);
  assert.ok(metadata.unavailable.some((u) => u.key === 'customFields'));
});

// --- field mappings: where a value comes from, and what happens when it fits
// --- nothing in the field's list ---------------------------------------------

const naturalContext = {
  form: 'Форма 5',
  person: 'Іванов Іван Іванович',
  sender: 'Ann (+380671112233)',
  message: 'потрібна ф5 на Іванов Іван Іванович',
  rest: '',
  first_line: 'потрібна ф5 на Іванов Іван Іванович',
};

test('a mapping is accepted as a bare template or as an object', () => {
  assert.deepEqual(normalizeFieldMapping('{form}'), { template: '{form}', source: 'template', fallback: '' });
  assert.deepEqual(normalizeFieldMapping({ source: 'sender_contact', fallback: '313' }), {
    template: '',
    source: 'sender_contact',
    fallback: '313',
  });
});

test('a rendered form label that the list has is used as it stands', () => {
  const action = { field_templates: { customField1: { template: '{form}', fallback: '313' } } };
  const { fields, unmatched } = buildTicketFields(action, naturalContext, dovidkaSchema);
  assert.equal(fields.customField1, 'Форма 5');
  assert.deepEqual(unmatched, []);
});

test('a form the list does not have falls back, and says what was asked for', () => {
  const action = { field_templates: { customField1: { template: '{form}', fallback: '313' } } };
  const { fields, unmatched } = buildTicketFields(
    action,
    { ...naturalContext, form: 'Форма 77' },
    dovidkaSchema
  );
  // "Інше (Вкажу в описі)" rather than a 422 from OpenProject.
  assert.equal(fields.customField1, '313');
  assert.deepEqual(unmatched, [
    { key: 'customField1', name: '🌀Тип довідки', source: 'template', requested: 'Форма 77' },
  ]);
});

test('with no fallback configured the value is left to fail loudly', () => {
  const action = { field_templates: { customField1: '{form}' } };
  const { fields, unmatched } = buildTicketFields(
    action,
    { ...naturalContext, form: 'Форма 77' },
    dovidkaSchema
  );
  assert.equal(fields.customField1, 'Форма 77');
  assert.deepEqual(unmatched, []);
});

test('a field sourced from the sender contact uses the value recorded for them', () => {
  const action = { field_templates: { customField19: { source: 'sender_contact', fallback: '7' } } };
  const { fields, unmatched } = buildTicketFields(action, naturalContext, dovidkaSchema, {
    contactValues: { customField19: '7' },
  });
  assert.equal(fields.customField19, '7');
  assert.deepEqual(unmatched, []);
});

test('a sender nobody has classified falls back, naming the sender', () => {
  const action = { field_templates: { customField19: { source: 'sender_contact', fallback: '7' } } };
  const { fields, unmatched } = buildTicketFields(action, naturalContext, dovidkaSchema, {
    contactValues: {},
  });
  assert.equal(fields.customField19, '7');
  assert.equal(unmatched[0].source, 'sender_contact');
  assert.equal(unmatched[0].requested, 'Ann (+380671112233)');
});

test('the description says what could not be matched, since the option promised it would', () => {
  assert.equal(
    describeUnmatched([
      { key: 'customField1', name: '🌀Тип довідки', source: 'template', requested: 'Форма 77' },
      { key: 'customField19', name: '👤Замовник', source: 'sender_contact', requested: 'Ann' },
    ]),
    '**Not matched to a list value:**\n- 🌀Тип довідки: Форма 77\n- 👤Замовник: Ann'
  );
  assert.equal(describeUnmatched([]), '');
});

test('a ticket confirmation defaults to wherever the request came from', () => {
  const context = { groupId: 'group.abc', senderNumber: '+1' };
  assert.equal(resolveConfirmRecipient({ confirm_target: 'source' }, context), 'group.abc');
  assert.equal(resolveConfirmRecipient({}, context), 'group.abc');
  assert.equal(resolveConfirmRecipient({ confirm_target: 'source' }, { senderNumber: '+1' }), '+1');
});

test('a ticket confirmation set to the reviewer goes to approval_recipient, not the source', () => {
  const context = { groupId: 'group.abc', senderNumber: '+1' };
  assert.equal(
    resolveConfirmRecipient({ confirm_target: 'reviewer', approval_recipient: '+999' }, context),
    '+999'
  );
  assert.equal(resolveConfirmRecipient({ confirm_target: 'reviewer' }, context), null);
});

// --- field_match: routing one field (e.g. assignee) by another field's ------
// --- already-resolved value ---------------------------------------------------

const assigneeField = {
  key: 'assignee',
  name: 'Assignee',
  type: 'User',
  required: false,
  hasDefault: false,
  writable: true,
  location: '_links',
  allowedValues: [
    { href: '/api/v3/users/12', id: 12, label: 'Assignee One' },
    { href: '/api/v3/users/34', id: 34, label: 'Assignee Two' },
    { href: '/api/v3/users/56', id: 56, label: 'Assignee Three' },
  ],
};
const schemaWithAssignee = { fields: [...dovidkaSchema.fields, assigneeField] };

test('normalizeFieldMapping keeps the field_match shape distinct, and every other source unchanged', () => {
  assert.deepEqual(
    normalizeFieldMapping({
      source: 'field_match',
      matchField: 'customField1',
      fallback: '56',
      rules: [
        { values: ['1'], value: '12' },
        { values: [''], value: '999' }, // dropped: no usable value text
        { values: ['313'], value: '' }, // dropped: no assignee chosen
      ],
    }),
    {
      template: '',
      source: 'field_match',
      fallback: '56',
      matchField: 'customField1',
      rules: [{ values: ['1'], value: '12' }],
    }
  );
  // Every pre-existing source keeps exactly the three keys it always had.
  assert.deepEqual(normalizeFieldMapping('{form}'), { template: '{form}', source: 'template', fallback: '' });
});

test('field_match routes by the id a dropdown-chosen customField1 resolved to', () => {
  const action = {
    field_templates: {
      customField1: '1', // "Форма 5", chosen from the dropdown
      assignee: {
        source: 'field_match',
        matchField: 'customField1',
        fallback: '56',
        rules: [
          { values: ['1'], value: '12' }, // Форма 5 -> Assignee One
          { values: ['313'], value: '34' },
        ],
      },
    },
  };
  const { fields, unmatched } = buildTicketFields(action, naturalContext, schemaWithAssignee);
  assert.equal(fields.customField1, '1');
  assert.equal(fields.assignee, '12');
  assert.deepEqual(unmatched, []);
});

test('field_match routes by label just as well as by id -- both sides resolve to the same option', () => {
  // customField1 here is rendered from {form} ("Форма 5"), a label, not an id.
  const action = {
    field_templates: {
      customField1: '{form}',
      assignee: {
        source: 'field_match',
        matchField: 'customField1',
        fallback: '56',
        // The rule is written with the option id; it still has to match a
        // customField1 that ended up holding the label.
        rules: [{ values: ['1'], value: '12' }],
      },
    },
  };
  const { fields } = buildTicketFields(action, naturalContext, schemaWithAssignee);
  assert.equal(fields.customField1, 'Форма 5');
  assert.equal(fields.assignee, '12');
});

test('field_match falls through to the "otherwise" default when no rule matches', () => {
  const action = {
    field_templates: {
      customField1: '{form}',
      assignee: {
        source: 'field_match',
        matchField: 'customField1',
        fallback: '56',
        rules: [{ values: ['1'], value: '12' }], // only covers Форма 5
      },
    },
  };
  const { fields, unmatched } = buildTicketFields(
    action,
    { ...naturalContext, form: 'Форма 12' },
    schemaWithAssignee
  );
  assert.equal(fields.assignee, '56');
  assert.deepEqual(unmatched, [
    { key: 'assignee', name: 'Assignee', source: 'field_match', requested: '🌀Тип довідки = "Форма 12"' },
  ]);
});

test('field_match with no default configured leaves the field unset, quietly', () => {
  const action = {
    field_templates: {
      customField1: '{form}',
      assignee: {
        source: 'field_match',
        matchField: 'customField1',
        rules: [{ values: ['1'], value: '12' }],
      },
    },
  };
  const { fields, unmatched } = buildTicketFields(
    action,
    { ...naturalContext, form: 'Форма 12' },
    schemaWithAssignee
  );
  assert.equal('assignee' in fields, false);
  assert.deepEqual(unmatched, []);
});

test('a multi-value rule matches any one of its listed values (the "Форма 6, Форма 7" case)', () => {
  const action = {
    field_templates: {
      customField1: '1',
      assignee: {
        source: 'field_match',
        matchField: 'customField1',
        fallback: '56',
        rules: [{ values: ['313', '1'], value: '34' }],
      },
    },
  };
  const { fields } = buildTicketFields(action, naturalContext, schemaWithAssignee);
  assert.equal(fields.assignee, '34');
});

test('field_match with nothing set on the matched field falls through to the default', () => {
  const action = {
    field_templates: {
      assignee: {
        source: 'field_match',
        matchField: 'customField1',
        fallback: '56',
        rules: [{ values: ['1'], value: '12' }],
      },
    },
  };
  const { fields, unmatched } = buildTicketFields(action, naturalContext, schemaWithAssignee);
  assert.equal(fields.assignee, '56');
  assert.deepEqual(unmatched, [
    { key: 'assignee', name: 'Assignee', source: 'field_match', requested: '🌀Тип довідки not set' },
  ]);
});
