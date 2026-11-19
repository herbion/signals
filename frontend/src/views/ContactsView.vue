<script setup>
import { onMounted, ref, computed } from 'vue';
import { useContactsStore } from '../stores/contacts.js';
import { useInboundRulesStore } from '../stores/inboundRules.js';
import { useSettingsStore } from '../stores/settings.js';
import TreeSelect from '../components/TreeSelect.vue';
import { optionPathLabel } from '../utils/optionTree.js';

const store = useContactsStore();
const inboundRules = useInboundRulesStore();
const settings = useSettingsStore();

const tab = ref('all');
// The OpenProject fields somebody has to answer per contact, and their options.
const slots = ref([]);
const slotsError = ref('');
const classifying = ref(null);

onMounted(() => {
  store.fetchAll();
  loadSlots();
});

// Two different origins share this table: a contact sync run finds someone by
// phone number and stamps openproject_user_id; anyone else got here through
// Signal (auto-created from a message, or added by hand) and has no such id.
const openProjectContacts = computed(() => store.contacts.filter((c) => c.openproject_user_id));
const signalContacts = computed(() => store.contacts.filter((c) => !c.openproject_user_id));

const visible = computed(() => {
  if (tab.value === 'unclassified') return store.needingClassification;
  if (tab.value === 'openproject') return openProjectContacts.value;
  if (tab.value === 'signal') return signalContacts.value;
  return store.contacts;
});

/**
 * A Signal-origin contact has no openproject_user_id, so the only "which
 * OpenProject person is this" answer on file is whatever a human classified
 * them as -- resolve each field_values entry to the option label the classify
 * dialog showed, using the same slots list it uses.
 */
function mappedLabel(contact) {
  const values = contact.field_values || {};
  return Object.entries(values)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(([key, v]) => {
      const slot = slots.value.find((s) => s.key === key);
      const label = optionPathLabel(slot?.allowedValues, v) ?? v;
      return slot ? `${slot.name}: ${label}` : label;
    })
    .join(', ');
}

/**
 * Which fields need an answer per contact: exactly the ones an inbound rule
 * points at "the sender's contact". Each of those lives on some project and
 * type, and that type's schema is what supplies the entries to choose from --
 * so there is nothing to fill in here that no rule actually asks for.
 */
async function loadSlots() {
  slotsError.value = '';
  try {
    await Promise.all([inboundRules.fetchAll(), settings.fetchSignal()]);
    const defaultProject = settings.signal?.default_project_id ?? '';
    const defaultType = settings.signal?.default_type_id ?? '';

    const wanted = new Map();
    for (const rule of inboundRules.rules) {
      for (const action of rule.actions ?? []) {
        if (action.action_type !== 'create_ticket') continue;
        const keys = Object.entries(action.field_templates ?? {})
          .filter(([, entry]) => entry && typeof entry === 'object' && entry.source === 'sender_contact')
          .map(([key]) => key);
        if (!keys.length) continue;

        const projectId = action.project_id || defaultProject;
        const typeId = action.type_id || defaultType;
        if (!projectId || !typeId) continue;

        const pair = `${projectId}-${typeId}`;
        if (!wanted.has(pair)) wanted.set(pair, { projectId, typeId, keys: new Set() });
        for (const key of keys) wanted.get(pair).keys.add(key);
      }
    }

    const found = [];
    for (const { projectId, typeId, keys } of wanted.values()) {
      const schema = await settings.openprojectSchema({ projectId, typeId });
      for (const field of schema.fields ?? []) {
        if (keys.has(field.key) && !found.some((existing) => existing.key === field.key)) found.push(field);
      }
    }
    slots.value = found;
  } catch (err) {
    slotsError.value = err.message;
  }
}

function startClassify(contact) {
  classifying.value = { id: contact.id, name: contact.name, values: { ...(contact.field_values ?? {}) } };
}

async function saveClassification() {
  error.value = '';
  try {
    await store.setFieldValues(classifying.value.id, classifying.value.values);
    classifying.value = null;
  } catch (err) {
    error.value = err.message;
  }
}

const editing = ref(null); // contact being edited, or a blank object for "new"
const error = ref('');
const syncStatus = ref('');
const syncing = ref(false);

async function sync() {
  error.value = '';
  syncStatus.value = '';
  syncing.value = true;
  try {
    const r = await store.syncFromOpenProject();
    syncStatus.value = `Synced: ${r.created} created, ${r.updated} updated, ${r.skipped} skipped (no phone number).`;
  } catch (err) {
    error.value = err.message;
  } finally {
    syncing.value = false;
  }
}

function startNew() {
  editing.value = { name: '', type: 'individual', signalIdentifier: '', notes: '', muted: false };
}
function startEdit(contact) {
  editing.value = {
    id: contact.id,
    name: contact.name,
    type: contact.type,
    signalIdentifier: contact.signal_identifier,
    notes: contact.notes ?? '',
    muted: Boolean(contact.muted),
  };
}

async function toggleMute(contact) {
  error.value = '';
  try {
    await store.setMuted(contact.id, !contact.muted);
  } catch (err) {
    error.value = err.message;
  }
}
function cancelEdit() {
  editing.value = null;
  error.value = '';
}

async function save() {
  error.value = '';
  try {
    if (editing.value.id) {
      await store.update(editing.value.id, editing.value);
    } else {
      await store.create(editing.value);
    }
    editing.value = null;
  } catch (err) {
    error.value = err.message;
  }
}

async function remove(contact) {
  if (!confirm(`Delete contact "${contact.name}"?`)) return;
  await store.remove(contact.id);
}
</script>

<template>
  <div>
    <div class="header-row">
      <h1>Contacts</h1>
      <div style="display: flex; gap: 0.5rem">
        <button class="btn secondary" :disabled="syncing" @click="sync">
          {{ syncing ? 'Syncing…' : 'Sync from OpenProject' }}
        </button>
        <button class="btn" @click="startNew">New Contact</button>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <p v-if="syncStatus" class="hint">{{ syncStatus }}</p>

    <div class="tabs">
      <button class="tab" :class="{ active: tab === 'all' }" @click="tab = 'all'">
        All contacts ({{ store.contacts.length }})
      </button>
      <button class="tab" :class="{ active: tab === 'openproject' }" @click="tab = 'openproject'">
        OpenProject ({{ openProjectContacts.length }})
      </button>
      <button class="tab" :class="{ active: tab === 'signal' }" @click="tab = 'signal'">
        Signal ({{ signalContacts.length }})
      </button>
      <button class="tab" :class="{ active: tab === 'unclassified' }" @click="tab = 'unclassified'">
        Needs classification ({{ store.needingClassification.length }})
      </button>
    </div>

    <p v-if="tab === 'openproject'" class="hint">
      Synced from OpenProject users by matching phone number &mdash; re-running the sync updates these rather than
      duplicating them.
    </p>
    <p v-if="tab === 'signal'" class="hint">
      Known only through Signal &mdash; nobody has matched them to an OpenProject user by phone number yet. The
      mapping column shows what a human has classified them as for fields that read off &ldquo;the sender's
      contact&rdquo;; &ldquo;Not classified&rdquo; means a ticket for them currently falls back to that field's
      default.
    </p>
    <p v-if="tab === 'unclassified'" class="hint">
      A rule filled an OpenProject field from &ldquo;the sender's contact&rdquo; and found nothing recorded for
      these people, so the ticket used that field's fallback and said so in its description. Answer it here and the
      next ticket gets the real value. Senders nobody had on file were added automatically.
    </p>
    <p v-if="tab === 'unclassified' && slotsError" class="hint">Could not load the field list: {{ slotsError }}</p>
    <p v-else-if="tab === 'unclassified' && !slots.length" class="hint">
      No inbound rule reads a field off the sender yet &mdash; set one up in a Create-ticket action first.
    </p>

    <div v-if="classifying" class="card" style="margin-bottom: 1rem">
      <h2 style="margin-top: 0">Classify {{ classifying.name }}</h2>
      <div v-for="slot in slots" :key="slot.key" class="field">
        <label>{{ slot.name }}</label>
        <TreeSelect
          v-model="classifying.values[slot.key]"
          :options="slot.allowedValues ?? []"
          empty-label="Not set — keep asking"
          search-placeholder="Search by name or unit…"
        />
        <p class="hint" style="margin: 0.15rem 0 0"><code>{{ slot.key }}</code></p>
      </div>
      <div class="actions">
        <button class="btn" @click="saveClassification">Save</button>
        <button class="btn secondary" @click="classifying = null">Cancel</button>
      </div>
    </div>

    <div v-if="editing" class="card" style="margin-bottom: 1rem">
      <div v-if="error" class="error-banner">{{ error }}</div>
      <div class="field">
        <label>Name</label>
        <input v-model="editing.name" style="width: 100%" />
      </div>
      <div class="field">
        <label>Type</label>
        <select v-model="editing.type">
          <option value="individual">Individual</option>
          <option value="group">Group</option>
        </select>
      </div>
      <div class="field">
        <label>Signal number / group id</label>
        <input v-model="editing.signalIdentifier" style="width: 100%" placeholder="+15551234567 or group.xxxx" />
      </div>
      <div class="field">
        <label>Notes (optional)</label>
        <input v-model="editing.notes" style="width: 100%" />
      </div>
      <div class="field">
        <label>
          <input type="checkbox" v-model="editing.muted" style="width: auto" />
          Mute all notifications
        </label>
        <p class="hint" style="margin: 0.15rem 0 0">
          No rule will message this contact while muted, including rules that resolve them as a work package's author
          or assignee. Suppressed messages still appear in the log so nothing goes missing silently.
        </p>
      </div>
      <div class="actions">
        <button class="btn" @click="save">Save</button>
        <button class="btn secondary" @click="cancelEdit">Cancel</button>
      </div>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Signal identifier</th>
            <th>Notifications</th>
            <th v-if="tab === 'signal'">Mapped OpenProject contact</th>
            <th v-else>Source</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="visible.length === 0">
            <td colspan="6" style="text-align: center; color: var(--text-faint); padding: 1.5rem">
              {{ tab === 'unclassified'
                ? 'Nothing waiting — every sender a rule asked about has an answer.'
                : 'No contacts yet — add one manually, or sync them from your OpenProject users.' }}
            </td>
          </tr>
          <tr v-for="c in visible" :key="c.id" :class="{ muted: c.muted }">
            <td>{{ c.name }}</td>
            <td>{{ c.type }}</td>
            <td>{{ c.signal_identifier }}</td>
            <td>
              <span class="badge" :class="c.muted ? 'neutral' : 'sent'">{{ c.muted ? 'Muted' : 'Active' }}</span>
            </td>
            <td v-if="tab === 'signal'">
              <span v-if="mappedLabel(c)">{{ mappedLabel(c) }}</span>
              <span v-else class="badge failed">Not classified</span>
            </td>
            <td v-else>
              <span v-if="c.openproject_user_id" class="badge received">OpenProject user #{{ c.openproject_user_id }}</span>
              <span v-else style="color: var(--text-faint)">manual</span>
              <span v-if="c.needs_classification" class="badge failed" style="margin-left: 0.35rem">unclassified</span>
            </td>
            <td class="actions">
              <button v-if="slots.length" class="btn secondary" @click="startClassify(c)">Classify</button>
              <button class="btn secondary" :title="c.muted ? 'Resume notifications' : 'Stop all notifications'" @click="toggleMute(c)">
                {{ c.muted ? 'Unmute' : 'Mute' }}
              </button>
              <button class="btn secondary" @click="startEdit(c)">Edit</button>
              <button class="btn danger" @click="remove(c)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.header-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
.actions { display: flex; gap: 0.5rem; }
.hint { color: var(--text-muted); font-size: 0.85rem; margin: 0 0 1rem; }
.tabs { display: flex; gap: 0.25rem; margin-bottom: 1rem; border-bottom: 1px solid var(--border); }
.tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-muted);
  cursor: pointer;
  font: inherit;
  padding: 0.5rem 0.75rem;
}
.tab.active { border-bottom-color: var(--primary); color: var(--text); }
/* Muted contacts stay readable but visibly inactive. */
tbody tr.muted td:not(.actions) { opacity: 0.55; }
</style>
