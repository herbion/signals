import { defineStore } from 'pinia';
import { api } from '../api/client.js';

export const useRulesStore = defineStore('rules', {
  state: () => ({
    rules: [],
    loading: false,
  }),
  actions: {
    async fetchAll() {
      this.loading = true;
      try {
        this.rules = await api.get('/rules');
      } finally {
        this.loading = false;
      }
    },
    async fetchOne(id) {
      return api.get(`/rules/${id}`);
    },
    async create(rule) {
      const created = await api.post('/rules', rule);
      this.rules.push(created);
      return created;
    },
    async update(id, rule) {
      const updated = await api.put(`/rules/${id}`, rule);
      const i = this.rules.findIndex((r) => r.id === Number(id));
      if (i !== -1) this.rules[i] = updated;
      return updated;
    },
    async remove(id) {
      await api.delete(`/rules/${id}`);
      this.rules = this.rules.filter((r) => r.id !== Number(id));
    },
    async toggleEnabled(rule) {
      return this.update(rule.id, { ...ruleToPayload(rule), enabled: !rule.enabled });
    },
  },
});

/** Strips server-only fields (id, timestamps, conditionTree already parsed) back into an update/create payload shape. */
export function ruleToPayload(rule) {
  return {
    name: rule.name,
    enabled: rule.enabled,
    projectScope: rule.project_scope,
    conditionTree: rule.conditionTree,
    actionRecipientMode: rule.action_recipient_mode,
    actionRecipientContactId: rule.action_recipient_contact_id,
    actionRecipientRaw: rule.action_recipient_raw,
    actionRecipientDynamicRelation: rule.action_recipient_dynamic_relation,
    messageTemplate: rule.message_template,
    commentTemplate: rule.comment_template,
    allowedContactIds: rule.allowed_contact_ids ?? [],
    batchWindowSeconds: rule.batch_window_seconds ?? null,
    priority: rule.priority,
  };
}
