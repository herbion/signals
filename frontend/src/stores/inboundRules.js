import { defineStore } from 'pinia';
import { api } from '../api/client.js';

export const useInboundRulesStore = defineStore('inboundRules', {
  state: () => ({
    rules: [],
    loading: false,
  }),
  actions: {
    async fetchAll() {
      this.loading = true;
      try {
        this.rules = await api.get('/inbound-rules');
      } finally {
        this.loading = false;
      }
    },
    async fetchOne(id) {
      return api.get(`/inbound-rules/${id}`);
    },
    async create(rule) {
      const created = await api.post('/inbound-rules', rule);
      this.rules.push(created);
      return created;
    },
    async update(id, rule) {
      const updated = await api.put(`/inbound-rules/${id}`, rule);
      const i = this.rules.findIndex((r) => r.id === Number(id));
      if (i !== -1) this.rules[i] = updated;
      return updated;
    },
    async remove(id) {
      await api.delete(`/inbound-rules/${id}`);
      this.rules = this.rules.filter((r) => r.id !== Number(id));
    },
    async toggleEnabled(rule) {
      return this.update(rule.id, { ...inboundRuleToPayload(rule), enabled: !rule.enabled });
    },
    /** Dry-runs a pattern against sample text; see the rule editor's tester. */
    async testPattern(payload) {
      return api.post('/inbound-rules/test', payload);
    },
  },
});

/** Common acknowledgement reactions, offered as one-click choices. */
export const EMOJI_CHOICES = ['👀', '✅', '👍', '🎫', '⏳', '❗', '🔥', '🙏'];

/** Blank action of a given type, matching the API's camelCase shape. */
export function newAction(actionType = 'send_message') {
  return {
    actionType,
    // A react action with an empty emoji fails validation, and a greyed-out
    // placeholder reads like a value -- so start it with a real one.
    emoji: actionType === 'react' ? EMOJI_CHOICES[0] : '',
    projectId: '',
    typeId: '',
    priorityId: '',
    subjectTemplate: '',
    descriptionTemplate: '',
    messageTemplate: '',
    replyTarget: 'source',
    replyContactId: '',
    replyRaw: '',
    // schema key -> template string / chosen option id, for whatever the
    // OpenProject type requires beyond subject and description.
    fieldTemplates: {},
    // How many tickets one natural-language message becomes. Ignored by every
    // other match type, and by the react / send_message actions.
    fanOut: 'pair',
    // Hold this action until a human reacts to the review request, and where
    // to send that request.
    requireApproval: false,
    approvalRecipient: '',
    // Where to send the reason when this action fails.
    failureRecipient: '',
    // Where a created ticket's confirmation reply goes: back to the group/DM
    // it came from, or to the reviewer who approved it (approvalRecipient).
    confirmTarget: 'source',
    // Append the plain-text "Reported by / Source / Received" block after the
    // rendered description. Off when the template is its own complete layout.
    includeProvenance: true,
    // Days from creation to finish, set as startDate=today / dueDate=today+N.
    // Blank leaves both dates unset (or however field_templates maps them).
    durationDays: '',
  };
}

/** API row (snake_case) -> editor form (camelCase). */
export function inboundRuleToForm(rule) {
  return {
    name: rule.name ?? '',
    enabled: rule.enabled ?? true,
    priority: rule.priority ?? 0,
    sourceScope: rule.source_scope ?? 'any',
    // The API hands this out parsed; a rule listing no groups listens to every
    // subscribed one.
    sourceGroupIds: [...(rule.source_group_ids ?? [])],
    matchType: rule.match_type ?? 'regex',
    pattern: rule.pattern ?? '',
    patternFlags: rule.pattern_flags ?? 'i',
    stopProcessing: rule.stop_processing ?? true,
    actions: (rule.actions ?? []).map((action) => ({
      ...newAction(action.action_type),
      actionType: action.action_type,
      emoji: action.emoji ?? '',
      projectId: action.project_id ?? '',
      typeId: action.type_id ?? '',
      priorityId: action.priority_id ?? '',
      subjectTemplate: action.subject_template ?? '',
      descriptionTemplate: action.description_template ?? '',
      messageTemplate: action.message_template ?? '',
      replyTarget: action.reply_target ?? 'source',
      replyContactId: action.reply_contact_id ?? '',
      replyRaw: action.reply_raw ?? '',
      fieldTemplates: { ...(action.field_templates ?? {}) },
      fanOut: action.fan_out ?? 'pair',
      requireApproval: Boolean(action.require_approval),
      approvalRecipient: action.approval_recipient ?? '',
      failureRecipient: action.failure_recipient ?? '',
      confirmTarget: action.confirm_target ?? 'source',
      includeProvenance: action.include_provenance ?? true,
      durationDays: action.duration_days ?? '',
    })),
  };
}

/**
 * Editor form (or a listed rule) -> API payload. Accepts either shape so the
 * rules list can flip `enabled` without loading the full editor form.
 */
export function inboundRuleToPayload(rule) {
  // A row straight from the API is snake_case; normalise it first.
  if ('match_type' in rule) return inboundRuleToPayload(inboundRuleToForm(rule));
  return {
    name: rule.name,
    enabled: rule.enabled,
    priority: Number(rule.priority ?? 0),
    sourceScope: rule.sourceScope ?? 'any',
    sourceGroupIds: [...(rule.sourceGroupIds ?? [])],
    matchType: rule.matchType ?? 'regex',
    pattern: rule.pattern,
    patternFlags: rule.patternFlags ?? 'i',
    stopProcessing: rule.stopProcessing ?? true,
    actions: (rule.actions ?? []).map((action, index) => ({ ...action, position: index })),
  };
}

/** What each match type is called in the editor and the rules list. */
export const MATCH_LABELS = {
  regex: 'Regular expression',
  contains: 'Contains text',
  any: 'Any message',
  natural: 'Certificate request (natural language)',
};

/**
 * Variables a natural-language match adds on top of the built-ins. Shown in
 * the editor because, unlike capture groups, they cannot be read off a pattern.
 */
export const NATURAL_VARIABLES = [
  ['person', 'Іванов Іван Іванович'],
  ['person_rank', 'майор Іванов Іван Іванович'],
  ['rank', 'майор'],
  ['surname', 'Іванов'],
  ['given', 'Іван'],
  ['patronymic', 'Іванович'],
  ['form', 'Форма 5'],
  ['forms', 'Форма 5, Форма 12'],
  ['form_code', 'f5'],
  ['form_number', '5'],
  ['purpose', 'вихідного контролю'],
  ['note', 'для пенсійного'],
  ['personal_number', '123124'],
  ['summary', 'one line per person, for a reply'],
  ['people', 'every person named in the message'],
  ['tickets_count', 'how many work packages this message files'],
];

export const FAN_OUT_LABELS = {
  pair: 'One ticket per certificate',
  person: 'One ticket per person',
  message: 'One ticket for the whole message',
};

export const ACTION_LABELS = {
  react: 'React with emoji',
  create_ticket: 'Create OpenProject ticket',
  send_message: 'Send Signal message',
};
