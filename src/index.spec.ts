import { transportFailure as fromErrors } from './core/errors';
import * as sdk from './index';

describe('the public API', () => {
  it('exports transportFailure, so a transport outside the SDK classifies a broken hop as the SDK’s own do', () => {
    expect(sdk.transportFailure).toBe(fromErrors);
  });
});
