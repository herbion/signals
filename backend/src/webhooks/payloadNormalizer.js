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

const CUSTOM_FIELD_KEY = /^customField\d+$/;

/**
 * Custom fields come in two places. Plain values (text, number, date) are
 * top-level properties; anything that points at another resource -- a list
 * option (`/api/v3/custom_options/2`), a hierarchy item
 * (`/api/v3/custom_field_items/57`, e.g. "👤Замовник") or a user -- appears
 * **only** under `_links`, as one link or, for a multi-select, an array of
 * them ("🌀Тип довідки" is `[{ title: "Форма 6", href: ... }]`). Reading only
 * top-level keys silently dropped every one of those for months.
 *
 * Link values normalize to `{ id, name, kind }`; `kind` says whether the id is
 * an OpenProject user or a list option, because the two id spaces overlap and
 * mistaking one for the other would notify an unrelated person. A
 * multi-select with several values joins ids and names with ", ".
 */
function extractCustomFields(wp, embedded, links) {
  const result = {};
  for (const key of Object.keys(wp)) {
    if (!CUSTOM_FIELD_KEY.test(key)) continue;
    const relational = pickRelation(embedded[key], links[key]);
    result[key] = relational ?? wp[key] ?? null;
  }
  for (const key of Object.keys(links)) {
    if (!CUSTOM_FIELD_KEY.test(key) || key in result) continue;
    result[key] = linkedCustomFieldValue(links[key]);
  }
  return result;
}

function linkedCustomFieldValue(link) {
  const items = (Array.isArray(link) ? link : [link]).filter((item) => item && (item.href || item.title));
  if (items.length === 0) return null;
  const values = items.map((item) => ({
    id: idFromHref(item.href),
    name: item.title ?? null,
    kind: /\/users\/\d+$/.test(item.href ?? '') ? 'user' : 'option',
  }));
  if (values.length === 1) return values[0];
  return {
    id: values.map((v) => v.id).join(','),
    name: values.map((v) => v.name).join(', '),
    kind: values[0].kind,
  };
}
