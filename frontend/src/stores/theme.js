import { defineStore } from 'pinia';

const STORAGE_KEY = 'signals-theme';

/** Stored choice wins; otherwise follow the OS setting on first visit. */
function initialTheme() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const useThemeStore = defineStore('theme', {
  state: () => ({ theme: 'light' }),
  getters: {
    isDark: (state) => state.theme === 'dark',
  },
  actions: {
    /** Called once at boot, before the app mounts, to avoid a flash of the wrong theme. */
    init() {
      this.apply(initialTheme());
    },
    apply(theme) {
      this.theme = theme;
      document.documentElement.setAttribute('data-theme', theme);
      // Keeps form controls, scrollbars and the like in the right palette.
      document.documentElement.style.colorScheme = theme;
      localStorage.setItem(STORAGE_KEY, theme);
    },
    toggle() {
      this.apply(this.isDark ? 'light' : 'dark');
    },
  },
});
