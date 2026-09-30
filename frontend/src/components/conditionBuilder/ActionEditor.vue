<script setup>
const props = defineProps({
  // { actionRecipientMode, actionRecipientContactId, actionRecipientRaw,
  //   actionRecipientDynamicRelation, messageTemplate }
  modelValue: { type: Object, required: true },
  contacts: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:modelValue']);

const VARIABLES = ['id', 'subject', 'type', 'status', 'status_from', 'project', 'assignee', 'author', 'priority', 'url'];

function update(patch) {
  emit('update:modelValue', { ...props.modelValue, ...patch });
}

function onModeChange(event) {
  const mode = event.target.value;
  update({
    actionRecipientMode: mode,
    actionRecipientDynamicRelation:
      mode === 'dynamic' ? props.modelValue.actionRecipientDynamicRelation || 'author' : null,
  });
}

function varLabel(name) {
  return `{${name}}`;
}

function insertVariable(name) {
  update({ messageTemplate: `${props.modelValue.messageTemplate ?? ''}${varLabel(name)}` });
}

// Signal's inline markup, rendered only when Settings -> Signal ->
// "Message formatting" is set to Styled.
const FORMATS = [
  { label: 'Bold', markup: '**', sample: 'bold' },
  { label: 'Italic', markup: '*', sample: 'italic' },
  { label: 'Strikethrough', markup: '~', sample: 'struck' },
  { label: 'Spoiler', markup: '||', sample: 'spoiler' },
  { label: 'Monospace', markup: '`', sample: 'code' },
];

function insertFormat({ markup, sample }) {
  update({ messageTemplate: `${props.modelValue.messageTemplate ?? ''}${markup}${sample}${markup}` });
}
</script>

<template>
  <div>
    <div class="field">
      <label>Send to</label>
      <select :value="modelValue.actionRecipientMode ?? 'contact'" @change="onModeChange">
        <option value="dynamic">The person involved in the work package</option>
        <option value="contact">A specific contact</option>
        <option value="raw">A raw number / group id</option>
      </select>
    </div>

    <div v-if="(modelValue.actionRecipientMode ?? 'contact') === 'dynamic'" class="field">
      <select
        :value="modelValue.actionRecipientDynamicRelation ?? 'author'"
        @change="update({ actionRecipientDynamicRelation: $event.target.value })"
      >
        <option value="author">Author (who created the work package)</option>
        <option value="assignee">Assignee</option>
      </select>
      <p class="hint">
        Resolved at send time by matching that OpenProject user to a contact. Run
        <strong>Contacts &rarr; Sync from OpenProject</strong> first so users have contacts with phone numbers;
        if a match is missing, the message is logged as failed with the reason.
      </p>
    </div>

    <div v-else-if="modelValue.actionRecipientMode === 'raw'" class="field">
      <input
        style="width: 100%"
        placeholder="+15551234567 or Signal group id"
        :value="modelValue.actionRecipientRaw"
        @input="update({ actionRecipientRaw: $event.target.value })"
      />
    </div>

    <div v-else class="field">
      <select
        :value="modelValue.actionRecipientContactId ?? ''"
        @change="update({ actionRecipientContactId: $event.target.value ? Number($event.target.value) : null })"
      >
        <option value="" disabled>Choose a contact&hellip;</option>
        <option v-for="c in contacts" :key="c.id" :value="c.id">{{ c.name }} ({{ c.type }})</option>
      </select>
    </div>

    <div class="field">
      <label>Message template</label>
      <div class="var-buttons">
        <button v-for="v in VARIABLES" :key="v" type="button" class="var-btn" @click="insertVariable(v)">{{ varLabel(v) }}</button>
      </div>
      <div class="var-buttons">
        <button
          v-for="f in FORMATS"
          :key="f.label"
          type="button"
          class="var-btn fmt-btn"
          :title="`${f.label}: ${f.markup}text${f.markup}`"
          @click="insertFormat(f)"
        >
          {{ f.label }}
        </button>
      </div>
      <textarea
        rows="3"
        style="width: 100%"
        placeholder='e.g. **{type} #{id}** "{subject}" was closed&#10;{url}'
        :value="modelValue.messageTemplate"
        @input="update({ messageTemplate: $event.target.value })"
      ></textarea>
      <p class="hint">
        <code>{url}</code> is a direct link to the work package in OpenProject. Formatting markup only renders if
        Settings &rarr; Signal &rarr; <strong>Message formatting</strong> is set to Styled.
      </p>
    </div>
  </div>
</template>

<style scoped>
.var-buttons { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-bottom: 0.4rem; }
.var-btn {
  background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; font-size: 0.75rem;
  padding: 0.15rem 0.4rem; cursor: pointer; font-family: monospace;
}
.var-btn:hover { background: var(--border); }
.fmt-btn { font-family: inherit; }
code { background: var(--surface-2); padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.75rem; }
.hint { color: var(--text-muted); font-size: 0.8rem; margin: 0.4rem 0 0; }
</style>
