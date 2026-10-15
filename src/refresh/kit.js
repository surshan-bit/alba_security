// Refresh kit (v1.121): one place for everything about refreshing Fundamental and Technical info from a list of stocks.
// Split in v1.193 into parts that each do one job:
//   kit-lookup.js   finding stocks by key; the registries of scopes, toolbars and selections
//   kit-menu.js     the floating menu (placing, closing, focus)
//   kit-queue.js    the saved queue of jobs, the runner that feeds the Live Data Refresh engine (ldBatchStart), the notices in the
//                   bell, and the sync with other devices; a refresh carries on from where it stopped when the dashboard is opened again
//                   (it still needs an open dashboard to run: TradingView and Claude are reached through the page)
//   kit-controls.js the buttons, menus, row ticks, selection bar and their keyboard and click handling
// This file is what the rest of the app imports: the `kit` object the screens call, and `init` for the start-up sequence.
import { dots } from './freshness.js';
import { defineScope, defineToolbar, useExternalSelection } from './kit-lookup.js';
import { activity, batchNotice, enqueueOne, initQueue } from './kit-queue.js';
import { barHtml, choiceBtn, defineChoices, headCell, installControls, repaint, rowBtn, rowCell, selbarSlot, selectionChanged, stockBtn, toolbarButton } from './kit-controls.js';

export async function init() {
  installControls();
  await initQueue();
}

export const kit = { choiceBtn, defineChoices, stockBtn, dots, barHtml, headCell, rowCell, rowBtn, selbarSlot, toolbarButton, defineScope, defineToolbar, useExternalSelection, selectionChanged, repaint, activity, batchNotice, enqueueOne };
