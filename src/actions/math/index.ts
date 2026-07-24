export {
  ADDITION_TYPE,
  addition,
  DIVISION_TYPE,
  division,
  GENERATE_RANDOM_TYPE,
  generateRandom,
  type MathResult,
  MODULO_TYPE,
  modulo,
  MULTIPLICATION_TYPE,
  multiplication,
  SUBTRACTION_TYPE,
  subtraction,
} from './math';

import { addition, division, generateRandom, modulo, multiplication, subtraction } from './math';

/** Every Math action, for catalog builds and registration. */
export const mathActions = [addition, subtraction, multiplication, division, modulo, generateRandom] as const;
