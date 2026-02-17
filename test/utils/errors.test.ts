import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('../../src/cli/utils/logger.js', async () => {
  const { createLoggerMock } = await import('../helpers/mocks/logger.js');
  return {
    logger: createLoggerMock(),
  };
});

const awsCredentialSuggestionsMock = vi.hoisted(() => vi.fn(() => ['aws creds']));
const cdkBootstrapSuggestionsMock = vi.hoisted(() => vi.fn(() => ['cdk bootstrap']));
const configNotFoundSuggestionsMock = vi.hoisted(() => vi.fn(() => ['config missing']));
const networkSuggestionsMock = vi.hoisted(() => vi.fn(() => ['network']));
const stackNotFoundSuggestionsMock = vi.hoisted(() => vi.fn(() => ['stack missing']));
const ssmSuggestionsMock = vi.hoisted(() => vi.fn(() => ['ssm']));

vi.mock('../../src/cli/utils/suggestions.js', () => ({
  awsCredentialSuggestions: awsCredentialSuggestionsMock,
  cdkBootstrapSuggestions: cdkBootstrapSuggestionsMock,
  configNotFoundSuggestions: configNotFoundSuggestionsMock,
  networkSuggestions: networkSuggestionsMock,
  stackNotFoundSuggestions: stackNotFoundSuggestionsMock,
  ssmSuggestions: ssmSuggestionsMock,
}));

import {
  CLIError,
  handleError,
  withRetry,
  isRetryableError,
  ValidationError,
  AWSError,
  ConfigError,
} from '../../src/cli/utils/errors.js';
import { logger } from '../../src/cli/utils/logger.js';

describe('errors utils', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('handleError prints CLIError suggestions and exits with code', () => {
    const err = new CLIError('boom', ['do x'], 2);
    handleError(err);
    expect(logger.error).toHaveBeenCalledWith('boom');
    expect(logSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('handleError prints suggestions based on message', () => {
    handleError(new Error('credentials not found'));
    expect(logger.error).toHaveBeenCalledWith('credentials not found');
    expect(awsCredentialSuggestionsMock).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('handleError handles unknown error types', () => {
    handleError('weird');
    expect(logger.error).toHaveBeenCalledWith('An unknown error occurred: weird');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('withRetry retries and succeeds', async () => {
    const op = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce('ok');
    const result = await withRetry(op, { maxAttempts: 2, delayMs: 1 });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('withRetry throws when maxAttempts reached', async () => {
    const op = vi.fn().mockRejectedValue(new Error('fail'));
    await expect(withRetry(op, { maxAttempts: 1, delayMs: 1 })).rejects.toThrow('fail');
  });

  it('isRetryableError identifies network issues and throttling', () => {
    expect(isRetryableError(new Error('timeout'))).toBe(true);
    const throttling = new Error('throttle');
    throttling.name = 'ThrottlingException';
    expect(isRetryableError(throttling)).toBe(true);
    expect(isRetryableError(new Error('other'))).toBe(false);
  });

  it('typed errors are instances of CLIError', () => {
    expect(new ValidationError('x')).toBeInstanceOf(CLIError);
    expect(new AWSError('x')).toBeInstanceOf(CLIError);
    expect(new ConfigError('x')).toBeInstanceOf(CLIError);
  });
});
