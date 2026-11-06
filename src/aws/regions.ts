/** Syntax only; service metadata still establishes actual regional availability. */
export const validAwsRegion = (value: string) => /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(value);
