import chalk from 'chalk';
import { logger } from './logger.js';
import {
  awsCredentialSuggestions,
  cdkBootstrapSuggestions,
  configNotFoundSuggestions,
  networkSuggestions,
  stackNotFoundSuggestions,
  ssmSuggestions
} from './suggestions.js';

export class CLIError extends Error {
  constructor(
    message: string,
    public readonly suggestions: string[] = [],
    public readonly exitCode: number = 1
  ) {
    super(message);
    this.name = 'CLIError';
  }
}

export function handleError(error: unknown): never {
  if (error instanceof CLIError) {
    logger.error(error.message);
    
    if (error.suggestions.length > 0) {
      console.log('\n' + chalk.bold('Suggestions:'));
      error.suggestions.forEach(suggestion => {
        console.log('  ' + chalk.cyan('→') + ' ' + suggestion);
      });
    }
    
    process.exit(error.exitCode);
  }
  
  if (error instanceof Error) {
    logger.error(error.message);
    
    // Provide suggestions based on error type
    const suggestions = getErrorSuggestions(error);
    if (suggestions.length > 0) {
      console.log('\n' + chalk.bold('Suggestions:'));
      suggestions.forEach(suggestion => {
        console.log('  ' + chalk.cyan('→') + ' ' + suggestion);
      });
    }
    
    process.exit(1);
  }
  
  logger.error('An unknown error occurred: ' + String(error));
  process.exit(1);
}

function getErrorSuggestions(error: Error): string[] {
  const message = error.message.toLowerCase();
  const suggestions: string[] = [];
  
  // AWS Credentials
  if (message.includes('credentials') || message.includes('access denied')) {
    suggestions.push(...awsCredentialSuggestions());
  }
  
  // CDK Bootstrap
  if (message.includes('bootstrap') || message.includes('cdk toolkit')) {
    suggestions.push(...cdkBootstrapSuggestions());
  }
  
  // Stack not found
  if (message.includes('stack') && message.includes('not found')) {
    suggestions.push(...stackNotFoundSuggestions());
  }
  
  // Config file
  if (message.includes('config') && message.includes('not found')) {
    suggestions.push(...configNotFoundSuggestions());
  }
  
  // SSM Session Manager
  if (message.includes('ssm') || message.includes('session')) {
    suggestions.push(...ssmSuggestions());
  }
  
  // Network/timeout
  if (message.includes('timeout') || message.includes('network')) {
    suggestions.push(...networkSuggestions());
  }
  
  return suggestions;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;
    delayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
    operationName?: string;
  } = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    delayMs = 1000,
    shouldRetry = () => true
  } = options;
  
  let lastError: unknown;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      
      // Don't retry if we shouldn't or if this was the last attempt
      if (!shouldRetry(error) || attempt === maxAttempts) {
        throw error;
      }
      
      // Wait before retrying (exponential backoff)
      const delay = delayMs * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  
  const message = error.message.toLowerCase();
  
  // Network/timeout errors are retryable
  if (
    message.includes('timeout') ||
    message.includes('network') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('throttl')
  ) {
    return true;
  }
  
  // AWS SDK errors
  if (error.name === 'ThrottlingException' || error.name === 'TooManyRequestsException') {
    return true;
  }
  
  return false;
}

export class ValidationError extends CLIError {
  constructor(message: string, suggestions: string[] = []) {
    super(message, suggestions, 1);
    this.name = 'ValidationError';
  }
}

export class AWSError extends CLIError {
  constructor(message: string, suggestions: string[] = []) {
    super(message, suggestions, 1);
    this.name = 'AWSError';
  }
}

export class ConfigError extends CLIError {
  constructor(message: string, suggestions: string[] = []) {
    super(message, suggestions, 1);
    this.name = 'ConfigError';
  }
}
