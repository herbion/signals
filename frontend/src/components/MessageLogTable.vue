<script setup>
import { reactive, onMounted } from 'vue';

defineProps({ rows: { type: Array, required: true } });

const STORAGE_KEY = 'messageLogTable:columnWidths';

const columns = [
  { key: 'time', label: 'Time', default: 120, min: 80 },
  { key: 'direction', label: 'Direction', default: 100, min: 70 },
  { key: 'ruleSender', label: 'Rule / Sender', default: 150, min: 80 },
  { key: 'workPackage', label: 'Work package', default: 110, min: 70 },
  { key: 'recipient', label: 'Recipient', default: 130, min: 60 },
  { key: 'message', label: 'Message', default: 340, min: 150 },
  { key: 'status', label: 'Status', default: 120, min: 80 },
];

const widths = reactive(Object.fromEntries(columns.map((c) => [c.key, c.default])));

onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    for (const col of columns) {
      if (typeof saved[col.key] === 'number' && saved[col.key] >= col.min) {
        widths[col.key] = saved[col.key];
      }
    }
  } catch {
    // Corrupt/foreign localStorage value -- fall back to defaults rather than breaking the table.
  }
});

function persistWidths() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
}

function startResize(key, min, event) {
  const startX = event.clientX;
  const startWidth = widths[key];
  document.body.style.userSelect = 'none';

  function onMove(moveEvent) {
    widths[key] = Math.max(min, startWidth + (moveEvent.clientX - startX));
  }
  function onUp() {
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    persistWidths();
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function formatTime(iso) {
  // Stored as UTC by SQLite's datetime('now') without a zone marker.
  return new Date(`${iso.replace(' ', 'T')}Z`).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
</script>

<template>
  <table class="resizable">
    <colgroup>
      <col v-for="col in columns" :key="col.key" :style="{ width: widths[col.key] + 'px' }" />
    </colgroup>
    <thead>
      <tr>
        <th v-for="col in columns" :key="col.key">
          <span class="th-label">{{ col.label }}</span>
          <span
            class="col-resize-handle"
            @mousedown.prevent="startResize(col.key, col.min, $event)"
          ></span>
        </th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="rows.length === 0">
        <td colspan="7" class="empty-row">No messages yet</td>
      </tr>
      <tr v-for="row in rows" :key="row.id">
        <td class="truncate">{{ formatTime(row.created_at) }}</td>
        <td class="truncate">
          <span class="badge neutral">{{ row.direction }}</span>
        </td>
        <td class="truncate" :title="row.direction === 'outbound' ? (row.rule_name ?? '') : row.sender">
          {{ row.direction === 'outbound' ? (row.rule_name ?? '—') : row.sender }}
        </td>
        <td class="truncate">
          <span v-if="row.work_package_id">#{{ row.work_package_id }}</span>
          <span v-else class="faint">—</span>
        </td>
        <td class="truncate" :title="row.recipient ?? ''">{{ row.recipient ?? '—' }}</td>
        <td class="truncate content-cell" :title="row.content">{{ row.content }}</td>
        <td class="truncate">
          <span class="badge" :class="row.status" :title="row.status === 'muted' ? 'Recipient is muted — not sent' : ''">
            {{ row.status }}
          </span>
          <div v-if="row.error_message" class="error-text" :title="row.error_message">{{ row.error_message }}</div>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
table.resizable {
  table-layout: fixed;
}
th {
  position: relative;
}
.th-label {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
}
.col-resize-handle {
  position: absolute;
  top: 0;
  right: -0.85rem;
  bottom: 0;
  width: 10px;
  cursor: col-resize;
  z-index: 1;
}
.col-resize-handle:hover,
.col-resize-handle:active {
  background: var(--accent, currentColor);
  opacity: 0.35;
}
.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.content-cell {
  color: var(--text-muted);
}
.faint {
  color: var(--text-faint);
}
.error-text {
  color: var(--danger);
  font-size: 0.72rem;
  margin-top: 0.25rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
