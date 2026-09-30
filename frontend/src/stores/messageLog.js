import { defineStore } from 'pinia';
import { api } from '../api/client.js';

export const useMessageLogStore = defineStore('messageLog', {
  state: () => ({
    rows: [],
    total: 0,
    page: 1,
    pageSize: 25,
    direction: '',
    loading: false,
    stats: null,
  }),
  actions: {
    async fetchStats() {
      this.stats = await api.get('/message-log/stats');
    },
    async fetch() {
      this.loading = true;
      try {
        const params = new URLSearchParams({ page: this.page, pageSize: this.pageSize });
        if (this.direction) params.set('direction', this.direction);
        const result = await api.get(`/message-log?${params}`);
        this.rows = result.rows;
        this.total = result.total;
      } finally {
        this.loading = false;
      }
    },
    setDirection(direction) {
      this.direction = direction;
      this.page = 1;
      this.fetch();
    },
    setPage(page) {
      this.page = page;
      this.fetch();
    },
  },
});
