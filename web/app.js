'use strict';
(function () {
  const STORAGE_KEY = 'xueshan-lane:dir';
  const REFRESH_MS = 30 * 1000;
  const STALE_MS = 3 * 60 * 1000;

  // 靜態行車提示（距離為約略值）
  const HINTS = {
    S: '南下：坪林交流道後約 1 公里進隧道，請在進隧道前決定車道（隧道內禁止變換車道）',
    N: '北上：頭城交流道後約 2 公里進隧道，請在進隧道前決定車道（隧道內禁止變換車道）',
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const fmtTime = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const fmtDate = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'numeric',
    day: 'numeric',
  });

  function loadDir() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === 'N' || v === 'S' ? v : 'S';
    } catch {
      return 'S';
    }
  }

  let dir = loadDir();
  let lastData = null;
  let timer = null;
  let reqSeq = 0;

  function saveDir(d) {
    try {
      localStorage.setItem(STORAGE_KEY, d);
    } catch {
      /* 無痕模式等情況忽略 */
    }
  }

  function setText(el, v) {
    el.textContent = v == null || Number.isNaN(v) ? '--' : String(v);
  }

  function renderDir() {
    for (const b of $$('.dir-btn')) b.setAttribute('aria-pressed', String(b.dataset.dir === dir));
    $('#hint').textContent = HINTS[dir];
    document.body.dataset.dir = dir;
  }

  function renderBanner(rec) {
    const banner = $('#banner');
    const text = $('#banner-text');
    const sub = $('#banner-sub');
    banner.className = 'banner';
    let main;
    let detail = '';
    if (!rec || rec.rec === 'unknown') {
      banner.classList.add('banner-similar');
      main = '資料不足';
    } else if (rec.rec === 'similar') {
      banner.classList.add('banner-similar');
      main = '兩線差不多';
      detail = `車速差距約 ${Math.abs(rec.diff)} km/h（推估）`;
    } else {
      banner.classList.add('banner-go', `banner-${rec.rec}`);
      main = rec.rec === 'left' ? '建議走左線' : '建議走右線';
      const faster = rec.diff > 0 ? 'left' : 'right';
      detail = faster === rec.rec
        ? `約快 ${Math.abs(rec.diff)} km/h（推估）`
        : '差距縮小中，暫維持原建議（推估）';
    }
    banner.dataset.rec = rec ? rec.rec : 'unknown';
    text.textContent = main;
    sub.textContent = detail;
  }

  function renderLane(id, lane, rec) {
    const el = $(id);
    setText($('[data-field="speed"]', el), lane?.speed);
    setText($('[data-field="vehiclesAhead"]', el), lane?.vehiclesAhead);
    setText($('[data-field="slowSuspect"]', el), lane?.slowSuspect);
    el.classList.toggle('is-rec', rec?.rec === el.dataset.lane);
  }

  function renderStale() {
    if (!lastData) return;
    const t = Date.parse(lastData.dataTime);
    const stale = !Number.isFinite(t) || Date.now() - t > STALE_MS;
    $('#stale').hidden = !stale;
    document.body.classList.toggle('is-stale', stale);
  }

  function render(data) {
    lastData = data;
    renderBanner(data.recommendation);
    renderLane('#lane-left', data.lanes?.left, data.recommendation);
    renderLane('#lane-right', data.lanes?.right, data.recommendation);
    const t = new Date(data.dataTime);
    const timeEl = $('#data-time');
    if (Number.isFinite(t.getTime())) {
      timeEl.textContent = `${fmtDate.format(t)} ${fmtTime.format(t)}`;
      timeEl.dateTime = t.toISOString();
    } else {
      timeEl.textContent = '--:--';
    }
    const src = $('#source');
    src.textContent = data.sourceLabel || data.source;
    src.dataset.source = data.source;
    document.body.dataset.source = data.source;
    renderStale();
  }

  async function refresh() {
    const seq = ++reqSeq;
    const wanted = dir;
    try {
      const res = await fetch(`api/lanes?dir=${wanted}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (seq !== reqSeq || wanted !== dir) return; // 已切換方向，丟棄舊回應
      $('#error').hidden = true;
      render(data);
    } catch (err) {
      if (seq !== reqSeq) return;
      const e = $('#error');
      e.textContent = '暫時無法更新資料，顯示的是上一次的結果。';
      e.hidden = false;
      renderStale();
    }
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') refresh();
      else renderStale();
    }, REFRESH_MS);
  }

  function setDir(d) {
    if (d === dir) return;
    dir = d;
    saveDir(d);
    lastData = null;
    renderDir();
    const banner = $('#banner');
    banner.className = 'banner banner-loading';
    $('#banner-text').textContent = '讀取中…';
    $('#banner-sub').textContent = '';
    refresh();
    schedule();
  }

  for (const b of $$('.dir-btn')) b.addEventListener('click', () => setDir(b.dataset.dir));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

  renderDir();
  refresh();
  schedule();
})();
