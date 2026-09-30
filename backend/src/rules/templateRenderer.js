/**
 * Builds the human-facing OpenProject link for a work package.
 *
 * The webhook payload's `_links.self.href` is a *relative* **API** path
 * (`/api/v3/work_packages/42`) -- useless in a Signal message, which needs
 * an absolute URL pointing at the page a person can actually open. So the
 * link is composed from the configured base URL instead. The trailing-slash
 * strip matters: base URLs are commonly stored as `http://host:9999/`.
 */
export function workPackageUrl(baseUrl, workPackageId) {
  if (!baseUrl || workPackageId === undefined || workPackageId === null) return '';
  return `${String(baseUrl).trim().replace(/\/+$/, '')}/work_packages/${workPackageId}`;
}

/**
 * Builds the variable context a message template can reference: {id},
 * {subject}, {type}, {status}, {project}, {assignee}, {author}, {priority},
 * {url}, plus "{field}_from" for the previous value of any changed relation
 * field, plus each custom field keyed by its OpenProject identifier (e.g.
 * {customField12}).
 *
 * `baseUrl` comes from openproject_settings and is what makes {url}
 * absolute; callers that don't supply it fall back to the payload's
 * relative API href rather than emitting an empty link.
 */
export function buildTemplateContext(snapshot, changeSet, { baseUrl } = {}) {
  const changeByField = new Map(changeSet.map((entry) => [entry.field, entry]));
  const relationName = (value) => (value && typeof value === 'object' ? value.name ?? '' : value ?? '');

  const context = {
    id: snapshot.id,
    subject: snapshot.subject ?? '',
    type: relationName(snapshot.type),
    status: relationName(snapshot.status),
    project: relationName(snapshot.project),
    assignee: relationName(snapshot.assignee),
    author: relationName(snapshot.author),
    priority: relationName(snapshot.priority),
    url: workPackageUrl(baseUrl, snapshot.id) || snapshot.url || '',
  };

  for (const field of ['type', 'status', 'project', 'assignee', 'author', 'priority']) {
    const entry = changeByField.get(field);
    if (entry?.changed) context[`${field}_from`] = relationName(entry.from);
  }

  for (const [key, value] of Object.entries(snapshot.customFields ?? {})) {
    context[key] = relationName(value);
  }

  return context;
}

/**
 * Substitutes {variable} placeholders. A placeholder with no matching key is
 * left as-is (rather than silently becoming an empty string) so a typo in a
 * rule's template is visible in the delivered message instead of hidden.
 */
export function renderTemplate(template, context) {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(context, key) ? String(context[key]) : match
  );
}
