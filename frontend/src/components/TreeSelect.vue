<script setup>
/**
 * A searchable picker for an OpenProject closed list, drawn as the tree it is.
 *
 * Built for "👤Замовник" -- some sixty people filed under their unit -- where a
 * native <select> means scrolling a flat list for one name. Typing narrows to
 * the entries whose *path* contains every word typed, so "бар" lists a unit
 * with its people, "береза" finds one person, and "бар береза" works too.
 * Entries kept only because something under them matched stay visible (dimmed)
 * so a name is never shown without its unit. Plain option lists have no
 * hierarchy and simply come out flat.
 *
 * v-model is the option id as a string; '' means "nothing chosen".
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import { buildOptionTree, foldText, highlightRuns } from '../utils/optionTree.js';

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  options: { type: Array, default: () => [] },
  /** Label for the "nothing chosen" entry; omit to offer no such entry. */
  emptyLabel: { type: String, default: '' },
  searchPlaceholder: { type: String, default: 'Search…' },
});
const emit = defineEmits(['update:modelValue']);

const uid = `tree-select-${Math.random().toString(36).slice(2, 9)}`;
const EMPTY_KEY = '\u0000empty';

const root = ref(null);
const searchInput = ref(null);
const list = ref(null);
const open = ref(false);
const query = ref('');
const activeKey = ref(null);
const collapsed = ref(new Set());

const tree = computed(() => buildOptionTree(props.options));
const hasHierarchy = computed(() => tree.value.rows.some((row) => row.children.length));
const selectedKey = computed(() => (props.modelValue === null || props.modelValue === undefined ? '' : String(props.modelValue)));
const selected = computed(() => tree.value.byId.get(selectedKey.value) ?? null);

const tokens = computed(() => foldText(query.value).split(' ').filter(Boolean));

/** Every row to draw, in order, with whether it matched the search itself. */
const visibleRows = computed(() => {
  const { rows } = tree.value;
  if (!tokens.value.length) {
    const out = [];
    for (const row of rows) {
      let hidden = false;
      for (let p = row.parent; p; p = p.parent) if (collapsed.value.has(p.id)) hidden = true;
      if (!hidden) out.push({ row, matched: true });
    }
    return out;
  }
  const matched = new Set(rows.filter((row) => tokens.value.every((t) => row.search.includes(t))));
  const keep = new Set(matched);
  for (const row of matched) for (let p = row.parent; p; p = p.parent) keep.add(p);
  return rows.filter((row) => keep.has(row)).map((row) => ({ row, matched: matched.has(row) }));
});

const matchCount = computed(() => visibleRows.value.filter((v) => v.matched).length);
const showEmptyEntry = computed(() => Boolean(props.emptyLabel) && !tokens.value.length);

/** Keyboard order: the "not set" entry first, then the rows as drawn. */
const navKeys = computed(() => [
  ...(showEmptyEntry.value ? [EMPTY_KEY] : []),
  ...visibleRows.value.map((v) => v.row.id),
]);

function optionDomId(key) {
  return `${uid}-${key === EMPTY_KEY ? 'empty' : key}`;
}

function openPanel() {
  if (open.value) return;
  open.value = true;
  query.value = '';
  // Unfold the branch holding the current choice so it is visible on open.
  if (selected.value) {
    const next = new Set(collapsed.value);
    for (let p = selected.value.parent; p; p = p.parent) next.delete(p.id);
    collapsed.value = next;
  }
  activeKey.value = selected.value ? selected.value.id : navKeys.value[0] ?? null;
  nextTick(() => {
    searchInput.value?.focus();
    scrollActiveIntoView();
  });
}

function closePanel({ refocus = false } = {}) {
  open.value = false;
  query.value = '';
  if (refocus) nextTick(() => root.value?.querySelector('.trigger')?.focus());
}

function choose(key) {
  emit('update:modelValue', key === EMPTY_KEY ? '' : key);
  closePanel({ refocus: true });
}

function toggleCollapse(row) {
  const next = new Set(collapsed.value);
  if (next.has(row.id)) next.delete(row.id);
  else next.add(row.id);
  collapsed.value = next;
}

function moveActive(step) {
  const keys = navKeys.value;
  if (!keys.length) return;
  const at = keys.indexOf(activeKey.value);
  const next = at === -1 ? (step > 0 ? 0 : keys.length - 1) : Math.min(keys.length - 1, Math.max(0, at + step));
  activeKey.value = keys[next];
  nextTick(scrollActiveIntoView);
}

function scrollActiveIntoView() {
  if (!activeKey.value || !list.value) return;
  const el = list.value.querySelector(`#${CSS.escape(optionDomId(activeKey.value))}`);
  el?.scrollIntoView({ block: 'nearest' });
}

function onSearchKeydown(event) {
  const active = tree.value.byId.get(activeKey.value);
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      moveActive(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      moveActive(-1);
      break;
    case 'PageDown':
      event.preventDefault();
      moveActive(8);
      break;
    case 'PageUp':
      event.preventDefault();
      moveActive(-8);
      break;
    case 'Enter':
      event.preventDefault();
      if (activeKey.value) choose(activeKey.value);
      break;
    case 'Escape':
      event.preventDefault();
      closePanel({ refocus: true });
      break;
    case 'Tab':
      closePanel();
      break;
    case 'ArrowRight':
      // Only while not typing, so the caret still moves inside the query.
      if (!query.value && active?.children.length && collapsed.value.has(active.id)) {
        event.preventDefault();
        toggleCollapse(active);
      }
      break;
    case 'ArrowLeft':
      if (!query.value && active) {
        if (active.children.length && !collapsed.value.has(active.id)) {
          event.preventDefault();
          toggleCollapse(active);
        } else if (active.parent) {
          event.preventDefault();
          activeKey.value = active.parent.id;
          nextTick(scrollActiveIntoView);
        }
      }
      break;
    default:
  }
}

function onTriggerKeydown(event) {
  if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
    event.preventDefault();
    openPanel();
  } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    // Start typing on the closed control and it opens already searching.
    event.preventDefault();
    openPanel();
    query.value = event.key;
  }
}

// A new query starts from the first real match rather than wherever the
// cursor happened to be -- or from an entry named exactly that, so "бар" lands
// on the unit БАР rather than on Бартіш listed above it.
watch(tokens, () => {
  const typed = foldText(query.value);
  const first =
    visibleRows.value.find((v) => v.matched && foldText(v.row.label) === typed) ??
    visibleRows.value.find((v) => v.matched);
  activeKey.value = first ? first.row.id : navKeys.value[0] ?? null;
  nextTick(() => list.value && (list.value.scrollTop = 0));
});

function onDocumentPointerDown(event) {
  if (open.value && root.value && !root.value.contains(event.target)) closePanel();
}
watch(open, (isOpen) => {
  if (isOpen) document.addEventListener('pointerdown', onDocumentPointerDown, true);
  else document.removeEventListener('pointerdown', onDocumentPointerDown, true);
});
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointerDown, true));
</script>

<template>
  <div ref="root" class="tree-select" :class="{ open }">
    <button
      type="button"
      class="trigger"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="open ? closePanel() : openPanel()"
      @keydown="onTriggerKeydown"
    >
      <span v-if="selected" class="value">
        <template v-for="(part, i) in selected.path" :key="i">
          <span v-if="i < selected.path.length - 1" class="crumb">{{ part }}<span class="sep">›</span></span>
          <span v-else class="leaf">{{ part }}</span>
        </template>
      </span>
      <span v-else-if="selectedKey" class="value unknown">Unknown entry #{{ selectedKey }}</span>
      <span v-else class="value placeholder">{{ emptyLabel || 'Choose…' }}</span>
      <AppIcon name="chevron-down" :size="16" class="caret" />
    </button>

    <div v-if="open" class="panel">
      <div class="search">
        <AppIcon name="search" :size="15" />
        <input
          ref="searchInput"
          v-model="query"
          type="text"
          role="combobox"
          autocomplete="off"
          spellcheck="false"
          aria-autocomplete="list"
          :aria-controls="`${uid}-list`"
          :aria-expanded="true"
          :aria-activedescendant="activeKey ? optionDomId(activeKey) : undefined"
          :placeholder="searchPlaceholder"
          @keydown="onSearchKeydown"
        />
        <span v-if="tokens.length" class="count">{{ matchCount }}</span>
      </div>

      <ul :id="`${uid}-list`" ref="list" class="list" role="listbox">
        <li
          v-if="showEmptyEntry"
          :id="optionDomId(EMPTY_KEY)"
          role="option"
          class="row empty-entry"
          :class="{ active: activeKey === EMPTY_KEY, selected: !selectedKey }"
          :aria-selected="!selectedKey"
          @mousemove="activeKey = EMPTY_KEY"
          @click="choose(EMPTY_KEY)"
        >
          <span class="label">{{ emptyLabel }}</span>
          <AppIcon v-if="!selectedKey" name="check" :size="15" class="tick" />
        </li>

        <li
          v-for="{ row, matched } in visibleRows"
          :id="optionDomId(row.id)"
          :key="row.id"
          role="option"
          class="row"
          :class="{
            active: activeKey === row.id,
            selected: selectedKey === row.id,
            group: row.children.length,
            context: !matched,
          }"
          :style="{ '--depth': row.depth }"
          :aria-selected="selectedKey === row.id"
          @mousemove="activeKey = row.id"
          @click="choose(row.id)"
        >
          <button
            v-if="row.children.length && !tokens.length"
            type="button"
            class="twisty"
            tabindex="-1"
            :aria-label="collapsed.has(row.id) ? `Expand ${row.label}` : `Collapse ${row.label}`"
            @click.stop="toggleCollapse(row)"
          >
            <AppIcon :name="collapsed.has(row.id) ? 'chevron-right' : 'chevron-down'" :size="14" />
          </button>
          <span v-else-if="hasHierarchy" class="twisty-spacer" />
          <span class="label">
            <template v-for="(run, i) in highlightRuns(row.label, tokens)" :key="i">
              <mark v-if="run.hit">{{ run.text }}</mark>
              <template v-else>{{ run.text }}</template>
            </template>
          </span>
          <span v-if="row.children.length" class="children-count">{{ row.children.length }}</span>
          <AppIcon v-if="selectedKey === row.id" name="check" :size="15" class="tick" />
        </li>

        <li v-if="tokens.length && !matchCount" class="nothing">Nothing matches “{{ query.trim() }}”.</li>
        <li v-else-if="!options.length" class="nothing">This field offers no entries.</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.tree-select {
  position: relative;
  width: 100%;
}

.trigger {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 0.85rem;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.trigger:focus-visible,
.open .trigger {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}
.value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crumb { color: var(--text-muted); }
.sep { margin: 0 0.35rem; color: var(--text-faint); }
.leaf { font-weight: 500; }
.placeholder { color: var(--text-muted); }
.unknown { color: var(--danger); }
.caret { color: var(--text-muted); transition: transform 0.15s; }
.open .caret { transform: rotate(180deg); }

.panel {
  position: absolute;
  z-index: 30;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow-md);
  overflow: hidden;
}

.search {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0 0.7rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
}
.search input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  box-shadow: none;
  padding: 0.6rem 0;
}
.search input:focus { box-shadow: none; }
.count {
  font-size: 0.75rem;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0.3rem;
  max-height: min(340px, 50vh);
  overflow-y: auto;
}

.row {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.38rem 0.5rem 0.38rem calc(0.5rem + var(--depth, 0) * 1.25rem);
  border-radius: 6px;
  font-size: 0.85rem;
  color: var(--text);
  cursor: pointer;
  user-select: none;
}
.row.active { background: var(--surface-2); }
.row.selected { color: var(--primary); }
.row.group > .label { font-weight: 600; }
.row.context { color: var(--text-faint); }
.row.context.group > .label { font-weight: 500; }
.empty-entry { color: var(--text-muted); font-style: italic; }
.empty-entry.selected { color: var(--primary); }

.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
mark {
  background: var(--warning-soft);
  color: inherit;
  border-radius: 2px;
}

.twisty,
.twisty-spacer {
  flex: 0 0 18px;
  height: 18px;
}
.twisty {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
}
.twisty:hover { background: var(--border); color: var(--text); }

.children-count {
  font-size: 0.72rem;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.tick { color: var(--primary); }

.nothing {
  padding: 0.75rem 0.5rem;
  font-size: 0.85rem;
  color: var(--text-muted);
  text-align: center;
}
</style>
