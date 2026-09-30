/**
 * Flattens an OpenProject webhook body into a stable WorkPackageSnapshot.
 *
 * OpenProject's webhook payload is `{ action, work_package: <HAL+JSON WP resource> }`.
 * Relations (type/status/project/assignee/priority) may appear fully in
 * `_embedded`, or only as `_links` (href + title, no id/other fields) --
 * which one you get depends on the OpenProject version and webhook config.
 * `pickRelation` below handles both.
 */
export function normalizeWebhookPayload(body) {
  const wp = body?.work_package ?? body;
  if (!wp || typeof wp !== 'object' || wp.id === undefined) {
    throw new Error('Webhook payload missing work_package data');
  }

  const embedded = wp._embedded ?? {};
  const links = wp._links ?? {};

  return {
    id: wp.id,
    subject: wp.subject ?? null,
    type: pickRelation(embedded.type, links.type),
    status: pickRelation(embedded.status, links.status),
    project: pickRelation(embedded.project, links.project),
    assignee: pickRelation(embedded.assignee, links.assignee),
    author: pickRelation(embedded.author, links.author),
    priority: pickRelation(embedded.priority, links.priority),
    customFields: extractCustomFields(wp, embedded, links),
    createdAt: wp.createdAt ?? null,
    updatedAt: wp.updatedAt ?? null,
    url: links.self?.href ?? null,
    action: body?.action ?? null,
  };
}

function pickRelation(embeddedValue, link) {
  if (embeddedValue && typeof embeddedValue === 'object') {
    return { id: embeddedValue.id ?? idFromHref(link?.href), name: embeddedValue.name ?? link?.title ?? null };
  }
  if (link && (link.href || link.title)) {
    return { id: idFromHref(link.href), name: link.title ?? null };
  }
  return null;
}

function idFromHref(href) {
  if (!href) return null;
  const match = href.match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function extractCustomFields(wp, embedded, links) {
  const result = {};
  for (const key of Object.keys(wp)) {
    if (!/^customField\d+$/.test(key)) continue;
    const relational = pickRelation(embedded[key], links[key]);
    result[key] = relational ?? wp[key] ?? null;
  }
  return result;
}
