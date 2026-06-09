import { Injectable, computed, signal } from '@angular/core';
import { RRuleEngineConfig } from './global-config.model';
import { isRRuleEngineEnabled, setRRuleEngineEnabled } from './rrule-engine-flag';

/**
 * Settings-layer wrapper for the local, per-device RRULE engine flag. Mirrors
 * TaskWidgetSettingsService: the value lives in localStorage (see
 * rrule-engine-flag), NOT in the synced global config, so the config page reads
 * and writes it through this service instead of the config store — keeping it
 * off the sync wire so older clients never receive it.
 */
@Injectable({ providedIn: 'root' })
export class RRuleFeatureFlagService {
  private readonly _settings = signal<Required<RRuleEngineConfig>>({
    isEnabled: isRRuleEngineEnabled(),
  });
  readonly settings = this._settings.asReadonly();
  readonly isEnabled = computed(() => this._settings().isEnabled);

  update(partial: Partial<RRuleEngineConfig>): void {
    const isEnabled = partial.isEnabled ?? this._settings().isEnabled;
    setRRuleEngineEnabled(isEnabled);
    this._settings.set({ isEnabled });
  }
}
