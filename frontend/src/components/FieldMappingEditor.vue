<script setup>
/**
 * How one OpenProject field on a Create-ticket action gets its value.
 *
 * A field whose schema gives a closed list can be filled three ways: pick one
 * entry for every ticket, render it from the message (a natural-language rule
 * points 🌀Тип довідки at {form}), or read it off whoever sent the message
 * (👤Замовник is a property of the requester, not of the text). The last two
 * can produce something the list does not contain, which is what the fallback
 * is for — OpenProject installs keep an "Інше (вкажу в описі)" entry for
 * exactly this, and the bridge writes the real answer into the description.
 *
 * A fourth source, "choose by another field's value", routes this field by
 * whatever another field on the same ticket resolved to — e.g. Assignee
 * depends on 🌀Тип довідки: Форма 5 goes to one person, Форма 6/7 to
 * another, anything else to a default. It is deliberately not gated behind
 * this field having its own closed list (`hasList`): a `User`-typed field
 * like assignee frequently has none — OpenProject's form endpoint only
 * returns assignable users when the install exposes that href — so the
 * source selector is always shown, and the per-rule "set to" picker falls
 * back to the `users` prop (fetched from Settings → OpenProject → Users)
 * whenever the field itself offers no list.
 */
import { computed } from 'vue';
import TreeSelect from './TreeSelect.vue';

const props = defineProps({
  field: { type: Object, required: true },
  mapping: { type: [String, Object], default: undefined },
  required: { type: Boolean, default: false },
  // Every field on the same schema, so a "choose by another field's value"
  // mapping can offer a "match on" dropdown instead of a free-typed key.
  schemaFields: { type: Array, default: () => [] },
  // Active OpenProject users ({id, name}), for a value picker on fields
  // (assignee, chiefly) whose schema carries no allowed-values list of its own.
  users: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:mapping']);

const options = computed(() => props.field.allowedValues ?? []);
const hasList = computed(() => options.value.length > 0);

/** Both stored shapes — a bare template string, or the full object — read the same. */
const current = computed(() => {
  const value = props.mapping;
  if (value && typeof value === 'object') {
    return {
      source: value.source ?? 'template',
      template: value.template ?? '',
      fallback: value.fallback ?? '',
      matchField: value.matchField ?? '',
      rules: Array.isArray(value.rules) ? value.rules : [],
    };
  }
  const template = value ?? '';
  // A stored string that matches a list entry was chosen from the dropdown.
  const source = hasList.value && options.value.some((o) => String(o.id) === String(template)) ? 'value' : 'template';
  return {
    source: template ? source : hasList.value ? 'value' : 'template',
    template,
    fallback: '',
    matchField: '',
    rules: [],
  };
});

function update(patch) {
  const next = { ...current.value, ...patch };
  if (next.source === 'field_match') {
    // Unlike the other sources, an in-progress field_match (source chosen,
    // matchField not yet picked) is kept rather than collapsed to null --
    // nulling it the instant it's empty would snap the selector straight back
    // to "Read it from the message" before the user gets to pick a field to
    // match on. A mapping left incomplete is caught at save time instead (see
    // inboundRules.controller.js), the same way an incomplete approval
    // recipient already is.
    emit('update:mapping', {
      source: 'field_match',
      matchField: next.matchField,
      rules: next.rules,
      fallback: next.fallback,
    });
    return;
  }
  // Nothing chosen anywhere is no mapping at all, not an empty one.
  const empty = next.source !== 'sender_contact' && !String(next.template).trim() && !String(next.fallback).trim();
  emit('update:mapping', empty ? null : { source: next.source, template: next.template, fallback: next.fallback });
}

const sourceLabel = computed(
  () =>
    ({
      value: 'the same value every time',
      template: 'the message',
      sender_contact: "the sender's contact",
      field_match: `another field's value`,
    })[current.value.source]
);

/** Every other field on this type — what a field_match mapping can route by. */
const matchFieldOptions = computed(() => props.schemaFields.filter((f) => f.key !== props.field.key));
const matchFieldDef = computed(() => matchFieldOptions.value.find((f) => f.key === current.value.matchField) ?? null);

/** Picker options for a field's own value — this field's list, or (for a User field with none) the OpenProject user list. */
function valueOptionsFor(field) {
  if (!field) return null;
  if (Array.isArray(field.allowedValues) && field.allowedValues.length) {
    // Keep depth/parentId so a hierarchy field draws as its tree.
    return field.allowedValues.map((o) => ({ ...o, id: String(o.id) }));
  }
  if (field.type === 'User') return props.users.map((u) => ({ id: String(u.id), label: u.name }));
  return null;
}

/** What this mapping's own field can be set to — this field, not the one matched on. */
const targetOptions = computed(() => valueOptionsFor(props.field));
/** What the matched field's rule rows can be ticked from. */
const matchValueOptions = computed(() => valueOptionsFor(matchFieldDef.value));

function setMatchField(key) {
  // A field's option ids mean nothing against a different field's list, so
  // rules built against the old match field are cleared rather than kept
  // silently stale.
  update({ matchField: key, rules: [] });
}

function addRule() {
  update({ rules: [...current.value.rules, { values: [], value: '' }] });
}
function removeRule(index) {
  update({ rules: current.value.rules.filter((_, i) => i !== index) });
}
function setRuleValue(index, value) {
  update({ rules: current.value.rules.map((r, i) => (i === index ? { ...r, value } : r)) });
}
function toggleRuleOption(index, optionId) {
  const rule = current.value.rules[index];
  const values = rule.values.includes(optionId)
    ? rule.values.filter((v) => v !== optionId)
    : [...rule.values, optionId];
  update({ rules: current.value.rules.map((r, i) => (i === index ? { ...r, values } : r)) });
}
function setRuleValuesText(index, text) {
  const values = text
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  update({ rules: current.value.rules.map((r, i) => (i === index ? { ...r, values } : r)) });
}
</script>

<template>
  <div class="field">
    <label>
      {{ field.name }}
      <span v-if="required" class="required">required</span>
    </label>

    <select :value="current.source" @change="update({ source: $event.target.value, template: '' })" style="width: 100%">
      <option v-if="hasList" value="value">Pick one value for every ticket</option>
      <option value="template">Read it from the message</option>
      <option value="sender_contact">Read it from the sender's contact</option>
      <option value="field_match">Choose by another field's value</option>
    </select>

    <!-- Pick one entry, or a field with no list at all: the old behaviour. -->
    <TreeSelect
      v-if="hasList && current.source === 'value'"
      class="spaced"
      :model-value="current.template"
      :options="options"
      empty-label="Select…"
      @update:model-value="update({ template: $event })"
    />

    <input
      v-else-if="current.source === 'template'"
      class="mono"
      style="width: 100%"
      :value="current.template"
      @input="update({ template: $event.target.value })"
      :placeholder="hasList ? '{form}' : field.type === 'String' ? '{rest}' : field.type"
    />

    <p v-else-if="current.source === 'sender_contact'" class="hint">
      Whatever a human recorded for this field against the sender, under
      <strong>Contacts → Needs classification</strong>. A sender nobody has classified yet is added there
      automatically, and this ticket uses the fallback below in the meantime.
    </p>

    <div v-else-if="current.source === 'field_match'" class="match">
      <label class="sub">Match on</label>
      <select :value="current.matchField" @change="setMatchField($event.target.value)" style="width: 100%">
        <option value="">Select a field…</option>
        <option v-for="f in matchFieldOptions" :key="f.key" :value="f.key">{{ f.name }}</option>
      </select>

      <template v-if="current.matchField">
        <div v-for="(rule, index) in current.rules" :key="index" class="rule-row">
          <div class="rule-values">
            <template v-if="matchValueOptions">
              <label v-for="opt in matchValueOptions" :key="opt.id" class="option-choice">
                <input
                  type="checkbox"
                  style="width: auto"
                  :checked="rule.values.includes(opt.id)"
                  @change="toggleRuleOption(index, opt.id)"
                />
                {{ opt.label }}
              </label>
            </template>
            <input
              v-else
              class="mono"
              style="width: 100%"
              :value="rule.values.join(', ')"
              @input="setRuleValuesText(index, $event.target.value)"
              :placeholder="`${matchFieldDef?.name ?? 'value'}, comma separated`"
            />
          </div>
          <span class="arrow">→</span>
          <TreeSelect
            v-if="targetOptions"
            class="rule-target"
            :model-value="rule.value"
            :options="targetOptions"
            empty-label="Select…"
            @update:model-value="setRuleValue(index, $event)"
          />
          <input
            v-else
            class="mono"
            style="width: 160px"
            :value="rule.value"
            @input="setRuleValue(index, $event.target.value)"
            :placeholder="field.name"
          />
          <button type="button" class="btn danger small" @click="removeRule(index)">Remove</button>
        </div>
        <button type="button" class="btn secondary small" @click="addRule">+ Add rule</button>
        <p class="hint">
          First matching rule wins. A message whose {{ matchFieldDef?.name ?? 'matched field' }} does not tick any
          box above uses the "otherwise" value below.
        </p>
      </template>
      <p v-else class="hint">Pick which field's value decides this one.</p>
    </div>

    <template v-if="hasList">
      <label class="sub">{{ current.source === 'field_match' ? 'Otherwise (no rule above matched)' : 'If that does not match a value in the list' }}</label>
      <TreeSelect
        :model-value="current.fallback"
        :options="options"
        :empty-label="current.source === 'field_match' ? 'Leave unset' : 'Fail, and say which field was wrong'"
        @update:model-value="update({ fallback: $event })"
      />
      <p v-if="current.fallback" class="hint">
        What was actually asked for is appended to the ticket description, so the fallback does not hide it.
      </p>
    </template>
    <template v-else-if="current.source === 'field_match'">
      <label class="sub">Otherwise (no rule above matched)</label>
      <TreeSelect
        v-if="targetOptions"
        :model-value="current.fallback"
        :options="targetOptions"
        empty-label="Leave unset"
        @update:model-value="update({ fallback: $event })"
      />
      <input
        v-else
        class="mono"
        style="width: 100%"
        :value="current.fallback"
        @input="update({ fallback: $event.target.value })"
        :placeholder="`Default ${field.name}, or leave blank to leave it unset`"
      />
    </template>

    <p class="hint">
      <code>{{ field.key }}</code> · {{ field.type }} · from {{ sourceLabel }}<span
        v-if="!hasList && current.source === 'template'"
      >
        &mdash; may use template variables like <code>{1}</code> or <code>{rest}</code></span
      >
    </p>
  </div>
</template>

<style scoped>
.sub {
  display: block;
  margin-top: 0.5rem;
  font-size: 0.85em;
  color: var(--text-muted);
}
.required {
  color: var(--danger);
  font-size: 0.8em;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.match {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.6rem;
  margin-top: 0.35rem;
  background: var(--surface);
}
.rule-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
  flex-wrap: wrap;
}
.rule-values {
  flex: 1;
  min-width: 180px;
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem 0.6rem;
}
.option-choice {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-weight: normal;
  font-size: 0.85rem;
  white-space: nowrap;
}
.arrow {
  color: var(--text-muted);
}
.spaced {
  margin-top: 0.35rem;
}
.rule-target {
  width: 240px;
  max-width: 100%;
}
.btn.small {
  font-size: 0.75rem;
  padding: 0.2rem 0.5rem;
}
</style>
