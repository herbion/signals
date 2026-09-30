<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useThemeStore } from '../stores/theme.js';
import AppIcon from '../components/AppIcon.vue';

const auth = useAuthStore();
const theme = useThemeStore();
const router = useRouter();

const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    await auth.login(username.value, password.value);
    router.push({ name: 'dashboard' });
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <button class="theme-toggle" :title="theme.isDark ? 'Switch to light' : 'Switch to dark'" @click="theme.toggle()">
      <AppIcon :name="theme.isDark ? 'sun' : 'moon'" />
    </button>

    <form class="card login-card" @submit.prevent="submit">
      <div class="brand">
        <span class="brand-mark"><AppIcon name="logo" :size="22" /></span>
        <span class="brand-text">Signals</span>
      </div>

      <h1>Welcome back</h1>
      <p class="hint subtitle">Sign in to manage your OpenProject → Signal rules.</p>

      <div v-if="error" class="error-banner">{{ error }}</div>

      <div class="field">
        <label for="username">Username</label>
        <input id="username" v-model="username" autocomplete="username" required />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" v-model="password" type="password" autocomplete="current-password" required />
      </div>

      <button class="btn block" type="submit" :disabled="loading">
        {{ loading ? 'Signing in…' : 'Sign in' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 1.5rem;
  /* Subtle brand wash so the sign-in screen isn't a flat grey field. */
  background:
    radial-gradient(circle at 15% 15%, var(--primary-soft), transparent 45%),
    radial-gradient(circle at 85% 80%, var(--info-soft), transparent 45%),
    var(--bg);
}

.theme-toggle {
  position: fixed;
  top: 1.25rem;
  right: 1.25rem;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-muted);
  cursor: pointer;
}
.theme-toggle:hover {
  color: var(--text);
}

.login-card {
  width: 100%;
  max-width: 370px;
  padding: 2rem;
  box-shadow: var(--shadow-md);
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 1.5rem;
}
.brand-mark {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--primary);
  color: #fff;
}
.brand-text {
  font-size: 1.15rem;
  font-weight: 700;
}

.subtitle {
  margin: 0.3rem 0 1.5rem;
}

.block {
  width: 100%;
  justify-content: center;
  padding: 0.6rem 1rem;
}
</style>
