import { defineStore } from 'pinia';
import { api } from '../api/client.js';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    username: null,
    checked: false,
  }),
  getters: {
    isAuthenticated: (state) => Boolean(state.username),
  },
  actions: {
    async checkSession() {
      try {
        const me = await api.get('/auth/me');
        this.username = me.username;
      } catch {
        this.username = null;
      } finally {
        this.checked = true;
      }
    },
    async login(username, password) {
      const result = await api.post('/auth/login', { username, password });
      this.username = result.username;
      this.checked = true;
    },
    async logout() {
      await api.post('/auth/logout');
      this.username = null;
    },
  },
});
