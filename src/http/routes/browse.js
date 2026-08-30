// Read-only navigation: what the phone can look at before committing to a call.
//
//   /menu            the root
//   /dms             DMs and group DMs, paged
//   /servers         guilds, paged
//   /server-channels voice channels in one guild, paged
//   /preview         one channel, with its roster and a Connect key

const express = require('express');
const xml = require('../../cisco/xml');
const { paginate, pageLinks } = require('../pagination');
const { respond, errorPage, userList, guard } = require('../pages');

const DMS_PER_PAGE = 12;
const SERVERS_PER_PAGE = 8;
const CHANNELS_PER_PAGE = 8;

/** Names shown in the roster on a preview page. */
const PREVIEW_USER_LIMIT = 10;

module.exports = function browseRoutes({ discord, urls }) {
  const router = express.Router();

  const rootMenu = () =>
    xml.menu({
      title: 'Discord Bridge',
      prompt: 'Select an option',
      items: [
        { name: 'Direct Messages', url: urls.dms() },
        { name: 'Servers', url: urls.servers() },
        { name: 'Status', url: urls.status() },
      ],
    });

  // /discord-menu is the original path. Phones already provisioned with it do
  // not reliably follow a redirect, so it serves the page rather than a 302.
  router.get(['/menu', '/discord-menu'], (req, res) => respond(res, rootMenu()));

  router.get(
    '/dms',
    guard(urls, 'DMs', async (req, res) => {
      const conversations = await discord.getDMChannels();
      const paged = paginate(conversations, req.query.page, DMS_PER_PAGE);

      const items = paged.items.map((channel) => ({
        // Group DMs are prefixed because their names are often people's names
        // too, and there is no room for a second line to say which it is.
        name: `${channel.type === 3 ? 'G:' : ''}${xml.displayName(channel.name) || 'Unknown'}`,
        url: urls.preview({ type: 'dm', id: channel.id }),
      }));

      if (items.length === 0) {
        items.push({ name: '(No DMs available)', url: urls.menu() });
      }

      respond(
        res,
        xml.menu({
          title: `DMs (${paged.page + 1}/${paged.totalPages})`,
          prompt: 'Select a conversation',
          items: [
            ...items,
            ...pageLinks(paged, (n) => urls.dms(n)),
            { name: 'Back to Menu', url: urls.menu() },
          ],
        }),
      );
    }),
  );

  router.get(
    '/servers',
    guard(urls, 'Servers', async (req, res) => {
      const guilds = await discord.getGuilds();
      const paged = paginate(guilds, req.query.page, SERVERS_PER_PAGE);

      const items = paged.items.map((guild) => ({
        name: xml.displayName(guild.name),
        url: urls.serverChannels(guild.id),
      }));

      if (items.length === 0) {
        items.push({ name: '(No servers available)', url: urls.menu() });
      }

      respond(
        res,
        xml.menu({
          title: `Servers (${paged.page + 1}/${paged.totalPages})`,
          prompt: 'Select a server',
          items: [
            ...items,
            ...pageLinks(paged, (n) => urls.servers(n)),
            { name: 'Back to Menu', url: urls.menu() },
          ],
        }),
      );
    }),
  );

  router.get(
    '/server-channels',
    guard(urls, 'ServerChannels', async (req, res) => {
      const { guildId } = req.query;
      if (!guildId) {
        return respond(res, errorPage(urls, 'Error', 'No server specified'));
      }

      const [channels, guild] = await Promise.all([
        discord.getVoiceChannels(guildId),
        discord.getGuild(guildId),
      ]);

      const paged = paginate(channels, req.query.page, CHANNELS_PER_PAGE);

      const items = paged.items.map((channel) => ({
        name: `${xml.displayName(channel.name)}${channel.memberCount > 0 ? ` (${channel.memberCount})` : ''}`,
        url: urls.preview({ type: 'server', id: channel.id, guildId }),
      }));

      if (items.length === 0) {
        items.push({ name: '(No voice channels)', url: urls.servers() });
      }

      respond(
        res,
        xml.menu({
          title: `${xml.displayName(guild?.name || 'Server')} (${paged.page + 1}/${paged.totalPages})`,
          prompt: 'Select a channel',
          items: [
            ...items,
            ...pageLinks(paged, (n) => urls.serverChannels(guildId, n)),
            { name: 'Back to Servers', url: urls.servers() },
          ],
        }),
      );
    }),
  );

  router.get(
    '/preview',
    guard(urls, 'Preview', async (req, res) => {
      const { type, id, guildId } = req.query;
      if (!type || !id) {
        return respond(res, errorPage(urls, 'Error', 'Invalid channel'));
      }

      const channel = await discord.getChannel(id);

      // A DM has no voice roster to show until the call exists, so only guild
      // channels get a user list here.
      const isServer = type === 'server' && Boolean(guildId);
      const users = isServer
        ? (await discord.getVoiceChannelMembers(id)).map((u) => u.displayName || u.username)
        : [];

      const channelName = isServer
        ? channel?.name || 'Channel'
        : channel?.name || channel?.recipient?.username || 'DM';

      const roster = userList(users, PREVIEW_USER_LIMIT);
      const rosterLines = roster
        ? ['', `Active Users (${users.length}):`, roster]
        : isServer
          ? ['', 'No users in channel']
          : [];

      respond(
        res,
        xml.textPage({
          title: xml.displayName(channelName, 40),
          body: [
            `Channel: ${xml.displayName(channelName, 40)}`,
            ...rosterLines,
            '',
            'Press Select to connect or Back to cancel.',
          ].join('\n'),
          softKeys: [
            { name: 'Connect', url: urls.join({ type, id, guildId }) },
            {
              name: 'Back',
              url: isServer ? urls.serverChannels(guildId) : urls.dms(),
            },
          ],
        }),
      );
    }),
  );

  return router;
};
