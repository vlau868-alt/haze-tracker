/* Shared by the page (app.js) and the service worker (sw.js). No DOM access here. */
(function (root) {
  'use strict';

  const API_PSI = 'https://api-open.data.gov.sg/v2/real-time/api/psi';
  const API_PM25 = 'https://api-open.data.gov.sg/v2/real-time/api/pm25';

  const REGIONS = ['north', 'west', 'central', 'east', 'south'];

  // NEA 24-hr PSI descriptors
  const PSI_BANDS = [
    { max: 50, key: 'good', label: 'Good', bg: '#3b8ff3', fg: '#ffffff' },
    { max: 100, key: 'moderate', label: 'Moderate', bg: '#4cb36b', fg: '#08210f' },
    { max: 200, key: 'unhealthy', label: 'Unhealthy', bg: '#f2c230', fg: '#2b2100' },
    { max: 300, key: 'very-unhealthy', label: 'Very unhealthy', bg: '#f08a24', fg: '#2b1300' },
    { max: Infinity, key: 'hazardous', label: 'Hazardous', bg: '#d6403a', fg: '#ffffff' }
  ];

  // NEA 1-hr PM2.5 bands (ug/m3)
  const PM25_BANDS = [
    { max: 55, key: 'normal', label: 'Normal', bg: '#4cb36b', fg: '#08210f' },
    { max: 150, key: 'elevated', label: 'Elevated', bg: '#f2c230', fg: '#2b2100' },
    { max: 250, key: 'high', label: 'High', bg: '#f08a24', fg: '#2b1300' },
    { max: Infinity, key: 'very-high', label: 'Very high', bg: '#d6403a', fg: '#ffffff' }
  ];

  const METRICS = {
    psi24: { label: '24-hr PSI', unit: '', bands: PSI_BANDS, defaultThreshold: 100 },
    pm25: { label: '1-hr PM2.5', unit: ' µg/m³', bands: PM25_BANDS, defaultThreshold: 55 }
  };

  const DEFAULT_SETTINGS = {
    enabled: false,
    region: 'central',
    metric: 'psi24',
    threshold: 100,
    lastState: null // 'above' | 'below' | null (unknown)
  };

  function bandFor(bands, value) {
    if (typeof value !== 'number' || isNaN(value)) return null;
    return bands.find(function (b) { return value <= b.max; }) || bands[bands.length - 1];
  }

  /* ---------- data ---------- */

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + url);
    const body = await res.json();
    if (body.code !== 0 || !body.data || !body.data.items || !body.data.items.length) {
      throw new Error('Unexpected API response');
    }
    return body.data.items[body.data.items.length - 1];
  }

  /** Returns { psi24:{region:n}, pm25:{region:n}, psiTimestamp, pm25Timestamp, fetchedAt }.
   *  Either half may be null if only one endpoint succeeded. Throws if both fail. */
  async function fetchHazeData() {
    const results = await Promise.allSettled([fetchJson(API_PSI), fetchJson(API_PM25)]);
    const psi = results[0].status === 'fulfilled' ? results[0].value : null;
    const pm = results[1].status === 'fulfilled' ? results[1].value : null;
    if (!psi && !pm) throw results[0].reason || results[1].reason;
    return {
      psi24: psi ? psi.readings.psi_twenty_four_hourly : null,
      pm25: pm ? pm.readings.pm25_one_hourly : null,
      psiTimestamp: psi ? psi.timestamp : null,
      pm25Timestamp: pm ? pm.timestamp : null,
      fetchedAt: Date.now()
    };
  }

  /* ---------- alert logic ---------- */

  /** Pure function. Decides whether to notify and what the new lastState is.
   *  Notifies only on a transition into "at or above threshold" (or first check already above). */
  function evaluateAlert(settings, data) {
    const series = data && data[settings.metric];
    if (!series) return { notify: false, newState: settings.lastState };

    let region = settings.region;
    let value;
    if (region === 'any') {
      let best = null;
      REGIONS.forEach(function (r) {
        if (typeof series[r] === 'number' && (best === null || series[r] > series[best])) best = r;
      });
      if (best === null) return { notify: false, newState: settings.lastState };
      region = best;
      value = series[best];
    } else {
      value = series[region];
      if (typeof value !== 'number') return { notify: false, newState: settings.lastState };
    }

    const above = value >= settings.threshold;
    const newState = above ? 'above' : 'below';
    return {
      notify: above && settings.lastState !== 'above',
      newState: newState,
      region: region,
      value: value
    };
  }

  function describeAlert(settings, result) {
    const m = METRICS[settings.metric];
    const band = bandFor(m.bands, result.value);
    const regionName = result.region.charAt(0).toUpperCase() + result.region.slice(1);
    return {
      title: 'Haze alert: ' + regionName + ' Singapore',
      body: m.label + ' is ' + result.value + m.unit + (band ? ' (' + band.label + ')' : '') +
        ', at or above your threshold of ' + settings.threshold + '.'
    };
  }

  /* ---------- settings storage (IndexedDB so the service worker can read it too) ---------- */

  function openDb() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open('haze-tracker', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function kvGet(key) {
    const db = await openDb();
    return new Promise(function (resolve, reject) {
      const req = db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function kvSet(key, value) {
    const db = await openDb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  async function loadSettings() {
    const saved = await kvGet('settings').catch(function () { return null; });
    return Object.assign({}, DEFAULT_SETTINGS, saved || {});
  }

  function saveSettings(settings) {
    return kvSet('settings', settings);
  }

  root.Haze = {
    REGIONS: REGIONS, METRICS: METRICS, PSI_BANDS: PSI_BANDS, PM25_BANDS: PM25_BANDS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    bandFor: bandFor, fetchHazeData: fetchHazeData,
    evaluateAlert: evaluateAlert, describeAlert: describeAlert,
    loadSettings: loadSettings, saveSettings: saveSettings
  };
})(typeof self !== 'undefined' ? self : this);
