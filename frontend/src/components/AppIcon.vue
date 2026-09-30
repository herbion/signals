<script setup>
/**
 * Inline SVG icon set. Kept local rather than pulling an icon font/CDN so the
 * app has no external asset dependencies (it's served from the backend
 * container on a private network).
 */
defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 18 },
});

const PATHS = {
  logo: '<path d="M13 2 4.5 12.5a1 1 0 0 0 .8 1.6H11l-1 7.9 8.5-10.5a1 1 0 0 0-.8-1.6H12z"/>',
  dashboard:
    '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="10" width="7" height="11" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  rules:
    '<path d="M9 5h11M9 12h11M9 19h11"/><circle cx="4.5" cy="5" r="1.6"/><circle cx="4.5" cy="12" r="1.6"/><circle cx="4.5" cy="19" r="1.6"/>',
  contacts:
    '<path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20"/><circle cx="9" cy="7" r="3.5"/><path d="M17 4.5a3.5 3.5 0 0 1 0 6.8M22 20v-1.5a4 4 0 0 0-3-3.8"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 1.5v2M12 20.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1.5 12h2M20.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
  moon: '<path d="M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5a8.5 8.5 0 1 0 10.8 10.8z"/>',
  send: '<path d="M21.5 2.5 10.5 13.5M21.5 2.5l-7 19-4-8.5-8.5-4z"/>',
  alert: '<path d="M12 8.5v5M12 17h.01"/><circle cx="12" cy="12" r="9.5"/>',
  inbox:
    '<path d="M21.5 12.5h-5l-1.5 3h-6l-1.5-3h-5"/><path d="M5.9 4.7 2.5 12.5v5a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2v-5l-3.4-7.8a2 2 0 0 0-1.8-1.2H7.7a2 2 0 0 0-1.8 1.2z"/>',
  bolt: '<path d="M13 2 4.5 12.5a1 1 0 0 0 .8 1.6H11l-1 7.9 8.5-10.5a1 1 0 0 0-.8-1.6H12z"/>',
};
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="PATHS[name] ?? ''"
  />
</template>

<style scoped>
svg {
  flex-shrink: 0;
}
</style>
