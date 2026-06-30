// ngin Providers for the desktop. Each wraps one platform capability as an
// injectable, lifecycle-managed resource. Business logic (bl/session.js) only
// ever sees these through `obtain()` — it never imports werift, the OpenAI SDK,
// or Bun.spawn directly. That's the whole point: swap any provider (local STT,
// a different agent runner, a node-datachannel peer) without touching logic.
//
// Note on ngin semantics: a Provider receives its *dependency Providers* as
// constructor args (you call `.obtain()` on them yourself), whereas Actions and
// Queries receive already-obtained *resources*.

import { Provider } from '@3sln/ngin';
import { AgentRunner } from './agent-runner.js';
import { SignalingClient } from './signaling-client.js';
import { HostPeer } from './peer.js';
import * as registry from './registry.js';
import * as service from './service.js';

/** Setups registry (persistent JSON + env files). */
export class RegistryProvider extends Provider {
  async obtain() {
    return registry;
  }
}

/** OS service manager (launchd / systemd / Task Scheduler). */
export class ServiceProvider extends Provider {
  async obtain() {
    return service;
  }
}

/** Long-lived agent subprocess (one per session). */
export class AgentProvider extends Provider {
  static deps = ['config'];
  constructor({ config }) {
    super();
    this.config = config;
    this.runner = null;
  }
  async obtain() {
    if (!this.runner) {
      const cfg = await this.config.obtain();
      this.runner = new AgentRunner(cfg.agent, { cwd: cfg.agent.cwd });
    }
    return this.runner;
  }
  async dispose() {
    this.runner?.kill();
    this.runner = null;
  }
}

/** Signaling connection to the backend relay (host role). */
export class SignalingProvider extends Provider {
  static deps = ['config'];
  constructor({ config }) {
    super();
    this.config = config;
    this.client = null;
  }
  async obtain() {
    if (!this.client) {
      const cfg = await this.config.obtain();
      this.client = new SignalingClient({ url: cfg.backendUrl, room: cfg.room, role: 'host' });
    }
    return this.client;
  }
  async dispose() {
    this.client?.close();
    this.client = null;
  }
}

/**
 * WebRTC peer *factory* (answerer). A fresh HostPeer is minted per phone
 * connection so the long-lived daemon survives unlimited reconnects — each
 * RTCPeerConnection is single-use. The session owns each peer's lifecycle.
 */
export class PeerProvider extends Provider {
  static deps = ['config'];
  constructor({ config }) {
    super();
    this.config = config;
  }
  async obtain() {
    const cfg = await this.config.obtain();
    return () => new HostPeer({ iceServers: cfg.iceServers });
  }
}
