import { describe, it, expect, vi, afterEach } from 'vitest';

const chain = vi.hoisted(() => ({
  scriptName: vi.fn().mockReturnThis(),
  usage: vi.fn().mockReturnThis(),
  command: vi.fn().mockReturnThis(),
  demandCommand: vi.fn().mockReturnThis(),
  help: vi.fn().mockReturnThis(),
  alias: vi.fn().mockReturnThis(),
  version: vi.fn().mockReturnThis(),
  epilogue: vi.fn().mockReturnThis(),
  strict: vi.fn().mockReturnThis(),
  parse: vi.fn().mockReturnThis(),
}));

const yargsMock = vi.hoisted(() => vi.fn(() => chain));
const hideBinMock = vi.hoisted(() => vi.fn(() => ['--help']));

vi.mock('yargs', () => ({
  default: yargsMock,
}));

vi.mock('yargs/helpers', () => ({
  hideBin: hideBinMock,
}));

const initCommandMock = vi.hoisted(() => ({ command: 'init' }));
const listCommandMock = vi.hoisted(() => ({ command: 'list' }));
const currentCommandMock = vi.hoisted(() => ({ command: 'current' }));
const useCommandMock = vi.hoisted(() => ({ command: 'use' }));
const deployCommandMock = vi.hoisted(() => ({ command: 'deploy' }));
const destroyCommandMock = vi.hoisted(() => ({ command: 'destroy' }));
const connectCommandMock = vi.hoisted(() => ({ command: 'connect' }));
const dashboardCommandMock = vi.hoisted(() => ({ command: 'dashboard' }));
const statusCommandMock = vi.hoisted(() => ({ command: 'status' }));
const outputsCommandMock = vi.hoisted(() => ({ command: 'outputs' }));
const logsCommandMock = vi.hoisted(() => ({ command: 'logs' }));
const stopCommandMock = vi.hoisted(() => ({ command: 'stop' }));
const startCommandMock = vi.hoisted(() => ({ command: 'start' }));
const restartCommandMock = vi.hoisted(() => ({ command: 'restart' }));

vi.mock('../../src/cli/commands/init.js', () => ({ default: initCommandMock }));
vi.mock('../../src/cli/commands/list.js', () => ({ default: listCommandMock }));
vi.mock('../../src/cli/commands/current.js', () => ({ default: currentCommandMock }));
vi.mock('../../src/cli/commands/use.js', () => ({ default: useCommandMock }));
vi.mock('../../src/cli/commands/deploy.js', () => ({ default: deployCommandMock }));
vi.mock('../../src/cli/commands/destroy.js', () => ({ default: destroyCommandMock }));
vi.mock('../../src/cli/commands/connect.js', () => ({ default: connectCommandMock }));
vi.mock('../../src/cli/commands/dashboard.js', () => ({ default: dashboardCommandMock }));
vi.mock('../../src/cli/commands/status.js', () => ({ default: statusCommandMock }));
vi.mock('../../src/cli/commands/outputs.js', () => ({ default: outputsCommandMock }));
vi.mock('../../src/cli/commands/logs.js', () => ({ default: logsCommandMock }));
vi.mock('../../src/cli/commands/stop.js', () => ({ default: stopCommandMock }));
vi.mock('../../src/cli/commands/start.js', () => ({ default: startCommandMock }));
vi.mock('../../src/cli/commands/restart.js', () => ({ default: restartCommandMock }));

describe('cli index', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('registers commands and configures yargs', async () => {
    await import('../../src/cli/index.ts');

    expect(yargsMock).toHaveBeenCalledTimes(1);
    expect(hideBinMock).toHaveBeenCalled();

    expect(chain.command).toHaveBeenCalledWith(initCommandMock);
    expect(chain.command).toHaveBeenCalledWith(listCommandMock);
    expect(chain.command).toHaveBeenCalledWith(currentCommandMock);
    expect(chain.command).toHaveBeenCalledWith(useCommandMock);
    expect(chain.command).toHaveBeenCalledWith(deployCommandMock);
    expect(chain.command).toHaveBeenCalledWith(statusCommandMock);
    expect(chain.command).toHaveBeenCalledWith(connectCommandMock);
    expect(chain.command).toHaveBeenCalledWith(dashboardCommandMock);
    expect(chain.command).toHaveBeenCalledWith(outputsCommandMock);
    expect(chain.command).toHaveBeenCalledWith(logsCommandMock);
    expect(chain.command).toHaveBeenCalledWith(stopCommandMock);
    expect(chain.command).toHaveBeenCalledWith(startCommandMock);
    expect(chain.command).toHaveBeenCalledWith(restartCommandMock);
    expect(chain.command).toHaveBeenCalledWith(destroyCommandMock);

    expect(chain.demandCommand).toHaveBeenCalledWith(1, 'You must specify a command');
    expect(chain.alias).toHaveBeenCalledWith('h', 'help');
    expect(chain.alias).toHaveBeenCalledWith('v', 'version');
    expect(chain.strict).toHaveBeenCalled();
    expect(chain.parse).toHaveBeenCalled();
  });
});
