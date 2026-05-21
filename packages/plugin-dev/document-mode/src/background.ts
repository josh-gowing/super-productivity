/**
 * Document-Mode background script.
 * Runs once per plugin load in the host page context. Registers the
 * work-context header button; the actual editor lives in the iframe
 * (src/ui/editor.ts).
 */

import type { ActiveWorkContext, PluginAPI } from '@super-productivity/plugin-api';

declare const PluginAPI: PluginAPI;

// Whether document mode is currently embedded in the work-view. Toggled by
// the header button. State is in-memory only for the POC; restart returns
// the user to the normal task list.
let isShown = false;

PluginAPI.registerWorkContextHeaderButton({
  label: 'Document Mode',
  icon: 'description',
  showFor: ['PROJECT', 'TODAY'],
  onClick: (ctx: ActiveWorkContext) => {
    if (isShown) {
      PluginAPI.closeWorkContextView();
      isShown = false;
      PluginAPI.log.log('Document mode closed for', { id: ctx.id, type: ctx.type });
    } else {
      PluginAPI.showInWorkContext();
      isShown = true;
      PluginAPI.log.log('Document mode opened for', { id: ctx.id, type: ctx.type });
    }
  },
});
