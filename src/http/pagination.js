// Slicing long lists into pages the phone can display.
//
// An 8845 shows a handful of menu rows at a time and has no scrollbar, so a
// server list of any size has to be paged or it is simply unreachable.

/**
 * @param {Array} items
 * @param {unknown} pageParam raw query value; anything unparseable is page 0
 * @param {number} perPage
 */
function paginate(items, pageParam, perPage) {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));

  // Clamp rather than 404: a stale bookmark on the phone should land somewhere
  // usable, not on an error page the user cannot navigate out of.
  const requested = Number.parseInt(pageParam, 10);
  const page = Number.isNaN(requested) ? 0 : Math.min(Math.max(requested, 0), totalPages - 1);

  const start = page * perPage;

  return {
    items: items.slice(start, start + perPage),
    page,
    totalPages,
    hasPrev: page > 0,
    hasNext: start + perPage < items.length,
  };
}

/**
 * Previous/Next rows for a paged menu.
 * @param {{page: number, hasPrev: boolean, hasNext: boolean}} state
 * @param {(page: number) => string} pageUrl
 */
function pageLinks({ page, hasPrev, hasNext }, pageUrl) {
  const links = [];
  if (hasPrev) links.push({ name: 'Previous Page', url: pageUrl(page - 1) });
  if (hasNext) links.push({ name: 'Next Page', url: pageUrl(page + 1) });
  return links;
}

module.exports = { paginate, pageLinks };
