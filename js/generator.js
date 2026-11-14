/* Runs model generation in a Web Worker (js/worker.js), with progress and cancel.
   Falls back to running on the page where workers can't start (e.g. file://); that path
   can't be cancelled and the page is busy while it runs. */
(() => {
'use strict';
const Mapcast = globalThis.Mapcast = globalThis.Mapcast || {};

const { buildModel } = Mapcast;

class Cancelled extends Error {
  constructor() { super('Generation cancelled.'); this.cancelled = true; }
}

function createGenerator() {
  const useWorker = typeof Worker !== 'undefined' && location.protocol !== 'file:';
  let worker = null, current = null, seq = 0;

  function settle(fn) { const c = current; current = null; if (c) fn(c); }

  function spawn() {
    worker = new Worker('js/worker.js');
    worker.onmessage = e => {
      const m = e.data;
      if (!current || m.id !== current.id) return; // reply from a cancelled job
      if (m.type === 'status') current.onStatus(m.msg, m.frac);
      else if (m.type === 'done') settle(c => c.resolve(m.result));
      else settle(c => c.reject(new Error(m.message)));
    };
    // Script/load failures (e.g. a CDN library unreachable) surface here.
    worker.onerror = e => {
      e.preventDefault();
      worker.terminate(); worker = null;
      settle(c => c.reject(new Error('The model builder failed to start' + (e.message ? `: ${e.message}` : '.') + ' Check your connection.')));
    };
  }

  return {
    // True when a running job can be cancelled (i.e. it runs in the worker).
    get cancellable() { return useWorker; },

    // ring: [{lat,lng}] print-area outline; settings: readSettings(); onStatus(msg, fraction).
    run(ring, settings, onStatus = () => {}) {
      if (!useWorker) return buildModel(ring, settings, onStatus);
      if (current) this.cancel();
      if (!worker) spawn();
      const id = ++seq;
      const plainRing = ring.map(p => ({ lat: p.lat, lng: p.lng }));
      return new Promise((resolve, reject) => {
        current = { id, resolve, reject, onStatus };
        worker.postMessage({ id, ring: plainRing, settings });
      });
    },

    // Stops the running job immediately. Returns false if nothing was running.
    cancel() {
      if (!current || !worker) return false;
      worker.terminate(); worker = null; // a fresh worker is spawned on the next run
      settle(c => c.reject(new Cancelled()));
      return true;
    }
  };
}

Object.assign(Mapcast, { createGenerator });
})();
