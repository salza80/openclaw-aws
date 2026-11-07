import type { UiBackend, UiOutcome } from '../../src/ui/contracts.js';
export function fixtureBackend(
  apply: () => Promise<UiOutcome> = async () => ({ summary: 'Stopped.', facts: [] }),
): UiBackend {
  return {
    async deployments() {
      return [];
    },
    async recovery() {
      return [];
    },
    async models() {
      return { current: 'openrouter/example', models: [] };
    },
    async openNative() {
      return { publicUrl: 'http://localhost:19444' };
    },
    async close() {},
    async prepare(request, id) {
      return {
        view: {
          id,
          action: request.action,
          title: 'Stop approved host',
          target: {
            name: request.name ?? 'alpha',
            account: '123456789012',
            region: 'eu-central-1',
          },
          createdAt: new Date().toISOString(),
          facts: [],
          effects: ['Stop compute; disk remains billable.'],
        },
        apply,
      };
    },
  };
}
