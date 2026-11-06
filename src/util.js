'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.PLAINSIGHT_HOME || path.join(os.homedir(), '.plainsight');
const VERSION = require('../package.json').version;
const PROTOCOL = 1;
const TAG = 'tag:plainsight';
const SERVICE = 'svc:plainsight';
const VIEWER_TAG = 'tag:plainsight-viewer';
const WEB_PORT = 4748; // dashboard: 127.0.0.1 locally, same port on the tailnet for untagged machines

const paths = {
  home: HOME,
  config: path.join(HOME, 'config.json'),
  logDir: path.join(HOME, 'log'),
  state: path.join(HOME, 'state.json'),
  pid: path.join(HOME, 'daemon.pid'),
  daemonLog: path.join(HOME, 'daemon.log'),
  prices: path.join(HOME, 'prices.json'),
  priceCache: path.join(HOME, 'prices-cache.json'),
};

function hash(s, n = 16) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n);
}

// Subscription id: provider + account id. Same account on any machine => same id; different accounts never collide.
function subId(provider, accountId) {
  return hash(`plainsight:${provider}:${accountId}`, 16);
}

function readJSON(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}

function writeJSON(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

function log(...a) {
  console.error(new Date().toISOString(), ...a);
}

function loadConfig() {
  return readJSON(paths.config, null);
}

module.exports = { HOME, VERSION, PROTOCOL, TAG, VIEWER_TAG, SERVICE, WEB_PORT, paths, hash, subId, readJSON, writeJSON, log, loadConfig };
