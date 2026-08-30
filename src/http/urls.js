// Every URL the phone can be sent to, in one place.
//
// The phone fetches each page over the network, so these must be absolute and
// reachable from the handset -- a relative path or localhost would not resolve.
// Building them here rather than interpolating a base URL at each call site
// means a route can be renamed without hunting through the handlers.

function buildUrls(publicUrl) {
  const base = publicUrl.replace(/\/$/, '');
  const at = (path, query) => {
    const params = new URLSearchParams(
      Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== null),
    );
    const qs = params.toString();
    return qs ? `${base}${path}?${qs}` : `${base}${path}`;
  };

  return {
    menu: () => at('/menu'),
    dms: (page = 0) => at('/dms', { page }),
    servers: (page = 0) => at('/servers', { page }),
    serverChannels: (guildId, page = 0) => at('/server-channels', { guildId, page }),
    preview: ({ type, id, guildId }) => at('/preview', { type, id, guildId }),
    join: ({ type, id, guildId }) => at('/join', { type, id, guildId }),
    connected: () => at('/connected'),
    status: () => at('/status'),
    stopped: () => at('/stopped'),
  };
}

module.exports = { buildUrls };
