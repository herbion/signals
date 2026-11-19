<script setup>
import { ref, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useRulesStore, ruleToPayload } from '../stores/rules.js';
import { useContactsStore } from '../stores/contacts.js';
import { api } from '../api/client.js';
import ConditionGroupEditor from '../components/conditionBuilder/ConditionGroupEditor.vue';
import ActionEditor from '../components/conditionBuilder/ActionEditor.vue';

const props = defineProps({ id: { type: [String, Number], default: null } });
const router = useRouter();
const rulesStore = useRulesStore();
const contactsStore = useContactsStore();

const isNew = computed(() => !props.id);
const error = ref('');
const saving = ref(false);
const metadata = ref(null);

const form = ref({
  name: '',
  enabled: true,
  project_scope: '',
  conditionTree: { type: 'group', operator: 'AND', children: [] },
  action_recipient_mode: 'dynamic',
  action_recipient_contact_id: null,
  action_recipient_raw: '',
  action_recipient_dynamic_relation: 'author',
  message_template: '',
  comment_template: '',
  allowed_contact_ids: [],
  priority: 0,
});

// ActionEditor speaks camelCase; form state mirrors the snake_case shape the
// API returns for an existing rule, so bridge the two directions here.
const actionModel = computed({
  get: () => ({
    actionRecipientMode: form.value.action_recipient_mode,
    actionRecipientContactId: form.value.action_recipient_contact_id,
    actionRecipientRaw: form.value.action_recipient_raw,
    actionRecipientDynamicRelation: form.value.action_recipient_dynamic_relation,
    messageTemplate: form.value.message_template,
    commentTemplate: form.value.comment_template,
    allowedContactIds: form.value.allowed_contact_ids ?? [],
  }),
  set: (v) => {
    form.value.action_recipient_mode = v.actionRecipientMode;
    form.value.action_recipient_contact_id = v.actionRecipientContactId;
    form.value.action_recipient_raw = v.actionRecipientRaw;
    form.value.action_recipient_dynamic_relation = v.actionRecipientDynamicRelation;
    form.value.message_template = v.messageTemplate;
    form.value.comment_template = v.commentTemplate;
    form.value.allowed_contact_ids = v.allowedContactIds ?? [];
  },
});

onMounted(async () => {
  contactsStore.fetchAll();
  try {
    const settings = await api.get('/settings/openproject');
    metadata.value = settings.metadataCache;
  } catch {
    metadata.value = null;
  }

  if (!isNew.value) {
    const rule = await rulesStore.fetchOne(props.id);
    form.value = { ...rule };
  }
});

async function save() {
  error.value = '';
  saving.value = true;
  try {
    const payload = ruleToPayload(form.value);
    if (isNew.value) {
      await rulesStore.create(payload);
    } else {
      await rulesStore.update(props.id, payload);
    }
    router.push({ name: 'rules' });
  } catch (err) {
    error.value = err.message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div>
    <h1>{{ isNew ? 'New Rule' : 'Edit Rule' }}</h1>
    <div v-if="error" class="error-banner">{{ error }}</div>

    <div class="card" style="margin-bottom: 1rem">
      <div class="field">
        <label>Name</label>
        <input v-model="form.name" placeholder="e.g. Notify on Телеграма closed" style="width: 100%" />
      </div>
      <div class="field">
        <label>Project scope (optional &mdash; id or identifier, blank = any project)</label>
        <input v-model="form.project_scope" style="width: 100%" />
      </div>
      <div class="field">
        <label><input type="checkbox" v-model="form.enabled" style="width: auto" /> Enabled</label>
      </div>
    </div>

    <div class="card" style="margin-bottom: 1rem">
      <label style="margin-bottom: 0.5rem">Conditions</label>
      <ConditionGroupEditor v-model="form.conditionTree" :metadata="metadata" root />
    </div>

    <div class="card" style="margin-bottom: 1rem">
      <label style="margin-bottom: 0.5rem">Action</label>
      <ActionEditor v-model="actionModel" :contacts="contactsStore.contacts" :metadata="metadata" />
    </div>

    <div class="actions">
      <button class="btn" :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save Rule' }}</button>
      <button class="btn secondary" @click="router.push({ name: 'rules' })">Cancel</button>
    </div>
  </div>
</template>

<style scoped>
h1 { margin-bottom: 1rem; }
.actions { display: flex; gap: 0.5rem; }
</style>
