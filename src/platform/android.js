import { CapacitorHttp } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { LocalNotifications } from '@capacitor/local-notifications';
import calendar from '../../server/tv/holidays.json';
import { createPriceBandService } from '../core/priceBands.js';
import { createMarketContextService } from '../core/marketContext.js';
import { createKiteClient } from '../core/kite.js';
import { createRecorder } from '../core/recorder.js';
import { createOrderScheduler } from '../core/orderScheduler.js';
import { createNseLiveService } from '../core/nseLive.js';
import { parseCSV, rowsToObjects } from '../utils/csv.js';
import { createPhonePreopen } from './phonePreopen.js';

/**
 * Android build: no backend. NSE, price bands, signals and Kite are called
 * directly from the phone, and everything is stored in the app's private
 * storage. Same interface as ./web.js. TV research needs a desktop browser
 * and the OpenAI API, so it is not part of the app.
 */

const TICK_MS = 20_000;
const NOTIFICATION_IDS = { first: 9100, count: 100 };

/**
 * fetch-compatible wrapper over Capacitor's native HTTP, which isn't subject
 * to the WebView's CORS rules (NSE and Kite don't allow browser origins).
 */
export async function nativeFetch(url, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  const contentType = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  let data;
  if (init.body != null) {
    // Form bodies go as an object so the native side encodes them.
    data = contentType.includes('x-www-form-urlencoded')
      ? Object.fromEntries(new URLSearchParams(String(init.body)))
      : init.body;
  }
  const response = await CapacitorHttp.request({
    url,
    method: init.method ?? 'GET',
    headers,
    data,
    // Binary files (zips) come back base64-encoded with 'arraybuffer'.
    responseType: init.binary ? 'arraybuffer' : 'text',
    connectTimeout: 25_000,
    readTimeout: 40_000,
  });
  const lower = Object.fromEntries(Object.entries(response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const text = () => (typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? ''));
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => text(),
    json: async () => (typeof response.data === 'string' ? JSON.parse(response.data) : response.data),
    async arrayBuffer() {
      const binary = atob(typeof response.data === 'string' ? response.data : '');
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    },
  };
}

/** JSON key/value store in the app's private data directory. */
export function deviceStore(root = 'advdec') {
  return {
    async read(name) {
      try {
        const { data } = await Filesystem.readFile({ path: `${root}/${name}`, directory: Directory.Data, encoding: Encoding.UTF8 });
        return JSON.parse(data);
      } catch { return null; }
    },
    async write(name, value) {
      await Filesystem.writeFile({
        path: `${root}/${name}`, data: JSON.stringify(value), directory: Directory.Data, encoding: Encoding.UTF8, recursive: true,
      });
    },
  };
}

/** 9:10 reminders on trading days (tap opens the app, which fetches the data). */
const notifier = {
  async schedule(runs) {
    let permission = await LocalNotifications.checkPermissions();
    if (permission.display === 'prompt' || permission.display === 'prompt-with-rationale') {
      permission = await LocalNotifications.requestPermissions();
    }
    const ours = (id) => id >= NOTIFICATION_IDS.first && id < NOTIFICATION_IDS.first + NOTIFICATION_IDS.count;
    const { notifications: pending } = await LocalNotifications.getPending();
    const stale = pending.filter((n) => ours(n.id));
    if (stale.length) await LocalNotifications.cancel({ notifications: stale.map((n) => ({ id: n.id })) });
    if (permission.display !== 'granted' || !runs.length) return;
    await LocalNotifications.schedule({
      notifications: runs.slice(0, NOTIFICATION_IDS.count).map((at, i) => ({
        id: NOTIFICATION_IDS.first + i,
        title: 'NSE pre-open data',
        body: 'Pre-open is in. Tap to load the Advance / Decline analysis.',
        schedule: { at, allowWhileIdle: true },
      })),
    });
  },
};

export function createAndroidApi() {
  const store = deviceStore();
  const fetchImpl = nativeFetch;
  const priceBands = createPriceBandService({ store, fetchImpl });
  // NSE cookies are kept by the phone's native HTTP layer.
  const nseLive = createNseLiveService({ fetchImpl });
  // No F&O backfill on the phone (about 24 MB once): the OI research history builds up day by day.
  const context = createMarketContextService({ store, fetchImpl, calendar, foBackfill: false });
  const recorder = createRecorder({
    store,
    calendar,
    context,
    inputs: async () => ({
      // Uploaded list, else the bundled one (same fallback as the UI).
      masterRows: (await store.read('master-stock.json'))?.rows
        ?? rowsToObjects(parseCSV(await (await fetch('/master_stock.csv')).text())),
      secList: await priceBands.get().catch(() => null),
      ...await context.get().then((c) => ({ events: c.events, market: c.market })).catch(() => ({})),
    }),
  });
  const preopen = createPhonePreopen({ store, fetchImpl, calendar, notifier, onSnapshot: (s) => recorder.record(s) });
  const kite = createKiteClient({ fetchImpl });
  const orderScheduler = createOrderScheduler({
    store, calendar, placeOrder: (args) => kite.placeOrder(args),
    // Kite's own record (received, at the exchange, fills) for each placed order.
    orderDetails: async (args) => {
      const [history, trades] = await Promise.all([kite.orderHistory(args), kite.orderTrades(args)]);
      return { history, trades };
    },
  });
  orderScheduler.load().catch(() => {});
  preopen.snapshot().then((s) => s && recorder.record(s)).catch(() => {});

  // Replaces the backend's cron jobs: check on start, on resume and while open.
  const tick = () => preopen.tick().catch(() => {});
  tick();
  preopen.reschedule().catch(() => {});
  setInterval(() => { if (document.visibilityState === 'visible') tick(); }, TICK_MS);
  App.addListener('resume', () => { tick(); context.get().catch(() => {}); });
  LocalNotifications.addListener('localNotificationActionPerformed', () => tick());
  // Android back button: go back through the app's pages, exit from the first one.
  App.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack && window.location.hash && window.location.hash !== '#/') window.history.back();
    else App.exitApp();
  });

  return {
    platform: 'android',
    features: { tvResearch: false },
    master: {
      get: () => store.read('master-stock.json'),
      async save(name, rows) {
        const saved = { name, uploadedAt: new Date().toISOString(), rows };
        await store.write('master-stock.json', saved);
        return saved;
      },
      reset: () => store.write('master-stock.json', null),
    },
    preopen: {
      subscribe(onUpdate) {
        let unsubscribe = () => {};
        let closed = false;
        preopen.subscribe(onUpdate).then((off) => { if (closed) off(); else unsubscribe = off; });
        return () => { closed = true; unsubscribe(); };
      },
      refresh: () => preopen.refresh(),
      saveSchedule: (config) => preopen.update(config),
    },
    priceBands: { get: () => priceBands.get() },
    context: {
      async get(date = null) {
        const c = await context.get({ date });
        return { ...c, preopen: await recorder.preopenBaseline(c.date).catch(() => null) };
      },
    },
    live: { quote: (instruments) => nseLive.quote(instruments) },
    // The WebSocket collector runs in the PC backend; the phone keeps /quote polling (milestone 1).
    opening: null,
    trading: null, // paper trading runs on the desktop backend; the phone never places orders
    files: {
      /** Saves into Documents/AdvDec on the phone (visible in the Files app). */
      async save(name, bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        await Filesystem.writeFile({ path: `AdvDec/${name}`, data: btoa(binary), directory: Directory.Documents, recursive: true });
        return `Documents/AdvDec/${name}`;
      },
    },
    // No backend on the phone: the app itself saves the 9:30 file while open (see App.jsx).
    exports: null,
    // On the phone, orders are sent by the app itself, so it must be open at the trigger time.
    scheduledOrders: {
      runsInBackground: false,
      list: async () => ({ orders: await orderScheduler.list(), session: orderScheduler.sessionStatus() }),
      async add(order) {
        const { order: o, warnings } = await orderScheduler.add(order);
        return { order: o, warnings, orders: await orderScheduler.list(), session: orderScheduler.sessionStatus() };
      },
      async cancel(id) {
        await orderScheduler.cancel(id);
        return { orders: await orderScheduler.list(), session: orderScheduler.sessionStatus() };
      },
      async refreshKite(id) {
        await orderScheduler.refreshKite(id);
        return { orders: await orderScheduler.list(), session: orderScheduler.sessionStatus() };
      },
      setSession: async (s) => orderScheduler.setSession(s),
    },
    confirm: {
      get: (date) => recorder.confirmation(date),
      save: (reading) => recorder.saveConfirmation(reading),
    },
    reportCard: {
      status: () => recorder.status(),
      get: (factorSettings) => recorder.report(factorSettings),
    },
    // The AI Analyst needs the PC backend (the provider key is kept there, never in the APK).
    ai: null,
    kite,
  };
}
