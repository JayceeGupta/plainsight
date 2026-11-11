'use strict';
// Builds the public demo into demo/dist: the real dashboard page with demo.js (and the real
// src/aggregate.js inside it) placed in front of the page's own script. Nothing else is changed,
// so the demo always shows the current dashboard.   node demo/build.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'dist');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const REPO = 'https://github.com/JayceeGupta/plainsight';

const demo = read('demo/demo.js')
  .replace('/*AGGREGATE*/', () => read('src/aggregate.js'))
  .replace('/*REPO*/', () => `<a href="${REPO}" target="_blank" rel="noopener">Get plainsight</a>`);

const css = `
/* demo only */
.demo-note { position: fixed; z-index: 40; right: 16px; bottom: max(14px, env(safe-area-inset-bottom)); display: flex; align-items: center; gap: 10px; max-width: calc(100vw - 32px); padding: 7px 13px; border-radius: 999px; background: rgba(14,14,14,.92); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); border: 1px solid var(--line2); font-size: 12.5px; color: var(--muted); white-space: nowrap; box-shadow: 0 8px 28px rgba(0,0,0,.7); }
.demo-note b { color: var(--text); font-weight: 600; }
.demo-note a { color: var(--text); text-decoration: none; border-left: 1px solid var(--line2); padding-left: 10px; }
.demo-note a:hover { text-decoration: underline; text-underline-offset: 3px; }
@media (max-width: 640px) { .demo-note span { display: none; } }
`;
const head = `<meta name="description" content="A live demo of plainsight: shared AI coding usage across machines and subscriptions, with made-up data.">
<meta property="og:title" content="plainsight demo">
<meta property="og:description" content="See who is using which Claude or Codex subscription, and how much of each limit is left. Made-up data.">
`;

let page = read('web/index.html');
const must = (a, b) => { if (!page.includes(a)) throw new Error(`web/index.html no longer has ${a}`); page = page.replace(a, b); };
must('<title>plainsight</title>', () => `<title>plainsight demo</title>\n${head}`);
must('</style>', () => `${css}</style>`);
must('<script>', () => `<script>\n${demo}</script>\n<script>`);

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), page);
for (const [from, to] of [['web/manifest.webmanifest', 'manifest.webmanifest'], ['assets/icon-192.png', 'icon-192.png'], ['assets/icon-512.png', 'icon-512.png'], ['assets/apple-touch-icon.png', 'apple-touch-icon.png'], ['assets/favicon.ico', 'favicon.ico']]) {
  fs.copyFileSync(path.join(root, from), path.join(out, to));
}
console.log(`demo built: ${path.relative(root, out)} (${Math.round(page.length / 1024)} KB page)`);
