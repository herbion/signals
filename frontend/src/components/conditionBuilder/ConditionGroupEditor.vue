<script setup>
import ConditionRow from './ConditionRow.vue';

const props = defineProps({
  modelValue: { type: Object, required: true }, // ConditionGroup
  metadata: { type: Object, default: null },
  root: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'remove']);

function update(patch) {
  emit('update:modelValue', { ...props.modelValue, ...patch });
}

function updateChild(index, value) {
  const children = [...props.modelValue.children];
  children[index] = value;
  update({ children });
}

function removeChild(index) {
  const children = props.modelValue.children.filter((_, i) => i !== index);
  update({ children });
}

function addCondition() {
  update({
    children: [...props.modelValue.children, { type: 'condition', field: 'status', operator: 'changed_to', value: '' }],
  });
}

function addGroup() {
  update({ children: [...props.modelValue.children, { type: 'group', operator: 'AND', children: [] }] });
}
</script>

<template>
  <div class="group" :class="{ nested: !root }">
    <div class="group-header">
      <select :value="modelValue.operator" @change="update({ operator: $event.target.value })">
        <option value="AND">Match ALL of the following (AND)</option>
        <option value="OR">Match ANY of the following (OR)</option>
      </select>
      <button v-if="!root" class="link-remove" type="button" title="Remove group" @click="$emit('remove')">&times; remove group</button>
    </div>

    <div class="children">
      <div v-for="(child, i) in modelValue.children" :key="i" class="child">
        <ConditionGroupEditor
          v-if="child.type === 'group'"
          :model-value="child"
          :metadata="metadata"
          @update:model-value="(v) => updateChild(i, v)"
          @remove="removeChild(i)"
        />
        <ConditionRow
          v-else
          :model-value="child"
          :metadata="metadata"
          @update:model-value="(v) => updateChild(i, v)"
          @remove="removeChild(i)"
        />
      </div>
      <p v-if="modelValue.children.length === 0" class="empty-hint">
        No conditions yet ({{ modelValue.operator === 'AND' ? 'always matches' : 'never matches' }}).
      </p>
    </div>

    <div class="group-actions">
      <button class="btn secondary small" type="button" @click="addCondition">+ Condition</button>
      <button class="btn secondary small" type="button" @click="addGroup">+ Nested group</button>
    </div>

    <p v-if="root" class="trigger-hint">
      Rules notify once, when the work package <em>starts</em> matching &mdash; not on every later edit. So
      <code>is</code> conditions act as filters (&ldquo;only Телеграма tickets&rdquo;) and won't re-send when someone
      adds an attachment; use <code>changed to</code> or <code>Event: created</code> to be explicit about the moment
      you want.
    </p>
  </div>
</template>

<style scoped>
.group { border: 1px solid var(--border); border-radius: 6px; padding: 0.75rem; background: var(--surface-2); }
.group.nested { margin: 0.5rem 0; background: var(--bg); }
.group-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem; }
.children { margin-left: 0.5rem; }
.empty-hint { color: var(--text-faint); font-size: 0.85rem; margin: 0.25rem 0; }
.group-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
.btn.small { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
.link-remove { background: none; border: none; color: var(--danger); cursor: pointer; font-size: 0.8rem; }
.trigger-hint { color: var(--text-muted); font-size: 0.8rem; margin: 0.75rem 0 0; line-height: 1.45; }
.trigger-hint code { background: var(--surface-2); padding: 0.05rem 0.25rem; border-radius: 3px; }
</style>
