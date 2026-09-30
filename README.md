# OpenProject ↔ Signal Bridge

Sends Signal messages when OpenProject work packages change, based on rules
you define (e.g. "message a contact when a work package of type Телеграма
is closed"). Includes a dashboard for managing rules, contacts, connection
settings, and message history.

See [CLAUDE.md](CLAUDE.md) for the architecture and internals.

## Requirements

- Docker + Docker Compose
- An OpenProject instance reachable from this app (for the webhook and,
  optionally, the metadata API)
- A spare phone number to register as the bot's Signal identity

## 1. Start the stack

```bash
cp .env.example .env
# edit .env: set JWT_SECRET, ADMIN_INIT_USERNAME, ADMIN_INIT_PASSWORD
docker compose up -d
```

## 2. Link the bot's Signal number

Open `http://<this-host>:8081/v1/qrcodelink?device_name=openproject-signal-bot`
in a browser, then in the Signal app go to **Settings → Linked Devices → +**
and scan the QR code. This registers signal-cli-rest-api's identity against
that Signal account; the app itself sends messages through that account
once configured in step 5.

## 3. Log into the dashboard

Visit `http://<this-host>:3000` and sign in with the admin credentials from
`.env`. Consider changing the password from the dashboard afterwards.

## 4. Configure the OpenProject connection

In **Settings → OpenProject connection**:

- **Base URL**: your OpenProject instance's URL
- **API key**: OpenProject → your avatar → *My Account* → *Access Tokens*
- Click **Test Connection**, then **Refresh Metadata** (populates the
  type/status/project dropdowns in the rule builder)
- **Phone custom field**: click *Detect* and pick the user field holding
  phone numbers (e.g. `Телефон`) — this is what contact sync reads
- Copy the **Webhook URL** shown — you'll paste it into OpenProject next
- Set a **webhook signature secret** here and use the *same* value when
  creating the OpenProject webhook below

## 5. Configure the Signal connection

In **Settings → Signal connection**, enter the bot's linked phone number
(the same one you scanned in step 2) and save. Click **Check Link Status**
to confirm it shows "linked".

## 6. Create the webhook in OpenProject

In OpenProject: **Administration → Webhooks → +**

- **Payload URL**: the Webhook URL copied in step 4
- **Signature secret**: the same secret you set in step 4
- **Events**: work package created, work package updated
- **Projects**: whichever projects you want notifications from

## 7. Sync contacts

In **Contacts**, click **Sync from OpenProject** — this creates a contact
for every OpenProject user that has a phone number in the custom field you
chose in step 4, linked back to that user. Re-run it any time users or their
numbers change; it updates in place and never touches contacts you added by
hand. You can still add contacts manually for anyone not in OpenProject
(or for Signal groups).

Each contact has a **Mute** switch (in the row, or in the edit form). A muted
contact is never messaged by any rule — including rules that resolve them as
a work package's author or assignee — until you unmute them. Suppressed
messages still show in the log as *muted*, so you can see what they would
have received. Muting survives re-syncing from OpenProject.

## 8. Add rules

**Rules** → **New Rule**: build a condition (e.g. *Type is Телеграма* AND
*Status changed to Closed*), then choose who to notify:

- **The person involved in the work package** → *Author* or *Assignee*.
  Resolved per-message via the synced contacts, so "notify whoever filed the
  ticket" works without naming anyone.
- **A specific contact**, or **a raw number / group id** for a fixed target.

Message templates support `{id}`, `{subject}`, `{type}`, `{status}`,
`{status_from}`, `{project}`, `{author}`, `{assignee}`, `{priority}`,
`{url}` (a direct link to the work package in OpenProject, built from the
base URL you set in step 4).

Templates can also use Signal's inline formatting — `**bold**`, `*italic*`,
`~strikethrough~`, `||spoiler||`, `` `monospace` `` — while **Settings →
Signal → Message formatting** is set to *Styled* (the default). Note that
styled mode has no escape syntax, so a work package subject containing a
literal `*`, `~`, `|` or backtick may render as unintended markup; switch
that setting to *Plain* to send everything literally.

## 9. Grouping (optional)

**Settings → Signal → Group messages before sending** is on by default. It
holds outbound messages briefly and combines everything headed to the same
person into one Signal message, so editing twenty work packages at once
sends each person one notification rather than twenty. Someone with a single
update still gets it exactly as their rule wrote it. The window (default 60s)
is measured from the first queued message, so it also caps how long a
notification can be delayed. Queued messages appear in the log as *pending*.

## 10. Receiving Signal messages (optional)

The bot can also act on messages people send it: react with an emoji, file an
OpenProject work package, or reply.

**Settings -> Inbound messages**:

1. Tick **Receive Signal messages**. Leave **Transport** on *Automatic* -- it
   asks signal-cli-rest-api which mode it is running in and connects the right
   way (a websocket for the `json-rpc*` modes this stack uses by default).
2. Choose what to listen to: **direct messages** to the bot, and/or specific
   **groups**. Click *Load groups from Signal* to list the groups the bot is a
   member of, tick the ones you want and save. Nothing from an unsubscribed
   group is received, logged, or acted on.
3. Optionally set a **default project and type** for tickets created from
   Signal, so individual rules do not each have to.

Then **Rules -> New Inbound Rule**:

- **Listen to** scopes the rule to groups, direct messages, or one specific
  group.
- **Parser** is how the message is matched. A regular expression is the
  default, and its capture groups become variables for the actions:
  `^!task\s+(?<subject>.+)$` makes `{subject}` available. Numbered groups
  work too (`{1}`, `{2}`). *Contains text* and *Any message* are there for
  rules that need no extraction. Use **Test pattern** with a sample message to
  see exactly what a rule would capture and what your templates would render,
  before it ever runs on real traffic.
- **Certificate request (natural language)** is the parser for messages nobody
  formats: it reads rank, name and requested forms out of ordinary Ukrainian
  text and matches only when it finds both a person and at least one form.

      молодший сержант Іванов Іван Іванович потрібно довідка ф12, довідка ф5

  ...becomes `Іванов Іван Іванович → Форма 12, Форма 5`, and the actions get
  `{person}`, `{rank}`, `{form}`, `{forms}`, `{purpose}`, `{summary}` and the
  rest (the editor lists them). It handles `ф5`, `Ф-12`, `довідка форми 5` and
  `Довідка в/с (замість ВК)`, which files under its OpenProject name
  *Довідка щодо військовослужбовця*; one name or a list of them under a shared form;
  forms written before or after the names. **One message becomes** on the
  ticket action chooses whether that files one work package per certificate
  (the default), one per person, or one for the whole message. A message it
  cannot read simply does not match, so a lower-priority *Any message* rule can
  reply asking for the missing detail. Names are filed in the nominative
  (називний відмінок) whatever case the message wrote them in, so "довідка для
  Іванова Івана Івановича" becomes a ticket for *Іванов Іван Іванович*.
- **Actions** run in order when the rule matches. Add as many as you want:
  *React with emoji* (acknowledge in the chat), *Create OpenProject ticket*,
  *Send Signal message* (back to the group, to the sender, to a contact, or to
  a fixed number).
- **Review and failures**, under each action, are the two safety valves:
  - *Hold for human review* stops the action running on its own. The bot sends
    what it is about to do to the number you give and waits; react **✅** or
    **👍** to that message and it runs, **❌** or **👎** and it is dropped.
    The other actions on the rule still run right away, so whoever wrote the
    message is not left in silence. A ticket action that would file four work
    packages asks once, not four times.
  - *Tell someone when this action fails* sends the reason, and the message it
    came from, as a Signal message. Failures are always written to the message
    log; this is for when nobody is looking at it.

Each field a type requires can be filled three ways:

- **Pick one value for every ticket** &mdash; the dropdown, as before.
- **Read it from the message** &mdash; a template. A natural-language rule
  points *🌀Тип довідки* at `{form}`; the label it renders is matched against
  the field's own list, so no id mapping is needed.
- **Read it from the sender's contact** &mdash; for a field that describes the
  requester rather than the request, like *👤Замовник*. The answer is recorded
  once per person under **Contacts → Needs classification**.

Either of the last two can produce something the list does not contain, so each
field also takes a **fallback** &mdash; typically the *"Інше (вкажу в описі)"*
entry these installs keep for the purpose. When it is used, what was actually
asked for is appended to the ticket description, so nothing is lost; a sender
nobody has classified yet is added to the classification queue at the same
time. Leave the fallback unset to have the rule fail loudly instead.

For a **Create OpenProject ticket** action, pick the project and type, then
click **Load fields for this type**. OpenProject types differ in what they
need: some require custom fields of their own, and some generate the subject
themselves rather than letting you set it. Loading the fields shows exactly
what this type requires, with dropdowns for list fields and template inputs
for text ones, so a rule can fill them from the message. If a required field
is left empty the rule fails with that field's OpenProject name in the message
log, rather than a silent rejection.

Note that an **archived project cannot receive work packages** — archived ones
are shown greyed out and offer no types.

Alongside the capture groups, templates can use `{message}`, `{rest}` (the
message minus the matched part), `{first_line}`, `{body}`, `{sender}`,
`{sender_number}`, `{group_name}` and `{date}`.

Rules are tried highest **priority** first, and the first match wins unless you
untick *Stop after this rule matches* -- so a low-priority *Any message* rule
makes a good fallback.

A worked example -- react, file, and confirm from one message:

| Field | Value |
| --- | --- |
| Listen to | Group messages only |
| Parser | Regular expression, `^!task\s+(?<subject>.+)$` |
| Action 1 | React with emoji, `👀` |
| Action 2 | Create ticket, subject `{subject}` |
| Action 3 | Send message, `Thanks {sender}, filing that now.` |

Sending `!task The printer on floor 2 is jammed` in that group gets a 👀
reaction, creates a work package titled *The printer on floor 2 is jammed*
(attributed to the sender if their phone number matches a synced contact, with
who/where/when recorded in the description), and replies in the group.

Inbound messages appear in the **Message Log** as *received*.

## 11. Test it

Change a matching work package in OpenProject. Within a few seconds it
should appear in the dashboard's **Message Log** and arrive as a Signal
message. If it doesn't show up at all, check `docker compose logs
app-backend` for webhook signature or connectivity errors. If it appears as
**failed**, the row's error explains why — a common one is an author with no
synced contact or no phone number in OpenProject.

## Local development (without Docker)

```bash
make install          # or npm install
make dev-backend      # http://localhost:3000, API only
make dev-frontend     # http://localhost:5173, proxies /api to :3000
make test             # Run backend unit & integration tests
```

Run `make help` to see all available Docker, dev, testing, and backup commands.

