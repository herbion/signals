<script setup>
import { ref, reactive, onMounted, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  useInboundRulesStore,
  inboundRuleToForm,
  inboundRuleToPayload,
  newAction,
  ACTION_LABELS,
  EMOJI_CHOICES,
  MATCH_LABELS,
  FAN_OUT_LABELS,
  NATURAL_VARIABLES,
} from '../stores/inboundRules.js';
import { useContactsStore } from '../stores/contacts.js';
import FieldMappingEditor from '../components/FieldMappingEditor.vue';
import TreeSelect from '../components/TreeSelect.vue';
import { useSettingsStore } from '../stores/settings.js';

const props = defineProps({ id: { type: [String, Number], default: null } });
const router = useRouter();
const store = useInboundRulesStore();
const contactsStore = useContactsStore();
// The number goes into the label so a contact can be found by it too; group
// ids are long base64 and only clutter the list.
const contactOptions = computed(() =>
  contactsStore.contacts.map((c) => ({
    id: String(c.id),
    label: c.type === 'group' ? `${c.name} (group)` : `${c.name} · ${c.signal_identifier}`,
  }))
);
const settingsStore = useSettingsStore();

const isNew = computed(() => !props.id);
// The natural-language parser reads the message instead of matching a pattern,
// so this hides the pattern box and turns on the fan-out controls.
const isNatural = computed(() => form.matchType === 'natural');
const error = ref('');
const saving = ref(false);
const metadata = ref(null);
const subscriptions = ref([]);
// Active OpenProject users, for a "choose by another field's value" mapping
// (e.g. assignee-by-🌀Тип-довідки) whose target field has no closed list of
// its own to pick from.
const openprojectUsers = ref([]);
// Settings → Signal defaults, used when an action leaves project/type blank.
const defaultProjectId = ref('');
const defaultTypeId = ref('');

const form = reactive(
  inboundRuleToForm({ actions: [{ action_type: 'send_message', reply_target: 'source' }] })
);

// --- pattern tester ---------------------------------------------------
const sample = ref('');
const testResult = ref(null);
const testError = ref('');

onMounted(async () => {
  contactsStore.fetchAll();
  settingsStore.signalSubscriptions().then((rows) => { subscriptions.value = rows; }).catch(() => {});
  settingsStore
    .fetchOpenProject()
    .then(() => { metadata.value = settingsStore.openproject?.metadataCache ?? null; })
    .catch(() => { metadata.value = null; });
  settingsStore
    .fetchSignal()
    .then(() => {
      defaultProjectId.value = settingsStore.signal?.default_project_id ?? '';
      defaultTypeId.value = settingsStore.signal?.default_type_id ?? '';
    })
    .catch(() => {});
  settingsStore.openprojectUsers().then((users) => { openprojectUsers.value = users; }).catch(() => {});

  if (!isNew.value) {
    Object.assign(form, inboundRuleToForm(await store.fetchOne(props.id)));
  }
});

/**
 * Every group the rule can be pointed at: the subscribed ones, plus any id the
 * rule already carries that is no longer subscribed -- dropping one silently
 * because Settings changed would widen the rule without anyone asking.
 */
const groupOptions = computed(() => {
  const options = subscriptions.value.map((s) => ({
    groupId: s.group_id,
    name: s.name || s.group_id,
    subscribed: true,
  }));
  for (const id of form.sourceGroupIds) {
    if (!options.some((option) => option.groupId === id)) {
      options.push({ groupId: id, name: id, subscribed: false });
    }
  }
  return options;
});

const groupHint = computed(() => {
  const picked = form.sourceGroupIds.length;
  const direct = form.sourceScope === 'any' ? ' Direct messages are unaffected by this list.' : '';
  if (picked === 0) return `Nothing ticked: every subscribed group.${direct}`;
  return `Only the ${picked} group${picked === 1 ? '' : 's'} ticked above.${direct}`;
});

function toggleGroup(groupId) {
  const index = form.sourceGroupIds.indexOf(groupId);
  if (index === -1) form.sourceGroupIds.push(groupId);
  else form.sourceGroupIds.splice(index, 1);
}

// A direct-only rule has no group half to narrow, and the backend stores no
// list for one -- drop it here too so the form matches what will be saved.
watch(
  () => form.sourceScope,
  (scope) => { if (scope === 'direct') form.sourceGroupIds = []; }
);

const projects = computed(() => metadata.value?.projects ?? []);

/**
 * A project only accepts work packages of the types enabled on it, so offering
 * the full type list would let a rule be built that OpenProject always rejects.
 */
function typesFor(projectId) {
  const all = metadata.value?.types ?? [];
  const allowed = metadata.value?.projectTypes?.[projectId];
  if (!projectId || !allowed) return all;
  return all.filter((t) => allowed.includes(t.id));
}

// Loaded schemas, keyed by "projectId-typeId".
const schemas = ref({});
const schemaStatus = ref({});

function schemaKeyFor(action) {
  const projectId = action.projectId || defaultProjectId.value;
  const typeId = action.typeId || defaultTypeId.value;
  return projectId && typeId ? `${projectId}-${typeId}` : null;
}
function schemaFor(action) {
  const key = schemaKeyFor(action);
  return key ? schemas.value[key] ?? null : null;
}

/** Fields a rule must supply: required, writable, and with no default. */
function requiredFields(action) {
  return (schemaFor(action)?.fields ?? []).filter((f) => f.required && f.writable && !f.hasDefault);
}
/** Everything else worth offering, without burying the required ones. */
function optionalFields(action) {
  return (schemaFor(action)?.fields ?? []).filter(
    (f) => f.writable && !(f.required && !f.hasDefault) && !['subject', 'description'].includes(f.key)
  );
}
/** Present but not writable — e.g. a subject OpenProject generates itself. */
function generatedSubject(action) {
  const subject = (schemaFor(action)?.fields ?? []).find((f) => f.key === 'subject');
  return subject && !subject.writable ? subject : null;
}

async function loadSchema(action) {
  const projectId = action.projectId || defaultProjectId.value;
  const typeId = action.typeId || defaultTypeId.value;
  const key = schemaKeyFor(action);
  if (!key) {
    schemaStatus.value = { ...schemaStatus.value, none: 'Pick a project and a type first.' };
    return;
  }
  schemaStatus.value = { ...schemaStatus.value, [key]: 'Loading…' };
  try {
    const schema = await settingsStore.openprojectSchema({ projectId, typeId });
    schemas.value = { ...schemas.value, [key]: schema };
    const required = schema.fields.filter((f) => f.required && f.writable && !f.hasDefault);
    schemaStatus.value = {
      ...schemaStatus.value,
      [key]: required.length
        ? `This type requires ${required.length} field(s).`
        : 'This type needs nothing beyond the subject.',
    };
  } catch (err) {
    schemaStatus.value = { ...schemaStatus.value, [key]: `Failed: ${err.message}` };
  }
}

function fieldValue(action, key) {
  return action.fieldTemplates?.[key] ?? '';
}
/** A mapping the editor emptied is removed, not stored as a blank one. */
function setFieldValue(action, key, value) {
  const next = { ...(action.fieldTemplates ?? {}) };
  if (value === null || value === undefined || value === '') delete next[key];
  else next[key] = value;
  action.fieldTemplates = next;
}

/** Variables the current pattern makes available, for the help line. */
const captureVariables = computed(() => {
  if (!testResult.value?.matched) return [];
  return Object.keys(testResult.value.groups ?? {});
});

async function runTest() {
  testError.value = '';
  testResult.value = null;
  try {
    testResult.value = await store.testPattern({
      matchType: form.matchType,
      pattern: form.pattern,
      patternFlags: form.patternFlags,
      sourceScope: form.sourceScope,
      isGroup: form.sourceScope !== 'direct',
      sampleText: sample.value,
      // Preview the same number of tickets the rule would actually file.
      fanOut: form.actions.find((action) => action.actionType === 'create_ticket')?.fanOut ?? 'pair',
      templates: Object.fromEntries(
        form.actions.flatMap((action, index) => {
          const label = `${index + 1}. ${ACTION_LABELS[action.actionType]}`;
          if (action.actionType === 'send_message') return [[label, action.messageTemplate]];
          if (action.actionType === 'create_ticket') return [[`${label} (subject)`, action.subjectTemplate]];
          return [];
        })
      ),
    });
  } catch (err) {
    testError.value = err.message;
  }
}

// Re-testing on every keystroke would be noisy; clear the stale result instead
// so nobody reads an outcome that belongs to an older pattern.
watch(() => [form.pattern, form.matchType, form.patternFlags], () => { testResult.value = null; });

function addAction(type) {
  form.actions.push(newAction(type));
}
/** Switching an existing action to "react" needs the same emoji default. */
function onActionTypeChange(action) {
  if (action.actionType === 'react' && !action.emoji) action.emoji = EMOJI_CHOICES[0];
}
function removeAction(index) {
  form.actions.splice(index, 1);
}
function moveAction(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= form.actions.length) return;
  const [action] = form.actions.splice(index, 1);
  form.actions.splice(target, 0, action);
}

async function save() {
  error.value = '';
  saving.value = true;
  try {
    const payload = inboundRuleToPayload(form);
    if (isNew.value) await store.create(payload);
    else await store.update(props.id, payload);
    router.push({ name: 'rules' });
  } catch (err) {
    error.value = err.message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div>
    <h1>{{ isNew ? 'New inbound rule' : 'Edit inbound rule' }}</h1>
    <p class="hint">
      Inbound rules run on Signal messages the bot receives, in priority order. The first matching rule runs all of
      its actions.
    </p>
    <div v-if="error" class="error-banner">{{ error }}</div>

    <div class="card">
      <div class="field">
        <label>Name</label>
        <input v-model="form.name" placeholder="e.g. File a ticket from !task" style="width: 100%" />
      </div>
      <div class="row">
        <div class="field">
          <label>Priority</label>
          <input v-model.number="form.priority" type="number" style="width: 100px" />
          <p class="hint">Higher runs first.</p>
        </div>
        <div class="field">
          <label><input type="checkbox" v-model="form.enabled" style="width: auto" /> Enabled</label>
          <label>
            <input type="checkbox" v-model="form.stopProcessing" style="width: auto" />
            Stop after this rule matches
          </label>
          <p class="hint">Turn off to let lower-priority rules act on the same message too.</p>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Listen to</h2>
      <div class="field">
        <label>Message source</label>
        <select v-model="form.sourceScope" style="width: 100%">
          <option value="any">Groups and direct messages</option>
          <option value="group">Group messages only</option>
          <option value="direct">Direct messages to the bot only</option>
        </select>
      </div>
      <div v-if="form.sourceScope !== 'direct'" class="field">
        <label>Restrict to groups</label>
        <p v-if="groupOptions.length === 0" class="hint">
          No groups subscribed yet — add them in <strong>Settings → Inbound messages</strong>.
        </p>
        <label v-for="g in groupOptions" :key="g.groupId" class="group-choice">
          <input
            type="checkbox"
            style="width: auto"
            :checked="form.sourceGroupIds.includes(g.groupId)"
            @change="toggleGroup(g.groupId)"
          />
          {{ g.name }}
          <span v-if="!g.subscribed" class="hint">— no longer subscribed</span>
        </label>
        <p class="hint">
          {{ groupHint }}
          Only groups subscribed in <strong>Settings → Inbound messages</strong> are received at all; this narrows
          the rule further.
        </p>
      </div>
    </div>

    <div class="card">
      <h2>Parser</h2>
      <div class="field">
        <label>Match</label>
        <select v-model="form.matchType" style="width: 100%">
          <option v-for="(label, value) in MATCH_LABELS" :key="value" :value="value">{{ label }}</option>
        </select>
        <p v-if="isNatural" class="hint">
          Reads the message the way it was written &mdash; rank, name and requested forms &mdash; and matches only
          when it finds both a person and at least one form. Handles
          <code>ф5</code>, <code>Ф-12</code>, <code>довідка форми 5</code> and
          <code>Довідка в/с (замість ВК)</code> (filed under its OpenProject name,
          <em>Довідка щодо військовослужбовця</em>), one name or a list of them, with the forms named before or after.
          A message it cannot read falls through to the next rule.
        </p>
      </div>

      <div v-if="form.matchType === 'regex' || form.matchType === 'contains'" class="field">
        <label>{{ form.matchType === 'regex' ? 'Pattern' : 'Text' }}</label>
        <input v-model="form.pattern" class="mono" :placeholder="form.matchType === 'regex' ? '^!task\\s+(?&lt;subject&gt;.+)$' : 'help' " style="width: 100%" />
        <p v-if="form.matchType === 'regex'" class="hint">
          Capture groups become template variables: <code>{1}</code>, <code>{2}</code>… by position, or
          <code>{name}</code> for a named group like <code>(?&lt;name&gt;…)</code>.
        </p>
      </div>

      <div v-if="form.matchType === 'regex'" class="field">
        <label>Flags</label>
        <input v-model="form.patternFlags" class="mono" style="width: 100px" placeholder="i" />
        <p class="hint">
          <code>i</code> ignore case (default), <code>m</code> multiline, <code>s</code> dot matches newlines.
        </p>
      </div>

      <div class="tester">
        <label>Try it against a sample message</label>
        <textarea
          v-model="sample"
          :rows="isNatural ? 4 : 3"
          class="mono"
          :placeholder="isNatural ? 'Потрібна ф5 та ф12 на майор Іванов Іван Іванович' : '!task The printer on floor 2 is jammed'"
        ></textarea>
        <button class="btn secondary" @click="runTest">Test pattern</button>

        <p v-if="testError" class="test-fail">{{ testError }}</p>
        <template v-else-if="testResult">
          <p v-if="!testResult.matched" class="test-fail">No match &mdash; this rule would not fire.</p>
          <div v-else class="test-pass">
            <template v-if="testResult.parsed">
              <p><strong>Read as {{ testResult.parsed.requests.length }} request(s):</strong></p>
              <ul>
                <li v-for="(request, index) in testResult.parsed.requests" :key="index">
                  {{ request.label }} → {{ request.forms.join(', ') }}
                  <span v-if="request.note" class="hint">({{ request.note }})</span>
                  <span v-if="request.purpose" class="hint">— {{ request.purpose }}</span>
                </li>
              </ul>
              <p v-if="testResult.items && testResult.items.length">
                <strong>Would file {{ testResult.items.length }} work package(s):</strong>
              </p>
              <ul>
                <li v-for="(item, index) in testResult.items" :key="'item' + index">
                  {{ item.variables.person }} — {{ item.variables.forms }}
                  <span v-for="(value, key) in item.rendered" :key="key" class="hint"> · {{ value }}</span>
                </li>
              </ul>
              <p v-if="testResult.parsed.warnings.length" class="hint">
                {{ testResult.parsed.warnings.join('; ') }}
              </p>
            </template>
            <template v-else>
            <p><strong>Matches.</strong> Captured:</p>
            <ul v-if="captureVariables.length">
              <li v-for="key in captureVariables" :key="key">
                <code>{{ '{' + key + '}' }}</code> → “{{ testResult.groups[key] }}”
              </li>
            </ul>
            <p v-else class="hint">No capture groups &mdash; use <code>{message}</code> or <code>{rest}</code>.</p>
            </template>
            <template v-if="!testResult.parsed && Object.keys(testResult.rendered || {}).length">
              <p><strong>Your templates would render as:</strong></p>
              <ul>
                <li v-for="(value, key) in testResult.rendered" :key="key">
                  {{ key }}: “{{ value }}”
                </li>
              </ul>
            </template>
          </div>
        </template>

        <div v-if="isNatural" class="hint">
          From the parsed request:
          <span v-for="([name, example]) in NATURAL_VARIABLES" :key="name">
            <code>{{ '{' + name + '}' }}</code> <em>{{ example }}</em>{{ ' ' }}
          </span>
        </div>
        <p class="hint">
          Always available: <code>{message}</code>, <code>{rest}</code> (message minus the match),
          <code>{first_line}</code>, <code>{body}</code>, <code>{sender}</code>, <code>{sender_number}</code>,
          <code>{group_name}</code>, <code>{date}</code>.
        </p>
      </div>
    </div>

    <div class="card">
      <h2>Actions</h2>
      <p class="hint">Run in order when the rule matches.</p>

      <p v-if="form.actions.length === 0" class="hint">No actions yet &mdash; add at least one.</p>

      <div v-for="(action, index) in form.actions" :key="index" class="action">
        <div class="action-head">
          <select v-model="action.actionType" @change="onActionTypeChange(action)">
            <option v-for="(label, value) in ACTION_LABELS" :key="value" :value="value">{{ label }}</option>
          </select>
          <div class="action-buttons">
            <button class="btn secondary" :disabled="index === 0" @click="moveAction(index, -1)">↑</button>
            <button class="btn secondary" :disabled="index === form.actions.length - 1" @click="moveAction(index, 1)">↓</button>
            <button class="btn danger" @click="removeAction(index)">Remove</button>
          </div>
        </div>

        <div v-if="action.actionType === 'react'" class="field">
          <label>Emoji</label>
          <div class="emoji-row">
            <input v-model="action.emoji" class="emoji-input" />
            <button
              v-for="choice in EMOJI_CHOICES"
              :key="choice"
              type="button"
              class="emoji-choice"
              :class="{ active: action.emoji === choice }"
              @click="action.emoji = choice"
            >{{ choice }}</button>
          </div>
          <p class="hint">Reacts to the message that matched, in the conversation it arrived in.</p>
        </div>

        <template v-if="action.actionType === 'create_ticket'">
          <div class="row">
            <div class="field">
              <label>Project</label>
              <select v-model="action.projectId">
                <option value="">Default from Settings</option>
                <option v-for="p in projects" :key="p.id" :value="String(p.id)" :disabled="p.active === false">
                  {{ p.name }}{{ p.active === false ? ' (archived)' : '' }}
                </option>
              </select>
            </div>
            <div class="field">
              <label>Type</label>
              <select v-model="action.typeId">
                <option value="">Default from Settings</option>
                <option
                  v-for="t in typesFor(action.projectId || defaultProjectId)"
                  :key="t.id"
                  :value="String(t.id)"
                >{{ t.name }}</option>
              </select>
            </div>
          </div>

          <div class="field">
            <label>Days to complete</label>
            <input
              v-model.number="action.durationDays"
              type="number"
              min="1"
              step="1"
              style="width: 120px"
              placeholder="e.g. 10"
            />
            <p class="hint">
              Sets Start date to today and Finish date that many days later. Leave blank to not set either date this
              way &mdash; mapping <code>startDate</code> / <code>dueDate</code> by hand below always wins over this.
            </p>
          </div>

          <div v-if="isNatural" class="field">
            <label>One message becomes</label>
            <select v-model="action.fanOut" style="width: 100%">
              <option v-for="(label, value) in FAN_OUT_LABELS" :key="value" :value="value">{{ label }}</option>
            </select>
            <p class="hint">
              &ldquo;ф5 та ф12 на Іванов&rdquo; is two certificates. Per certificate files one work package for each,
              which is what a single-valued &ldquo;Тип довідки&rdquo; field can hold; per person files one with
              <code>{forms}</code> listing them. Reactions and replies always happen once per message.
            </p>
          </div>

          <div class="field">
            <button class="btn secondary" @click="loadSchema(action)">Load fields for this type</button>
            <p v-if="schemaStatus[schemaKeyFor(action) ?? 'none']" class="hint">
              {{ schemaStatus[schemaKeyFor(action) ?? 'none'] }}
            </p>
            <p class="hint">
              An OpenProject type can make its own fields mandatory, and can generate the subject itself. Load them
              here so this rule fills in what the type actually needs.
            </p>
          </div>

          <div v-if="generatedSubject(action)" class="field">
            <label>Subject</label>
            <p class="hint generated">
              OpenProject generates the subject for this type ({{ generatedSubject(action).placeholder || 'from a pattern' }}),
              so anything set here is ignored.
            </p>
          </div>
          <div v-else class="field">
            <label>Subject template</label>
            <input
              v-model="action.subjectTemplate"
              class="mono"
              style="width: 100%"
              :placeholder="isNatural ? '{form} — {person}' : '{subject}'"
            />
            <p class="hint">
              {{ isNatural
                ? 'Leave blank to use the first line of the message — a parsed rule usually wants {form} — {person}.'
                : 'Leave blank to use the message text after the matched part.' }}
            </p>
          </div>

          <FieldMappingEditor
            v-for="field in requiredFields(action)"
            :key="field.key"
            :field="field"
            :required="true"
            :mapping="fieldValue(action, field.key)"
            :schema-fields="schemaFor(action)?.fields ?? []"
            :users="openprojectUsers"
            @update:mapping="setFieldValue(action, field.key, $event)"
          />

          <div class="field">
            <label>Description template</label>
            <textarea
              v-model="action.descriptionTemplate"
              rows="10"
              class="mono"
              placeholder="{message}"
            ></textarea>
            <p class="hint">
              Blank uses the whole message. This is sent to OpenProject as-is, so a full HTML layout &mdash; tables,
              <code>&lt;figure&gt;</code>, links &mdash; works exactly as it would if typed straight into OpenProject's
              own rich text editor. Add <code>|urlencode</code> to a variable to use it safely inside a URL, e.g.
              <code>{base_url}/search?q={person|urlencode}</code>.
            </p>
            <label>
              <input type="checkbox" v-model="action.includeProvenance" style="width: auto" />
              Append &ldquo;Reported by / Source / Received&rdquo; after the description
            </label>
            <p class="hint">
              Turn off when the template above is already a complete layout with its own who/where/when &mdash;
              otherwise it's added as a footer, not glued above your HTML.
            </p>
          </div>

          <div class="field">
            <label>Confirm the created ticket to</label>
            <select v-model="action.confirmTarget">
              <option value="source">Where the request came from (group, or the sender in a DM)</option>
              <option value="reviewer">The reviewer who approved it</option>
            </select>
            <p class="hint">
              Only sent when "Auto-reply with ticket confirmation" is on in Settings → Signal.
              <template v-if="action.confirmTarget === 'reviewer'">
                Goes to the review recipient set below under "Review and failures" — required for this option.
              </template>
            </p>
          </div>

          <details v-if="optionalFields(action).length" class="optional">
            <summary>Other fields on this type ({{ optionalFields(action).length }})</summary>
            <FieldMappingEditor
              v-for="field in optionalFields(action)"
              :key="field.key"
              :field="field"
              :mapping="fieldValue(action, field.key)"
              :schema-fields="schemaFor(action)?.fields ?? []"
              :users="openprojectUsers"
              @update:mapping="setFieldValue(action, field.key, $event)"
            />
          </details>
        </template>

        <template v-if="action.actionType === 'send_message'">
          <div class="field">
            <label>Message template</label>
            <textarea v-model="action.messageTemplate" rows="2" class="mono" placeholder="Thanks {sender}, filing that now."></textarea>
          </div>
          <div class="field">
            <label>Send to</label>
            <select v-model="action.replyTarget">
              <option value="source">Where the message came from (group, or the sender in a DM)</option>
              <option value="sender">The sender directly</option>
              <option value="contact">A specific contact</option>
              <option value="raw">A number or group id</option>
            </select>
          </div>
          <div v-if="action.replyTarget === 'contact'" class="field">
            <label>Contact</label>
            <TreeSelect
              v-model="action.replyContactId"
              :options="contactOptions"
              empty-label="Select…"
              search-placeholder="Search contacts…"
            />
          </div>
          <div v-if="action.replyTarget === 'raw'" class="field">
            <label>Number or group id</label>
            <input v-model="action.replyRaw" class="mono" style="width: 100%" placeholder="+380… or group.…" />
          </div>
        </template>

        <details class="optional">
          <summary>Review and failures</summary>

          <div class="field">
            <label>
              <input type="checkbox" v-model="action.requireApproval" style="width: auto" />
              Hold for human review before running
            </label>
            <p class="hint">
              The bot sends what it is about to do to the number below and waits. React <strong>✅</strong> or
              <strong>👍</strong> to that message to run it, <strong>❌</strong> or <strong>👎</strong> to drop it.
              Other actions on this rule still run right away, so the sender is not left in silence.
            </p>
          </div>
          <div v-if="action.requireApproval || action.confirmTarget === 'reviewer'" class="field">
            <label>Send the review request to</label>
            <input v-model="action.approvalRecipient" class="mono" style="width: 100%" placeholder="+380…" />
            <p v-if="!action.requireApproval" class="hint">
              This action isn't held for review, but its ticket confirmation is set to go to this number.
            </p>
          </div>

          <div class="field">
            <label>Tell someone when this action fails</label>
            <input v-model="action.failureRecipient" class="mono" style="width: 100%" placeholder="+380… (optional)" />
            <p class="hint">
              A failure is always written to the message log; this also sends the reason, and the message it came
              from, as a Signal message. Leave blank for no notification.
            </p>
          </div>
        </details>
      </div>

      <div class="add-actions">
        <button class="btn secondary" @click="addAction('react')">+ React</button>
        <button class="btn secondary" @click="addAction('create_ticket')">+ Create ticket</button>
        <button class="btn secondary" @click="addAction('send_message')">+ Send message</button>
      </div>
    </div>

    <!-- Repeated next to the button: the Save control sits well below the fold
         on a rule with several actions, and an error only at the top of the
         page reads as "nothing happened". -->
    <div v-if="error" class="error-banner">{{ error }}</div>
    <div class="actions">
      <button class="btn" :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save rule' }}</button>
      <button class="btn secondary" @click="router.push({ name: 'rules' })">Cancel</button>
    </div>
  </div>
</template>

<style scoped>
h1 { margin-bottom: 0.25rem; }
h2 { margin-top: 0; font-size: 1.05rem; margin-bottom: 0.75rem; }
.card { margin-bottom: 1rem; }
.row { display: flex; gap: 1.5rem; flex-wrap: wrap; }
.hint { color: var(--text-muted); font-size: 0.82rem; margin: 0.25rem 0 0.75rem; }
.actions { display: flex; gap: 0.5rem; }
.group-choice { display: flex; align-items: center; gap: 0.4rem; font-weight: normal; margin-bottom: 0.2rem; }
.group-choice .hint { margin: 0; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; }
textarea.mono { width: 100%; }

.tester {
  border-top: 1px solid var(--border);
  margin-top: 1rem;
  padding-top: 1rem;
}
.tester textarea { width: 100%; margin-bottom: 0.5rem; }
.test-pass { color: var(--success, #28c76f); font-size: 0.85rem; }
.test-fail { color: var(--danger); font-size: 0.85rem; }
.test-pass ul, .test-fail ul { margin: 0.25rem 0 0.75rem 1.1rem; }

.action {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.85rem;
  margin-bottom: 0.75rem;
  background: var(--surface-2);
}
.action-head { display: flex; gap: 0.5rem; justify-content: space-between; margin-bottom: 0.75rem; }
.action-head select { flex: 1; }
.action-buttons { display: flex; gap: 0.35rem; }
.add-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.emoji-row { display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; }
.emoji-input { width: 4.5rem; text-align: center; font-size: 1.1rem; }
.emoji-choice {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  font-size: 1.1rem;
  line-height: 1;
  padding: 0.3rem 0.45rem;
}
.emoji-choice.active { border-color: var(--primary); background: var(--surface-2); }
.required {
  background: var(--danger);
  border-radius: 3px;
  color: #fff;
  font-size: 0.65rem;
  font-weight: 600;
  margin-left: 0.35rem;
  padding: 0.05rem 0.3rem;
  text-transform: uppercase;
  vertical-align: middle;
}
.generated { font-style: italic; }
.optional { margin-bottom: 0.75rem; }
.optional summary { cursor: pointer; color: var(--text-muted); font-size: 0.85rem; margin-bottom: 0.5rem; }
code { background: var(--surface-2); padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.8rem; }
</style>
