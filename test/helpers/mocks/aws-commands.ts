export function createAwsCommandClass<TInput = Record<string, unknown>>() {
  return class {
    input: TInput;

    constructor(input: TInput) {
      this.input = input;
    }
  };
}
