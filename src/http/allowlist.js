/*
 * Restricts the XML service to the handset.
 *
 * There is no authentication on these routes and there cannot easily be one:
 * a Cisco phone fetching an XML service is not a browser and has no useful
 * credential store. But the endpoints are not harmless -- /dms lists the
 * account's private conversations by name, /servers and /server-channels
 * enumerate its guilds, and /join makes the account join a call and starts
 * piping the handset's microphone into it.
 *
 * The service binds 0.0.0.0 because the phone has to reach it, so anyone able
 * to open a TCP connection to the port could do all of the above. Only one
 * device is ever a legitimate client, and its address is already configured,
 * so the address is the check: deny by default, allow the phone.
 *
 * This is not a substitute for network isolation. A caller who can spoof a
 * source address on the LAN, or who occupies the phone's IP, gets in. Do not
 * expose the port beyond the local segment.
 */

/** IPv4-mapped IPv6 (`::ffff:192.0.2.20`) is what a dual-stack listener sees. */
function normalise(address) {
  if (!address) return '';
  return address.replace(/^::ffff:/i, '').trim();
}

const LOOPBACK = ['127.0.0.1', '::1'];

/**
 * @param {{phoneIp: string, extra?: string[]}} spec
 * @returns Express middleware
 */
function clientAllowlist({ phoneIp, extra = [] }) {
  // Loopback is included so the service can be exercised from the host itself;
  // anything already running here has no need of this port to do harm.
  const allowed = new Set([phoneIp, ...LOOPBACK, ...extra].map(normalise).filter(Boolean));

  console.log(`[XmlService] Accepting requests from: ${[...allowed].join(', ')}`);

  return (req, res, next) => {
    const from = normalise(req.socket?.remoteAddress);

    if (allowed.has(from)) return next();

    console.warn(`[XmlService] Refused request from ${from || 'unknown'} for ${req.originalUrl || req.url}`);
    res.status(403).type('text/plain').send('Forbidden');
  };
}

module.exports = { clientAllowlist, normalise };
