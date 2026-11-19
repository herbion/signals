<script setup>
import { computed, ref } from 'vue';

const props = defineProps({
  // { actionRecipientMode, actionRecipientContactId, actionRecipientRaw,
  //   actionRecipientDynamicRelation, messageTemplate, commentTemplate,
  //   allowedContactIds }
  modelValue: { type: Object, required: true },
  contacts: { type: Array, default: () => [] },
  // openproject_settings.metadata_cache -- its customFields list is often
  // empty (/api/v3/custom_fields 404s on some versions), so the custom field
  // key can always be typed by hand as well.
  metadata: { type: Object, default: null },
});
const emit = defineEmits(['update:modelValue']);

const VARIABLES = [
  'id', 'subject', 'type', 'status', 'status_from', 'project', 'assignee', 'author', 'priority', 'url',
  'recipient_name',
];

const CUSTOM_FIELD_KEY = /^customField\d+$/;

// The relation select shows 'customField' for any customFieldNN key; the key
// itself is edited in the box next to it.
const relationKind = computed(() => {
  const relation = props.modelValue.actionRecipientDynamicRelation ?? 'author';
  return CUSTOM_FIELD_KEY.test(relation) || relation === 'customField' ? 'customField' : relation;
});
const customFieldKey = computed(() => {
  const relation = props.modelValue.actionRecipientDynamicRelation ?? '';
  return CUSTOM_FIELD_KEY.test(relation) ? relation : '';
});
const customFieldOptions = computed(() =>
  (props.metadata?.customFields ?? []).map((cf) => ({ key: `customField${cf.id}`, name: cf.name }))
);

function onRelationChange(event) {
  const kind = event.target.value;
  // A bare 'customField' is not a valid relation, so saving is refused until
  // a key is filled in -- a rule pointed at no field would match nobody.
  update({ actionRecipientDynamicRelation: kind === 'customField' ? customFieldKey.value || 'customField' : kind });
}

function onCustomFieldKeyInput(value) {
  const key = String(value ?? '').trim();
  update({ actionRecipientDynamicRelation: key || 'customField' });
}

// "Only these contacts" -- a testing limit. Individuals only: a group is
// never what a person-resolving rule resolves to.
const allowedIds = computed(() => props.modelValue.allowedContactIds ?? []);
const allowFilter = ref('');
const people = computed(() => props.contacts.filter((c) => c.type !== 'group'));
const visiblePeople = computed(() => {
  const q = allowFilter.value.trim().toLowerCase();
  return people.value.filter(
    (c) => allowedIds.value.includes(c.id) || !q || `${c.name} ${c.signal_identifier}`.toLowerCase().includes(q)
  );
});

function toggleAllowed(id, checked) {
  const next = new Set(allowedIds.value);
  if (checked) next.add(id);
  else next.delete(id);
  update({ allowedContactIds: [...next] });
}

function insertCommentVariable(name) {
  update({ commentTemplate: `${props.modelValue.commentTemplate ?? ''}${varLabel(name)}` });
}

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
      <select :value="relationKind" @change="onRelationChange">
        <option value="author">Author (who created the work package)</option>
        <option value="assignee">Assignee</option>
        <option value="customField">A person named in a custom field (e.g. 🎯На кого)</option>
      </select>
      <template v-if="relationKind === 'customField'">
        <div class="cf-row">
          <select
            v-if="customFieldOptions.length"
            :value="customFieldKey"
            @change="onCustomFieldKeyInput($event.target.value)"
          >
            <option value="" disabled>Choose a custom field&hellip;</option>
            <option v-for="cf in customFieldOptions" :key="cf.key" :value="cf.key">{{ cf.name }} ({{ cf.key }})</option>
          </select>
          <input placeholder="customField21" :value="customFieldKey" @input="onCustomFieldKeyInput($event.target.value)" />
        </div>
        <p class="hint">
          The field's value (a ПІБ such as &ldquo;Іванов Іван Іванович&rdquo;) is matched against
          <strong>contact names</strong>: every word of a contact's name must appear in it, in any order, ranks ignored.
          A one-word contact name never matches, and two matching contacts is an error rather than a guess &mdash;
          either way the message is logged as failed with the reason. A user-typed field is matched to the synced
          OpenProject user instead.
        </p>
      </template>
      <p v-else class="hint">
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
      <label>Only send to these contacts (optional, for testing)</label>
      <input v-model="allowFilter" placeholder="Filter contacts&hellip;" style="width: 100%" />
      <div class="allow-list">
        <label v-for="c in visiblePeople" :key="c.id" class="allow-item">
          <input
            type="checkbox"
            style="width: auto"
            :checked="allowedIds.includes(c.id)"
            @change="toggleAllowed(c.id, $event.target.checked)"
          />
          {{ c.name }} <span class="muted-id">{{ c.signal_identifier }}</span>
        </label>
        <p v-if="!visiblePeople.length" class="hint">No contacts match.</p>
      </div>
      <p class="hint">
        <template v-if="allowedIds.length">
          Limited to <strong>{{ allowedIds.length }}</strong> contact(s). Anyone else the rule resolves to is logged as
          suppressed (status <em>muted</em>, with the reason) and gets no message and no comment.
          <button type="button" class="link-btn" @click="update({ allowedContactIds: [] })">Clear limit</button>
        </template>
        <template v-else>Nothing ticked: the rule may message anyone it resolves to.</template>
      </p>
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
        Custom fields are available as <code>{customField21}</code> and so on; <code>{recipient_name}</code> is the
        contact the message goes to.
      </p>
    </div>

    <div class="field">
      <label>Comment on the work package (optional)</label>
      <div class="var-buttons">
        <button v-for="v in VARIABLES" :key="v" type="button" class="var-btn" @click="insertCommentVariable(v)">{{ varLabel(v) }}</button>
      </div>
      <textarea
        rows="2"
        style="width: 100%"
        placeholder="e.g. Повідомлено в Signal: {recipient_name}"
        :value="modelValue.commentTemplate"
        @input="update({ commentTemplate: $event.target.value })"
      ></textarea>
      <p class="hint">
        Posted to the work package's activity once the Signal message has been sent (or queued, with grouping on).
        Leave blank for no comment. The OpenProject API user needs the &ldquo;Add notes&rdquo; permission.
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
.allow-list {
  max-height: 11rem; overflow-y: auto; border: 1px solid var(--border); border-radius: 4px;
  padding: 0.3rem 0.5rem; margin-top: 0.4rem; background: var(--surface);
}
.allow-item { display: flex; align-items: center; gap: 0.4rem; font-weight: normal; margin: 0.15rem 0; }
.muted-id { color: var(--text-muted); font-size: 0.75rem; font-family: monospace; }
.link-btn {
  background: none; border: none; padding: 0; color: var(--primary); text-decoration: underline;
  cursor: pointer; font-size: inherit;
}
.cf-row { display: flex; gap: 0.4rem; margin-top: 0.4rem; }
.cf-row > * { flex: 1; }
.hint { color: var(--text-muted); font-size: 0.8rem; margin: 0.4rem 0 0; }
</style>
