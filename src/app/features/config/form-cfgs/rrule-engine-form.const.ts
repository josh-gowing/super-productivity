import {
  ConfigFormSection,
  LimitedFormlyFieldConfig,
  RRuleEngineConfig,
} from '../global-config.model';
import { T } from '../../../t.const';

/**
 * Local, per-device toggle for the experimental RRULE recurrence engine. Like
 * TASK_WIDGET_FORM_CFG, the value is NOT part of GlobalConfigState — the config
 * page routes it to RRuleFeatureFlagService (localStorage), so it never syncs.
 */
export const RRULE_ENGINE_FORM_CFG: ConfigFormSection<RRuleEngineConfig> = {
  title: T.GCF.RRULE_ENGINE.TITLE,
  key: 'rruleEngine',
  help: T.GCF.RRULE_ENGINE.HELP,
  items: [
    {
      key: 'isEnabled',
      type: 'checkbox',
      templateOptions: {
        label: T.GCF.RRULE_ENGINE.IS_ENABLED,
      },
    },
  ] as LimitedFormlyFieldConfig<RRuleEngineConfig>[],
};
