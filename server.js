const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');

// ── Config (env-driven for portability) ────────────────────────────────────
const PORT = process.env.PORT || 3391;
const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(process.env.HOME, '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const DEBUG_DIR = path.join(CLAUDE_DIR, 'debug');
const TODOS_DIR = path.join(CLAUDE_DIR, 'todos');
const CREDENTIALS_FILE = path.join(CLAUDE_DIR, '.credentials.json');
const MAX_RESULT_SIZE = parseInt(process.env.MAX_RESULT_SIZE || '51200', 10); // 50KB per tool result
const AUTH_CHECK_INTERVAL = parseInt(process.env.AUTH_CHECK_INTERVAL || '300000', 10); // 5 min

// ── Auth health state ─────────────────────────────────────────────────────
let authHealthy = true; // optimistic on startup, first check runs quickly
let lastAuthCheck = 0;

// ── State ──────────────────────────────────────────────────────────────────
const fileOffsets = new Map(); // filePath -> bytesRead
const excludedSessions = new Set(); // sessionIds confirmed as bot check-ins

// ── Helpers ────────────────────────────────────────────────────────────────
function getSessionId(filePath) {
  return path.basename(filePath, '.jsonl');
}

function parseJSONL(filePath, fromByte = 0) {
  const events = [];
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= fromByte) return { events, newOffset: fromByte };

    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(stat.size - fromByte);
    fs.readSync(fd, buf, 0, buf.length, fromByte);
    fs.closeSync(fd);

    const text = buf.toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch (_) { /* partial line */ }
    }
    return { events, newOffset: stat.size };
  } catch (e) {
    return { events, newOffset: fromByte };
  }
}

// ── Session exclusion filter ──────────────────────────────────────────────
// Bot check-in sessions (e.g. discord bot sending "ok" to validate auth) are
// noise. We detect them by structure: exactly 5 JSONL lines, user content is
// just "ok", model is <synthetic> or response is a canned auth message, and
// token usage is negligible. These never contain real work.

function isExcludedSession(filePath) {
  const sid = getSessionId(filePath);
  if (excludedSessions.has(sid)) return true;

  try {
    const { events } = parseJSONL(filePath, 0);
    if (events.length > 6) return false; // real sessions have more lines

    const userMsgs = events.filter(e => e.type === 'user');
    const assistantMsgs = events.filter(e => e.type === 'assistant');

    // Check if all user messages are trivial bot probes
    const allTrivialUser = userMsgs.every(e => {
      const content = e.message?.content;
      if (typeof content === 'string') return content.trim().length <= 10;
      if (Array.isArray(content)) {
        const text = content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
        return text.length <= 10;
      }
      return false;
    });

    if (!allTrivialUser) return false;

    // Check for synthetic model, auth errors, or canned responses
    const isBotSession = assistantMsgs.some(e => {
      const msg = e.message || {};
      const model = msg.model || '';
      const usage = msg.usage || {};
      const content = msg.content || [];
      const text = content.filter(c => c.type === 'text').map(c => c.text).join('');
      const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);

      return (
        model === '<synthetic>' ||
        e.error === 'authentication_failed' ||
        e.isApiErrorMessage === true ||
        text.includes('Not logged in') ||
        text.includes('ready to help') ||
        totalTokens <= 20
      );
    });

    if (isBotSession) {
      excludedSessions.add(sid);
      return true;
    }
  } catch (_) {}

  return false;
}

// ── Auth token validation ─────────────────────────────────────────────────
// Validates the Claude OAuth token against Anthropic's API. The dashboard
// sidecar uses this as a health signal — if the token is invalid/expired,
// the pod should fail its health check so the operator knows auth is broken.

async function checkAuthHealth() {
  try {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
    const token = creds?.claudeAiOauth?.accessToken;
    if (!token) {
      console.error('[auth] No access token found in credentials file');
      authHealthy = false;
      return;
    }

    // Check expiry locally first
    const expiresAt = creds.claudeAiOauth.expiresAt;
    if (expiresAt && Date.now() > expiresAt) {
      console.error('[auth] Token expired at', new Date(expiresAt).toISOString());
      authHealthy = false;
      return;
    }

    // Validate against Anthropic API (lightweight models list endpoint)
    const https = require('https');
    const result = await new Promise((resolve, reject) => {
      const req = https.request('https://api.anthropic.com/v1/models', {
        method: 'GET',
        headers: {
          'x-api-key': token,
          'anthropic-version': '2023-06-01',
        },
        timeout: 10000,
      }, (res) => {
        res.resume(); // drain body
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });

    const wasHealthy = authHealthy;
    authHealthy = result === 200;
    if (!authHealthy) {
      console.error(`[auth] Anthropic API returned ${result} — marking unhealthy`);
    } else if (!wasHealthy) {
      console.log('[auth] Token validated successfully — healthy');
    }
    lastAuthCheck = Date.now();
    // Broadcast auth status change to connected clients
    if (wasHealthy !== authHealthy) {
      broadcast({ type: 'auth', healthy: authHealthy, lastCheck: new Date(lastAuthCheck).toISOString() });
    }
  } catch (e) {
    console.error('[auth] Health check error:', e.message);
    const wasHealthy = authHealthy;
    authHealthy = false;
    lastAuthCheck = Date.now();
    if (wasHealthy !== authHealthy) {
      broadcast({ type: 'auth', healthy: authHealthy, lastCheck: new Date(lastAuthCheck).toISOString() });
    }
  }
}

// ── Tool result extraction ─────────────────────────────────────────────────
// Claude's JSONL alternates: assistant msg (with tool_use) → user msg (with tool_result)
// We collect tool_results from user messages and attach them to preceding tool_uses.

function extractToolResults(rawEvents) {
  const resultMap = new Map(); // tool_use_id -> { content, isError }

  for (const ev of rawEvents) {
    if (ev.type !== 'user') continue;
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const tid = block.tool_use_id;
      const isError = !!block.is_error;
      let text = '';

      if (typeof block.content === 'string') {
        text = block.content;
      } else if (Array.isArray(block.content)) {
        text = block.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n');
      }

      // Cap size to avoid blowing up websocket frames
      if (text.length > MAX_RESULT_SIZE) {
        text = text.slice(0, MAX_RESULT_SIZE) + `\n\n[... truncated at ${MAX_RESULT_SIZE} bytes]`;
      }

      resultMap.set(tid, { content: text, isError });
    }
  }

  return resultMap;
}

function summarizeEvents(rawEvents) {
  const resultMap = extractToolResults(rawEvents);
  const summarized = [];

  for (const ev of rawEvents) {
    const s = summarizeEvent(ev, resultMap);
    if (s) summarized.push(s);
  }

  return summarized;
}

function summarizeEvent(ev, resultMap) {
  const base = {
    type: ev.type,
    timestamp: ev.timestamp,
    sessionId: ev.sessionId,
    uuid: ev.uuid,
  };

  if (ev.type === 'user') {
    const content = ev.message?.content;
    let text = '';
    let hasToolResults = false;

    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const textParts = [];
      for (const c of content) {
        if (c.type === 'text') textParts.push(c.text);
        if (c.type === 'tool_result') hasToolResults = true;
      }
      text = textParts.join(' ');
    }

    // Skip user messages that are purely tool results (no human text)
    if (hasToolResults && !text.trim()) return null;

    return { ...base, role: 'user', text: text.slice(0, 2000), cwd: ev.cwd, gitBranch: ev.gitBranch };
  }

  if (ev.type === 'assistant') {
    const msg = ev.message || {};
    const content = msg.content || [];
    const usage = msg.usage || {};
    const model = msg.model || '';

    const parts = [];
    const toolCalls = [];

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        parts.push(block.text);
      } else if (block.type === 'tool_use') {
        const tc = {
          tool: block.name,
          id: block.id,
          input: summarizeToolInput(block.name, block.input),
        };

        // Attach the paired result
        if (resultMap && resultMap.has(block.id)) {
          const r = resultMap.get(block.id);
          tc.result = r.content;
          tc.isError = r.isError;
        }

        toolCalls.push(tc);
      }
    }

    return {
      ...base,
      role: 'assistant',
      model,
      text: parts.join('\n').slice(0, 2000),
      toolCalls,
      usage: {
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheRead: usage.cache_read_input_tokens || 0,
        cacheCreation: usage.cache_creation_input_tokens || 0,
      },
    };
  }

  if (ev.type === 'queue-operation') {
    return { ...base, operation: ev.operation };
  }

  return base;
}

function summarizeToolInput(toolName, input) {
  if (!input) return {};
  switch (toolName) {
    case 'Bash':
      return { command: (input.command || '').slice(0, 500), description: input.description };
    case 'Read':
      return { file: input.file_path, offset: input.offset, limit: input.limit };
    case 'Write':
      return { file: input.file_path, size: (input.content || '').length };
    case 'Edit':
      return { file: input.file_path, old: (input.old_string || '').slice(0, 200), new: (input.new_string || '').slice(0, 200) };
    case 'Glob':
      return { pattern: input.pattern, path: input.path };
    case 'Grep':
      return { pattern: input.pattern, path: input.path, type: input.type, output_mode: input.output_mode };
    case 'Task':
      return { description: input.description, type: input.subagent_type, prompt: (input.prompt || '').slice(0, 300) };
    case 'WebFetch':
      return { url: input.url, prompt: (input.prompt || '').slice(0, 150) };
    case 'WebSearch':
      return { query: input.query };
    case 'TodoWrite':
      return { count: (input.todos || []).length, items: (input.todos || []).map(t => ({ content: t.content, status: t.status })) };
    case 'NotebookEdit':
      return { file: input.notebook_path, mode: input.edit_mode };
    case 'AskUserQuestion':
      return { questions: (input.questions || []).map(q => q.question) };
    default:
      return Object.fromEntries(
        Object.entries(input).slice(0, 8).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 200) : v])
      );
  }
}

function getDebugTail(sessionId, lines = 80) {
  const debugFile = path.join(DEBUG_DIR, `${sessionId}.txt`);
  try {
    const content = fs.readFileSync(debugFile, 'utf8');
    return content.split('\n').slice(-lines).join('\n');
  } catch (_) {
    return '';
  }
}

function getTodos() {
  try {
    const files = fs.readdirSync(TODOS_DIR);
    const todos = [];
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(TODOS_DIR, f), 'utf8'));
        if (Array.isArray(data) && data.length > 0) {
          // Todo files are named {sessionId}-agent-{agentId}.json
          // Extract just the session UUID (first 36 chars before "-agent-")
          const baseName = f.replace('.json', '');
          const agentIdx = baseName.indexOf('-agent-');
          const sessionId = agentIdx > 0 ? baseName.slice(0, agentIdx) : baseName;
          todos.push({ sessionId, todos: data });
        }
      } catch (_) {}
    }
    return todos;
  } catch (_) {
    return [];
  }
}

function discoverSessions() {
  const results = [];
  try {
    const projectDirs = fs.readdirSync(PROJECTS_DIR);
    for (const dir of projectDirs) {
      const projectPath = path.join(PROJECTS_DIR, dir);
      try {
        const stat = fs.statSync(projectPath);
        if (!stat.isDirectory()) continue;
      } catch (_) { continue; }

      try {
        const files = fs.readdirSync(projectPath);
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          const sessionId = f.replace('.jsonl', '');
          const filePath = path.join(projectPath, f);
          try {
            const fstat = fs.statSync(filePath);

            // Skip bot check-in sessions (e.g. "ok" probes)
            if (isExcludedSession(filePath)) continue;

            results.push({
              sessionId,
              project: dir,
              file: filePath,
              size: fstat.size,
              lastModified: fstat.mtime,
            });
          } catch (_) {}
        }
      } catch (_) {}
    }
  } catch (_) {}
  return results.sort((a, b) => b.lastModified - a.lastModified);
}

function getFullSessionState(sessionFile) {
  const { events } = parseJSONL(sessionFile, 0);
  return summarizeEvents(events);
}

// ── HTTP Server ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]; // strip query params

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    return;
  }

  if (url === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(discoverSessions()));
    return;
  }

  if (url.startsWith('/api/session/')) {
    const sessionId = url.split('/api/session/')[1];
    const session = discoverSessions().find(s => s.sessionId === sessionId);
    if (session) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      const events = getFullSessionState(session.file);
      const debug = getDebugTail(sessionId);
      res.end(JSON.stringify({ session, events, debug }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  if (url === '/api/todos') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getTodos()));
    return;
  }

  // Health/liveness probe — always 200 if server is up.
  // Auth status is informational (exposed via /api/auth and WebSocket),
  // NOT a kill signal. The dashboard is a sidecar — restarting it can't
  // fix an expired token in the main container.
  if (url === '/healthz' || url === '/readyz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      auth: authHealthy,
      lastAuthCheck: lastAuthCheck ? new Date(lastAuthCheck).toISOString() : null,
      uptime: process.uptime(),
      excludedSessions: excludedSessions.size,
    }));
    return;
  }

  // Auth status endpoint for monitoring/alerting
  if (url === '/api/auth') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      healthy: authHealthy,
      lastCheck: lastAuthCheck ? new Date(lastAuthCheck).toISOString() : null,
    }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket Server ───────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  console.log(`[ws] client connected (total: ${clients.size + 1})`);
  clients.add(ws);

  const allSessions = discoverSessions();
  ws.send(JSON.stringify({ type: 'sessions', data: allSessions }));
  ws.send(JSON.stringify({ type: 'todos', data: getTodos() }));

  // Auto-send the most recently modified session
  if (allSessions.length > 0) {
    const active = allSessions[0];
    const events = getFullSessionState(active.file);
    const debug = getDebugTail(active.sessionId);
    ws.send(JSON.stringify({
      type: 'session-history',
      sessionId: active.sessionId,
      project: active.project,
      events,
      debug,
    }));
  }

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'subscribe' && data.sessionId) {
        const session = discoverSessions().find(s => s.sessionId === data.sessionId);
        if (session) {
          const events = getFullSessionState(session.file);
          const debug = getDebugTail(data.sessionId);
          ws.send(JSON.stringify({
            type: 'session-history',
            sessionId: session.sessionId,
            project: session.project,
            events,
            debug,
          }));
        }
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[ws] client disconnected (total: ${clients.size})`);
  });
});

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

// ── File Watchers ──────────────────────────────────────────────────────────
const jsonlWatcher = chokidar.watch(path.join(PROJECTS_DIR, '**', '*.jsonl'), {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
});

jsonlWatcher.on('change', (filePath) => {
  const sessionId = getSessionId(filePath);
  const offset = fileOffsets.get(filePath) || 0;
  const { events: rawEvents, newOffset } = parseJSONL(filePath, offset);
  fileOffsets.set(filePath, newOffset);

  if (rawEvents.length > 0) {
    // For incremental updates we need the full file to pair tool results properly,
    // because a tool_use in the delta might have its tool_result in the same delta
    // or the result might arrive in the *next* delta. We re-parse the full file for
    // pairing, but only send the new events (identified by the ones in the delta).
    const { events: allRaw } = parseJSONL(filePath, 0);
    const resultMap = extractToolResults(allRaw);

    const summarized = [];
    for (const ev of rawEvents) {
      const s = summarizeEvent(ev, resultMap);
      if (s) summarized.push(s);
    }

    if (summarized.length > 0) {
      const projectDir = path.basename(path.dirname(filePath));
      broadcast({
        type: 'session-events',
        sessionId,
        project: projectDir,
        events: summarized,
      });
    }
  }
});

jsonlWatcher.on('add', (filePath) => {
  fileOffsets.set(filePath, 0);
  broadcast({
    type: 'session-new',
    sessionId: getSessionId(filePath),
    sessions: discoverSessions(),
  });
});

// Watch debug logs
const debugWatcher = chokidar.watch(path.join(DEBUG_DIR, '*.txt'), {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
});

const debugOffsets = new Map();

debugWatcher.on('change', (filePath) => {
  const sessionId = path.basename(filePath, '.txt');
  if (sessionId === 'latest') return;

  try {
    const stat = fs.statSync(filePath);
    const prevOffset = debugOffsets.get(filePath) || 0;
    if (stat.size <= prevOffset) return;

    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(Math.min(stat.size - prevOffset, 8192));
    fs.readSync(fd, buf, 0, buf.length, prevOffset);
    fs.closeSync(fd);
    debugOffsets.set(filePath, stat.size);

    broadcast({ type: 'debug', sessionId, lines: buf.toString('utf8') });
  } catch (_) {}
});

// Watch todos
const todoWatcher = chokidar.watch(path.join(TODOS_DIR, '*.json'), {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
});

const todoHandler = () => broadcast({ type: 'todos', data: getTodos() });
todoWatcher.on('change', todoHandler);
todoWatcher.on('add', todoHandler);

// ── Initialize offsets ─────────────────────────────────────────────────────
for (const session of discoverSessions()) {
  try {
    const stat = fs.statSync(session.file);
    fileOffsets.set(session.file, stat.size);
  } catch (_) {}
}

// ── Start ──────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Claude Dashboard v1.1.0`);
  console.log(`  ─────────────────────────`);
  console.log(`  http://0.0.0.0:${PORT}`);
  console.log(`  Watching: ${PROJECTS_DIR}`);
  console.log(`  Debug:    ${DEBUG_DIR}`);
  console.log(`  Todos:    ${TODOS_DIR}`);
  console.log(`  Auth check interval: ${AUTH_CHECK_INTERVAL / 1000}s\n`);

  // Run initial auth check after a short delay (let the server settle)
  setTimeout(() => {
    checkAuthHealth();
    setInterval(checkAuthHealth, AUTH_CHECK_INTERVAL);
  }, 5000);
});
