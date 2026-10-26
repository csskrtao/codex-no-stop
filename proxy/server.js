'use strict';

/**
 * codex-no-stop: local retry proxy for Codex CLI.
 *
 * Codex -> http://127.0.0.1:<PORT>/v1 -> upstream relay
 *
 * When the upstream answers with a capacity/overload error (the relay's
 * "Selected model is at capacity. Please try a different model."), the proxy
 * silently retries with backoff instead of handing the error to Codex.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');

if (!process.env.CODEX_RETRY_UPSTREAM) {
  console.error(
    'CODEX_RETRY_UPSTREAM is not set.\n' +
      'Run install.cmd first, or start the proxy with start-proxy.cmd.',
  );
  process.exit(1);
}
let UPSTREAM;
try {
  UPSTREAM = new URL(process.env.CODEX_RETRY_UPSTREAM);
} catch {
  console.error(`CODEX_RETRY_UPSTREAM is not a valid URL: ${process.env.CODEX_RETRY_UPSTREAM}`);
  process.exit(1);
}
const PORT = Number(process.env.CODEX_RETRY_PORT || 8788);
const HOST = process.env.CODEX_RETRY_HOST || '127.0.0.1';
const MAX_RETRIES = Number(process.env.CODEX_RETRY_MAX || 100);
const BASE_DELAY_MS = Number(process.env.CODEX_RETRY_BASE_MS || 2000);
const MAX_DELAY_MS = Number(process.env.CODEX_RETRY_MAX_DELAY_MS || 20000);
const MAX_SERVER_DELAY_MS = Number(process.env.CODEX_RETRY_MAX_SERVER_DELAY_MS || 60000);
const FAKE_CAPACITY_FIRST_N = Number(process.env.CODEX_RETRY_FAKE_CAPACITY_FIRST_N || 0);
const FAKE_STREAM_FAIL_FIRST_N = Number(
  process.env.CODEX_RETRY_FAKE_STREAM_FAIL_FIRST_N || 0,
);
const LOG_FILE = process.env.CODEX_RETRY_LOG || path.join(__dirname, 'proxy.log');
const QUIET = process.env.CODEX_RETRY_QUIET === '1';

// Errors worth retrying: transient capacity / overload / rate limiting.
const RETRY_PATTERNS = [
  /at capacity/i,
  /try a different model/i,
  /server_is_overloaded/i,
  /overloaded/i,
  /try again later/i,
  /rate[\s_-]?limit/i,
  /capacity/i,
  /no auth available/i,
];

// Errors that will never succeed on retry; hand them straight to Codex.
const NO_RETRY_PATTERNS = [
  /model_not_found/i,
  /unknown provider/i,
  /invalid_request/i,
  /invalid api key/i,
  /context_length/i,
  /content[_\s-]?filter/i,
  /policy/i,
  /permission denied/i,
];

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {
    /* logging must never break proxying */
  }
  if (!QUIET) process.stdout.write(line + '\n');
}

// ---- retry statistics -------------------------------------------------------
// Kept in memory for the live count and persisted so the lifetime total survives
// proxy restarts. Served over GET /__stats for the terminal-title helper.
const STATS_FILE = process.env.CODEX_RETRY_STATS || path.join(__dirname, 'retry-stats.json');

function loadStats() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    return {
      total_retries: Number(raw.total_retries) || 0,
      first_retry_at: raw.first_retry_at || null,
      last_retry_at: raw.last_retry_at || null,
      last_retry_reason: raw.last_retry_reason || null,
    };
  } catch (_) {
    return { total_retries: 0, first_retry_at: null, last_retry_at: null, last_retry_reason: null };
  }
}

const stats = loadStats();
stats.session_retries = 0;
stats.session_started_at = new Date().toISOString();

function saveStats() {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2) + '\n');
  } catch (_) {
    /* stats are best-effort */
  }
}

function recordRetry(reason) {
  const now = new Date().toISOString();
  stats.total_retries += 1;
  stats.session_retries += 1;
  stats.last_retry_at = now;
  stats.last_retry_reason = reason || 'unknown';
  if (!stats.first_retry_at) stats.first_retry_at = now;
  saveStats();
}

function snippet(text, limit = 400) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat;
}

function classifyErrorText(text) {
  if (!text) return null;
  if (NO_RETRY_PATTERNS.some((re) => re.test(text))) return 'commit';
  if (RETRY_PATTERNS.some((re) => re.test(text))) return 'retry';
  return null;
}

function shouldRetryStatus(status, bodyText) {
  const verdict = classifyErrorText(bodyText);
  if (verdict === 'commit') return false;
  if (status === 429 || status >= 500) return true;
  return verdict === 'retry';
}

/** Collects error-ish strings from a structured API/SSE payload. */
function extractErrorText(value) {
  const found = [];
  const visit = (node, depth) => {
    if (node == null || depth > 6) return;
    if (typeof node === 'string') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (typeof child === 'string' && ['message', 'code', 'type'].includes(key)) {
        found.push(child);
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return found.join(' ');
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return null;
}

function backoffMs(attempt, serverDelayMs) {
  if (serverDelayMs != null) {
    return Math.min(serverDelayMs, MAX_SERVER_DELAY_MS);
  }
  const exp = BASE_DELAY_MS * Math.pow(2, Math.min(attempt - 1, 4));
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(exp, MAX_DELAY_MS) + jitter;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function upstreamRequestOptions(req, body) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const k = key.toLowerCase();
    if (k === 'host' || k === 'content-length' || k === 'accept-encoding' || HOP_BY_HOP.has(k)) {
      continue;
    }
    headers[k] = value;
  }
  headers['accept-encoding'] = 'identity';
  headers['content-length'] = Buffer.byteLength(body);
  return {
    hostname: UPSTREAM.hostname,
    port: UPSTREAM.port || (UPSTREAM.protocol === 'https:' ? 443 : 80),
    path: req.url,
    method: req.method,
    headers,
  };
}

function upstreamTransport() {
  return UPSTREAM.protocol === 'https:' ? https : http;
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length,
  });
  res.end(body);
}

function writeFullResponse(res, status, headers, body) {
  const outHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k) || k === 'content-length') continue;
    outHeaders[k] = value;
  }
  outHeaders['content-length'] = body.length;
  res.writeHead(status, outHeaders);
  res.end(body);
}

const COMMIT_EVENTS = new Set([
  'response.output_text.delta',
  'response.output_item.added',
  'response.output_item.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_text.delta',
  'response.function_call_arguments.delta',
  'response.completed',
  'response.incomplete',
]);

const RETRY_EVENTS = new Set(['response.failed', 'error']);

// After `response.created`, wait this long for a failure event before
// committing the stream to Codex. Keeps latency low without missing
// capacity errors that arrive just after the stream opens.
const COMMIT_GRACE_MS = Number(process.env.CODEX_RETRY_GRACE_MS || 3000);

function parseSseEvent(block) {
  let type = '';
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  const dataText = dataLines.join('\n');
  let parsed = null;
  try {
    parsed = JSON.parse(dataText);
  } catch (_) {
    /* non-JSON data */
  }
  if (!type && parsed && typeof parsed.type === 'string') type = parsed.type;
  return { type, dataText, parsed };
}

/**
 * Handles a 2xx SSE stream. Headers are held back until the stream is known
 * to be real (content arrived, grace period elapsed, or clean end), so a
 * capacity error delivered inside the stream can still be retried silently.
 */
function handleStream(res, upstreamRes) {
  return new Promise((resolve) => {
    const buffered = [];
    let sse = '';
    let decision = null;
    let settled = false;
    let graceTimer = null;

    // Compressed streams cannot be inspected; pass them straight through.
    const encoding = String(upstreamRes.headers['content-encoding'] || '').toLowerCase();
    if (encoding && encoding !== 'identity') {
      const outHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        const k = key.toLowerCase();
        if (HOP_BY_HOP.has(k) || k === 'content-length') continue;
        outHeaders[k] = value;
      }
      res.writeHead(upstreamRes.statusCode, outHeaders);
      upstreamRes.pipe(res);
      upstreamRes.on('end', () => resolve({ action: 'done' }));
      upstreamRes.on('error', () => resolve({ action: 'done' }));
      return;
    }

    const finish = (action, reason) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (action === 'retry') {
        resolve({ action: 'retry', reason });
        upstreamRes.destroy();
        return;
      }
      resolve({ action: 'done' });
    };

    const commit = () => {
      if (decision) return;
      decision = 'commit';
      const outHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        const k = key.toLowerCase();
        if (HOP_BY_HOP.has(k) || k === 'content-length') continue;
        outHeaders[k] = value;
      }
      res.writeHead(upstreamRes.statusCode, outHeaders);
      for (const chunk of buffered) res.write(chunk);
      buffered.length = 0;
    };

    const decide = (action, reason) => {
      if (decision) return;
      if (action === 'commit') {
        commit();
        return;
      }
      decision = 'retry';
      finish('retry', reason);
    };

    const onEvent = (block) => {
      if (!block.trim() || decision) return;
      const { type, dataText, parsed } = parseSseEvent(block);

      // Once the stream has started, wait at most COMMIT_GRACE_MS before
      // handing it to Codex, so a late capacity error can still be retried.
      if (!graceTimer) {
        graceTimer = setTimeout(() => decide('commit'), COMMIT_GRACE_MS);
        graceTimer.unref?.();
      }

      if (RETRY_EVENTS.has(type)) {
        const detail = parsed ? extractErrorText(parsed) || dataText : dataText;
        const verdict = classifyErrorText(detail);
        if (verdict === 'commit') {
          decide('commit');
        } else {
          decide('retry', `stream ${type}: ${snippet(detail)}`);
        }
        return;
      }

      if (COMMIT_EVENTS.has(type)) {
        decide('commit');
      }
    };

    upstreamRes.on('data', (chunk) => {
      if (decision === 'commit') {
        res.write(chunk);
        return;
      }
      if (decision === 'retry') return;

      buffered.push(chunk);
      sse += chunk.toString('utf8');
      let idx;
      while (!decision && (idx = sse.indexOf('\n\n')) !== -1) {
        const block = sse.slice(0, idx);
        sse = sse.slice(idx + 2);
        onEvent(block);
      }
      if (!decision && sse.length > 1024 * 1024) {
        // Unbounded single event: not classifiable, treat it as real output.
        decide('commit');
      }
    });

    upstreamRes.on('end', () => {
      if (!decision) {
        if (sse.trim()) onEvent(sse);
      }
      if (decision === 'retry') {
        finish('retry');
        return;
      }
      commit();
      if (!res.writableEnded) res.end();
      finish('done');
    });

    upstreamRes.on('error', (err) => {
      if (decision === 'commit') {
        if (!res.writableEnded) res.destroy();
        finish('done');
        return;
      }
      decide('retry', 'stream transport error: ' + err.message);
    });

    res.on('close', () => {
      if (!res.writableEnded) upstreamRes.destroy();
    });
  });
}

function attemptUpstream(req, body, res, attempt) {
  return new Promise((resolve, reject) => {
    const opts = upstreamRequestOptions(req, body);
    const upReq = upstreamTransport().request(opts, (upstreamRes) => {
      const status = upstreamRes.statusCode || 0;
      const contentType = String(upstreamRes.headers['content-type'] || '');

      if (status >= 200 && status < 300 && contentType.includes('text/event-stream')) {
        handleStream(res, upstreamRes).then(resolve, reject);
        return;
      }

      const chunks = [];
      upstreamRes.on('data', (chunk) => chunks.push(chunk));
      upstreamRes.on('end', () => {
        const payload = Buffer.concat(chunks);
        const text = payload.toString('utf8');
        if (shouldRetryStatus(status, text)) {
          resolve({
            action: 'retry',
            reason: `HTTP ${status}: ${snippet(text)}`,
            retryAfterMs: parseRetryAfter(upstreamRes.headers['retry-after']),
          });
          return;
        }
        writeFullResponse(res, status, upstreamRes.headers, payload);
        resolve({ action: 'done' });
      });
      upstreamRes.on('error', reject);
    });

    upReq.setTimeout(600000, () => upReq.destroy(new Error('upstream request timeout')));
    upReq.on('error', reject);
    upReq.end(body);
  });
}

/** Test helper: pretends upstream opened an SSE stream and then failed. */
function fakeStreamAttempt(res) {
  const fake = new PassThrough();
  fake.statusCode = 200;
  fake.headers = { 'content-type': 'text/event-stream' };
  const pending = handleStream(res, fake);

  fake.write(
    'event: response.created\ndata: ' +
      JSON.stringify({ type: 'response.created', response: { id: 'resp_fake', error: null } }) +
      '\n\n',
  );
  setTimeout(() => {
    if (fake.destroyed) return;
    const failed = {
      type: 'response.failed',
      response: {
        id: 'resp_fake',
        status: 'failed',
        error: {
          code: 'capacity',
          message: 'Selected model is at capacity. Please try a different model.',
        },
      },
    };
    fake.write('event: response.failed\ndata: ' + JSON.stringify(failed) + '\n\n');
  }, 150);
  setTimeout(() => {
    if (!fake.destroyed) fake.end();
  }, 5000).unref();

  return pending;
}

async function handle(req, res, body) {  if (req.url === '/__health') {
    sendJson(res, 200, {
      ok: true,
      upstream: UPSTREAM.href,
      max_retries: MAX_RETRIES,
      pid: process.pid,
    });
    return;
  }

  if (req.url === '/__stats') {
    const last = stats.last_retry_at ? Date.parse(stats.last_retry_at) : null;
    const startedAt = Date.parse(stats.session_started_at);
    sendJson(res, 200, {
      ok: true,
      total_retries: stats.total_retries,
      session_retries: stats.session_retries,
      last_retry_at: stats.last_retry_at,
      last_retry_reason: stats.last_retry_reason,
      last_retry_ago_ms: last ? Date.now() - last : null,
      first_retry_at: stats.first_retry_at,
      session_started_at: stats.session_started_at,
      uptime_ms: Date.now() - startedAt,
      pid: process.pid,
    });
    return;
  }

  const started = Date.now();
  let lastReason = 'unknown';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    if (FAKE_CAPACITY_FIRST_N > 0 && attempt <= FAKE_CAPACITY_FIRST_N) {
      log(`${req.method} ${req.url} attempt ${attempt}/${MAX_RETRIES}: [fake] capacity error`);
      lastReason = 'fake capacity error';
      recordRetry(lastReason);
      await sleep(backoffMs(attempt, null));
      continue;
    }

    if (FAKE_STREAM_FAIL_FIRST_N > 0 && attempt <= FAKE_STREAM_FAIL_FIRST_N) {
      log(`${req.method} ${req.url} attempt ${attempt}/${MAX_RETRIES}: [fake] stream failure`);
      const outcome = await fakeStreamAttempt(res);
      if (outcome.action === 'done') return;
      lastReason = outcome.reason || 'fake stream failure';
      recordRetry(lastReason);
      await sleep(backoffMs(attempt, null));
      continue;
    }

    let outcome;
    try {
      outcome = await attemptUpstream(req, body, res, attempt);
    } catch (err) {
      lastReason = 'transport error: ' + err.message;
      log(`${req.method} ${req.url} attempt ${attempt}/${MAX_RETRIES}: ${lastReason}`);
    }

    if (outcome && outcome.action === 'done') {
      if (attempt > 1) {
        log(`${req.method} ${req.url}: succeeded on attempt ${attempt} after ${Date.now() - started}ms`);
      }
      return;
    }

    lastReason = (outcome && outcome.reason) || lastReason;
    const delay = backoffMs(attempt, outcome && outcome.retryAfterMs);
    log(
      `${req.method} ${req.url} attempt ${attempt}/${MAX_RETRIES}: ${lastReason}; ` +
        `retrying in ${(delay / 1000).toFixed(1)}s`,
    );
    recordRetry(lastReason);
    await sleep(delay);
  }

  log(`${req.method} ${req.url}: gave up after ${MAX_RETRIES} attempts (${lastReason})`);
  if (!res.headersSent) {
    sendJson(res, 503, {
      error: {
        message: `codex-no-stop proxy gave up after ${MAX_RETRIES} retries: ${lastReason}`,
        type: 'proxy_retry_exhausted',
      },
    });
  } else {
    res.destroy();
  }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    handle(req, res, body).catch((err) => {
      log(`handler error: ${err.stack || err.message}`);
      if (!res.headersSent) {
        sendJson(res, 502, {
          error: { message: 'codex-no-stop proxy error: ' + err.message, type: 'proxy_error' },
        });
      } else {
        res.destroy();
      }
    });
  });
});

server.on('error', (err) => {
  log(`server error: ${err.message}`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  log(`codex-no-stop proxy listening on http://${HOST}:${PORT}/v1 -> ${UPSTREAM.href}`);
  log(`max retries per request: ${MAX_RETRIES}; log: ${LOG_FILE}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
