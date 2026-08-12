'use strict';

/**
 * Unix domain socket JSONL control plane (no HTTP).
 * One connection = one Grok mind attached to this body.
 *
 * Request:  {"id":1,"op":"status"}\\n
 * Response: {"id":1,"ok":true,"result":{...}}\\n
 */

const net = require('net');
const fs = require('fs');
const path = require('path');

function createSocketServer(socketPath, handlers) {
  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  } catch {
    /* */
  }

  const server = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        handleLine(conn, line, handlers).catch((e) => {
          try {
            conn.write(
              JSON.stringify({
                ok: false,
                error: e.code || 'ERROR',
                message: e.message,
              }) + '\n'
            );
          } catch {
            /* */
          }
        });
      }
    });
    conn.on('error', () => {});
  });

  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      /* */
    }
  });

  server.on('error', (e) => {
    console.error('[socket]', e.message);
  });

  return {
    server,
    path: socketPath,
    close() {
      return new Promise((resolve) => {
        server.close(() => {
          try {
            fs.unlinkSync(socketPath);
          } catch {
            /* */
          }
          resolve();
        });
      });
    },
  };
}

async function handleLine(conn, line, handlers) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    conn.write(
      JSON.stringify({ ok: false, error: 'BAD_JSON', message: 'invalid json' }) + '\n'
    );
    return;
  }
  const id = req.id;
  const op = String(req.op || req.cmd || '').toLowerCase();
  try {
    if (!handlers[op]) {
      conn.write(
        JSON.stringify({
          id,
          ok: false,
          error: 'BAD_ARGS',
          message: `unknown op: ${op}. ops=${Object.keys(handlers).join(',')}`,
        }) + '\n'
      );
      return;
    }
    const result = await handlers[op](req);
    conn.write(JSON.stringify({ id, ok: true, result }) + '\n');
  } catch (e) {
    conn.write(
      JSON.stringify({
        id,
        ok: false,
        error: e.code || 'ERROR',
        message: e.message,
        job: e.job || null,
      }) + '\n'
    );
  }
}

module.exports = { createSocketServer };
