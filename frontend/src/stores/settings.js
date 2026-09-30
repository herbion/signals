import { defineStore } from 'pinia';
import { api } from '../api/client.js';

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    openproject: null,
    signal: null,
  }),
  actions: {
    async fetchOpenProject() {
      this.openproject = await api.get('/settings/openproject');
    },
    async saveOpenProject(payload) {
      await api.put('/settings/openproject', payload);
      await this.fetchOpenProject();
    },
    async testOpenProjectConnection() {
      return api.post('/settings/openproject/test-connection');
    },
    async openprojectUserFields() {
      return api.get('/settings/openproject/user-fields');
    },
    // Active OpenProject users, for pickers that need a real person -- e.g.
    // assignee-routing rules in the inbound rule editor.
    async openprojectUsers() {
      return api.get('/settings/openproject/users');
    },
    async refreshMetadata() {
      const metadata = await api.post('/settings/openproject/refresh-metadata');
      await this.fetchOpenProject();
      return metadata;
    },
    async fetchSignal() {
      this.signal = await api.get('/settings/signal');
    },
    async saveSignal(payload) {
      this.signal = await api.put('/settings/signal', payload);
    },
    /**
     * Writable fields of one (project, type) pair. OpenProject types can make
     * custom fields mandatory and can generate the subject themselves, so the
     * rule editor has to ask rather than assume.
     */
    async openprojectSchema({ projectId, typeId }) {
      return api.get(`/settings/openproject/schema?projectId=${encodeURIComponent(projectId)}&typeId=${encodeURIComponent(typeId)}`);
    },
    async signalLinkStatus() {
      return api.get('/settings/signal/link-status');
    },
    // The bot's Signal groups, straight from signal-cli-rest-api. Group ids
    // are opaque base64 and aren't visible anywhere in the Signal app, so
    // this listing is the only practical way to pick one.
    async signalGroups({ refresh = false } = {}) {
      return api.get(`/settings/signal/groups${refresh ? '?refresh=true' : ''}`);
    },
    async signalSubscriptions() {
      return api.get('/settings/signal/subscriptions');
    },
    async saveSubscriptions(groupIds) {
      return api.put('/settings/signal/subscriptions', { groupIds });
    },
  },
});
