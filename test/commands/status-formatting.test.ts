import { describe, it, expect } from 'vitest';
import {
  formatStackStatus,
  formatInstanceStatus,
  formatSSMStatus,
  formatGatewayStatus,
} from '../../src/cli/commands/status.js';

describe('status formatting', () => {
  it('formats stack statuses with icons', () => {
    expect(formatStackStatus('CREATE_COMPLETE')).toContain('✓');
    expect(formatStackStatus('CREATE_FAILED')).toContain('✗');
    expect(formatStackStatus('CREATE_IN_PROGRESS')).toContain('⚙');
  });

  it('formats instance statuses with icons', () => {
    expect(formatInstanceStatus('running')).toContain('✓');
    expect(formatInstanceStatus('stopped')).toContain('○');
    expect(formatInstanceStatus('terminated')).toContain('✗');
  });

  it('formats SSM status', () => {
    expect(formatSSMStatus('ready')).toContain('✓');
    expect(formatSSMStatus('not-ready')).toContain('⚠');
  });

  it('formats gateway status', () => {
    expect(formatGatewayStatus(true)).toContain('✓');
    expect(formatGatewayStatus(false)).toContain('✗');
  });
});
