// Business logic for daemonized setups: install, remove, list. These are the
// ngin verbs/nouns the CLI dispatches; the registry + service providers do the
// platform work. Auto-install-after-first-tether dispatches InstallSetupAction.

import { Action, Query } from '@3sln/ngin';

/** Persist a setup and register an OS service for it. */
export class InstallSetupAction extends Action {
  static deps = ['registry', 'service'];
  /**
   * @param {{name,room,agent,cwd,backendUrl}} setup
   * @param {{apiKey?:string, language?:string, createdAt?:string}} secrets
   */
  constructor(setup, secrets = {}) {
    super();
    this.setup = setup;
    this.secrets = secrets;
  }
  async execute({ registry, service }, { dispatchFeed }) {
    const saved = await registry.saveSetup({
      ...this.setup,
      createdAt: this.setup.createdAt || this.secrets.createdAt || null,
    });
    // Stash secrets in a 0600 env file the service loads at runtime.
    await registry.writeEnvFile(saved.name, {
      OPENAI_API_KEY: this.secrets.apiKey || '',
      BRIDLE_WHISPER_LANG: this.secrets.language || '',
    });
    const svc = await service.installService(saved.name);
    dispatchFeed.dispatchEvent(new CustomEvent('installed', { detail: { setup: saved, service: svc } }));
  }
}

/** Stop + remove a setup's service and registry entry. */
export class RemoveSetupAction extends Action {
  static deps = ['registry', 'service'];
  constructor(name) {
    super();
    this.name = name;
  }
  async execute({ registry, service }, { dispatchFeed }) {
    await service.uninstallService(this.name);
    const removed = await registry.removeSetup(this.name);
    dispatchFeed.dispatchEvent(new CustomEvent('removed', { detail: { name: this.name, removed } }));
  }
}

/** List setups with their live service status. */
export class SetupsQuery extends Query {
  static deps = ['registry', 'service'];
  async boot({ registry, service }, { notify }) {
    const all = await registry.readSetups();
    const list = await Promise.all(
      Object.values(all).map(async (s) => ({
        ...s,
        status: await service.serviceStatus(s.name),
        manager: service.platformName(),
      })),
    );
    notify(list);
  }
}
