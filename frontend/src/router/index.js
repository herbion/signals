import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

const routes = [
  { path: '/login', name: 'login', component: () => import('../views/LoginView.vue') },
  { path: '/', name: 'dashboard', component: () => import('../views/DashboardView.vue') },
  { path: '/rules', name: 'rules', component: () => import('../views/RulesListView.vue') },
  { path: '/rules/new', name: 'rule-new', component: () => import('../views/RuleEditorView.vue') },
  { path: '/rules/:id', name: 'rule-edit', component: () => import('../views/RuleEditorView.vue'), props: true },
  { path: '/inbound-rules/new', name: 'inbound-rule-new', component: () => import('../views/InboundRuleEditorView.vue') },
  { path: '/inbound-rules/:id', name: 'inbound-rule-edit', component: () => import('../views/InboundRuleEditorView.vue'), props: true },
  { path: '/contacts', name: 'contacts', component: () => import('../views/ContactsView.vue') },
  { path: '/settings', name: 'settings', component: () => import('../views/SettingsView.vue') },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.checked) {
    await auth.checkSession();
  }
  if (to.name !== 'login' && !auth.isAuthenticated) {
    return { name: 'login' };
  }
  if (to.name === 'login' && auth.isAuthenticated) {
    return { name: 'dashboard' };
  }
  return true;
});

export default router;
