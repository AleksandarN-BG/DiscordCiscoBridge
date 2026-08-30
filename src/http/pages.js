// Page renderings and route plumbing shared by more than one router.

const xml = require('../cisco/xml');

/** Cisco phones only parse a response typed as XML. */
function respond(res, document) {
  res.type('text/xml').send(document);
}

/**
 * An error the user can navigate out of.
 *
 * Always carries a soft key back to the menu: the phone gives no other way off
 * a text page, so an error without one strands whoever hit it.
 */
function errorPage(urls, title, message) {
  return xml.textPage({
    title,
    body: String(message ?? 'Unknown error'),
    softKeys: [{ name: 'Menu', url: urls.menu() }],
  });
}

/** The page shown while a call is up, from both /join and /connected. */
function connectedPage(urls, session) {
  const roster = userList(session.users, 6);

  return xml.textPage({
    title: 'Connected',
    body: [
      `Channel: ${xml.displayName(session.channelName, 40)}`,
      ...(roster ? ['', `Users (${session.users.length}):`, roster] : []),
      '',
      'Hang up to disconnect.',
    ].join('\n'),
    softKeys: [{ name: 'Refresh', url: urls.connected() }],
  });
}

/**
 * A truncated list of names for a text page.
 * @param {string[]} users
 */
function userList(users, limit) {
  if (!users || users.length === 0) return '';

  const lines = users.slice(0, limit).map((u) => `- ${xml.displayName(u, 20)}`);
  if (users.length > limit) lines.push(`...and ${users.length - limit} more`);
  return lines.join('\n');
}

/**
 * Wrap a handler so a thrown error becomes a page rather than a dead request.
 *
 * The phone shows a bare "Host not found" for a non-XML response, which says
 * nothing about what went wrong, so every failure has to be rendered.
 */
function guard(urls, label, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      console.error(`[${label}]`, e.message);
      respond(res, errorPage(urls, 'Error', e.message));
    }
  };
}

module.exports = { respond, errorPage, connectedPage, userList, guard };
