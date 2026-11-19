/**
 * A field's allowedValues as a tree. Hierarchy custom fields ("👤Замовник":
 * unit -> person) come from the backend with `parentId` / `depth`; a plain
 * option list has neither and comes out as a flat list of roots, so every
 * caller can treat both the same way.
 */

/** Lower-case, one apostrophe, single spaces -- "Мар’яна" finds "Мар'яна". */
export function foldText(text) {
  return String(text ?? '')
    .toLocaleLowerCase('uk')
    .replace(/[’ʼ`‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @returns {{ rows: Row[], byId: Map<string, Row> }} rows in display order
 *   (each parent directly followed by its subtree), where
 *   Row = { id, label, option, depth, parent, children, path, search }
 */
export function buildOptionTree(options) {
  const nodes = [];
  const byId = new Map();
  // Fallback when an item names no parent but has a depth: the collection is
  // returned pre-ordered, so the parent is the last item seen one level up.
  const lastAtDepth = [];

  for (const option of options ?? []) {
    if (option == null || option.id == null) continue;
    const id = String(option.id);
    const node = { id, label: String(option.label ?? id).trim(), option, children: [], parent: null };

    if (option.parentId != null && byId.has(String(option.parentId))) {
      node.parent = byId.get(String(option.parentId));
    } else if (option.parentId == null && Number.isInteger(option.depth) && option.depth > 0) {
      node.parent = lastAtDepth[option.depth - 1] ?? null;
    }
    if (Number.isInteger(option.depth)) {
      lastAtDepth[option.depth] = node;
      lastAtDepth.length = option.depth + 1;
    }

    if (node.parent) node.parent.children.push(node);
    nodes.push(node);
    byId.set(id, node);
  }

  const rows = [];
  const visit = (node, depth, ancestors) => {
    node.depth = depth;
    node.path = [...ancestors, node.label];
    node.search = foldText(node.path.join(' '));
    rows.push(node);
    for (const child of node.children) visit(child, depth + 1, node.path);
  };
  for (const node of nodes) if (!node.parent) visit(node, 0, []);

  return { rows, byId };
}

/** "БАР › Береза Андрій" for a stored id, or null when the list has no such entry. */
export function optionPathLabel(options, id, separator = ' › ') {
  if (id === null || id === undefined || String(id).trim() === '') return null;
  const node = buildOptionTree(options).byId.get(String(id));
  return node ? node.path.join(separator) : null;
}

/**
 * Splits a label into plain and highlighted runs for every search token.
 * Folding keeps string length (one char -> one char), so offsets found in the
 * folded copy are valid in the original.
 */
export function highlightRuns(label, tokens) {
  const text = String(label ?? '');
  if (!tokens?.length) return [{ text, hit: false }];
  const folded = text.toLocaleLowerCase('uk').replace(/[’ʼ`‘]/g, "'");
  if (folded.length !== text.length) return [{ text, hit: false }];

  const marks = new Array(text.length).fill(false);
  for (const token of tokens) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(token, from);
      if (at === -1 || !token) break;
      for (let i = at; i < at + token.length; i++) marks[i] = true;
      from = at + token.length;
    }
  }

  const runs = [];
  for (let i = 0; i < text.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.hit === marks[i]) last.text += text[i];
    else runs.push({ text: text[i], hit: marks[i] });
  }
  return runs;
}
