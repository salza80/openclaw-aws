import chalk from 'chalk';
import { logger } from './logger.js';

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
    suggestions.push('Run: aws configure');
    suggestions.push('Check your AWS credentials are valid');
    suggestions.push('Verify IAM permissions for CloudFormation, EC2, and SSM');
  }
  
  // CDK Bootstrap
  if (message.includes('bootstrap') || message.includes('cdk toolkit')) {
    suggestions.push('Run: cdk bootstrap aws://ACCOUNT-ID/REGION');
    suggestions.push('Check: https://docs.aws.amazon.com/cdk/latest/guide/bootstrapping.html');
  }
  
  // Stack not found
  if (message.includes('stack') && message.includes('not found')) {
    suggestions.push('Run: openclaw-aws deploy (to create the stack)');
    suggestions.push('Check: openclaw-aws status (to see current state)');
  }
  
  // Config file
  if (message.includes('config') && message.includes('not found')) {
    suggestions.push('Run: openclaw-aws init (to create configuration)');
  }
  
  // SSM Session Manager
  if (message.includes('ssm') || message.includes('session')) {
    suggestions.push('Install SSM plugin: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html');
    suggestions.push('Wait a few minutes for instance to be ready');
    suggestions.push('Check: openclaw-aws status');
  }
  
  // Network/timeout
  if (message.includes('timeout') || message.includes('network')) {
    suggestions.push('Check your internet connection');
    suggestions.push('Verify AWS region is accessible');
    suggestions.push('Try again in a few moments');
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
    shouldRetry = () => true,
    operationName = 'operation'
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
