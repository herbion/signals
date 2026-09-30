import { defineStore } from 'pinia';
import { api } from '../api/client.js';

export const useContactsStore = defineStore('contacts', {
  state: () => ({
    contacts: [],
    loading: false,
  }),
  getters: {
    /**
     * Contacts a rule asked a question about and did not get an answer for --
     * the bridge flags them (creating the row if the sender was new) when a
     * field mapped to "the sender's contact" finds nothing recorded.
     */
    needingClassification: (state) => state.contacts.filter((contact) => contact.needs_classification),
  },
  actions: {
    async fetchAll() {
      this.loading = true;
      try {
        this.contacts = await api.get('/contacts');
      } finally {
        this.loading = false;
      }
    },
    async create(contact) {
      const created = await api.post('/contacts', contact);
      this.contacts.push(created);
      return created;
    },
    async update(id, contact) {
      const updated = await api.put(`/contacts/${id}`, contact);
      const i = this.contacts.findIndex((c) => c.id === Number(id));
      if (i !== -1) this.contacts[i] = updated;
      return updated;
    },
    async remove(id) {
      await api.delete(`/contacts/${id}`);
      this.contacts = this.contacts.filter((c) => c.id !== Number(id));
    },
    async setMuted(id, muted) {
      const updated = await api.patch(`/contacts/${id}/muted`, { muted });
      const i = this.contacts.findIndex((c) => c.id === Number(id));
      if (i !== -1) this.contacts[i] = updated;
      return updated;
    },
    /**
     * Which list entry a contact stands for, per OpenProject schema key.
     * Saving a value is what takes them off the classification queue.
     */
    async setFieldValues(id, fieldValues) {
      const updated = await api.put(`/contacts/${id}/field-values`, { fieldValues });
      const i = this.contacts.findIndex((c) => c.id === Number(id));
      if (i !== -1) this.contacts[i] = updated;
      return updated;
    },
    async syncFromOpenProject() {
      const result = await api.post('/contacts/sync');
      await this.fetchAll();
      return result;
    },
  },
});
