<script setup>
import { computed } from 'vue';

const props = defineProps({
  modelValue: { type: Object, required: true },
  metadata: { type: Object, default: null },
});
const emit = defineEmits(['update:modelValue', 'remove']);

const BUILTIN_FIELDS = [
  { value: 'subject', label: 'Subject', kind: 'text' },
  { value: 'type', label: 'Type', kind: 'relation', metadataKey: 'types' },
  { value: 'status', label: 'Status', kind: 'relation', metadataKey: 'statuses' },
  { value: 'project', label: 'Project', kind: 'relation', metadataKey: 'projects' },
  { value: 'assignee', label: 'Assignee', kind: 'text' },
  { value: 'author', label: 'Author', kind: 'text' },
  { value: 'priority', label: 'Priority', kind: 'text' },
];
const EVENT_CREATED = '__event_created__';

const OPERATORS = [
  { value: 'equals', label: 'is' },
  { value: 'not_equals', label: 'is not' },
  { value: 'any_change', label: 'changed (any value)' },
  { value: 'changed_to', label: 'changed to' },
  { value: 'changed_from', label: 'changed from' },
  { value: 'changed_from_to', label: 'changed from … to …' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'is not empty' },
];

const customFieldOptions = computed(() =>
  (props.metadata?.customFields ?? []).map((cf) => ({
    value: `customField:customField${cf.id}`,
    label: cf.name,
    kind: 'text',
  }))
);
const allFields = computed(() => [...BUILTIN_FIELDS, ...customFieldOptions.value]);

const selectedFieldKey = computed(() =>
  props.modelValue.operator === 'event_type_created' ? EVENT_CREATED : props.modelValue.field
);
const isEventField = computed(() => selectedFieldKey.value === EVENT_CREATED);
const selectedFieldDef = computed(() => allFields.value.find((f) => f.value === props.modelValue.field));
// null (not []) whenever there's nothing to populate a dropdown with, so the
// template correctly falls back to a free-text input instead of rendering an
// unusable empty <select> (e.g. before OpenProject metadata has been fetched).
const metadataOptions = computed(() => {
  const key = selectedFieldDef.value?.metadataKey;
  if (!key || !props.metadata) return null;
  return props.metadata[key]?.length ? props.metadata[key] : null;
});

function update(patch) {
  emit('update:modelValue', { ...props.modelValue, ...patch });
}

function onFieldChange(event) {
  const newKey = event.target.value;
  if (newKey === EVENT_CREATED) {
    emit('update:modelValue', { type: 'condition', operator: 'event_type_created' });
    return;
  }
  const operator = props.modelValue.operator && props.modelValue.operator !== 'event_type_created'
    ? props.modelValue.operator
    : 'equals';
  emit('update:modelValue', { type: 'condition', field: newKey, operator, value: props.modelValue.value ?? '' });
}
</script>

<template>
  <div class="row">
    <select :value="selectedFieldKey" @change="onFieldChange">
      <option :value="EVENT_CREATED">Event: work package created</option>
      <optgroup label="Fields">
        <option v-for="f in allFields" :key="f.value" :value="f.value">{{ f.label }}</option>
      </optgroup>
    </select>

    <template v-if="!isEventField">
      <select :value="modelValue.operator" @change="update({ operator: $event.target.value })">
        <option v-for="op in OPERATORS" :key="op.value" :value="op.value">{{ op.label }}</option>
      </select>

      <template v-if="modelValue.operator === 'changed_from_to'">
        <select v-if="metadataOptions" :value="modelValue.fromValue" @change="update({ fromValue: $event.target.value })">
          <option value="" disabled>from&hellip;</option>
          <option v-for="opt in metadataOptions" :key="opt.id" :value="opt.id">{{ opt.name }}</option>
        </select>
        <input v-else placeholder="from" :value="modelValue.fromValue" @input="update({ fromValue: $event.target.value })" />
      </template>

      <template v-if="!['is_empty', 'is_not_empty', 'any_change'].includes(modelValue.operator)">
        <select v-if="metadataOptions" :value="modelValue.value" @change="update({ value: $event.target.value })">
          <option value="" disabled>value&hellip;</option>
          <option v-for="opt in metadataOptions" :key="opt.id" :value="opt.id">{{ opt.name }}</option>
        </select>
        <input v-else placeholder="value" :value="modelValue.value" @input="update({ value: $event.target.value })" />
      </template>
    </template>

    <button class="link-remove" type="button" title="Remove condition" @click="$emit('remove')">&times;</button>
  </div>
</template>

<style scoped>
.row { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; flex-wrap: wrap; }
.link-remove { background: none; border: none; color: var(--danger); font-size: 1.1rem; cursor: pointer; line-height: 1; padding: 0 0.3rem; }
</style>
