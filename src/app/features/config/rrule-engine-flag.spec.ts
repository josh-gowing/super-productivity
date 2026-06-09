import { isRRuleEngineEnabled, setRRuleEngineEnabled } from './rrule-engine-flag';

const STORAGE_KEY = 'sp_rrule_engine_enabled';

describe('rrule-engine-flag', () => {
  afterEach(() => {
    // Reset so the flag never leaks into other specs in the shared Karma run.
    localStorage.removeItem(STORAGE_KEY);
  });

  it('defaults to false when unset', () => {
    localStorage.removeItem(STORAGE_KEY);
    expect(isRRuleEngineEnabled()).toBe(false);
  });

  it('round-trips through localStorage', () => {
    setRRuleEngineEnabled(true);
    expect(isRRuleEngineEnabled()).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');

    setRRuleEngineEnabled(false);
    expect(isRRuleEngineEnabled()).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false');
  });

  it('treats any non-"true" stored value as off', () => {
    localStorage.setItem(STORAGE_KEY, 'yes');
    expect(isRRuleEngineEnabled()).toBe(false);
    localStorage.setItem(STORAGE_KEY, '1');
    expect(isRRuleEngineEnabled()).toBe(false);
  });
});
