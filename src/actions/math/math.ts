import { randomInt } from 'node:crypto';

import { defineAction } from '../../core/action';
import { ActionError } from '../../core/errors';
import { number } from '../../core/props';

/** Math utilities — pure no-auth actions; type ids are snake_case `<op>_math` (the namespace rejects camel-case). */

/** The single-value result every arithmetic op returns. */
export interface MathResult {
  result: number;
}

const first = number({ label: 'First number', required: true });
const second = number({ label: 'Second number', required: true });

export const ADDITION_TYPE = 'math.addition_math';
export const addition = defineAction({
  type: ADDITION_TYPE,
  name: 'Addition',
  description: 'Add the second number to the first.',
  auth: { type: 'none' },
  props: { first_number: first, second_number: second },
  run: ({ props }): Promise<MathResult> =>
    Promise.resolve({ result: props.first_number + props.second_number }),
});

export const SUBTRACTION_TYPE = 'math.subtraction_math';
export const subtraction = defineAction({
  type: SUBTRACTION_TYPE,
  name: 'Subtraction',
  description: 'Subtract the second number from the first.',
  auth: { type: 'none' },
  props: { first_number: first, second_number: second },
  run: ({ props }): Promise<MathResult> =>
    Promise.resolve({ result: props.first_number - props.second_number }),
});

export const MULTIPLICATION_TYPE = 'math.multiplication_math';
export const multiplication = defineAction({
  type: MULTIPLICATION_TYPE,
  name: 'Multiplication',
  description: 'Multiply the two numbers.',
  auth: { type: 'none' },
  props: { first_number: first, second_number: second },
  run: ({ props }): Promise<MathResult> =>
    Promise.resolve({ result: props.first_number * props.second_number }),
});

export const DIVISION_TYPE = 'math.division_math';
export const division = defineAction({
  type: DIVISION_TYPE,
  name: 'Division',
  description: 'Divide the first number by the second.',
  auth: { type: 'none' },
  props: { first_number: first, second_number: second },
  run: ({ props }): Promise<MathResult> => {
    if (props.second_number === 0) {
      throw new ActionError({ code: 'invalid_input', message: 'cannot divide by zero', retryable: false });
    }
    return Promise.resolve({ result: props.first_number / props.second_number });
  },
});

export const MODULO_TYPE = 'math.modulo_math';
export const modulo = defineAction({
  type: MODULO_TYPE,
  name: 'Modulo',
  description: 'The remainder of dividing the first number by the second.',
  auth: { type: 'none' },
  props: { first_number: first, second_number: second },
  run: ({ props }): Promise<MathResult> => {
    if (props.second_number === 0) {
      throw new ActionError({
        code: 'invalid_input',
        message: 'cannot take modulo by zero',
        retryable: false,
      });
    }
    return Promise.resolve({ result: props.first_number % props.second_number });
  },
});

export const GENERATE_RANDOM_TYPE = 'math.generate_random_math';
export const generateRandom = defineAction({
  type: GENERATE_RANDOM_TYPE,
  name: 'Generate Random Number',
  description: 'Generate a random integer between the min and max (inclusive).',
  auth: { type: 'none' },
  props: {
    min: number({ label: 'Min', required: true, defaultValue: 0 }),
    max: number({ label: 'Max', required: true, defaultValue: 100 }),
  },
  run: ({ props }): Promise<MathResult> => {
    const lo = Math.ceil(props.min);
    const hi = Math.floor(props.max);
    if (lo > hi) {
      throw new ActionError({ code: 'invalid_input', message: 'min must be <= max', retryable: false });
    }
    // randomInt's upper bound is exclusive; +1 makes the range inclusive.
    return Promise.resolve({ result: randomInt(lo, hi + 1) });
  },
});
