<script setup>
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import { useThemeStore } from './stores/theme.js';
import AppIcon from './components/AppIcon.vue';

const auth = useAuthStore();
const theme = useThemeStore();
const router = useRouter();
const route = useRoute();

const sidebarOpen = ref(false);

const NAV = [
  { section: 'Monitor', items: [{ to: '/', icon: 'dashboard', label: 'Dashboard' }] },
  {
    section: 'Configure',
    items: [
      { to: '/rules', icon: 'rules', label: 'Rules' },
      { to: '/contacts', icon: 'contacts', label: 'Contacts' },
      { to: '/settings', icon: 'settings', label: 'Settings' },
    ],
  },
];

async function logout() {
  await auth.logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <!-- Login renders standalone, without the shell chrome. -->
  <RouterView v-if="!auth.isAuthenticated" />

  <div v-else class="shell">
    <aside class="sidebar" :class="{ open: sidebarOpen }">
      <div class="brand">
        <span class="brand-mark"><AppIcon name="logo" /></span>
        <span class="brand-text">Signals</span>
      </div>

      <nav class="nav">
        <template v-for="group in NAV" :key="group.section">
          <p class="nav-section">{{ group.section }}</p>
          <RouterLink
            v-for="item in group.items"
            :key="item.to"
            :to="item.to"
            class="nav-link"
            :class="{ active: route.path === item.to || (item.to !== '/' && route.path.startsWith(item.to)) }"
            @click="sidebarOpen = false"
          >
            <AppIcon :name="item.icon" />
            <span>{{ item.label }}</span>
          </RouterLink>
        </template>
      </nav>
    </aside>

    <div class="main">
      <header class="topbar">
        <!-- Inner wrapper shares the content column's max-width so the user
             menu lines up with the cards below instead of drifting to the
             far edge on wide screens. -->
        <div class="topbar-inner">
          <button class="icon-btn burger" title="Menu" @click="sidebarOpen = !sidebarOpen">
            <AppIcon name="menu" />
          </button>

          <span class="spacer"></span>

          <button class="icon-btn" :title="theme.isDark ? 'Switch to light' : 'Switch to dark'" @click="theme.toggle()">
            <AppIcon :name="theme.isDark ? 'sun' : 'moon'" />
          </button>

          <div class="user">
            <div class="avatar">{{ (auth.username || '?').slice(0, 1).toUpperCase() }}</div>
            <div class="user-meta">
              <span class="user-name">{{ auth.username }}</span>
              <span class="user-role">Admin</span>
            </div>
          </div>

          <button class="btn secondary small" @click="logout">Log out</button>
        </div>
      </header>

      <main class="content">
        <RouterView />
      </main>
    </div>

    <div v-if="sidebarOpen" class="scrim" @click="sidebarOpen = false"></div>
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
}

/* ---------- sidebar ---------- */

.sidebar {
  position: fixed;
  inset: 0 auto 0 0;
  width: var(--sidebar-w);
  background: var(--sidebar);
  border-right: 1px solid var(--border);
  padding: 1.1rem 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  z-index: 30;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0 0.5rem;
}
.brand-mark {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: var(--primary);
  color: #fff;
}
.brand-text {
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.nav-section {
  margin: 0.9rem 0 0.35rem;
  padding: 0 0.6rem;
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-faint);
}
.nav-link {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.6rem 0.7rem;
  border-radius: 8px;
  color: var(--text-muted);
  text-decoration: none;
  font-size: 0.88rem;
  transition: background 0.15s, color 0.15s;
}
.nav-link:hover {
  background: var(--surface-2);
  color: var(--text);
}
.nav-link.active {
  background: var(--primary);
  color: var(--on-primary);
  font-weight: 500;
  box-shadow: 0 3px 10px var(--primary-soft);
}

/* ---------- main column ---------- */

.main {
  margin-left: var(--sidebar-w);
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  height: var(--topbar-h);
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}
.topbar-inner {
  height: 100%;
  max-width: 1280px;
  margin: 0 auto;
  padding: 0 1.5rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.spacer {
  flex: 1;
}

.icon-btn {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.icon-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}
.burger {
  display: none;
}

.user {
  display: flex;
  align-items: center;
  gap: 0.55rem;
}
.avatar {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--primary);
  color: #fff;
  font-weight: 600;
  font-size: 0.85rem;
}
.user-meta {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}
.user-name {
  font-size: 0.85rem;
  font-weight: 600;
}
.user-role {
  font-size: 0.72rem;
  color: var(--text-faint);
}

.content {
  flex: 1;
  padding: 1.5rem;
  max-width: 1280px;
  width: 100%;
  /* Centres the column in the space left of the sidebar, instead of
     letting it hug the left edge on wide screens. */
  margin: 0 auto;
}

.scrim {
  display: none;
}

@media (max-width: 900px) {
  .sidebar {
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }
  .sidebar.open {
    transform: none;
    box-shadow: var(--shadow-md);
  }
  .main {
    margin-left: 0;
  }
  .burger {
    display: grid;
  }
  .user-meta {
    display: none;
  }
  .scrim {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(15, 17, 26, 0.45);
    z-index: 25;
  }
}
</style>
