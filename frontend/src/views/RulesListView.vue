<script setup>
import { onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useRulesStore } from '../stores/rules.js';
import { useInboundRulesStore } from '../stores/inboundRules.js';
import { useContactsStore } from '../stores/contacts.js';

const store = useRulesStore();
const inboundStore = useInboundRulesStore();
const contactsStore = useContactsStore();
const router = useRouter();

onMounted(() => {
  store.fetchAll();
  inboundStore.fetchAll();
  contactsStore.fetchAll();
});

const allRules = computed(() => {
  const outbound = store.rules.map(r => ({ ...r, _type: 'outbound' }));
  const inbound = inboundStore.rules.map(r => ({ ...r, _type: 'inbound' }));
  return [...outbound, ...inbound].sort((a, b) => b.priority - a.priority);
});

const ACTION_SHORT = { react: 'React', create_ticket: 'Create ticket', send_message: 'Send message' };

function describeTrigger(rule) {
  if (rule._type !== 'inbound') return rule.project_scope || 'Any project';
  const base =
    rule.source_scope === 'group' ? 'Group' : rule.source_scope === 'direct' ? 'Direct' : 'Group + direct';
  // A rule narrowed to particular groups is not listening to "Group" at large,
  // and that is exactly the thing worth seeing from the list.
  const picked = (rule.source_group_ids ?? []).length;
  const where = picked ? `${base} (${picked})` : base;
  if (rule.match_type === 'any') return `${where} · any message`;
  if (rule.match_type === 'natural') return `${where} · certificate request`;
  return `${where} · ${rule.match_type === 'regex' ? '/' + (rule.pattern ?? '') + '/' : `"${rule.pattern ?? ''}"`}`;
}

function describeRecipient(rule) {
  if (rule._type === 'inbound') {
    const actions = rule.actions ?? [];
    if (actions.length === 0) return 'No actions';
    return actions.map((a) => ACTION_SHORT[a.action_type] ?? a.action_type).join(' → ');
  }
  if (rule.action_recipient_mode === 'dynamic') {
    return `WP ${rule.action_recipient_dynamic_relation ?? 'author'}`;
  }
  if (rule.action_recipient_contact_id) {
    const contact = contactsStore.contacts.find((c) => c.id === rule.action_recipient_contact_id);
    return contact ? contact.name : `Contact #${rule.action_recipient_contact_id}`;
  }
  return rule.action_recipient_raw || '—';
}

async function toggle(rule) {
  if (rule._type === 'inbound') {
    await inboundStore.toggleEnabled(rule);
  } else {
    await store.toggleEnabled(rule);
  }
}

async function remove(rule) {
  if (!confirm(`Delete rule "${rule.name}"?`)) return;
  if (rule._type === 'inbound') {
    await inboundStore.remove(rule.id);
  } else {
    await store.remove(rule.id);
  }
}
</script>

<template>
  <div>
    <div class="header-row">
      <h1>Rules</h1>
      <div class="actions">
        <button class="btn secondary" @click="router.push({ name: 'inbound-rule-new' })">New Inbound Rule</button>
        <button class="btn" @click="router.push({ name: 'rule-new' })">New Outbound Rule</button>
      </div>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Name</th>
            <th>Enabled</th>
            <th>Trigger</th>
            <th>Action</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="allRules.length === 0">
            <td colspan="6" style="text-align: center; color: var(--text-faint); padding: 1.5rem">
              No rules yet &mdash; create one to start automating OpenProject and Signal.
            </td>
          </tr>
          <tr v-for="rule in allRules" :key="`${rule._type}-${rule.id}`">
            <td>
              <span class="badge" :class="rule._type === 'inbound' ? 'badge-inbound' : 'badge-outbound'">
                {{ rule._type === 'inbound' ? 'Inbound' : 'Outbound' }}
              </span>
            </td>
            <td>{{ rule.name }}</td>
            <td>
              <input type="checkbox" :checked="rule.enabled" @change="toggle(rule)" />
            </td>
            <td class="trigger">{{ describeTrigger(rule) }}</td>
            <td>{{ describeRecipient(rule) }}</td>
            <td class="actions">
              <button class="btn secondary" @click="router.push({ name: rule._type === 'inbound' ? 'inbound-rule-edit' : 'rule-edit', params: { id: rule.id } })">Edit</button>
              <button class="btn danger" @click="remove(rule)">Delete</button>
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
.badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
}
.badge-inbound {
  background: rgba(46, 204, 113, 0.2);
  color: #2ecc71;
}
.trigger { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; color: var(--text-muted); max-width: 22rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge-outbound {
  background: rgba(52, 152, 219, 0.2);
  color: #3498db;
}
</style>
