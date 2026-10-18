/*
  Serves the built example app with a Content Security Policy that forbids
  `unsafe-eval` and checks it in headless Chrome:
  - the "Custom validator" example validates and evaluates its rule without
    any CSP violation;
  - an Ajv validated example is blocked by the policy, proving it is enforced.

  Usage: pnpm run build:examples-app && pnpm run test:csp
  Chrome is taken from CHROME_BIN or the platform's default location.
*/
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self'",
].join('; ');

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../example/dist'
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const serve = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0]);
      let file = path.join(root, url === '/' ? 'index.html' : url);
      if (!file.startsWith(root) || !fs.existsSync(file)) {
        file = path.join(root, 'index.html');
      }
      res.writeHead(200, {
        'Content-Type':
          types[path.extname(file)] || 'application/octet-stream',
        'Content-Security-Policy': CSP,
      });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

const chromeBinary = () => {
  if (process.env.CHROME_BIN) {
    return process.env.CHROME_BIN;
  }
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
  }[process.platform];
  return (candidates ?? []).find((candidate) => fs.existsSync(candidate));
};

const launchChrome = async (binary) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonforms-csp-'));
  const chrome = spawn(
    binary,
    [
      '--headless=new',
      '--no-first-run',
      '--disable-gpu',
      '--no-sandbox',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) {
    await sleep(100);
  }
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const close = async () => {
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill();
    await Promise.race([exited, sleep(5000)]);
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    } catch (_error) {
      // A leftover temporary profile must not fail the check
    }
  };
  return { port, close };
};

/** A minimal Chrome DevTools Protocol client for one page. */
const openPage = async (port) => {
  const target = await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: 'PUT',
    })
  ).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    } else if (
      msg.method === 'Log.entryAdded' &&
      msg.params.entry.level === 'error'
    ) {
      problems.push(msg.params.entry.text);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const details = msg.params.exceptionDetails;
      problems.push(details.exception?.description ?? details.text);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  return {
    problems,
    open: async (baseUrl, example, run) => {
      problems.length = 0;
      await send('Page.navigate', { url: `${baseUrl}/?run=${run}#${example}` });
      await sleep(2000);
    },
    evaluate: async (expression) =>
      (await send('Runtime.evaluate', { expression, returnByValue: true }))
        ?.result?.value,
    close: () => ws.close(),
  };
};

const formState = `(() => {
  const visible = (name) => {
    const label = [...document.querySelectorAll('label')].find((l) =>
      new RegExp('^\\\\s*' + name, 'i').test(l.textContent)
    );
    return !!label && label.offsetParent !== null;
  };
  const errors = [...document.querySelectorAll('[class*="error"]')]
    .map((el) => el.textContent.trim())
    .filter(Boolean);
  return {
    errors: [...new Set(errors)],
    frequencyVisible: visible('frequency'),
  };
})()`;

const toggleNewsletter = `(() => {
  const input = document.querySelector('input[type="checkbox"][id*="newsletter"]');
  if (!input) return false;
  input.click();
  return true;
})()`;

const failures = [];
const check = (condition, message) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
  if (!condition) {
    failures.push(message);
  }
};

if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error(`No example app in ${root}; run build:examples-app first.`);
  process.exit(1);
}
const binary = chromeBinary();
if (!binary) {
  console.error('No Chrome found; set CHROME_BIN.');
  process.exit(1);
}

const server = await serve();
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const chrome = await launchChrome(binary);
const page = await openPage(chrome.port);

try {
  await page.open(baseUrl, 'custom-validator', 1);
  const initial = await page.evaluate(formState);
  check(
    initial?.errors.includes('must be lowercase'),
    'custom validator reports "must be lowercase"'
  );
  check(
    initial?.errors.includes('must contain a dot'),
    'custom validator reports "must contain a dot"'
  );
  check(initial?.frequencyVisible === true, 'rule shows "frequency"');
  check(
    (await page.evaluate(toggleNewsletter)) === true,
    'newsletter checkbox found'
  );
  await sleep(500);
  const toggled = await page.evaluate(formState);
  check(toggled?.frequencyVisible === false, 'rule hides "frequency"');
  check(
    page.problems.length === 0,
    `no CSP violation or error (${page.problems.length} found)`
  );
  page.problems.forEach((problem) =>
    console.log(`     ${problem.split('\n')[0]}`)
  );

  await page.open(baseUrl, 'person', 2);
  check(
    page.problems.some((problem) => /unsafe-eval/.test(problem)),
    'Ajv validated "person" example is blocked by the policy'
  );
} finally {
  page.close();
  await chrome.close();
  server.close();
}

if (failures.length > 0) {
  console.error(`${failures.length} CSP check(s) failed`);
  process.exit(1);
}
console.log('CSP checks passed');
