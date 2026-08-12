'use strict';

(() => {
  const onlineEl = document.getElementById('online-count');
  const listEl = document.getElementById('player-list');
  const feedEl = document.getElementById('chat-feed');
  const metaEl = document.getElementById('server-meta');
  const connDot = document.getElementById('conn-dot');
  const connLabel = document.getElementById('conn-label');

  let watcherName = 'WebWatcher';
  let lastCount = null;
  const seenIds = new Set();
  let es = null;
  let retryMs = 1000;
  let emptyFeed = true;

  function fmtTime(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function setConn(state, label) {
    connDot.classList.remove('live', 'bad');
    if (state === 'live') connDot.classList.add('live');
    if (state === 'bad') connDot.classList.add('bad');
    connLabel.textContent = label;
  }

  function renderPlayers(status) {
    const players = Array.isArray(status.players) ? status.players : [];
    const online = typeof status.online === 'number' ? status.online : players.length;
    watcherName = status.watcher || watcherName;

    if (lastCount !== null && lastCount !== online) {
      onlineEl.classList.remove('bump');
      // force reflow for bump animation
      void onlineEl.offsetWidth;
      onlineEl.classList.add('bump');
      setTimeout(() => onlineEl.classList.remove('bump'), 400);
    }
    lastCount = online;
    onlineEl.textContent = String(online);

    listEl.innerHTML = '';
    if (!players.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = status.connected ? '暂无其他玩家' : '旁观者未连上服务器';
      listEl.appendChild(li);
    } else {
      for (const name of players) {
        const li = document.createElement('li');
        li.textContent = name;
        if (name === watcherName) {
          li.className = 'watcher';
          li.title = '状态旁观者（本站）';
          li.textContent = `${name} · 旁观`;
        }
        listEl.appendChild(li);
      }
    }

    const s = status.server || {};
    const up = status.uptime_ms != null ? Math.floor(status.uptime_ms / 1000) : 0;
    const mins = Math.floor(up / 60);
    const secs = up % 60;
    metaEl.textContent = `${s.host || '?'}:${s.port || '?'} · ${s.version || '?'} · 旁观进程 ${mins}m${secs}s`;
  }

  function clearEmpty() {
    if (!emptyFeed) return;
    feedEl.innerHTML = '';
    emptyFeed = false;
  }

  function appendEvent(ev, { scroll } = { scroll: true }) {
    if (!ev || seenIds.has(ev.id)) return;
    seenIds.add(ev.id);
    clearEmpty();

    const row = document.createElement('div');
    row.className = `line kind-${ev.kind || 'system'}`;
    row.dataset.id = String(ev.id);

    const time = document.createElement('time');
    time.dateTime = new Date(ev.ts).toISOString();
    time.textContent = fmtTime(ev.ts);

    const body = document.createElement('div');
    body.className = 'body';

    if (ev.kind === 'chat') {
      const user = document.createElement('span');
      user.className = 'user';
      user.textContent = ev.username || '?';
      body.appendChild(user);
      body.appendChild(document.createTextNode(ev.text || ''));
    } else {
      body.textContent = ev.text || `${ev.kind} ${ev.username || ''}`.trim();
    }

    row.appendChild(time);
    row.appendChild(body);
    feedEl.appendChild(row);

    // Cap DOM nodes
    while (feedEl.children.length > 400) {
      const first = feedEl.firstElementChild;
      if (first?.dataset?.id) seenIds.delete(Number(first.dataset.id));
      first.remove();
    }

    if (scroll) {
      const nearBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 120;
      if (nearBottom) feedEl.scrollTop = feedEl.scrollHeight;
    }
  }

  function showEmptyFeed() {
    if (!emptyFeed) return;
    feedEl.innerHTML = '<p class="feed-empty">等待世界消息… 有人说话或进出时会出现在这里。</p>';
  }

  function handleFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'hello') {
      if (frame.status) renderPlayers(frame.status);
      if (Array.isArray(frame.events)) {
        for (const ev of frame.events) appendEvent(ev, { scroll: false });
        feedEl.scrollTop = feedEl.scrollHeight;
      }
      if (!frame.events?.length) showEmptyFeed();
      setConn(
        frame.status?.connected ? 'live' : 'bad',
        frame.status?.connected ? '已连接世界' : '旁观者重连中…'
      );
      return;
    }
    if (frame.type === 'status' && frame.status) {
      renderPlayers(frame.status);
      setConn(
        frame.status.connected ? 'live' : 'bad',
        frame.status.connected ? '已连接世界' : '旁观者重连中…'
      );
      return;
    }
    if (frame.type === 'event' && frame.event) {
      appendEvent(frame.event, { scroll: true });
    }
  }

  function connect() {
    if (es) {
      try {
        es.close();
      } catch {
        /* */
      }
    }
    setConn('bad', '连接中…');
    es = new EventSource('/api/stream');

    es.onopen = () => {
      retryMs = 1000;
      setConn('live', '链路已建立');
    };

    es.onmessage = (msg) => {
      try {
        handleFrame(JSON.parse(msg.data));
      } catch {
        /* ignore bad frames */
      }
    };

    es.onerror = () => {
      setConn('bad', '链路断开，重连中…');
      try {
        es.close();
      } catch {
        /* */
      }
      const wait = retryMs;
      retryMs = Math.min(retryMs * 1.7, 15000);
      setTimeout(connect, wait);
    };
  }

  // Fallback poll if EventSource missing
  async function pollFallback() {
    try {
      const [st, ev] = await Promise.all([
        fetch('/api/status').then((r) => r.json()),
        fetch('/api/events?limit=100').then((r) => r.json()),
      ]);
      renderPlayers(st);
      for (const item of ev.items || []) appendEvent(item, { scroll: false });
      feedEl.scrollTop = feedEl.scrollHeight;
      setConn(st.connected ? 'live' : 'bad', st.connected ? '轮询模式' : '旁观者离线');
    } catch {
      setConn('bad', '无法拉取状态');
    }
    setTimeout(pollFallback, 3000);
  }

  if ('EventSource' in window) connect();
  else {
    showEmptyFeed();
    pollFallback();
  }
})();
