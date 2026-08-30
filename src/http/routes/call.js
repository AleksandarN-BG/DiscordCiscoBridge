// Call lifecycle: bringing a session up, reporting on it, tearing it down.
//
//   /join       start RTP on the phone, then join Discord
//   /connected  the in-call page, re-fetched by its Refresh key
//   /stopped    the phone's own callback when the handset hangs up
//
// Ordering in /join is deliberate. The phone is asked for a stream first,
// because its reply carries the stream id needed to stop it later, and because
// the RTP receiver needs the phone talking before it knows where to send.

const express = require('express');
const { respond, errorPage, connectedPage, guard } = require('../pages');

module.exports = function callRoutes({ discord, phone, bridge, session, urls, rtp }) {
  const router = express.Router();

  router.get(
    '/join',
    guard(urls, 'Join', async (req, res) => {
      const { type, id, guildId } = req.query;
      if (!type || !id) {
        return respond(res, errorPage(urls, 'Error', 'No channel specified'));
      }

      /*
       * The phone can reach /join while a call is already up -- Back to Menu,
       * pick another channel -- and nothing here used to notice. That left the
       * first phone stream orphaned, because its id was overwritten in the
       * session and stopMedia needs it, and VoiceSession replaced its
       * connection without destroying the old one, leaking an audio player and
       * a second encoder onto the same PCM stream.
       */
      if (session.active) {
        console.log(`[Join] Replacing the call in progress (${session.channelName})`);
        await endSession({ session, phone, discord, bridge });
      }

      const channel = await discord.getChannel(id);
      const channelName = describeChannel(channel, type);
      const targetGuildId = type === 'server' ? guildId || channel?.guild?.id : null;

      const streamId = await phone.startMedia(rtp.bridgeIp, rtp.listenPort, urls.stopped());

      // From here the phone is streaming. If Discord will not take us, close
      // that stream before reporting the failure -- otherwise the handset sits
      // in an open call with nothing on the far end.
      try {
        if (type === 'dm') {
          await discord.joinDMCall(id, bridge);
        } else {
          await discord.joinVoiceChannel(targetGuildId, id, bridge);
        }
      } catch (err) {
        await phone.stopMedia(streamId).catch(() => {});
        throw err;
      }

      const users =
        type === 'server'
          ? (await discord.getVoiceChannelMembers(id)).map((u) => u.displayName || u.username)
          : [];

      session.start({
        channelId: id,
        guildId: targetGuildId,
        streamId,
        channelName,
        channelType: type,
        users,
      });

      console.log(`[Join] Connected to ${channelName} (${type})`);
      respond(res, connectedPage(urls, session));
    }),
  );

  router.get(
    '/connected',
    guard(urls, 'Connected', async (req, res) => {
      if (!session.active) {
        return respond(res, errorPage(urls, 'Not Connected', 'No active session'));
      }

      if (session.isRefreshable) {
        const users = await discord.getVoiceChannelMembers(session.channelId);
        session.setUsers(users.map((u) => u.displayName || u.username));
      }

      respond(res, connectedPage(urls, session));
    }),
  );

  // The phone posts here from the onStopped notification set in startMedia.
  // It expects a plain 200 and ignores the body, so this answers before the
  // slower cleanup -- a phone that times out waiting will retry.
  router.post('/stopped', async (req, res) => {
    console.log('[Stopped] Handset hung up');
    res.sendStatus(200);

    if (!session.active) return;

    const { channelName } = session;

    // The handset has already hung up, so its own stream is gone; only the
    // Discord side and the display need attention.
    await endSession({ session, phone, discord, bridge, stopMedia: false });
    await phone.clearDisplay().catch((e) => console.error('[Stopped]', e.message));
    console.log(`[Stopped] Cleaned up after ${channelName}`);
  });

  return router;
};

/**
 * Tear the current call down, leaving nothing running.
 *
 * Order matters: the session is cleared first so a concurrent request cannot
 * act on a half-dismantled call, and each step is allowed to fail without
 * stranding the ones after it.
 *
 * @param {{stopMedia?: boolean}} options pass false when the phone has already
 *        hung up and its stream no longer exists.
 */
async function endSession({ session, phone, discord, bridge, stopMedia = true }) {
  const { streamId } = session;
  session.reset();

  if (stopMedia && streamId) {
    await phone.stopMedia(streamId).catch((e) => console.error('[EndSession] stopMedia:', e.message));
  }

  try {
    discord.leaveVoiceChannel();
  } catch (e) {
    console.error('[EndSession] leaveVoiceChannel:', e.message);
  }

  // A closed UDP socket cannot be rebound and an ended stream will not accept
  // writes, so the audio components are replaced rather than reused.
  bridge.restart();
}

/** A label for whatever kind of channel this is. */
function describeChannel(channel, type) {
  if (!channel) return 'Unknown';

  if (type === 'server') return channel.name || 'Channel';

  // Group DMs are frequently unnamed; fall back to who is in them.
  if (channel.recipients?.size > 0) {
    return (
      channel.name || [...channel.recipients.values()].map((r) => r.username).join(', ')
    );
  }
  return channel.name || channel.recipient?.username || 'DM';
}
