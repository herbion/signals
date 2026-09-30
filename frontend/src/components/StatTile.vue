<script setup>
import AppIcon from './AppIcon.vue';

defineProps({
  label: { type: String, required: true },
  value: { type: [Number, String], required: true },
  sub: { type: String, default: '' },
  icon: { type: String, required: true },
  tone: { type: String, default: 'primary' }, // primary | success | danger | info
});
</script>

<template>
  <div class="card tile">
    <div class="tile-text">
      <p class="tile-label">{{ label }}</p>
      <p class="tile-value">{{ value }}</p>
      <p v-if="sub" class="tile-sub">{{ sub }}</p>
    </div>
    <span class="tile-icon" :class="tone"><AppIcon :name="icon" :size="20" /></span>
  </div>
</template>

<style scoped>
.tile {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
.tile-text {
  min-width: 0;
}
.tile-label {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.82rem;
}
.tile-value {
  margin: 0.35rem 0 0;
  font-size: 1.6rem;
  font-weight: 600;
  line-height: 1.1;
}
.tile-sub {
  margin: 0.3rem 0 0;
  font-size: 0.75rem;
  color: var(--text-faint);
}
.tile-icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  flex-shrink: 0;
}
.tile-icon.primary {
  background: var(--primary-soft);
  color: var(--primary);
}
.tile-icon.success {
  background: var(--success-soft);
  color: var(--success);
}
.tile-icon.danger {
  background: var(--danger-soft);
  color: var(--danger);
}
.tile-icon.info {
  background: var(--info-soft);
  color: var(--info);
}
</style>
