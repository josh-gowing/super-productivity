const STORAGE_KEY = 'sp_rrule_engine_enabled';

/**
 * Local, per-device feature flag gating the experimental RFC 5545 RRULE
 * recurrence engine. OFF by default. While off, the legacy `repeatCycle` engine
 * stays authoritative for every occurrence calculation, and clients that never
 * opt in (including older / mobile clients) are unaffected.
 *
 * Stored in localStorage (NOT the synced global config) so enabling it on one
 * device never propagates a half-built engine to another — opt-in testers flip
 * it per device. It is read through a plain function rather than Angular DI
 * because the occurrence engine routes inside pure NgRx selector projectors that
 * cannot inject services.
 *
 * The read is live (no in-memory cache) so it stays trivially testable and free
 * of cross-spec module state; the occurrence guards call it only after checking
 * `cfg.rrule`, so a device with no RRULE configs never touches storage. A
 * runtime toggle takes full effect after a reload — already-memoised occurrence
 * selectors keep their cached result until their inputs next change.
 */
export const isRRuleEngineEnabled = (): boolean => {
  try {
    return (
      typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === 'true'
    );
  } catch {
    // Storage blocked (privacy mode) → safe default: legacy engine.
    return false;
  }
};

/** Persist the flag. Used by the settings toggle (RRuleFeatureFlagService). */
export const setRRuleEngineEnabled = (enabled: boolean): void => {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
    }
  } catch {
    // ignore storage failures — nothing else to fall back to
  }
};
