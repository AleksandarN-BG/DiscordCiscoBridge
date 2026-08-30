// Configuration, read from the environment.
//
// This replaces the old config.json, which held a live Discord user token and
// the phone's password in plaintext inside the working tree -- one `git add .`
// away from being published. Secrets now come from .env, which .gitignore
// excludes; .env.example documents the shape and is safe to commit.
//
// The exported object keeps the exact nested shape the old JSON had, so every
// consumer (index.js, phone-api.js, xml-service.js) is unchanged.

const path = require('path');

// Explicit path rather than dotenv's cwd default, so `node src/index.js`
// works from any working directory.
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

/** Required: no sensible default exists, and a wrong guess fails confusingly later. */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    missing.push(name);
    return '';
  }
  return value;
}

/** Optional, with a default that works for a typical single-host setup. */
function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function port(name, fallback) {
  const value = Number(optional(name, fallback));
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a port number between 1 and 65535, got "${process.env[name]}"`);
  }
  return value;
}

const missing = [];

const bridgeIp = required('BRIDGE_IP');
const httpPort = port('HTTP_PORT', 8080);

const config = {
  discord: {
    userToken: required('DISCORD_USER_TOKEN'),
    guildId: optional('DISCORD_GUILD_ID', null),
  },
  phone: {
    ip: required('PHONE_IP'),
    username: required('PHONE_USERNAME'),
    password: required('PHONE_PASSWORD'),
  },
  rtp: {
    listenPort: port('RTP_LISTEN_PORT', 20480),
    bridgeIp,
  },
  http: {
    host: optional('HTTP_HOST', '0.0.0.0'),
    port: httpPort,
    // The phone fetches menus from this, so it must be an address the phone can
    // reach -- not localhost. Derived from BRIDGE_IP unless overridden.
    publicUrl: optional('HTTP_PUBLIC_URL', `http://${bridgeIp}:${httpPort}`),
  },
};

if (missing.length > 0) {
  console.error(
    `\nMissing required configuration: ${missing.join(', ')}\n\n` +
      `Copy .env.example to .env and fill it in:\n` +
      `    cp .env.example .env\n\n` +
      `.env is gitignored. Never commit it.\n`
  );
  process.exit(1);
}

module.exports = config;
