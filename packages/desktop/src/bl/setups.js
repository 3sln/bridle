// Business logic for tethers: remove + list. The registry holds tethers.json and
// the shared server's status.json; the CLI reads both. Creating/running a tether
// no longer installs anything per-tether — `bridle tether` writes the registry and
// the single server picks it up (see index.js / server.js).

import { Action, Query } from '@3sln/ngin';

/** Forget the pinned phone for a tether, so the next device to connect pairs
 *  (trust-on-first-use again). This is the documented way back in when the
 *  paired phone is gone — reinstalled the PWA, cleared its data, or a new
 *  handset — because re-scanning the QR keeps the same room and therefore the
 *  same pin. It is deliberately a separate, explicit command: re-tethering must
 *  not quietly drop the second factor that protects an already-paired tether. */
export class UnpairAction extends Action {
  static deps = ['registry'];
  constructor(name) {
    super();
    this.name = name;
  }
  async execute({ registry }, { dispatchFeed }) {
    const setup = await registry.getSetup(this.name);
    if (!setup) throw new Error(`no such tether: ${this.name}`);
    const had = !!(await registry.getPin(setup.room));
    await registry.removePin(setup.room);
    dispatchFeed.dispatchEvent(new CustomEvent('unpaired', { detail: { name: setup.name, had } }));
  }
}

/** Remove a tether from the registry. The running server notices the change and
 *  tears its session down; there's no per-tether service to uninstall. */
export class RemoveSetupAction extends Action {
  static deps = ['registry'];
  constructor(name) {
    super();
    this.name = name;
  }
  async execute({ registry }, { dispatchFeed }) {
    const removed = await registry.removeSetup(this.name);
    dispatchFeed.dispatchEvent(new CustomEvent('removed', { detail: { name: this.name, removed } }));
  }
}

/** List tethers with live status: whether the shared server is running, whether
 *  it's persistent (service registered), and each tether's live phase/guest as
 *  reported in status.json. */
export class SetupsQuery extends Query {
  static deps = ['registry', 'service'];
  async boot({ registry, service }, { notify }) {
    const all = await registry.readSetups();
    const svc = await service.serverServiceStatus(); // 'active' == the server service is registered
    const serverUp = registry.serverRunning();
    const status = registry.readStatusSync();
    const now = Date.now();
    const pins = await Promise.all(Object.values(all).map((s) => registry.getPin(s.room)));
    const list = Object.values(all).map((s, i) => {
      const live = status[s.name];
      // Only trust status.json while the server is actually up — otherwise a
      // just-killed server leaves stale entries that would read as "live".
      const fresh = serverUp && !!live && now - (live.at || 0) < registry.STATUS_STALE_MS;
      return {
        ...s,
        service: svc,
        serverRunning: serverUp,
        running: fresh, // the server currently has a live session for this tether
        phase: fresh ? live.phase : null,
        guest: fresh ? live.guest : null,
        paired: !!pins[i], // a phone is pinned to this tether (TOFU)
        manager: service.platformName(),
      };
    });
    notify(list);
  }
}
