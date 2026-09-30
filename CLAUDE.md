# OpenProject ↔ Signal Bridge

An app that receives OpenProject work package webhooks, figures out what
actually changed (OpenProject only sends full current state, never a diff),
evaluates admin-defined rules against that change, and sends Signal messages
via `bbernhard/signal-cli-rest-api`. A Vue dashboard manages rules, contacts,
connection settings, and shows message history.

Read this file before adding features — it captures decisions and quirks
that aren't obvious from the code alone.

## Architecture

```
OpenProject --webhook(HMAC)--> POST /webhooks/openproject/:token
                                    |
                        payloadNormalizer: HAL+JSON -> flat WorkPackageSnapshot
                                    |
                        diffEngine.processWebhookEvent (synchronous, must
                        succeed before we respond -- see Diffing below)
                                    |
                          [response sent here: 200 or 500]
                                    |
                    ruleProcessor.processChangeEvent (async, fire-and-forget;
                    failures never turn into a 500 / webhook retry)
                                    |
                          ruleEvaluator against every enabled rule
                                    |
                         (rule matches) -> templateRenderer -> signalSender
                                    |                              |
                                    v                              v
                            message_log (failed)          message_log (sent)

separately (inbound):
  signalReceiver (websocket or GET poll) / POST /webhooks/signal
      |
      v
  inboundMessageHandler
      |  drop own/sync messages -> dedup on (author, sent timestamp)
      |  -> /process command? (replayCommand, before the subscription check)
      |       forwarded text + named author -> synthetic envelope -> runRules
      |  -> subscription check (group subscribed? DMs allowed?)
      |  -> message_log (inbound, received)
      v
  inboundMatcher: source scope + parser
      |    regex / contains / any -> capture groups -> template variables
      |    natural -> naturalParser: ПІБ + certificate forms -> one item per
      |               requested certificate (create_ticket runs once per item)
      v
  inboundRuleActions, in order, for the first matching rule
      |
      |     (action needs approval) -> pending_approvals + review message
      |          ^                                              |
      |          +--- reviewer reacts ✅/👍 (or ❌/👎) ----------+
      |
      +---> signalSender.sendReaction   (react with emoji)
      |
      +---> createWorkPackage           (OpenProject API v3, sender as author)
      |
      +---> signalSender.sendMessage    (reply to group / sender / contact / raw)
```

Single Node.js/Express process serves both the JSON API (`/api/*`) and the
built Vue static assets (`frontend/dist`, if present). `bbernhard/signal-cli-rest-api`
runs as a second docker-compose service and is the only thing that talks to
Signal. OpenProject itself is external -- not part of this stack.

## Directory Layout

```
backend/src/
  db/            connection.js (node:sqlite), migrations/001_init.sql, seed.js
  webhooks/      openproject.controller.js, signatureVerifier.js, payloadNormalizer.js
  diff/          diffEngine.js, stateCache.repository.js
  rules/         ruleEvaluator.js, templateRenderer.js, rules.repository.js,
                 rules.controller.js, ruleProcessor.js (orchestrates evaluator + sender + logging)
  signal/        signalSender.js (send + react), signalReceiver.js (websocket/poll),
                 signalGroups.js (group id translation), subscriptions.repository.js,
                 inboundMessageHandler.js, inboundEnvelope.js, inboundMatcher.js,
                 replayCommand.js (`/process` -- re-run a missed message),
                 naturalParser.js (free-text ПІБ + form extraction),
                 nominativeCase.js (ПІБ -> називний відмінок),
                 approvals.js (hold an action for human review),
                 inboundActionExecutor.js
  inboundRules/  inboundRules.repository.js, inboundRules.controller.js
  openproject/   openprojectClient.js (metadata fetch for rule-builder dropdowns)
  contacts/, messageLog/, settings/, auth/    controller.js + repository.js pairs
  api/router.js  mounts everything under /api, JWT-gated except /auth/login
  index.js       bootstrap: migrations, seed, webhook router (raw body), api
                 router (json body), static frontend, signal receive poller

frontend/src/
  styles/theme.css  design tokens + base component styles (see below)
  stores/        Pinia: auth, theme, rules, contacts, settings, messageLog
  views/         LoginView, DashboardView, RulesListView, RuleEditorView, ContactsView, SettingsView
  components/    AppIcon (inline SVG set), StatTile, MessageLogTable
  components/conditionBuilder/   ConditionGroupEditor (recursive AND/OR), ConditionRow, ActionEditor
```

## Theming

`styles/theme.css` defines every colour as a CSS custom property on `:root`
(light) and `:root[data-theme='dark']`; `stores/theme.js` stamps `data-theme`
on `<html>` and persists the choice, defaulting to `prefers-color-scheme` on
first visit. **Views must never hard-code a colour** -- use the tokens
(`--surface`, `--text-muted`, `--danger`, …) or both themes drift apart. The
store's `init()` runs before mount so the first paint is already correct.
Icons are inline SVG in `AppIcon.vue` rather than an icon font/CDN, since the
app is served from the backend container on a private network with no
external asset access.

## Database: `node:sqlite`, not `better-sqlite3`

The plan originally called for `better-sqlite3`, but it requires native
compilation and there's no prebuilt binary for every Node/platform
combination -- it failed outright on a Windows dev machine with no MSVC
build tools installed. We switched to Node's built-in `node:sqlite`
(`DatabaseSync`), which needs no native compile step anywhere, local or in
Docker. `backend/Dockerfile` pins `node:22-alpine`, where `node:sqlite` is
stable and unflagged; don't downgrade the base image without checking that
still holds. The `db.prepare(sql).run()/.get()/.all()` call shape used
throughout the codebase matches `node:sqlite`'s `StatementSync` API
(including named `@param` binding via a single object argument), so this
was a drop-in swap -- no repository code depends on a better-sqlite3-only
feature.

## Schema (`backend/src/db/migrations/001_init.sql`)

- `admin_user` -- single admin account, bcrypt hash.
- `openproject_settings` / `signal_settings` -- single-row tables (`id = 1`).
  `openproject_settings.webhook_token` is a random per-install secret baked
  into the webhook URL path (`/webhooks/openproject/:token`) as a second
  layer on top of the HMAC signature, so the endpoint isn't guessable even
  before the signature is checked.
- `contacts` -- name + Signal phone number/group id, referenced by rules.
  `field_values` (migration `013`) is a JSON map of OpenProject schema key ->
  option id, for values a work package needs that the message never contains --
  "👤Замовник" is a property of the requester, not of the text. A field mapped
  to `sender_contact` reads it from here. `needs_classification` is set when
  such a lookup finds nothing (creating the contact if that sender was new) and
  cleared when a human records a value; it is what the Contacts screen's
  classification queue lists. The repository hands `field_values` out parsed,
  so a malformed blob reads as "nothing recorded" rather than breaking the
  contacts list.
  `muted` (migration `006`) is a per-contact kill switch. It's enforced in
  `ruleProcessor` against the **resolved signal identifier**, not the rule's
  contact id, so it holds for all three recipient modes -- including a `raw`
  rule that types the same number directly, which would otherwise be an
  obvious hole. Suppressed messages are logged with `status = 'muted'`
  rather than dropped, so the dashboard can answer "why wasn't this person
  notified?". `'muted'` is deliberately *not* folded into `'failed'`:
  nothing went wrong, and it would make the failure count meaningless.
  Adding it required rebuilding `message_log` (SQLite can't alter a CHECK
  constraint in place) -- see migration `006`. Contact sync only writes
  `name`/`signal_identifier`, so re-syncing never silently unmutes anyone.
  `openproject_user_id` links a contact to the OpenProject user it was
  synced from (NULL for hand-entered contacts, unique when set). This is the
  join that lets a rule notify "the work package's author" -- see Contact
  sync below.
- `rules` -- `condition_tree` is the JSON ConditionGroup tree (see below).
  `project_scope` is a separate column (not part of the tree) so "only this
  project" doesn't have to be re-encoded as a condition in every rule.
- `message_log` -- both outbound (rule fired -> Signal) and inbound
  (Signal -> logged) entries, one table, disambiguated by `direction`.
- `work_package_state_cache` -- last known state per work package.
  **`last_updated_at` stores OpenProject's own `updatedAt` timestamp from
  the payload, not our local wall clock.** This is what makes out-of-order
  delivery detection correct; if you ever "simplify" this to a local
  timestamp, that detection silently breaks.
- `webhook_events` -- audit/dedup log, unique on `(work_package_id, payload_hash)`.
- `inbound_events` -- the same idea for inbound Signal, unique on
  `(source_key, signal_timestamp)`.
- `signal_group_subscriptions` -- which groups the bot listens to. Stores
  **both** group ids (see signal-cli-rest-api quirks); `enabled` pauses one
  without losing the id.
- `inbound_rule_actions.field_templates` (migration `010`) -- JSON map of
  work package schema key -> template, for whatever fields the chosen
  OpenProject type requires beyond subject and description.
- `inbound_rule_actions.require_approval` / `approval_recipient` /
  `failure_recipient` (migration `012`) -- see Review and failures below.
  `pending_approvals` holds the work itself: one row per *held request*, not
  per action, keyed on `review_timestamp` (what `/v2/send` returned for the
  review message, which is the only id Signal has for it). `rule_name` is
  denormalized and there is no foreign key to `inbound_rules`, so deleting a
  rule leaves its decided approvals readable as the audit trail they are.
- `inbound_rule_actions.fan_out` (migration `011`) -- `pair` | `person` |
  `message`, how many work packages one natural-language message becomes.
  Migration `011` also adds `natural` to `inbound_rules.match_type`; because
  `foreign_keys` is ON in the app connection, it rebuilds `inbound_rule_actions`
  *first* and drops it before `inbound_rules` -- dropping the parent while the
  child still referenced it would cascade-delete every action row.
- `inbound_rules` / `inbound_rule_actions` -- see Inbound Message Processing.
  Migration `009` split the old single-action columns out into
  `inbound_rule_actions`, and replaced `signal_settings.group_filter` (a
  free-text blob that could only ever filter groups, and silently let every
  direct message through) with real subscriptions.

## Diffing & Idempotency Algorithm (`diff/diffEngine.js`)

OpenProject webhooks deliver full current state, never a diff, and can be
redelivered or arrive out of order. `processWebhookEvent(db, snapshot)`
implements, in order:

1. Hash the normalized snapshot. If `(work_package_id, payload_hash)`
   already exists in `webhook_events`, it's an exact duplicate redelivery --
   stop, no rule evaluation.
2. Compare the snapshot's `updatedAt` to the cached `last_updated_at`:
   older -> `out_of_order_ignored` (don't touch the cache, don't evaluate
   rules -- evaluating would produce a nonsensical "change"); equal ->
   treat as duplicate defensively.
3. If there's no cache row yet (first time we've ever seen this work
   package), detect a **creation** event and expose it as the synthetic
   `event_type_created` condition. Detection prefers OpenProject's explicit
   `action: "work_package:created"` envelope field, falling back to
   `createdAt` &approx; `updatedAt` only when `action` is absent -- the
   timestamp heuristic alone misses creations whose `updatedAt` drifts
   (attachments, API-created work packages with an immediate follow-up
   write). Gating on "no cache row" is what guarantees a created-rule fires
   at most once per work package. Plain
   field-transition conditions (`changed_to`, `any_change`, ...) never
   match on first sight -- there is no prior state to diff against. Only
   `equals`/`is_empty`-style state-only conditions can match a first-sight
   event. This also prevents a notification storm when the app is first
   pointed at an OpenProject instance with years of existing history.
4. Compute the `ChangeSet` (`{ field, from, to, changed }[]`) against the
   cached snapshot.
5. Upsert the cache, record the `webhook_events` row as `processed`.

This all happens **synchronously before the webhook HTTP response is sent**,
so a failure here surfaces as a 500 and OpenProject retries the delivery.
Rule evaluation and the actual Signal send happen *after* the response
(`ruleProcessor.processChangeEvent`, fired without awaiting) specifically so
a Signal-side failure never turns into a 500 that makes OpenProject retry
the whole webhook and re-run rules that already fired once.

## Outbound grouping (`signal/outboundDispatcher.js`)

A bulk edit in OpenProject fans out into one webhook per work package, which
previously meant one Signal message each -- spam from the recipient's side.
With `signal_settings.grouping_enabled` (migration `005`, **on** by default),
`ruleProcessor` no longer sends: it writes the rendered message to
`message_log` with `status = 'pending'`, and `outboundDispatcher` (a
setTimeout loop like the receive poller, 5s tick) flushes them.

- Messages are grouped **by recipient**, so several rules firing at once for
  the same person still produce one Signal message.
- The window (`grouping_window_seconds`, default 60) runs from the
  **first** queued message for that recipient, not as a debounce -- a
  continuous stream of edits would otherwise postpone delivery forever.
  Worst-case delay is therefore bounded by the window.
- A batch of one is sent verbatim, with no header, so ordinary single
  notifications look exactly as their template wrote them.
- Rows are claimed by stamping `message_log.batch_id` **before** the network
  call, so an overlapping pass can't double-send; rows sharing a `batch_id`
  went out in one Signal message. A failed batch marks every row in it
  `failed` with the reason and leaves `batch_id` set.
- The dispatcher ignores `grouping_enabled` when flushing, so switching the
  setting off doesn't strand rows already queued. It also drains whatever a
  restart left pending, since the queue is in SQLite rather than memory.

## Condition-Builder (`rules/ruleEvaluator.js`)

```
ConditionGroup = { type: 'group', operator: 'AND'|'OR', children: [...] }
ConditionRule  = { type: 'condition', field, operator, value?, fromValue? }
operator: equals | not_equals | any_change | changed_to | changed_from
        | changed_from_to (uses fromValue AND value) | is_empty | is_not_empty
        | event_type_created (ignores `field` entirely)
```

**Rules are edge-triggered.** `ruleProcessor` evaluates each matching rule a
second time against the *prior* state (`ruleAlreadyMatched` /
`buildPreviousEvaluationContext` in ruleEvaluator.js) and skips it if it was
already satisfied before this webhook. Without this, a rule built only from
state conditions (`equals`, `is_empty`, …) re-sends on *every* subsequent
webhook for that work package -- attachment uploads, description edits,
assignee changes -- because "status **is** Нова" stays true for as long as
the ticket sits in Нова. This was a real bug in production: one ticket sent
four identical messages. Transition conditions (`changed_to`, `any_change`,
`event_type_created`) are inherently false against the prior state, so this
never suppresses them; it only converts "while X" into "when it becomes X".
Leaving and re-entering a state fires again, which is intended.

Stored as JSON in `rules.condition_tree`, root is always a `ConditionGroup`.
Evaluation is a pure recursive function (`evaluateConditionTree`) with no DB
or HTTP dependency -- see `test/ruleEvaluator.test.js`. **Empty group
semantics: `AND([]) === true`, `OR([]) === false`** -- an empty AND group is
vacuously satisfied, an empty OR group can never match. Relation fields
(type/status/project/assignee/priority) diff to `{ id, name }`; a rule's
`value` can be either the numeric id (what the dropdown stores, sourced from
`openproject_settings.metadata_cache`) or the free-text name -- `valuesEqual`
in ruleEvaluator.js matches either, so both authoring paths (dropdown vs.
manual entry when metadata isn't configured) work identically.

## Contact sync & dynamic recipients

A rule can notify a *person derived from the work package* rather than a
fixed number. `rules.action_recipient_mode` is one of:

- `dynamic` -- resolve `action_recipient_dynamic_relation` (`author` or
  `assignee`) against the incoming snapshot, then look up the contact whose
  `openproject_user_id` matches that person's id.
- `contact` -- a fixed `action_recipient_contact_id`.
- `raw` -- a literal number/group id.

`resolveRecipient` in `rules/ruleProcessor.js` throws (rather than returning
null) when resolution fails, and `processChangeEvent` writes that message
into `message_log.error_message` -- so "the author has no contact / no phone"
is visible in the dashboard instead of a silent no-op.

The `openproject_user_id` links are populated by **contact sync**
(`contacts/contactsSync.js`, `POST /api/contacts/sync`): it fetches
`/api/v3/users` and reads each user's phone from the custom field named in
`openproject_settings.phone_custom_field` (e.g. `customField5` for a field
labeled "Телефон"). Sync upserts keyed on `openproject_user_id`, so
re-running updates rather than duplicating, and it never touches
hand-entered contacts (those have a NULL `openproject_user_id`). Users
without a phone value are skipped -- a contact we can't message is worse
than no contact, since a rule would resolve to it and then fail.

Which custom field holds the phone varies per OpenProject install, so it's a
setting, not a constant. `GET /api/settings/openproject/user-fields` detects
the `customFieldNN` keys actually present on user records (and labels them
from the metadata cache when available) to populate that setting's
dropdown -- `/api/v3/custom_fields` isn't available on every OpenProject
version, so detecting from real user payloads is the reliable path.

## OpenProject payload quirks

- Relations may appear fully in `_embedded` or only as `_links` (href +
  title, no id) -- depends on OpenProject version/config.
  `webhooks/payloadNormalizer.js`'s `pickRelation` handles both, falling
  back to extracting the id from the href when only a link is present.
- Custom fields appear as top-level `customFieldNN` keys on the work
  package resource; the normalizer extracts anything matching
  `/^customField\d+$/` into `snapshot.customFields`, and the diff engine
  further prefixes them as `customField:customFieldNN` in the ChangeSet so
  they don't collide with built-in field names.
- API v3 auth is HTTP Basic with the literal username `apikey` and the
  personal access token as the password (`openproject/openprojectClient.js`).
- A **numeric** user custom field comes back as a JSON number, not a string
  (`"customField17": 380996075027`), and carries no leading `+`. Anything
  reading custom fields must handle both types --
  `contactsSync.normalizePhone` does this for phone numbers (adds the `+`,
  maps a `00` international prefix, strips separators). A string-only check
  here silently skipped every user during contact sync.
- **`/api/v3/custom_fields` does not exist on every OpenProject version** --
  it 404s on this install. `fetchMetadata` originally used `Promise.all`, so
  that single 404 rejected the whole refresh and `metadata_cache` stayed
  empty; every type/status/project dropdown in the app was therefore blank,
  and a rule could not be pointed at a project at all. It now uses
  `Promise.allSettled` and reports the endpoints it could not read in
  `metadata.unavailable`, which Settings shows after a refresh.
- **A type can make custom fields mandatory, and can generate its own
  subject.** On this install "Телеграма" requires `customField14` and
  "Довідка" requires `customField1`, `customField19` and `customField21`;
  both report `subject.writable === false` with
  `placeholder: "Automatically generated through type ..."`. Posting a
  subject to such a type, or omitting a mandatory custom field, is a 422.
  There is no fixed set of work package attributes to hard-code -- the
  payload has to be built from the schema.
- **Read the schema from the *form* endpoint, not `/work_packages/schemas`.**
  `POST /api/v3/projects/{id}/work_packages/form` validates without creating
  anything and returns the schema with `allowedValues` populated; the plain
  schema resource returns an empty `_links` for custom option fields, so the
  dropdown values are simply not there. The form's `validationErrors` also
  name each missing field in the instance's own language ("🌀Тип довідки
  can't be blank."). Hierarchy fields expose `allowedValues` as an href
  (`/api/v3/custom_fields/19/items`) that has to be followed separately.
- Each schema field carries `location`: `"_links"` means the value is sent as
  an href under `_links` (as an **array** for `[]CustomOption`), anything
  else is a plain attribute. `buildWorkPackagePayload` keys off exactly that
  rather than a hand-maintained list of which fields are links.
- `required` alone does not mean a rule must supply it: `status` and
  `priority` are required *with* `hasDefault: true`. Only
  required-and-writable-without-a-default is genuinely the caller's problem.
- An archived project (`active: false`) offers no types and cannot receive
  work packages.
- The exact webhook signature header format (`X-OP-Signature: <algo>=<hex>`)
  and payload envelope shape (`{ action, work_package }`) are implemented
  per OpenProject's documented convention but have not been verified against
  a live OpenProject instance -- if the signature check rejects real
  deliveries, check the actual header your instance sends first.

## signal-cli-rest-api quirks

- **`/v1/receive/{number}` is two different endpoints depending on `MODE`.**
  In `normal`/`native` it is a plain `GET` returning an array of envelopes;
  in `json-rpc`/`json-rpc-native` the *same path* is a **websocket**, and the
  `GET` returns `400 {"error":"websocket: the client is not using the
  websocket protocol"}` forever. `docker-compose.yml` defaults to
  `json-rpc-native`, so the original GET-polling receiver could never receive
  anything -- it just logged a 400 every 10 seconds. `signalReceiver.js`
  therefore picks a transport from `signal_settings.receive_transport`:
  `auto` (default) reads `mode` from `GET /v1/about` and chooses; the
  explicit `websocket`/`poll`/`webhook` values exist for when a proxy makes
  the probe wrong. If the probe itself fails it assumes websocket, because
  guessing `poll` reproduces exactly the 400-loop this replaced. Inbound is
  still gated behind `signal_settings.receive_enabled` (migration `002`),
  **off by default**. A supervisor re-reads settings every 5s and rebuilds
  the connection when they change, so toggling receive or switching transport
  takes effect without a restart.
- **A group has two ids and they are not interchangeable.** `GET
  /v1/groups/{number}` returns both: `id` (`"group.<base64>"`), which is what
  `/v2/send` accepts as a recipient, and `internal_id` (`"<base64>"`), which
  is what arrives on received envelopes as `dataMessage.groupInfo.groupId`.
  Replying to a group with the id off the envelope silently fails.
  `signalGroups.toSendableGroupId` translates one to the other (subscription
  table first, live lookup as fallback), and every inbound reply or reaction
  goes through it.
- Reactions are `POST /v1/reactions/{number}` with
  `{reaction, recipient, target_author, timestamp}` (`DELETE` removes one).
  Signal has no message id: `target_author` plus the message's *sent*
  timestamp **is** the id, which is why `normalizeEnvelope` prefers
  `dataMessage.timestamp` over the envelope's.
- **A `-native` MODE cannot react to most senders, and fails by killing
  itself.** Signal hides phone numbers by default, so a sender's envelope
  routinely carries `sourceNumber: null` and only a UUID; `targetAuthorOf`
  then sends that bare UUID as `target_author`. Given one,
  `signal-cli-native` (the GraalVM native image behind `json-rpc-native` and
  `native`) dies with `java.lang.StackOverflowError` at
  `com.oracle.svm.core.jni.functions.JNIFunctions.ExceptionCheck` -- a hard
  process exit (status 99), not an error response. Two things follow, and
  both were live bugs:
  - **The HTTP request then hangs forever.** In the json-rpc modes the REST
    API is a front for a signal-cli daemon it talks to over JSON-RPC; when
    the daemon dies mid-request the handler waits for a reply that will never
    come. Nothing is logged -- GIN logs a request when it *completes*, so the
    absence of any `POST /v1/reactions` line in the access log while the app
    reports failures is the signature of this, not evidence the request was
    never sent. Look at `/var/log/signal-cli-json-rpc-1/out.log` and
    supervisord's log inside the container for the crash itself.
  - **Node's `fetch` waits 300s** (undici's default `headersTimeout`) and
    then throws a bare `TypeError: fetch failed` -- no status, and the real
    reason hidden on `err.cause`. Since a rule's actions run in order, the
    ticket queued behind a reaction was created five minutes late. Hence the
    deadline and cause-unwrapping in `signalFetch` (`signal/signalSender.js`),
    and hence **no retries there**: a retry re-kills the daemon and doubles
    the outage, which is exactly what an earlier "transient blip" retry did.

  The JVM build answers the same request `204` in under a second, so
  `docker-compose.yml` (and `.env`'s `SIGNAL_MODE`) pin `json-rpc`. Memory
  measured *lower* than the native build (235 MiB against 339 MiB), so the
  usual reason to prefer `-native` does not apply here.
- `syncMessage.sentMessage` is a message this account sent from another
  linked device, echoed back. Treating those as inbound makes the bot answer
  its own replies, so they are dropped -- as is anything whose sender is the
  bot's own number.
- Linking the bot's phone number is a manual, one-time, out-of-band step
  (`GET /v1/qrcodelink?device_name=...`, scan with Signal -> Linked
  Devices) -- the app cannot automate this.
- `MODE` env var tradeoffs, low to high speed: `normal` < `native` <
  `json-rpc` < `json-rpc-native`. **`json-rpc` is what this install runs**,
  and the `-native` variants are unusable here -- see the reaction crash
  above. Note `.env` sets `SIGNAL_MODE`, which overrides the default written
  in `docker-compose.yml`; changing only the compose file changes nothing.
- `/v2/send` request shape:
  `{ message, number: <bot number>, recipients: [...], text_mode }`.
  `text_mode` is `normal` | `styled`; styled makes signal-cli parse
  `**bold**`, `*italic*`, `~strike~`, `||spoiler||`, `` `mono` ``. It's
  stored in `signal_settings.text_mode` (migration `004`, default `styled`)
  and **always sent explicitly** -- omitting it would hand control to the
  container's `DEFAULT_SIGNAL_TEXT_MODE` env var instead. Note there is no
  reliable way to escape a literal `*`/`~`/`|`/backtick in styled mode
  (upstream issue #562 is open), so a work package subject containing those
  can render as unintended markup; the Plain setting is the escape hatch.

## Auth model

Single admin user (seeded from `ADMIN_INIT_USERNAME`/`ADMIN_INIT_PASSWORD`
on first boot only, changeable from the dashboard). JWT in an httpOnly
cookie, no session table. `requireAuth` middleware guards everything under
`/api/*` except `/api/auth/login`. The webhook route
(`/webhooks/openproject/:token`) lives entirely outside `/api` and is never
JWT-gated -- it authenticates via the path token + HMAC signature instead,
since OpenProject can't hold a login session.

## Inbound Message Processing

Inbound messages reach `inboundMessageHandler.handleInboundMessage` from
`signalReceiver.js` (websocket or GET poll, see quirks above) or from
`POST /webhooks/signal[/:token]`. All three paths funnel envelopes through
`signalReceiver.envelopesFrom`, which accepts a websocket frame
(`{envelope}`), a GET array, or a bare envelope.

The handler runs these in order, and the order is deliberate:

1. Drop `syncMessage` echoes, empty bodies (receipts, typing indicators,
   reactions), and anything sent by the bot's own number.
2. **Deduplicate** on `(author, sent timestamp)` -- Signal's own identity for
   a message -- via `inbound_events`. A websocket reconnect or a redelivered
   webhook would otherwise fire the same rule twice.
3. **Subscription check** (`isSubscribed`): a group message needs an enabled
   row in `signal_group_subscriptions` (or `subscribe_all_groups`); a direct
   message needs `allow_direct_messages`. Everything else is dropped
   *without* logging -- the bot's number sits in groups that have nothing to
   do with this app, and logging all of them buries the real traffic.
4. Translate the envelope's group id to the sendable one, then log to
   `message_log` with `direction = 'inbound'`, `status = 'received'`.
5. Evaluate rules.

### Inbound rules

`inbound_rules` + `inbound_rule_actions` (migration `009`). Rules are ordered
by `priority` DESC; the first one that matches runs **all** of its actions in
`position` order, then stops unless `stop_processing = 0` -- so a catch-all
rule at priority 0 works as a fallback without firing for messages a specific
rule already handled.

Matching (`signal/inboundMatcher.js`, pure -- see
`test/inboundMatcher.test.js`) has two parts:

- **Source scope**: `any` | `group` | `direct`, optionally narrowed to a set of
  groups (`source_group_ids`, migration `018` -- a JSON array of *sendable*
  group ids, handed out of the repository already parsed). The list is checked
  only against messages that have a group, so `any` plus two groups means
  "direct messages, plus those two groups"; an empty list is no restriction.
  Migration `018` replaced the single `source_group_id`, which the editor only
  offered for `group` scope -- an `any` rule carrying one silently matched
  nothing but that group, so those rows were rewritten as the group-only rules
  they effectively were.
- **Parser**: `match_type` is `regex` (default), `contains`, `any`, or
  `natural` (see below -- it carries no pattern and decides by parsing the
  message). For regex, **capture groups become template variables**: `{1}`,
  `{2}` by position and `{name}` for `(?<name>...)`. That is the point of exposing a
  regex rather than a keyword list -- the pattern both selects the message
  and extracts the payload. `pattern_flags` is sanitized to `imsu`; `g` is
  deliberately excluded, because `exec()` on a `g` regex is stateful and
  would make a rule match every *other* message.

Beyond captures, every template can use `{message}`, `{rest}` (the message
minus the matched text -- the usual "everything after the !command" payload),
`{first_line}`, `{body}`, `{sender}`, `{sender_name}`, `{sender_number}`,
`{group}`, `{group_name}`, `{date}`. Captures are merged last, so a group
named `sender` deliberately shadows the built-in. Unknown variables render
empty rather than leaking a literal `{foo}` into a message sent to a real
person.

`POST /api/inbound-rules/test` dry-runs a pattern against sample text and
returns the captures plus rendered templates; the rule editor uses it so a
regex can be checked without sending real Signal messages. For a `natural`
rule it also returns the parsed structure and one entry per work package the
message would file, so a rule can be checked against a real request without
filing anything. Patterns are also compiled at save time (`validateRule`) --
an uncompilable regex used to be stored happily and then throw on every
inbound message, with nothing in the UI to explain why the rule never fired.
A rule stored *before* that validation still cannot break the pipeline: a
pattern that fails to compile is logged and skipped, and the rules after it
still run.

### The natural-language parser (`signal/naturalParser.js`)

`match_type = 'natural'` has no pattern at all: the rule matches when the
message *parses as* a certificate request. Real traffic in the help-desk group
looks like "молодший сержант Іванов Іван Іванович потрібно довідка ф12, довідка
ф5 для вихідного контролю" -- a regex can pull one capture group out of one
fixed shape, but the same request arrives with the forms first, the name first,
one name or a list of them under a shared header, and the certificate written
as `ф5`, `Ф-12`, `довідка форми 5` or `Довідка в/с (замість ВК)`.

`parseRequests(text)` returns `people`, `forms`, `requests` (people joined to
their forms) and `pairs` (that flattened, one entry per certificate). It is
pure -- `test/naturalParser.test.js` pins every message shape it was built
from. The mechanics worth knowing before changing it:

- **Forms are found first and masked out of the text.** "Довідка" and "Форма"
  are capitalized words, so leaving them in makes them the start of a name.
  Parentheticals are masked next (a note about that person, `(для пенсійного)`),
  then names, then the purpose -- which is why `для суду на солдат Іванов Іван
  Іванович` yields `суду` and not the rest of the sentence.
- **A name needs a patronymic or a rank in front of it.** Two capitalized words
  in a row are otherwise "Слава Україні". The patronymic also anchors *where*
  to split a run long enough to hold two names.
- **Only a prefixed number is a form.** Reading bare numbers would make
  "ф5 і 2 людини" a request for Форма 2. Precision matters more than recall
  here: a missed request gets re-asked in the group, an invented one files a
  work package against a real person.
- **Forms and people are joined by narrowing scope**: the person's own
  clause, then their line, then forms on a line that names nobody (a header),
  then every form in the message. A message naming exactly one person skips
  all of it and gets every form mentioned.
- **A header speaks only for the names under it, not for the whole message.**
  "Ф5:" / a name / "Ф6:" / two more names is a normal way to write two requests,
  and treating both header lines as message-wide gave all three people both
  forms -- six work packages where three were asked for. Header lines with
  nobody named between them are one header (a list broken across two lines),
  and a person with no header above them takes the first one below, which is
  the only reading of a message that puts its forms last.
- **A clause is sub-line, and boundaries come at two strengths.** Two requests
  are routinely written on one line -- "довідка ф12 на Костиря Сергій
  Олександрович; і ф6 для пенсійного на Жепяк Назар Васильович" -- and joining
  by line alone handed both people both forms *and* both purposes. A clause
  ends at a line break, a semicolon or a sentence end; a segment also ends at a
  comma or a standalone "і"/"та" ("and"). Both are ambiguous the same way -- a
  comma separates two requests in "ф12 на Костиря, ф6 на Жепяк" but two forms
  of one request in "потрібні ф5, ф12 на Костиря", and "і"/"та" separates two
  requests in "ф6 на Борсук ... і ф5 на Колесника ..." but two forms of one in
  "ф5 і ф12 на Іванов" -- so a comma- or conjunction-run with nobody named in
  it is merged into the nearest person **within the same clause**, forward
  first. Staying inside the clause is what keeps "Костиря потрібно ф12, ф5;
  Жепяк потрібно ф6" from handing Костиря's ф5 to Жепяк, and the line-level
  fallback means a boundary in the wrong place costs nothing. The conjunction
  check matches "і"/"та" only as a whole word (`\p{L}` lookaround, same as
  everywhere else in this file) -- both letter sequences occur constantly
  mid-word, and splitting inside one would scatter an ordinary surname across
  two segments.
- **What was said *about* a person is scoped the same way**: their note, their
  purpose and their personal number come from their own clause, and from the
  rest of the line only when they are the only person on it. A single "для ..."
  in a message where no clause claimed one speaks for everybody; once one
  clause does claim it, it speaks only there.
- `\b` is ASCII-only in JavaScript and never fires next to a Cyrillic letter,
  so every word boundary in this file is a `\p{L}` lookaround.

The rank list and `DEFAULT_FORM_ALIASES` are the extension points -- an
alias's `label` is the OpenProject option name, not what the group calls it:
"замість ВК" is what everybody asks for and "Довідка щодо військовослужбовця"
is what it files as; `parseRequests` takes `options.aliases`
for callers that need their own.

**Fan-out.** One message can be several work packages, so `create_ticket` runs
once per item (`naturalItems`), with that item's variables merged over the
message-wide ones: `{person}`, `{rank}`, `{form}`, `{forms}`, `{purpose}`,
`{note}`, `{personal_number}`. `react` and `send_message` never fan out --
four reactions to one message is noise -- and get `{summary}`, `{people}`,
`{tickets_count}` describing the whole request. `fan_out` chooses the
granularity; `pair` is the default because OpenProject's "Тип довідки" holds
one value, so two certificates cannot be one ticket.

A rendered `{form}` reaches OpenProject as a *label*, not an id --
`resolveLinkHref` already matches an allowed value by label, so no
form-to-option mapping table is needed. That is why `buildTicketFields` renders
a link-typed field template when it contains a `{variable}` and passes it
through untouched otherwise: the untouched path is a dropdown-chosen id, which
must not go near the renderer.

### Replaying a missed message (`signal/replayCommand.js`)

**Inbound delivery is live-only, and nothing recovers it after the fact.**
signal-cli-rest-api hands an envelope to whatever websocket client is attached
at that instant and keeps nothing for one that reconnects later; Signal has no
server-side history to re-fetch and no message id to ask with. A message that
arrives while the app is restarting is therefore gone from the pipeline for
good, and the only copy left anywhere is the one in the operator's own Signal
client. Reacting to the original message cannot fix this either -- a reaction
envelope carries `targetAuthor` + `targetSentTimestamp` but **not the message
text**, so it points at something we never received and cannot fetch.

Hence `/process`: forward the message to the bot with a command line, and it
runs through exactly the pipeline it missed.

```
~Forwarded message
/process Петренко Олег
молодший сержант Іванов Іван Іванович потрібно довідка ф12 ...
```

- **The command names the original sender**, because that is the one thing a
  forward destroys -- a Signal forward arrives as a fresh message from whoever
  forwarded it. The sender is not cosmetic: it picks the OpenProject `author`,
  the 👤Замовник value read off the contact record, and the mute check. So the
  whole replay is a **synthetic envelope with the sender swapped**
  (`buildReplayContext`), and every stage downstream behaves as though that
  person had sent it. Nothing in the matcher, parser or executor knows a replay
  is happening -- the one seam is `context.senderNumber`.
- **The command line need not be the first line.** Signal's own "Forwarded
  message" marker lands above it, so everything before it is chrome and
  everything after it is the body. `/trigger` is an accepted alias.
- **Author resolution is contacts first, then the OpenProject user list.** A
  contact match carries both halves of an identity (Signal number *and*
  `openproject_user_id`); contact sync skips users with no phone, though, so
  the contacts table is only a subset of who a ticket can be attributed to --
  and a replay never needs to *message* the author, only to name them. An
  author found only in OpenProject is carried as `context.authorUserId`,
  because there is no contact row for `senderContact` to find.
  **An ambiguous or unknown name is an error sent back to the operator, not a
  guess** -- filing a request against the wrong person is the one failure this
  must not have. Omitting the name is different: that is a deliberate "this one
  is mine" and attributes it to the forwarder.
- **`/process` is answered before the subscription check**, for the same reason
  an approval reaction is: the operator's DM need not be a subscribed
  conversation, and making recovery depend on `allow_direct_messages` would tie
  it to an unrelated setting.
- **Authorization is the approval-recipient list**, reused rather than given a
  second table -- replaying files work packages in someone else's name, which is
  the trust an approval reaction already carries. It gates the *branch*, not
  just the handler (`isReplayRequest`), so an ordinary message that happens to
  contain a `/process` line still goes to rules instead of being swallowed as a
  command the sender was not allowed to run.
- **A DM carries no group, and inbound rules are routinely group-scoped**, so a
  replay would otherwise match nothing and look ignored. In order: the
  subscribed group the command was *sent in* (run in the help-desk group, that
  conversation is plainly what was meant -- and the envelope's internal id is
  translated to the sendable one), then
  `signal_settings.default_replay_group_id` (migration `017`), then -- with
  neither -- a single enabled subscription, which is unambiguous and needs no
  configuration at all. A group nobody subscribed to is ignored rather than
  used: it would replace a working configured group with one no rule is scoped
  to.
- **The command reports what it actually did.** This was the missing half, and
  the reason `/process` felt broken: it acknowledged itself and then went quiet
  whatever happened next, because a rule that does not match simply does not
  run and `runAction` swallows a failed action into `message_log` plus the
  rule's `failure_recipient` -- which is nobody by default. So a rule scoped to
  another group, a message the parser did not recognise, and a work package
  OpenProject rejected all looked identical from the outside, and every one of
  them is a different thing to go and fix. `runRules` now returns a report
  (matched rules, why each other rule passed, one row per action, what is held
  for review) and the replay sends it back: ticket numbers on success, the real
  error on failure, and per-rule reasons when nothing matched.
  `inboundMatcher.evaluateRule` is `matchRule` plus that reason -- the live
  pipeline still calls `matchRule` and ignores it -- and `runAction` takes an
  optional `outcomes` collector in the same spirit as `replies`, since its
  swallowed errors are exactly why a caller cannot read a return value.
- **`react` actions are skipped on a replay** -- (author, sent timestamp) names
  a message this bot never received, and reacting to the operator's own
  `/process` instead would be meaningless. The ticket and the reply still run.
- The provenance footer gains a **`Replayed by:`** line, so "Reported by" is not
  a silent claim about a Signal message that was never actually received.

### Nominative case (`signal/nominativeCase.js`)

A request is written in whatever case its sentence needed -- "довідка для
Іванова Івана Івановича" -- and filing that verbatim gives a tracker full of
names nobody can match against the personnel list. `toNominative` puts a ПІБ
back into the називний відмінок.

**The patronymic decides.** It is the only part of a Ukrainian full name whose
ending states the case unambiguously, and the gender with it, so it is read
first and the other two parts are converted to match. When the patronymic is
already nominative -- which is how most of these messages are written --
nothing is touched at all, and a name with no patronymic (a two-word
rank-anchored one) is never touched either, because nothing there says what
case it is in. That conservatism is the point: a wrong guess writes a real
person's name wrongly into the unit's tracker.

Two ambiguities are worth knowing, because both were wrong before they were
handled:

- `-им` is two different surnames. Possessive keeps its stem (Івановим ->
  Іванов), adjectival takes `-ий` back (Ковальським -> Ковальський).
- A surname in `-ка` is either a `-ко` surname or a consonant stem, and what
  separates them is the letter before the к: a consonant means `-ко`
  (Петренка -> Петренко), a vowel means the к is the stem's own last letter
  (Мельника -> Мельник).

Male given names ending in `-о` cannot be derived at all -- "Петра" and
"Івана" are the same shape -- so `O_STEM_GIVEN` lists them. Ranks decline with
the name they introduce ("для солдата Іванова"), so `rankBefore` also matches
by stem and stores the canonical nominative from `RANKS` either way.

A few given names (Микола, Ілля, ...) decline like a noun of the opposite
grammatical gender, which breaks the assumption everywhere else in this file
that a male name's genitive and accusative are the same shape ("Олега" covers
both). "Миколи" (genitive) and "Миколу" (accusative) are two different
endings, so both are whitelisted in `A_STEM_GIVEN`/`YA_STEM_GIVEN` rather than
matched by a generic `-у$` rule -- a generic rule would also fire on an
unrelated dative like "Олегу" and strip a letter that belongs there.

`person.full` is the nominative and `person.writtenAs` keeps the message's own
spelling, exposed as `{person_as_written}` for a reply that should echo the
sender's words back.

### Review and failures (`signal/approvals.js`)

Two per-action flags, because acknowledging a message with a reaction needs no
review while the work package it produces might.

**`require_approval`** holds the action instead of running it. The bot sends
`approval_recipient` exactly what it is about to do -- rendered from that
action's own templates -- and waits for a reaction: ✅ / 👍 runs it, ❌ / 👎
drops it. Details that matter:

- The held work is stored **already rendered**, as the item contexts the action
  would have run with, so approving files what the reviewer was shown rather
  than whatever the message would parse to now. The *action* is re-read from
  the database at approval time, so an edited action runs as it now stands and
  a deleted one is skipped rather than fatal.
- One row per matched rule, not per action: a ticket action fanning out into
  four work packages asks the reviewer once.
- Actions on the same rule that need no approval still run immediately.
  Leaving the sender in silence while a reviewer sleeps is worse than either.
- The reaction reaches `decideApproval` **before** the "no message body" check
  and before the subscription check -- a reaction carries no text, and the
  reviewer's DM need not be a subscribed conversation. The authorization is
  the stored `review_timestamp`: the bot only holds work against a reviewer it
  was configured to ask, and the reaction must target a message the bot sent.
- `sendMessage` therefore returns the timestamp `/v2/send` answered with. A
  send that worked never fails on an unreadable body; only approval requests
  need the timestamp, and they check for it.
- A review request that cannot be sent is a logged failure, not a silent drop:
  nothing was created and nobody was asked.

**`failure_recipient`** sends the reason for a failed action, and the message it
came from, to a person. Every failure already writes a `message_log` row, but
nobody is watching the dashboard at 23:00. `runAction` in
`inboundActionExecutor.js` wraps execute + log + notify, and both the live
pipeline and an approved-later action go through it, so a failure after
approval reaches the same person. Contact mute is honoured here as everywhere
else (logged `muted`, not sent).

### Actions

Each row in `inbound_rule_actions` is one of:

- **`react`** -- `sendReaction` with the rule's `emoji`, always delivered
  into the conversation the message came from.
- **`create_ticket`** -- builds the work package **from the type's schema**
  (see OpenProject payload quirks). `project_id` / `type_id` fall back to
  `signal_settings.default_project_id` / `default_type_id`; the schema for
  that pair is fetched once and cached for 5 minutes.

  `subject_template` and `description_template` are just two entries in the
  rendered field map, not special cases: `inbound_rule_actions.field_templates`
  (migration `010`) is a JSON object of schema key -> mapping, so a rule can
  fill `customField14`, `customField21` or anything else the type demands.

  A mapping is either a bare template string (the original shape, still read)
  or `{ source, template, fallback }` -- see `normalizeFieldMapping`. `source`
  is `value` (an id a dropdown produced), `template`, `sender_contact`, or
  `field_match`; only `sender_contact` and `field_match` behave differently,
  and `value`/`template` differ solely in how the rule editor presents them.
  Text fields go through the template renderer; link-typed fields are rendered
  only when the template contains a variable, so a dropdown-chosen id still
  reaches OpenProject untouched.

  **`field_match` routes a field by another field's already-resolved value**
  -- e.g. Assignee by 🌀Тип довідки: Форма 5 goes to one person, Форма 6/7 to
  another, anything else to a default. Its shape is
  `{ source: 'field_match', matchField, rules: [{ values, value }], fallback }`
  rather than `template` -- `rules` is checked top to bottom, first match
  wins, and `fallback` doubles as "otherwise" here (the same key the
  closed-list mismatch case above already used it for). `buildTicketFields`
  resolves every other field first and `field_match` entries in a **second
  pass**, reading `fields[matchField]` -- the field's *final* value, whether
  that ended up being an id (chosen from a dropdown) or a label (rendered
  from `{form}`). Both sides of a comparison are resolved to the matched
  field's canonical option id when it has a closed list (`findAllowedValue`),
  so a rule written against the id matches a `customField1` that ended up
  holding the label, and vice versa; with no closed list, comparison falls
  back to trimmed, case-insensitive text. A `field_match` entry cannot
  target another `field_match` entry -- the second pass has no dependency
  ordering, only insertion order -- which is not a real limitation for the
  one thing this exists for: routing by a field the natural-language parser
  already set directly (`customField1: '{form}'`).

  The `assignee` field is the reason this exists, and the one place it needs
  help beyond the closed-list machinery above: `assignee` is `User`-typed,
  and OpenProject's form schema only returns `allowedValues` for it when the
  install exposes an assignable-users href, which this one does not.
  `FieldMappingEditor.vue` therefore always shows the source selector (it
  used to be hidden behind `hasList`, which also silently made
  `sender_contact` unreachable from a blank listless field -- fixed as a side
  effect), and a `field_match` rule row's "set to" value -- and the
  "otherwise" fallback -- falls back to `GET /api/settings/openproject/users`
  (`contactsSync.toUserOptions` -- active users only, sorted by name)
  whenever the field being set has no closed list of its own. The plain
  "pick one value for every ticket" (`value`) source is unchanged and still
  needs a real closed list, since it predates this and assignee was never
  reachable through it on this install anyway.

  **A field whose schema gives a closed list is checked against that list
  before posting.** A rule that renders "Форма 5" into a list without that
  option, or wants a value from a contact nobody has classified, uses the
  mapping's `fallback` option instead of failing with an opaque 422 -- these
  installs keep an "Інше (Вкажу в описі)" entry for exactly this. What was
  actually asked for is appended to the description, which is what makes the
  fallback honest rather than lossy, and a `sender_contact` miss also flags the
  contact for classification. With no fallback configured nothing changes: the
  value goes as rendered and fails loudly.

  Before posting, `missingRequiredFields` compares the rendered map against
  the schema and fails with the field's real OpenProject name -- "requires
  \"🌀Тип довідки\" (customField1)" -- instead of letting the POST come back
  as an opaque 422. Provenance (who, which group, when) is still prepended to
  the description, and the sender becomes the OpenProject `author` when their
  number matches a synced contact **and** the schema reports `author` as
  writable -- on a personal API token `author` commonly comes back
  `writable: false` (OpenProject sets it to the authenticating user
  regardless), and sending it anyway is a 422:
  `Author was attempted to be written but is not writable`. `author` is
  therefore gated through the same schema check as every other field rather
  than appended to the payload unconditionally.
- **`send_message`** -- renders `message_template` and sends it to
  `reply_target`: `source` (the group, or the sender in a DM), `sender`, a
  fixed `contact`, or a `raw` number/group id. Contact mute is enforced here
  too, logging `status = 'muted'` exactly like the outbound path.

An action that throws is logged to `message_log` with `status = 'failed'` and
the error, and the remaining actions still run -- a Signal reply failing
should not lose the ticket that was already filed.

## Backups

The database runs in WAL mode, so **`docker compose cp app-backend:/data/app.db`
on its own can silently copy an empty-looking database** -- recent writes live
in `app.db-wal` until a checkpoint. Either copy all three files
(`app.db`, `app.db-wal`, `app.db-shm`) or force a checkpoint first:

```
docker compose exec app-backend node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/app.db').prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()"
```

This bit once while taking a pre-migration backup: the copy restored with 0
rows in every table, which looked like migration data loss but was purely a
backup artifact.

## Testing

`backend/test/*.test.js` (Node's built-in `node:test`) cover the diff
engine, rule evaluator, and template renderer as pure/DB-isolated units --
`npm test` from `backend/`. `test/testDb.js` builds a real in-memory
`node:sqlite` database from the actual migration files, so diff engine tests
exercise real persistence, not mocks. There is no automated end-to-end test
against real OpenProject/Signal; verify that flow manually per the README
setup sequence.
