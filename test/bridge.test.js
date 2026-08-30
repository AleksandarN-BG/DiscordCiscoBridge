// Unit tests for the parts that can be checked without a handset.
//
// The RTP, Opus and Discord paths need real hardware and a real account, so
// what is covered here is the pure logic they sit on -- codec tables, mixing,
// RTP framing, paging, XML escaping -- plus a pass over every HTTP route with
// the three collaborators stubbed out.
//
//   node --test
//
// Each of these guards a bug that was actually present before the code was
// split up, which is the reason they exist rather than for a coverage number.

const test = require('node:test');
const assert = require('node:assert/strict');

const xml = require('../src/cisco/xml');
const { decodeMulaw, upsample8to48, UPSAMPLE_FACTOR } = require('../src/audio/g711');
const { Mixer } = require('../src/audio/mixer');
const { RtpPacketizer, HEADER_BYTES } = require('../src/audio/rtp-packet');
const { paginate, pageLinks } = require('../src/http/pagination');
const { buildUrls } = require('../src/http/urls');
const CallSession = require('../src/http/session');
const XmlService = require('../src/http/xml-service');

test('xml escapes exactly once', () => {
  const doc = xml.menu({ title: 'A & B', items: [{ name: "O'Brien <x>", url: 'http://h/p?a=1&b=2' }] });

  assert.match(doc, /<Title>A &amp; B<\/Title>/);
  assert.match(doc, /<Name>O&apos;Brien &lt;x&gt;<\/Name>/);
  // Query separators must survive as entities, or the phone truncates the URL.
  assert.match(doc, /<URL>http:\/\/h\/p\?a=1&amp;b=2<\/URL>/);
  // The regression this replaced: escape applied twice, giving &amp;amp;.
  assert.doesNotMatch(doc, /&amp;(amp|lt|gt|quot|apos);/);
});

test('displayName strips to ASCII and clamps, without escaping', () => {
  assert.equal(xml.displayName('Ünïcode Café'), 'ncode Caf');
  assert.equal(xml.displayName('a'.repeat(40)), 'a'.repeat(14));
  // Escaping here is what caused the double-escape; it must not happen.
  assert.equal(xml.displayName('A & B'), 'A & B');
  assert.equal(xml.displayName(null), '');
});

test('soft-key positions are contiguous from one', () => {
  const doc = xml.textPage({
    title: 't',
    body: 'b',
    softKeys: [{ name: 'a', url: 'u' }, { name: 'b', url: 'u' }],
  });
  assert.deepEqual([...doc.matchAll(/<Position>(\d)<\/Position>/g)].map((m) => m[1]), ['1', '2']);
});

test('mu-law decodes to the G.711 reference values', () => {
  const pcm = decodeMulaw(Buffer.from([0xff, 0x7f, 0x00]));

  assert.equal(pcm.length, 6, 'one byte in, one 16-bit sample out');
  assert.equal(pcm.readInt16LE(0), 0, '0xFF is positive silence');
  assert.equal(pcm.readInt16LE(2), 0, '0x7F is negative silence');
  assert.equal(pcm.readInt16LE(4), -32124, '0x00 is full-scale negative');
});

test('upsampling holds the final sample instead of ramping to zero', () => {
  const pcm8k = Buffer.alloc(4);
  pcm8k.writeInt16LE(1000, 0);
  pcm8k.writeInt16LE(1000, 2);

  const out = upsample8to48(pcm8k);
  assert.equal(out.length, pcm8k.length * UPSAMPLE_FACTOR);

  // A ramp toward silence on the tail would put a click on every packet.
  const last = out.readInt16LE(out.length - 2);
  assert.equal(last, 1000);
});

test('mixer sums speakers and clamps instead of wrapping', () => {
  const mixer = new Mixer({ frameBytes: 4 });
  const loud = Buffer.alloc(4);
  loud.writeInt16LE(30000, 0);
  loud.writeInt16LE(-30000, 2);

  mixer.push('a', loud);
  mixer.push('b', loud);

  const frame = mixer.pullFrame();
  assert.equal(frame.readInt16LE(0), 32767, 'clamped, not wrapped to a negative');
  assert.equal(frame.readInt16LE(2), -32768);
  assert.ok(mixer.isIdle());
});

test('mixer keeps a partial frame for the next tick', () => {
  const mixer = new Mixer({ frameBytes: 4 });

  mixer.push('a', Buffer.alloc(2));
  assert.equal(mixer.pullFrame(), null, 'half a frame is not enough to send');
  assert.equal(mixer.isIdle(), false, 'and it is not discarded either');

  mixer.push('a', Buffer.alloc(2));
  assert.equal(mixer.pullFrame().length, 4);
});

test('RTP sequence and timestamp wrap at their field widths', () => {
  const packetizer = new RtpPacketizer({ payloadType: 0, samplesPerPacket: 160 });
  packetizer.seq = 0xffff;
  packetizer.timestamp = 0xffffff00;

  const first = packetizer.packetize(Buffer.alloc(160));
  assert.equal(first.length, HEADER_BYTES + 160);
  assert.equal((first[0] >> 6) & 0x03, 2, 'RTP version 2');
  assert.equal(first.readUInt16BE(2), 0xffff);

  const second = packetizer.packetize(Buffer.alloc(160));
  assert.equal(second.readUInt16BE(2), 0, 'sequence wraps to 0, not to 65536');
  assert.equal(second.readUInt32BE(4), 0xffffffa0, 'timestamp advances mod 2^32');
});

test('paging clamps out-of-range and unparseable pages', () => {
  const items = Array.from({ length: 20 }, (_, i) => i);

  assert.equal(paginate(items, '99', 8).page, 2, 'a stale bookmark lands on the last page');
  assert.equal(paginate(items, 'abc', 8).page, 0);
  assert.equal(paginate(items, '-5', 8).page, 0);
  assert.equal(paginate(items, undefined, 8).page, 0);

  const empty = paginate([], '0', 8);
  assert.equal(empty.totalPages, 1, 'never zero pages, which would render 1/0');

  const middle = paginate(items, '1', 8);
  assert.deepEqual(pageLinks(middle, (n) => `/x?page=${n}`).map((l) => l.url), [
    '/x?page=0',
    '/x?page=2',
  ]);
});

test('urls omit absent parameters', () => {
  const urls = buildUrls('http://192.0.2.10:8080/');
  assert.equal(urls.menu(), 'http://192.0.2.10:8080/menu');
  assert.equal(urls.preview({ type: 'dm', id: '1' }), 'http://192.0.2.10:8080/preview?type=dm&id=1');
});

test('session reset clears every field, guildId included', () => {
  const session = new CallSession();
  session.start({
    channelId: 'c', guildId: 'g', streamId: 's', channelName: 'n', channelType: 'server',
  });
  assert.ok(session.isRefreshable);

  session.reset();
  // guildId used to survive a hangup, because the reset was an object literal
  // written out by hand at each call site and two of them missed it.
  assert.deepEqual(
    { ...session },
    { active: false, channelId: null, guildId: null, streamId: null, channelName: null, channelType: null, users: [] },
  );
});

test('every route answers with parseable XML', async () => {
  const service = new XmlService({
    http: { host: '127.0.0.1', port: 18099, publicUrl: 'http://127.0.0.1:18099' },
    rtp: { bridgeIp: '192.0.2.10', listenPort: 20480 },
    discord: stubDiscord(),
    phone: { startMedia: async () => 's1', stopMedia: async () => {}, clearDisplay: async () => {} },
    bridge: { restart() {}, getDiscordInputStream: () => null },
  });

  service.start();
  await new Promise((resolve) => setTimeout(resolve, 200));

  try {
    // Order matters: /join before the pages that report on a live session.
    const paths = [
      '/menu', '/discord-menu', '/dms', '/dms?page=99', '/servers',
      '/server-channels?guildId=g0', '/server-channels',
      '/preview?type=server&id=v0&guildId=g0', '/preview?type=dm&id=d0', '/preview',
      '/status', '/connected',
      '/join?type=server&id=v0&guildId=g0', '/connected', '/status',
    ];

    for (const path of paths) {
      const res = await fetch(`http://127.0.0.1:18099${path}`);
      const body = await res.text();

      assert.equal(res.status, 200, `${path} should answer 200`);
      assert.match(res.headers.get('content-type'), /xml/, `${path} must be typed as XML`);
      assert.ok(body.startsWith('<?xml version="1.0"?>'), `${path} needs the declaration`);
      assert.doesNotMatch(body, /&amp;(amp|lt|gt|quot|apos);/, `${path} double-escaped`);
      // Any bare & inside an element would make the document unparseable.
      assert.doesNotMatch(
        body,
        /(?:<Name>|<Text>|<Title>|<URL>)[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/,
        `${path} has an unescaped ampersand`,
      );
    }

    const hangup = await fetch('http://127.0.0.1:18099/stopped', { method: 'POST' });
    assert.equal(hangup.status, 200, 'the phone needs a plain 200 or it retries');
  } finally {
    await service.stop();
  }
});

/** Names chosen to be hostile to XML; the roster is long enough to truncate. */
function stubDiscord() {
  const members = Array.from({ length: 13 }, (_, i) => ({ displayName: `user & ${i}` }));

  return {
    getGuilds: async () => [{ id: 'g0', name: 'A & B <hostile>' }],
    getGuild: async () => ({ name: 'A & B' }),
    getDMChannels: async () => [{ id: 'd0', name: "<script> & 'x'", type: 3, lastMessageId: '1' }],
    getVoiceChannels: async () => [{ id: 'v0', name: 'a & b', memberCount: 2 }],
    getChannel: async () => ({ name: 'x & y', recipient: { username: 'p & q' } }),
    getVoiceChannelMembers: async () => members,
    joinVoiceChannel: async () => {},
    joinDMCall: async () => {},
    leaveVoiceChannel() {},
  };
}
