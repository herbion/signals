/**
 * OpenProject's API v3 uses HTTP Basic auth with the literal username
 * "apikey" and the personal access token (from My Account -> Access Tokens)
 * as the password.
 */
function authHeader(apiKey) {
  const token = Buffer.from(`apikey:${apiKey}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

/** A configured base URL may or may not carry a trailing slash. */
export function normalizeBaseUrl(baseUrl) {
  return String(baseUrl ?? '').replace(/\/+$/, '');
}

async function fetchCollection(baseUrl, apiKey, path) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, { headers: authHeader(apiKey) });
  if (!response.ok) {
    throw new Error(`OpenProject API ${path} failed: ${response.status}`);
  }
  const body = await response.json();
  return (body._embedded?.elements ?? []).map((el) => ({ id: el.id, name: el.name }));
}

/** Used by Settings -> OpenProject -> "Test Connection". */
export async function testConnection(baseUrl, apiKey) {
  const response = await fetch(`${baseUrl}/api/v3/users/me`, { headers: authHeader(apiKey) });
  if (!response.ok) {
    throw new Error(`OpenProject connection test failed: ${response.status}`);
  }
  return response.json();
}

/**
 * Fetches all users, preserving their raw `customFieldNN` values (which is
 * where OpenProject stores per-user fields like a phone number). Paginates
 * until the collection is exhausted -- `/api/v3/users` caps pageSize, so a
 * single request silently truncates on larger instances.
 */
export async function fetchUsers(baseUrl, apiKey) {
  const users = [];
  const pageSize = 100;
  let offset = 1;

  while (true) {
    const response = await fetch(`${baseUrl}/api/v3/users?pageSize=${pageSize}&offset=${offset}`, {
      headers: authHeader(apiKey),
    });
    if (!response.ok) {
      throw new Error(`OpenProject API /api/v3/users failed: ${response.status}`);
    }
    const body = await response.json();
    const elements = body._embedded?.elements ?? [];
    users.push(...elements);
    if (users.length >= (body.total ?? users.length) || elements.length === 0) break;
    offset += 1;
  }

  return users;
}

/**
 * Fetches types/statuses/projects/custom fields to power the rule
 * condition-builder's dropdowns. Purely a UX convenience -- webhook
 * processing never depends on this succeeding, so callers should catch
 * failures and fall back to free-text fields in the UI.
 */
export async function fetchMetadata(baseUrl, apiKey) {
  // `Promise.all` used to be used here, which meant a single endpoint failing
  // discarded everything. `/api/v3/custom_fields` does not exist on every
  // OpenProject version (it 404s on 13.x), so metadata refresh failed
  // outright and every type/status/project dropdown in the app stayed empty.
  // Each endpoint now degrades on its own.
  const wanted = [
    ['types', '/api/v3/types?pageSize=200'],
    ['statuses', '/api/v3/statuses?pageSize=200'],
    ['projects', '/api/v3/projects?pageSize=200'],
    ['priorities', '/api/v3/priorities?pageSize=200'],
    ['customFields', '/api/v3/custom_fields?pageSize=200'],
  ];
  const settled = await Promise.allSettled(
    wanted.map(([, path]) => fetchCollection(baseUrl, apiKey, path))
  );

  const metadata = { fetchedAt: new Date().toISOString(), unavailable: [] };
  settled.forEach((result, index) => {
    const [key] = wanted[index];
    if (result.status === 'fulfilled') {
      metadata[key] = result.value;
    } else {
      metadata[key] = [];
      metadata.unavailable.push({ key, error: result.reason?.message ?? String(result.reason) });
    }
  });

  // Which types each project actually offers -- a project only accepts work
  // packages of the types enabled on it, so the rule editor must not offer
  // combinations OpenProject will reject.
  metadata.projectTypes = {};
  await Promise.all(
    (metadata.projects ?? []).map(async (project) => {
      try {
        metadata.projectTypes[project.id] = (
          await fetchCollection(baseUrl, apiKey, `/api/v3/projects/${project.id}/types?pageSize=200`)
        ).map((t) => t.id);
      } catch {
        metadata.projectTypes[project.id] = [];
      }
    })
  );

  // Archived projects can't receive new work packages; flag them so the
  // editor can say so rather than letting a rule fail at message time.
  try {
    const raw = await fetch(`${normalizeBaseUrl(baseUrl)}/api/v3/projects?pageSize=200`, {
      headers: authHeader(apiKey),
    });
    if (raw.ok) {
      const body = await raw.json();
      const activeById = new Map((body._embedded?.elements ?? []).map((p) => [p.id, p.active !== false]));
      metadata.projects = (metadata.projects ?? []).map((p) => ({ ...p, active: activeById.get(p.id) !== false }));
    }
  } catch {
    // leave projects unannotated
  }

  if (!metadata.types?.length && !metadata.projects?.length) {
    const reasons = metadata.unavailable.map((u) => `${u.key}: ${u.error}`).join('; ');
    throw new Error(`could not read anything from OpenProject (${reasons || 'unknown error'})`);
  }
  return metadata;
}

/**
 * A work package's writable fields for one (project, type) pair.
 *
 * This uses the **form** endpoint rather than `/work_packages/schemas/...`
 * for two reasons: it fills in `allowedValues` (the plain schema returns an
 * empty `_links` for custom option fields), and it validates without creating
 * anything, so the returned `validationErrors` name exactly which fields a
 * rule must supply.
 *
 * `location: "_links"` on a field is OpenProject telling us the value belongs
 * under `_links` as an href rather than as a plain attribute -- that is what
 * `buildWorkPackagePayload` keys off.
 */
export async function fetchTypeSchema(baseUrl, apiKey, projectId, typeId, payload = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const response = await fetch(`${base}/api/v3/projects/${projectId}/work_packages/form`, {
    method: 'POST',
    headers: { ...authHeader(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, _links: { type: { href: `/api/v3/types/${typeId}` }, ...(payload._links ?? {}) } }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenProject work package form failed (${response.status}): ${body.slice(0, 300)}`);
  }
  const form = await response.json();
  const schema = form._embedded?.schema ?? {};

  const fields = [];
  for (const [key, definition] of Object.entries(schema)) {
    if (!definition || typeof definition !== 'object' || !definition.type) continue;
    if (['project', 'type'].includes(key)) continue; // chosen by the rule itself

    let allowedValues = null;
    const embedded = definition._embedded?.allowedValues;
    const href = definition._links?.allowedValues?.href;
    if (Array.isArray(embedded)) {
      allowedValues = toAllowedValues(embedded);
    } else if (href) {
      allowedValues = await fetchAllowedValues(base, apiKey, href);
    }

    fields.push({
      key,
      name: definition.name ?? key,
      type: definition.type,
      required: Boolean(definition.required),
      hasDefault: Boolean(definition.hasDefault),
      writable: definition.writable !== false,
      // Subject is not writable on types whose subject OpenProject generates
      // from a pattern; the placeholder explains that to the admin.
      placeholder: definition.placeholder ?? null,
      location: definition.location ?? null,
      isCustomField: /^customField\d+$/.test(key),
      allowedValues,
    });
  }

  const validationErrors = Object.fromEntries(
    Object.entries(form._embedded?.validationErrors ?? {}).map(([key, err]) => [key, err?.message ?? 'invalid'])
  );

  return { projectId: Number(projectId), typeId: Number(typeId), fields, validationErrors };
}

/**
 * One entry of a field's closed list. Hierarchy items (`/custom_fields/N/items`)
 * also carry where they sit in the tree -- `depth` and the parent's id -- so a
 * picker can show "БАР › Береза Андрій" instead of 60 flat names.
 */
function toAllowedValue(element) {
  const href = element?._links?.self?.href ?? null;
  const parentHref = element?._links?.parent?.href ?? null;
  const value = {
    href,
    id: element?.id ?? (href ? Number(href.split('/').pop()) : null),
    // Labels are typed by hand in OpenProject and sometimes keep a stray
    // leading space (" Гела Мар'яна").
    label: String(element?.value ?? element?.name ?? element?.label ?? element?.id ?? '').trim(),
  };
  if (element?._type === 'HierarchyItem') {
    value.depth = Number.isInteger(element.depth) ? element.depth : 0;
    value.parentId = parentHref ? Number(parentHref.split('/').pop()) : null;
  }
  return value;
}

/**
 * A hierarchy's collection starts with its root item -- no label, no parent,
 * depth null. It is the container, not a choice, and shown as an option it is
 * just its own id ("5").
 */
function isHierarchyRoot(element) {
  return element?._type === 'HierarchyItem' && element.label == null && !element._links?.parent?.href;
}

function toAllowedValues(elements) {
  const values = elements.filter((element) => !isHierarchyRoot(element)).map(toAllowedValue);
  // Top-level items point at the root we just dropped.
  const ids = new Set(values.map((v) => v.id));
  for (const v of values) if (v.parentId != null && !ids.has(v.parentId)) v.parentId = null;
  return values;
}

async function fetchAllowedValues(base, apiKey, href) {
  try {
    const response = await fetch(`${base}${href}`, { headers: authHeader(apiKey) });
    if (!response.ok) return null;
    const body = await response.json();
    const elements = body._embedded?.elements ?? (Array.isArray(body) ? body : []);
    return toAllowedValues(elements);
  } catch {
    return null;
  }
}

/** Where a link-typed field's value lives when the schema offers no allowedValues. */
const LINK_PATHS = {
  User: 'users',
  Priority: 'priorities',
  Status: 'statuses',
  Version: 'versions',
  Category: 'categories',
  WorkPackage: 'work_packages',
  CustomOption: 'custom_options',
};

/**
 * Turns a configured value into an API href. Rules can store either the
 * numeric id a dropdown produced, the label a human typed, or a full href.
 */
/**
 * The entry of a field's closed list that this value names, by href, id or
 * label -- or null when the list has no such entry.
 *
 * Split out from `resolveLinkHref` so a caller can *ask* whether a value fits
 * rather than find out by catching the throw: a rule that renders "Форма 5"
 * into a list that has no such option should fall back to the option the
 * install keeps for exactly that ("Інше (Вкажу в описі)"), not fail with a 422.
 */
export function findAllowedValue(field, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return (
    (field?.allowedValues ?? []).find(
      (option) =>
        option.href === raw ||
        String(option.id) === raw ||
        (option.label ?? '').toLowerCase() === raw.toLowerCase()
    ) ?? null
  );
}

/** True when this field's value must come from a list the schema supplied. */
export function hasClosedList(field) {
  return Array.isArray(field?.allowedValues) && field.allowedValues.length > 0;
}

export function resolveLinkHref(field, value) {
  const raw = String(value).trim();
  if (raw.startsWith('/api/v3/')) return raw;

  const match = findAllowedValue(field, raw);
  if (match?.href) return match.href;

  const bare = field.type.replace(/^\[\]/, '');
  const path = LINK_PATHS[bare] ?? (bare.startsWith('CustomField::Hierarchy') ? null : null);
  if (path && /^\d+$/.test(raw)) return `/api/v3/${path}/${raw}`;

  throw new Error(`"${raw}" is not a valid value for ${field.name}`);
}

/**
 * Builds an API v3 create payload from rendered field values, driven by the
 * schema rather than by a fixed list of attributes.
 *
 * Fields the schema marks non-writable are dropped rather than sent: types
 * whose subject OpenProject generates from a pattern report
 * `subject.writable === false`, and posting a subject to one of those is a
 * validation error. `location === '_links'` decides href-vs-attribute.
 *
 * Pure -- see test/workPackagePayload.test.js.
 */
export function buildWorkPackagePayload({ projectId, typeId, fields, schema }) {
  const payload = { _links: { project: { href: `/api/v3/projects/${projectId}` } } };
  if (typeId) payload._links.type = { href: `/api/v3/types/${typeId}` };

  const schemaFields = schema?.fields ?? [];
  const byKey = new Map(schemaFields.map((field) => [field.key, field]));
  // With no schema at all (OpenProject unreachable, or no type chosen) there
  // is nothing to filter against, so fall back to posting what we were given.
  // Dropping `subject` in that case would create blank work packages.
  const schemaKnown = schemaFields.length > 0;
  const skipped = [];

  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined || value === null || String(value).trim() === '') continue;
    const field = byKey.get(key);

    if (!field) {
      if (!schemaKnown || /^customField\d+$/.test(key)) {
        payload[key] = key === 'description' ? { format: 'markdown', raw: String(value) } : value;
      } else {
        skipped.push(key);
      }
      continue;
    }
    if (!field.writable) {
      skipped.push(key);
      continue;
    }

    if (field.location === '_links') {
      const isMulti = field.type.startsWith('[]');
      const values = Array.isArray(value) ? value : String(value).split(',').map((v) => v.trim()).filter(Boolean);
      const hrefs = values.map((v) => ({ href: resolveLinkHref(field, v) }));
      payload._links[key] = isMulti ? hrefs : hrefs[0];
      continue;
    }

    switch (field.type) {
      case 'Formattable':
        payload[key] = { format: 'markdown', raw: String(value) };
        break;
      case 'Integer':
      case 'Float':
        payload[key] = Number(value);
        break;
      case 'Boolean':
        payload[key] = value === true || value === 'true' || value === 1 || value === '1';
        break;
      default:
        payload[key] = String(value);
    }
  }

  return { payload, skipped };
}

/** Turns an OpenProject error body into something worth showing a human. */
export function describeOpenProjectError(status, body) {
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    return `OpenProject rejected the work package (${status}): ${String(body).slice(0, 300)}`;
  }

  const details = parsed?._embedded?.errors;
  if (Array.isArray(details) && details.length) {
    return `OpenProject rejected the work package: ${details.map((e) => e.message).join('; ')}`;
  }
  if (parsed?.message) {
    return `OpenProject rejected the work package: ${parsed.message}`;
  }
  return `OpenProject rejected the work package (${status})`;
}

/**
 * Creates a work package. `fields` is a flat map of schema keys to already
 * rendered values (`subject`, `description`, `customField14`, ...); the
 * schema decides how each one is encoded and which are dropped.
 */
export async function createWorkPackage(baseUrl, apiKey, { projectId, typeId, fields = {}, schema = null, authorId }) {
  if (!projectId) throw new Error('an OpenProject project is required to create a work package');

  const base = normalizeBaseUrl(baseUrl);
  const effectiveSchema = schema ?? (typeId ? await fetchTypeSchema(baseUrl, apiKey, projectId, typeId) : { fields: [] });

  // `author` goes through the same schema gate as every other field rather
  // than being appended afterwards. OpenProject reports it as
  // `writable: false` on a normal API token -- it sets the author to the
  // authenticating user -- and sending it anyway fails the whole create with
  // "Author was attempted to be written but is not writable". The reporter is
  // still named in the description's provenance header either way.
  const authorField = (effectiveSchema.fields ?? []).find((field) => field.key === 'author');
  const withAuthor =
    authorId && authorField?.writable ? { ...fields, author: authorId } : fields;

  const { payload } = buildWorkPackagePayload({ projectId, typeId, fields: withAuthor, schema: effectiveSchema });

  const response = await fetch(`${base}/api/v3/work_packages`, {
    method: 'POST',
    headers: { ...authHeader(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(describeOpenProjectError(response.status, errorBody));
  }

  const created = await response.json();
  return {
    id: created.id,
    subject: created.subject ?? fields.subject ?? '',
    url: `${base}/work_packages/${created.id}`,
    raw: created,
  };
}


/**
 * Adds a comment to a work package's activity, as the API token's user.
 *
 * `POST /work_packages/{id}/activities` with `{ comment: { raw } }` is the API
 * v3 "comment work package" call; the token's user needs the "Add notes"
 * permission in that project, or this is a 403. The comment itself bumps the
 * work package's `updatedAt` and so comes back as another webhook -- harmless,
 * because nothing a rule watches changed in it (see edge triggering).
 */
export async function addWorkPackageComment(baseUrl, apiKey, workPackageId, text) {
  if (!workPackageId) throw new Error('a work package id is required to comment on it');
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/v3/work_packages/${workPackageId}/activities`, {
    method: 'POST',
    headers: { ...authHeader(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment: { raw: text } }),
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(describeOpenProjectError(response.status, errorBody));
  }
  return response.json().catch(() => null);
}
