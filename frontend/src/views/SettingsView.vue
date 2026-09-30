<script setup>
import { onMounted, reactive, ref, computed } from 'vue';
import { useSettingsStore } from '../stores/settings.js';

const store = useSettingsStore();

// The "signal-cli-rest-api base URL" field below is the *internal* Docker
// network address (e.g. http://signal-api:8080) that only the backend
// container can resolve -- a browser can never open it directly. The QR
// link has to be opened by a human in an actual browser, so it needs the
// host-mapped port from docker-compose.yml (8081:8080) instead. If that
// port mapping is ever changed there, update the literal below too.
const SIGNAL_API_HOST_PORT = 8081;
const qrLinkUrl = computed(
  () => `${window.location.protocol}//${window.location.hostname}:${SIGNAL_API_HOST_PORT}/v1/qrcodelink?device_name=openproject-signal-bot`
);

const opForm = reactive({ baseUrl: '', apiKey: '', webhookSecret: '', phoneCustomField: '' });
const userFields = ref([]);
const signalForm = reactive({
  signalApiBaseUrl: '',
  botNumber: '',
  receiveTransport: 'auto',
  pollIntervalSeconds: 10,
  receiveEnabled: false,
  textMode: 'styled',
  groupingEnabled: true,
  groupingWindowSeconds: 60,
  allowDirectMessages: true,
  subscribeAllGroups: false,
  autoReplyEnabled: true,
  defaultReplayGroupId: '',
  defaultProjectId: '',
  defaultTypeId: '',
  inboundWebhookToken: '',
});

const groups = ref([]);
const groupsStatus = ref('');
const subscribedIds = ref([]);
// Kept whole (not just the ids) so the replay-group dropdown can name the
// subscribed groups without first fetching the live list from Signal.
const subscriptions = ref([]);

/**
 * Groups a replayed message can be attributed to. The live list when it has
 * been loaded, falling back to the subscriptions -- which is where a replay
 * would sensibly point anyway, and is available without a round trip.
 */
const replayGroupOptions = computed(() => {
  const byId = new Map(subscriptions.value.map((s) => [s.group_id, s.name]));
  for (const group of groups.value) byId.set(group.id, group.name);
  return [...byId].map(([id, name]) => ({ id, name: name || '(unnamed group)' }));
});

const opStatus = ref('');
const opError = ref('');
const linkStatus = ref(null);
const saving = ref(false);
const tab = ref('openproject');

onMounted(async () => {
  await Promise.all([store.fetchOpenProject(), store.fetchSignal()]);
  opForm.baseUrl = store.openproject.baseUrl ?? '';
  opForm.phoneCustomField = store.openproject.phoneCustomField ?? '';
  signalForm.signalApiBaseUrl = store.signal.signal_api_base_url ?? '';
  signalForm.botNumber = store.signal.bot_number ?? '';
  signalForm.receiveTransport = store.signal.receive_transport ?? 'auto';
  signalForm.pollIntervalSeconds = store.signal.poll_interval_seconds ?? 10;
  signalForm.receiveEnabled = Boolean(store.signal.receive_enabled);
  signalForm.textMode = store.signal.text_mode ?? 'styled';
  signalForm.groupingEnabled = Boolean(store.signal.grouping_enabled);
  signalForm.groupingWindowSeconds = store.signal.grouping_window_seconds ?? 60;
  signalForm.allowDirectMessages = Boolean(store.signal.allow_direct_messages);
  signalForm.subscribeAllGroups = Boolean(store.signal.subscribe_all_groups);
  signalForm.autoReplyEnabled = Boolean(store.signal.auto_reply_enabled);
  signalForm.defaultReplayGroupId = store.signal.default_replay_group_id ?? '';
  signalForm.defaultProjectId = store.signal.default_project_id ?? '';
  signalForm.defaultTypeId = store.signal.default_type_id ?? '';
  signalForm.inboundWebhookToken = store.signal.inbound_webhook_token ?? '';
  subscriptions.value = await store.signalSubscriptions().catch(() => []);
  subscribedIds.value = subscriptions.value.map((s) => s.group_id);
  checkLinkStatus();
});

async function saveOpenProject() {
  opError.value = '';
  saving.value = true;
  try {
    await store.saveOpenProject(opForm);
    opForm.apiKey = '';
    opForm.webhookSecret = '';
  } catch (err) {
    opError.value = err.message;
  } finally {
    saving.value = false;
  }
}

async function testConnection() {
  opStatus.value = 'Testing…';
  try {
    const result = await store.testOpenProjectConnection();
    opStatus.value = `Connected as ${result.user}`;
  } catch (err) {
    opStatus.value = `Failed: ${err.message}`;
  }
}

async function loadUserFields() {
  opStatus.value = 'Loading user fields…';
  try {
    userFields.value = await store.openprojectUserFields();
    opStatus.value = userFields.value.length
      ? `Found ${userFields.value.length} user custom field(s).`
      : 'No custom fields found on OpenProject user records.';
  } catch (err) {
    opStatus.value = `Failed: ${err.message}`;
  }
}

async function refreshMetadata() {
  opStatus.value = 'Refreshing…';
  try {
    const m = await store.refreshMetadata();
    const parts = [
      `${m.projects?.length ?? 0} projects`,
      `${m.types?.length ?? 0} types`,
      `${m.statuses?.length ?? 0} statuses`,
    ];
    // Endpoints degrade individually now; say which ones this OpenProject
    // version doesn't serve rather than pretending everything loaded.
    const missing = (m.unavailable ?? []).map((u) => u.key).join(', ');
    opStatus.value =
      `Refreshed: ${parts.join(', ')}.` + (missing ? ` Not available on this OpenProject: ${missing}.` : '');
  } catch (err) {
    opStatus.value = `Failed: ${err.message}`;
  }
}

async function saveSignal() {
  await store.saveSignal(signalForm);
  checkLinkStatus();
}

/**
 * Group ids are opaque base64 that the Signal app never shows, so the only
 * way to pick one is to list what the bot is actually a member of.
 */
async function loadGroups({ refresh = false } = {}) {
  groupsStatus.value = refresh ? 'Refreshing…' : 'Loading…';
  try {
    groups.value = await store.signalGroups({ refresh });
    groupsStatus.value = groups.value.length
      ? `${groups.value.length} group(s) found.`
      : 'The bot is not a member of any Signal group yet.';
  } catch (err) {
    groupsStatus.value = `Failed: ${err.message}`;
  }
}

async function saveSubscriptions() {
  groupsStatus.value = 'Saving…';
  try {
    const saved = await store.saveSubscriptions(subscribedIds.value);
    subscribedIds.value = saved.map((s) => s.group_id);
    groupsStatus.value = `Subscribed to ${saved.length} group(s).`;
  } catch (err) {
    groupsStatus.value = `Failed: ${err.message}`;
  }
}

const metadata = computed(() => store.openproject?.metadataCache ?? null);

const inboundWebhookUrl = computed(
  () => `${window.location.origin}/webhooks/signal${signalForm.inboundWebhookToken ? '/' + signalForm.inboundWebhookToken : ''}`
);

async function checkLinkStatus() {
  linkStatus.value = await store.signalLinkStatus().catch((err) => ({ linked: false, error: err.message }));
}

function copyWebhookUrl() {
  navigator.clipboard?.writeText(store.openproject.webhookUrl);
}
</script>

<template>
  <div v-if="store.openproject && store.signal" class="settings">
    <div class="header-row">
      <div>
        <h1>Settings</h1>
        <p class="hint" style="margin: 0.25rem 0 0">Connect OpenProject and the Signal transport.</p>
      </div>
    </div>

    <div class="tabs">
      <button class="tab" :class="{ active: tab === 'openproject' }" @click="tab = 'openproject'">OpenProject</button>
      <button class="tab" :class="{ active: tab === 'signal' }" @click="tab = 'signal'">Signal</button>
      <button class="tab" :class="{ active: tab === 'inbound' }" @click="tab = 'inbound'">Inbound Messages</button>
    </div>

    <div v-if="tab === 'openproject'" class="card">
      <h2>OpenProject connection</h2>
      <p class="hint">Used to verify webhook signatures and to fetch types/statuses/projects for the rule builder dropdowns.</p>
      <div v-if="opError" class="error-banner">{{ opError }}</div>

      <div class="field">
        <label>Base URL</label>
        <input v-model="opForm.baseUrl" placeholder="http://openproject.local" style="width: 100%" />
      </div>
      <div class="field">
        <label>API key {{ store.openproject.apiKeySet ? '(set — leave blank to keep)' : '' }}</label>
        <input v-model="opForm.apiKey" type="password" placeholder="from My Account → Access Tokens" style="width: 100%" />
      </div>
      <div class="field">
        <label>Webhook signature secret {{ store.openproject.webhookSecretSet ? '(set — leave blank to keep)' : '' }}</label>
        <input v-model="opForm.webhookSecret" type="password" style="width: 100%" />
      </div>
      <div class="field">
        <label>Phone custom field on OpenProject users (e.g. "Телефон")</label>
        <div style="display: flex; gap: 0.5rem; align-items: center">
          <input
            v-model="opForm.phoneCustomField"
            list="user-field-options"
            placeholder="customField5"
            style="width: 100%"
          />
          <datalist id="user-field-options">
            <option v-for="f in userFields" :key="f.key" :value="f.key">{{ f.name ?? f.key }}</option>
          </datalist>
          <button class="btn secondary" type="button" style="white-space: nowrap" @click="loadUserFields">Detect</button>
        </div>
        <p class="hint" style="margin-top: 0.25rem">
          Which user field holds the phone number to message. Used by <strong>Contacts &rarr; Sync from
          OpenProject</strong>, which creates a contact per user so rules can notify a work package's author.
          Click <em>Detect</em> to list the fields present on your users.
        </p>
      </div>
      <div class="field">
        <label>Webhook URL (paste into OpenProject Administration → Webhooks)</label>
        <div style="display: flex; gap: 0.5rem">
          <input :value="store.openproject.webhookUrl" readonly style="width: 100%" />
          <button class="btn secondary" type="button" @click="copyWebhookUrl">Copy</button>
        </div>
      </div>

      <div class="actions">
        <button class="btn" :disabled="saving" @click="saveOpenProject">Save</button>
        <button class="btn secondary" @click="testConnection">Test Connection</button>
        <button class="btn secondary" @click="refreshMetadata">Refresh Metadata</button>
      </div>
      <p v-if="opStatus" class="hint">{{ opStatus }}</p>
      <p v-if="store.openproject.metadataCache" class="hint">
        Cached: {{ store.openproject.metadataCache.types?.length ?? 0 }} types,
        {{ store.openproject.metadataCache.statuses?.length ?? 0 }} statuses,
        {{ store.openproject.metadataCache.projects?.length ?? 0 }} projects
        (fetched {{ store.openproject.metadataCache.fetchedAt }})
      </p>
    </div>

    <div v-if="tab === 'signal'" class="card">
      <h2>Signal connection</h2>
      <p class="hint">
        Link the bot's number once by opening
        <a :href="qrLinkUrl" target="_blank" rel="noopener">{{ qrLinkUrl }}</a>
        in a browser and scanning with Signal &rarr; Linked Devices, then enter the same number below.
        (This is the host-mapped port from <code>docker-compose.yml</code> — not the internal address below,
        which the backend container uses and your browser can't reach.)
      </p>

      <div class="field">
        <label>signal-cli-rest-api base URL <span class="hint-inline">(internal, backend-only — not for your browser)</span></label>
        <input v-model="signalForm.signalApiBaseUrl" style="width: 100%" />
      </div>
      <div class="field">
        <label>Bot's linked Signal number</label>
        <input v-model="signalForm.botNumber" placeholder="+15551234567" style="width: 100%" />
      </div>
      <div class="field">
        <label>
          <input type="checkbox" v-model="signalForm.groupingEnabled" style="width: auto" />
          Group messages before sending
        </label>
        <p class="hint" style="margin-top: 0.15rem">
          Waits briefly and combines everything headed to the same person into one Signal message, so a bulk edit in
          OpenProject doesn't fire off a separate notification per work package. A person with only one update still
          receives it exactly as their rule wrote it.
        </p>
      </div>
      <div v-if="signalForm.groupingEnabled" class="field">
        <label>Grouping window (seconds)</label>
        <input v-model.number="signalForm.groupingWindowSeconds" type="number" min="0" style="width: 110px" />
        <p class="hint" style="margin-top: 0.15rem">
          Counted from the first queued message, so this is also the longest a notification can be delayed &mdash;
          a continuing stream of edits won't keep postponing delivery.
        </p>
      </div>

      <div class="field">
        <label>Message formatting</label>
        <select v-model="signalForm.textMode">
          <option value="styled">Styled &mdash; render **bold**, *italic*, ~strike~, ||spoiler||, `mono`</option>
          <option value="normal">Plain &mdash; send all characters literally</option>
        </select>
        <p class="hint" style="margin-top: 0.15rem">
          Applies to every rule's message template. In styled mode Signal interprets those characters as markup, so a
          work package subject that happens to contain <code>*</code>, <code>~</code>, <code>|</code> or a backtick can
          render unexpectedly &mdash; switch to Plain if that becomes a problem.
        </p>
      </div>

      <div class="actions">
        <button class="btn" @click="saveSignal">Save</button>
        <button class="btn secondary" @click="checkLinkStatus">Check Link Status</button>
      </div>
      <p v-if="linkStatus" class="hint">
        <span class="badge" :class="linkStatus.linked ? 'sent' : 'failed'">{{ linkStatus.linked ? 'linked' : 'not linked' }}</span>
        <span v-if="linkStatus.error"> — {{ linkStatus.error }}</span>
      </p>
    </div>

    <div v-if="tab === 'inbound'" class="card">
      <h2>Inbound messages</h2>
      <p class="hint">
        Receiving lets inbound rules act on Signal messages &mdash; react, file an OpenProject ticket, or reply.
        Nothing is received, logged or acted on while this is off.
      </p>

      <div class="field">
        <label>
          <input type="checkbox" v-model="signalForm.receiveEnabled" style="width: auto" />
          Receive Signal messages
        </label>
      </div>

      <template v-if="signalForm.receiveEnabled">
        <div class="field">
          <label>Transport</label>
          <select v-model="signalForm.receiveTransport">
            <option value="auto">Automatic &mdash; detect from the container's MODE</option>
            <option value="websocket">WebSocket (json-rpc / json-rpc-native MODE)</option>
            <option value="poll">Poll GET /v1/receive (normal / native MODE)</option>
            <option value="webhook">None &mdash; something else posts to the inbound webhook</option>
          </select>
          <p class="hint">
            signal-cli-rest-api serves <code>/v1/receive</code> as a websocket in the json-rpc modes and as a plain
            <code>GET</code> otherwise; polling a json-rpc container just returns 400 forever. Leave this on
            Automatic unless a proxy makes the detection wrong.
          </p>
        </div>

        <div v-if="signalForm.receiveTransport === 'poll'" class="field">
          <label>Poll interval (seconds)</label>
          <input v-model.number="signalForm.pollIntervalSeconds" type="number" min="1" style="width: 100px" />
        </div>

        <div v-if="signalForm.receiveTransport === 'webhook'" class="field">
          <label>Inbound webhook token (optional)</label>
          <input v-model="signalForm.inboundWebhookToken" style="width: 100%" placeholder="leave blank for no token" />
          <p class="hint">Post envelopes to <code>{{ inboundWebhookUrl }}</code>.</p>
        </div>

        <div class="field">
          <label>
            <input type="checkbox" v-model="signalForm.allowDirectMessages" style="width: auto" />
            Listen to direct messages sent to the bot
          </label>
        </div>

        <div class="field">
          <label>
            <input type="checkbox" v-model="signalForm.subscribeAllGroups" style="width: auto" />
            Listen to every group the bot is in
          </label>
          <p class="hint">Otherwise only the groups ticked below are received.</p>
        </div>

        <div v-if="!signalForm.subscribeAllGroups" class="field">
          <label>Subscribed groups</label>
          <div class="actions" style="margin-bottom: 0.5rem">
            <button class="btn secondary" @click="loadGroups({ refresh: true })">Load groups from Signal</button>
            <button class="btn secondary" :disabled="groups.length === 0" @click="saveSubscriptions">Save subscriptions</button>
          </div>
          <p v-if="groupsStatus" class="hint">{{ groupsStatus }}</p>
          <ul v-if="groups.length" class="group-list">
            <li v-for="group in groups" :key="group.id">
              <label>
                <input type="checkbox" :value="group.id" v-model="subscribedIds" style="width: auto" />
                {{ group.name || '(unnamed group)' }}
                <span class="hint-inline">&nbsp;{{ group.membersCount }} members</span>
              </label>
            </li>
          </ul>
          <p v-else-if="subscribedIds.length" class="hint">
            {{ subscribedIds.length }} group(s) subscribed. Load the list to change them.
          </p>
        </div>

        <div class="field">
          <label>
            <input type="checkbox" v-model="signalForm.autoReplyEnabled" style="width: auto" />
            Confirm created tickets back to the conversation
          </label>
          <p class="hint">Sends the new work package's number and link wherever the request came from.</p>
        </div>

        <div class="field">
          <label>Group for replayed messages</label>
          <select v-model="signalForm.defaultReplayGroupId">
            <option value="">
              {{ subscribedIds.length === 1 ? 'The one subscribed group (automatic)' : 'None — group-scoped rules will not match' }}
            </option>
            <option v-for="group in replayGroupOptions" :key="group.id" :value="group.id">{{ group.name }}</option>
          </select>
          <p class="hint">
            A message forwarded to the bot with <code>/process&nbsp;Name</code> is replayed as if it had arrived
            here, so rules scoped to a group still match it. Only approval recipients may run the command.
            With exactly one subscribed group this can be left automatic — and running <code>/process</code>
            in a subscribed group replays it into that group whatever is chosen here. The bot replies with
            what the replay filed, or why no rule matched.
          </p>
        </div>

        <div class="row">
          <div class="field">
            <label>Default project for tickets</label>
            <select v-model="signalForm.defaultProjectId">
              <option value="">None &mdash; each rule must set one</option>
              <option v-for="p in metadata?.projects" :key="p.id" :value="String(p.id)">{{ p.name }}</option>
            </select>
          </div>
          <div class="field">
            <label>Default type</label>
            <select v-model="signalForm.defaultTypeId">
              <option value="">OpenProject default</option>
              <option v-for="t in metadata?.types" :key="t.id" :value="String(t.id)">{{ t.name }}</option>
            </select>
          </div>
        </div>
        <p class="hint">Used by any inbound rule that doesn't pick its own project or type.</p>
      </template>

      <div class="actions">
        <button class="btn" @click="saveSignal">Save</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings { max-width: 760px; }
.hint { color: var(--text-muted); font-size: 0.82rem; margin: 0.25rem 0 0.75rem; }
.tabs { display: flex; gap: 0.25rem; margin-bottom: 1rem; border-bottom: 1px solid var(--border); }
.tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-muted);
  cursor: pointer;
  font: inherit;
  padding: 0.5rem 0.75rem;
}
.tab.active { border-bottom-color: var(--primary); color: var(--text); }
.hint-inline { color: var(--text-faint); font-weight: 400; }
.row { display: flex; gap: 1.5rem; flex-wrap: wrap; }
.group-list { list-style: none; margin: 0; padding: 0; max-height: 15rem; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; }
.group-list li { padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border); }
.group-list li:last-child { border-bottom: none; }
.actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
code { background: var(--surface-2); padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.8rem; }
</style>
