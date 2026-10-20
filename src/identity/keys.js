// Names of the browser-storage keys that mirror a person's saved preferences, shared by the preference and strategy sync.

// localStorage key -> [field in the saved record, how it is stored]
const PREF_FIELDS = {
  'albaDashboard.theme.v1': ['theme', 'raw'],
  'albaDashboard.analysisFilters.v1': ['analysis', 'json'],
  'albaDashboard.tradeView.v1': ['tradeView', 'raw'],
  'albaDashboard.business.v1': ['industry', 'json'],   // Industry screen: view, period, grouping, strategy
  'albaDashboard.uiState.v1': ['uiState', 'json'],   // last screen, Analysis selection + panels
  'albaDashboard.claudeControls.v1': ['claudeControls', 'json']   // Settings: which steps may use Claude
};
const PREFS_OWNER_KEY = 'albaDashboard.prefsOwner.v1';
const PREFS_LOCAL_AT_KEY = 'albaDashboard.prefsLocalAt.v1';  // when this browser's mirror last changed (so a not-yet-saved change is never overwritten by an older database copy)
const UISTATE_KEY = 'albaDashboard.uiState.v1';
const STRAT_KEY = 'albaDashboard.strategies.v1';
const STRAT_AT_KEY = 'albaDashboard.strategiesLocalAt.v1';

export { PREFS_LOCAL_AT_KEY, PREFS_OWNER_KEY, PREF_FIELDS, STRAT_AT_KEY, STRAT_KEY, UISTATE_KEY };
