// /status -- reachable from the root menu whether or not a call is up.

const express = require('express');
const xml = require('../../cisco/xml');
const { respond, userList } = require('../pages');

const STATUS_USER_LIMIT = 8;

module.exports = function statusRoutes({ session, urls }) {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const body = session.active ? connectedBody(session) : 'Status: Idle\n\nNo active connection.';

    respond(
      res,
      xml.textPage({
        title: 'Bridge Status',
        body,
        softKeys: [
          { name: 'Refresh', url: urls.status() },
          { name: 'Menu', url: urls.menu() },
        ],
      }),
    );
  });

  return router;
};

function connectedBody(session) {
  const roster = userList(session.users, STATUS_USER_LIMIT);

  return [
    'Status: Connected',
    '',
    `Channel: ${xml.displayName(session.channelName, 40)}`,
    ...(roster ? ['', 'Users in channel:', roster] : ['', 'No other users']),
  ].join('\n');
}
