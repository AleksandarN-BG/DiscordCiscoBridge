// Entry point: builds the four components, wires them, and runs until stopped.
//
//   config      .env -> validated settings
//   DiscordClient  the user account, its directory and its voice session
//   PhoneApi       the handset's CGI interface
//   AudioBridge    RTP <-> Opus in both directions
//   XmlService     the menus the phone browses, which drive the other three
//
// Order matters: Discord has to be logged in before its directory can be
// listed, and the RTP socket has to be bound before the phone is told to
// stream to it.

const config = require('./config');
const DiscordClient = require('./discord/client');
const PhoneApi = require('./cisco/phone-api');
const AudioBridge = require('./audio/bridge');
const XmlService = require('./http/xml-service');

async function main() {
  console.log('=== Discord-Cisco bridge starting ===\n');

  const discord = new DiscordClient(config.discord.userToken);
  await discord.login();

  const phone = new PhoneApi(config.phone);

  const bridge = new AudioBridge(config.rtp.listenPort);
  bridge.start();

  const xmlService = new XmlService({
    http: config.http,
    rtp: config.rtp,
    phoneIp: config.phone.ip,
    discord,
    phone,
    bridge,
  });
  xmlService.start();

  console.log(`
=== Ready ===
  Phone service URL   ${config.http.publicUrl}/menu
  RTP listening on    ${config.rtp.bridgeIp}:${config.rtp.listenPort}
  Handset             ${config.phone.ip}

Browse to the service on the phone and pick a channel.
`);

  installShutdown(async () => {
    console.log('\n=== Shutting down ===');
    await xmlService.stop();
    bridge.stop();
    discord.leaveVoiceChannel();
    console.log('Done');
  });
}

/**
 * Run `teardown` once on either signal.
 *
 * Guarded because an impatient second Ctrl-C would otherwise re-enter cleanup
 * while the first pass is still awaiting the phone, and because the handset is
 * left in a call if the process exits without stopping its stream.
 */
function installShutdown(teardown) {
  let shuttingDown = false;

  const handle = (signal) => async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}`);

    try {
      await teardown();
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err.message);
      process.exit(1);
    }
  };

  process.on('SIGINT', handle('SIGINT'));
  process.on('SIGTERM', handle('SIGTERM'));
}

// Only start when run directly. Without this guard, merely requiring this file
// -- from a test, a REPL, or a tool walking the module graph -- logs the
// self-bot into Discord and opens the RTP socket as a side effect.
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { main };
