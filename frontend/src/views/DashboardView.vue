<script setup>
import { onMounted, computed } from 'vue';
import { useMessageLogStore } from '../stores/messageLog.js';
import MessageLogTable from '../components/MessageLogTable.vue';
import StatTile from '../components/StatTile.vue';

const store = useMessageLogStore();

onMounted(() => {
  store.fetch();
  store.fetchStats();
});

const totalPages = computed(() => Math.max(1, Math.ceil(store.total / store.pageSize)));

// Bars are scaled against the busiest day so a quiet fortnight still reads.
const chartMax = computed(() => Math.max(1, ...(store.stats?.daily ?? []).map((d) => d.sent + d.failed)));

function barHeight(value) {
  return value === 0 ? 0 : Math.max(4, (value / chartMax.value) * 100);
}

function dayLabel(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * Axis tick: the day of the month. Taken from the date directly rather than
 * by splitting dayLabel(), whose field order is locale-dependent
 * ("Aug 13" vs "13 Aug").
 */
function dayTick(iso) {
  return Number(iso.slice(8, 10));
}

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'outbound', label: 'Outbound' },
  { value: 'inbound', label: 'Inbound' },
];
</script>

<template>
  <div>
    <div class="header-row">
      <div>
        <h1>Dashboard</h1>
        <p class="hint" style="margin: 0.25rem 0 0">Delivery activity across your OpenProject notification rules.</p>
      </div>
    </div>

    <div v-if="store.stats" class="tiles">
      <StatTile
        label="Sent today"
        :value="store.stats.sentToday"
        :sub="store.stats.pending ? `${store.stats.pending} queued for grouping` : `${store.stats.sent} all time`"
        icon="send"
        tone="primary"
      />
      <StatTile
        label="Failed"
        :value="store.stats.failed"
        :sub="store.stats.failed ? 'Check the log below' : 'No delivery errors'"
        icon="alert"
        :tone="store.stats.failed ? 'danger' : 'success'"
      />
      <StatTile
        label="Active rules"
        :value="store.stats.rulesEnabled"
        :sub="`${store.stats.rulesTotal} configured`"
        icon="rules"
        tone="info"
      />
      <StatTile
        label="Contacts"
        :value="store.stats.contacts"
        :sub="`${store.stats.inbound} inbound logged`"
        icon="contacts"
        tone="success"
      />
    </div>

    <div v-if="store.stats" class="card chart-card">
      <div class="card-title">
        <h2>Messages sent</h2>
        <span class="hint">Last 14 days</span>
      </div>
      <div class="chart">
        <div v-for="day in store.stats.daily" :key="day.date" class="chart-col" :title="`${dayLabel(day.date)} — ${day.sent} sent, ${day.failed} failed`">
          <div class="chart-stack">
            <div class="bar failed" :style="{ height: barHeight(day.failed) + '%' }"></div>
            <div class="bar sent" :style="{ height: barHeight(day.sent) + '%' }"></div>
          </div>
          <span class="chart-label">{{ dayTick(day.date) }}</span>
        </div>
      </div>
      <div class="legend">
        <span><i class="dot sent"></i> Sent</span>
        <span><i class="dot failed"></i> Failed</span>
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        <h2>Message log</h2>
        <div class="actions">
          <button
            v-for="f in FILTERS"
            :key="f.value"
            class="btn small"
            :class="{ secondary: store.direction !== f.value }"
            @click="store.setDirection(f.value)"
          >
            {{ f.label }}
          </button>
        </div>
      </div>

      <div class="table-wrap">
        <MessageLogTable :rows="store.rows" />
      </div>

      <div class="pagination">
        <button class="btn secondary small" :disabled="store.page <= 1" @click="store.setPage(store.page - 1)">
          Previous
        </button>
        <span class="hint">Page {{ store.page }} of {{ totalPages }} · {{ store.total }} messages</span>
        <button class="btn secondary small" :disabled="store.page >= totalPages" @click="store.setPage(store.page + 1)">
          Next
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 1rem;
  margin-bottom: 1rem;
}

.chart-card {
  margin-bottom: 1rem;
}
.chart {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  height: 150px;
}
.chart-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  height: 100%;
}
.chart-stack {
  flex: 1;
  width: 100%;
  max-width: 26px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 2px;
}
.bar {
  width: 100%;
  border-radius: 4px;
  transition: height 0.25s ease;
}
.bar.sent {
  background: var(--primary);
}
.bar.failed {
  background: var(--danger);
}
.chart-label {
  font-size: 0.68rem;
  color: var(--text-faint);
}

.legend {
  display: flex;
  gap: 1rem;
  margin-top: 0.9rem;
  font-size: 0.78rem;
  color: var(--text-muted);
}
.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 0.35rem;
}
.dot.sent {
  background: var(--primary);
}
.dot.failed {
  background: var(--danger);
}

.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  margin-top: 1rem;
}
</style>
