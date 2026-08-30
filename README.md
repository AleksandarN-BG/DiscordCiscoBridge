# Discord-to-Cisco RTP Bridge

## Overview
This project bridges Discord voice channels and Cisco IP phones (CP-8845+) using the Cisco RTP Streaming API and a Discord self-bot. It enables a Cisco phone to join Discord voice channels via an interactive phone menu, with real-time audio bridging.

**WARNING:** This project uses a Discord self-bot (user account). Self-bots are against Discord's Terms of Service and may result in account termination. Use for personal/proof-of-concept purposes only.

## Features
- Cisco phone XML menu for Discord channel selection
- Direct RTP audio streaming (G.711) between phone and bridge
- Real-time audio transcoding (G.711 ↔ Opus)
- Discord voice channel join/leave via phone
- Status and control endpoints

## Requirements
- Cisco CP-8845 (firmware 10.3(2)+)
- Node.js 18+
- Discord user account (for self-bot)
- Network access between phone and bridge

## Setup
1. **Check Phone Firmware:**
   - Access phone web UI → Device Information → Firmware Version (must be 10.3(2)+)
2. **Obtain Discord User Token:**
   - Use browser dev tools (see Discord self-bot guides online)
   - **Never share your token.** It grants full access to the account, not a
     scoped bot permission. It belongs in `.env`, which is gitignored.
3. **Add XML Service to Phone:**
   - Phone web UI → Device → Phone Services → Add new service
   - Name: DiscordBridge, URL: `http://<bridge-ip>:8080/discord-menu`
   - Or via CUCM: Device → Phone → Add Service URL
4. **Configure Phone HTTP Credentials:**
   - Phone web UI → Security → HTTP Authentication
   - Set username/password to match `PHONE_USERNAME` / `PHONE_PASSWORD`
5. **Network:**
   - Allow UDP `RTP_LISTEN_PORT` (default 20480) and TCP `HTTP_PORT` (default
     8080) **between the phone and the bridge only**. Do not forward either
     from the internet -- see [Security](#security).
6. **Install Dependencies:**
   - `npm install`
   - npm may report that `@discordjs/opus` has a blocked install script. That
     script fetches its prebuilt binary. Approve it with
     `npm install-scripts approve @discordjs/opus && npm rebuild @discordjs/opus`,
     or skip it -- see [Opus backend](#opus-backend) below.
7. **Configure:**
   - `cp .env.example .env`, then fill it in
8. **Run:**
   - `npm start`, or `npm test` to check the parts that need no hardware

## Configuration

All configuration comes from environment variables, read from `.env` at startup.
`.env` is gitignored; `.env.example` documents the shape and is safe to commit.

| Variable | Required | Notes |
| --- | --- | --- |
| `DISCORD_USER_TOKEN` | yes | Self-bot token. Full account access -- treat as a password. |
| `DISCORD_GUILD_ID` | no | Restrict to one guild. Blank allows all. |
| `PHONE_IP` | yes | Cisco phone address |
| `PHONE_USERNAME` | yes | Phone HTTP auth |
| `PHONE_PASSWORD` | yes | Phone HTTP auth |
| `BRIDGE_IP` | yes | This host, as the phone sees it. Not `localhost`. |
| `RTP_LISTEN_PORT` | no | Default `20480` |
| `HTTP_HOST` | no | Default `0.0.0.0` |
| `HTTP_PORT` | no | Default `8080` |
| `HTTP_ALLOWED_CLIENTS` | no | Extra addresses allowed to reach the XML service, comma separated. `PHONE_IP` and loopback are always allowed; everything else is refused. |
| `HTTP_PUBLIC_URL` | no | Defaults to `http://$BRIDGE_IP:$HTTP_PORT`. The phone fetches its menus from this, so it must be reachable from the phone. |

Start-up fails with a list of anything missing rather than erroring obscurely
later.

## Architecture

Four collaborators, wired together by `index.js`. Each speaks to exactly one
outside thing, and the pure logic they sit on is separated out so it can be
tested without a handset.

```
src/
  index.js              wiring and shutdown
  config.js             environment -> validated config

  cisco/                things that speak to the phone
    phone-api.js        the handset's CGI/Execute interface
    xml.js              CiscoIPPhone* document builders (pure)

  discord/
    client.js           login, and the directory the phone browses
    voice.js            joining, leaving, and per-speaker audio

  audio/
    bridge.js           coordinator between the two directions
    mixer.js            additive mixing of several speakers (pure)
    g711.js             mu-law codec and 8k <-> 48k resampling (pure)
    rtp-receiver.js     phone -> bridge (G.711 in)
    rtp-streamer.js     bridge -> phone (G.711 out)
    rtp-packet.js       RFC 3550 header construction (pure)

  http/                 the menus the phone renders
    xml-service.js      assembles the app, owns its lifecycle
    allowlist.js        refuses anything that is not the handset
    session.js          the one call that can be in progress
    urls.js             every route the phone can be sent to
    pagination.js       slicing lists into pages a phone can show (pure)
    pages.js            shared renderings and error handling
    routes/
      browse.js         /menu /dms /servers /server-channels /preview
      call.js           /join /connected /stopped
      status.js         /status
```

Two rules hold this together:

- **`http/` never builds XML and never touches discord.js.** Routes assemble
  data and hand it to `cisco/xml.js`; every Discord method returns plain
  objects. Escaping happens once, inside the builders.
- **`audio/` knows nothing about Discord or HTTP.** It receives PCM and emits
  PCM; who is speaking is just a string key to the mixer.

### Audio path

The phone streams G.711 mu-law to `rtp-receiver`, which strips the RTP header,
decodes to 8 kHz PCM and upsamples to 48 kHz. `bridge` re-frames that to whole
960-sample frames, Opus-encodes it, and Discord plays the result.

Coming back, each Discord speaker is decoded to PCM separately and queued in
`mixer`. Every 20 ms the mixer sums whoever has a full frame -- a phone call
carries one mono stream, so simultaneous speakers have to be combined -- and
`rtp-streamer` resamples to 8 kHz mu-law through FFmpeg, wraps each 20 ms in an
RTP header, and paces it out to the handset.

The RTP framing is written by hand rather than delegated to FFmpeg's `-f rtp`,
which gives up control of the send cadence. A handset notices a burst.

## Opus backend

`prism-media` needs an Opus codec and tries, in order, `@discordjs/opus`, then
`opusscript`. Both are installed:

| | | |
| --- | --- | --- |
| `@discordjs/opus` | native | 0.36% of the real-time budget for one stream |
| `opusscript` | pure JavaScript | 0.61%, and needs no compiler |

The native one is preferred, and the pure-JS one carries the call if it is not
built -- a blocked install script, a missing compiler, a fresh clone on another
machine. Either way the encoder produces byte-identical output, because both
wrap the same libopus.

`node-opus` was the original backend and has been removed: it is a `nan` addon
last published in 2019, and Node 26's V8 no longer has the
`GetAlignedPointerFromInternalField` overload it compiles against. It cannot be
built on a current runtime at all.

## Tests

```sh
npm test
```

Covers what can be checked without hardware: the mu-law tables, mixing and
clipping, RTP framing and field wraparound, paging, XML escaping, and a pass
over every HTTP route with Discord and the phone stubbed out. The RTP, Opus and
Discord transports themselves need a real handset and a real account.

## Network Requirements

- The phone and the bridge must be able to reach each other directly. Put them
  on the same LAN segment.
- UDP `RTP_LISTEN_PORT` (default 20480) open between phone and bridge, in both
  directions. The phone has to send first: its return address is discovered
  from the source of its own RTP.
- TCP `HTTP_PORT` (default 8080) reachable from the phone.
- `HTTP_PUBLIC_URL` must be an address the phone can resolve. Not `localhost`,
  not `0.0.0.0`.

**Do not port-forward either of these.** See below.

## Security

Two things about this project are worth understanding before running it.

**The XML service has no authentication, and cannot easily have any.** A Cisco
phone fetching an XML service is not a browser; it has no useful credential
store. The endpoints are not harmless:

| route | what it gives a caller |
| --- | --- |
| `/dms` | the account's private conversations, by name, most recent first |
| `/servers`, `/server-channels` | its guilds and their voice channels |
| `/preview` | who is currently in a voice channel |
| `/join` | makes the account join a call, and pipes the handset's audio in |

Because only one device is ever a legitimate client, and its address is already
configured, the address is the check: `src/http/allowlist.js` refuses every
request that does not come from `PHONE_IP` (or loopback, or an address named in
`HTTP_ALLOWED_CLIENTS`). It runs before any route.

That is a segment-level control, not authentication. Anyone who can spoof a
source address on the LAN, or who takes the phone's address, gets through. Keep
the port on a network you trust and do not expose it.

**It signs in as a user account, not a bot.** Discord bots cannot be placed in
a DM call, which is half of what this exists to do, so there is no bot-token
version of this project. That is against Discord's terms of service and the
token grants full access to the account -- not a scoped permission. Treat
`.env` accordingly, and expect that the account could be terminated.

## Troubleshooting

- **Phone shows "Host not found."** The service URL is not reachable from the
  handset. `HTTP_PUBLIC_URL` must be an address the phone can resolve, not
  `localhost` or `0.0.0.0`.
- **Menus load but no audio.** The phone has to send first, since its return
  address is discovered from the source of its own RTP. Check UDP
  `RTP_LISTEN_PORT` is open in both directions.
- **`startMedia` fails.** Phone HTTP credentials, or firmware below 10.3(2).
- **Names look mangled on the phone.** Expected: the display is ASCII only, so
  non-ASCII characters are stripped and rows are clamped to 14 characters.

## License

MIT. See [LICENSE](LICENSE).


