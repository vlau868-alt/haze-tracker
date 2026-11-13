(function () {
  'use strict';

  const H = window.Haze;
  const $ = function (id) { return document.getElementById(id); };
  const CACHE_KEY = 'haze-last-data';
  const POLL_MS = 5 * 60 * 1000;

  let settings = Object.assign({}, H.DEFAULT_SETTINGS);
  let data = null;
  let swReg = null;
  let deferredInstall = null;

  /* ---------- helpers ---------- */

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function fmtTime(iso) {
    if (!iso) return '';
    return new Intl.DateTimeFormat('en-SG', {
      timeZone: 'Asia/Singapore', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true
    }).format(new Date(iso));
  }

  function setStatus(msg, isError) {
    const el = $('status');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }

  /* ---------- rendering ---------- */

  function readingEl(metricKey, value, label) {
    const m = H.METRICS[metricKey];
    const band = H.bandFor(m.bands, value);
    const wrap = document.createElement('div');
    wrap.className = 'reading';

    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = typeof value === 'number' ? String(value) : '–';
    if (band) {
      badge.style.background = band.bg;
      badge.style.color = band.fg;
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    const b = document.createElement('b');
    b.textContent = label;
    const s = document.createElement('span');
    s.textContent = band ? band.label : 'No data';
    meta.append(b, s);

    wrap.append(badge, meta);
    return wrap;
  }

  function renderRegions() {
    const grid = $('regions');
    grid.textContent = '';
    H.REGIONS.forEach(function (r, i) {
      const card = document.createElement('article');
      card.className = 'region' + (i === H.REGIONS.length - 1 ? ' wide' : '');
      if (settings.enabled && settings.region === r) card.classList.add('watched');

      const h = document.createElement('h3');
      h.textContent = cap(r);
      card.append(h);
      card.append(readingEl('psi24', data && data.psi24 ? data.psi24[r] : null, '24-hr PSI'));
      card.append(readingEl('pm25', data && data.pm25 ? data.pm25[r] : null, '1-hr PM2.5'));
      grid.append(card);
    });
  }

  function renderThresholdHint() {
    const m = H.METRICS[settings.metric];
    const parts = [];
    let prev = 0;
    m.bands.forEach(function (b) {
      if (b.max === Infinity) parts.push(b.label + ' above ' + prev);
      else parts.push(b.label + ' ≤' + b.max);
      prev = b.max;
    });
    $('threshold-hint').textContent = 'NEA bands: ' + parts.join(' · ') + '.';
  }

  function renderForm() {
    $('region').value = settings.region;
    $('metric').value = settings.metric;
    $('threshold').value = settings.threshold;
    $('enabled').checked = settings.enabled;
    renderThresholdHint();
  }

  function renderStatusLine(fromCache) {
    if (!data) return;
    const ts = data.psiTimestamp || data.pm25Timestamp;
    let msg = 'Reading for ' + fmtTime(ts) + ' (Singapore time).';
    if (data.psiTimestamp && data.pm25Timestamp && data.psiTimestamp !== data.pm25Timestamp) {
      msg = 'PSI for ' + fmtTime(data.psiTimestamp) + ', PM2.5 for ' + fmtTime(data.pm25Timestamp) + '.';
    }
    if (!data.psi24 || !data.pm25) msg += ' Part of the data is unavailable right now.';
    if (fromCache) msg = 'Offline or NEA unreachable. Showing the last saved reading. ' + msg;
    setStatus(msg, !!fromCache);
  }

  /* ---------- data ---------- */

  async function load(manual) {
    const btn = $('refresh');
    btn.classList.add('spin');
    try {
      data = await H.fetchHazeData();
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) {}
      renderStatusLine(false);
      renderRegions();
      await runAlertCheck();
    } catch (err) {
      let cached = null;
      try { cached = JSON.parse(localStorage.getItem(CACHE_KEY)); } catch (e) {}
      if (cached) {
        data = cached;
        renderRegions();
        renderStatusLine(true);
      } else {
        setStatus('Could not load NEA data. Check your connection and try again.', true);
      }
    } finally {
      btn.classList.remove('spin');
    }
  }

  /* ---------- notifications ---------- */

  function notificationsSupported() { return 'Notification' in window; }

  async function showNotification(title, body) {
    const opts = {
      body: body,
      icon: 'icons/icon-192.png',
      badge: 'icons/favicon-32.png',
      tag: 'haze-alert',
      renotify: true,
      data: { url: './' }
    };
    if (swReg && swReg.showNotification) {
      await swReg.showNotification(title, opts);
    } else {
      new Notification(title, opts);
    }
  }

  async function runAlertCheck() {
    if (!settings.enabled || !data) return;
    if (!notificationsSupported() || Notification.permission !== 'granted') return;
    const result = H.evaluateAlert(settings, data);
    if (result.newState !== settings.lastState) {
      settings.lastState = result.newState;
      await H.saveSettings(settings);
    }
    if (result.notify) {
      const msg = H.describeAlert(settings, result);
      await showNotification(msg.title, msg.body);
    }
  }

  async function ensurePermission() {
    if (!notificationsSupported()) return 'unsupported';
    if (Notification.permission === 'default') {
      return await Notification.requestPermission();
    }
    return Notification.permission;
  }

  async function registerBackgroundCheck() {
    if (!swReg || !('periodicSync' in swReg)) return false;
    try {
      await swReg.periodicSync.register('haze-check', { minInterval: 60 * 60 * 1000 });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function unregisterBackgroundCheck() {
    if (swReg && 'periodicSync' in swReg) {
      try { await swReg.periodicSync.unregister('haze-check'); } catch (e) {}
    }
  }

  function setAlertStatus(msg) { $('alert-status').textContent = msg; }

  /* ---------- form events ---------- */

  $('metric').addEventListener('change', function () {
    const m = $('metric').value;
    settings.metric = m;
    $('threshold').value = H.METRICS[m].defaultThreshold;
    renderThresholdHint();
  });

  $('alert-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    const threshold = parseInt($('threshold').value, 10);
    if (!(threshold >= 1)) {
      setAlertStatus('Enter a threshold of 1 or more.');
      return;
    }

    const wantEnabled = $('enabled').checked;
    let message = 'Saved.';

    if (wantEnabled) {
      const perm = await ensurePermission();
      if (perm !== 'granted') {
        $('enabled').checked = false;
        settings.enabled = false;
        message = perm === 'unsupported'
          ? 'This browser does not support notifications. On iPhone, add the app to your home screen first, then open it from there.'
          : 'Notification permission was not granted, so alerts are off. You can allow notifications for this site in your browser or phone settings.';
      }
    }

    const enabled = wantEnabled && $('enabled').checked;
    settings = Object.assign({}, settings, {
      enabled: enabled,
      region: $('region').value,
      metric: $('metric').value,
      threshold: threshold,
      lastState: null // re-evaluate from scratch with the new rule
    });
    await H.saveSettings(settings);

    if (enabled) {
      const bg = await registerBackgroundCheck();
      message = bg
        ? 'Saved. Alerts are on, including background checks about once an hour.'
        : 'Saved. Alerts are on while this app is open. This browser does not run background checks, so keep the app open or reopen it to be alerted.';
    } else {
      await unregisterBackgroundCheck();
      if (!wantEnabled) message = 'Saved. Notifications are off.';
    }

    setAlertStatus(message);
    renderRegions();
    await runAlertCheck();
  });

  $('test').addEventListener('click', async function () {
    const perm = await ensurePermission();
    if (perm !== 'granted') {
      setAlertStatus('Notifications are not allowed yet, so a test cannot be shown.');
      return;
    }
    await showNotification('Haze Tracker', 'Test notification. Alerts will look like this.');
    setAlertStatus('Test notification sent.');
  });

  $('refresh').addEventListener('click', function () { load(true); });

  /* ---------- install ---------- */

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function setupInstallCard() {
    if (isStandalone()) return;
    const card = $('install');
    const text = $('install-text');
    const ua = navigator.userAgent;
    const isIos = /iPhone|iPad|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1);

    card.hidden = false;
    if (isIos) {
      text.textContent = 'In Safari, tap the Share button, then “Add to Home Screen”. Open the app from your home screen to use notifications.';
    } else {
      text.textContent = 'Use your browser menu and choose “Install app” or “Add to Home screen”.';
    }
  }

  window.addEventListener('beforeinstallprompt', function (ev) {
    ev.preventDefault();
    deferredInstall = ev;
    $('install').hidden = false;
    $('install-text').textContent = 'Install Haze Tracker for quick access and background alerts.';
    $('install-btn').hidden = false;
  });

  $('install-btn').addEventListener('click', async function () {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    $('install-btn').hidden = true;
  });

  window.addEventListener('appinstalled', function () { $('install').hidden = true; });

  /* ---------- boot ---------- */

  async function boot() {
    settings = await H.loadSettings();
    renderForm();

    if ('serviceWorker' in navigator) {
      try {
        swReg = await navigator.serviceWorker.register('sw.js');
        await navigator.serviceWorker.ready;
      } catch (e) { /* app still works without it */ }
    }

    // Show last known data instantly while the network request runs.
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (cached) { data = cached; renderRegions(); renderStatusLine(false); }
    } catch (e) {}
    renderRegions();

    setupInstallCard();
    await load(false);

    setInterval(function () { if (!document.hidden) load(false); }, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(false); });
  }

  boot();
})();
