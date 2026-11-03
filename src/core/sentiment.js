// The sentiment tag (pos / neg / neu) on a saved news event. It is written by Claude from news text and read back from
// the database, so it is untrusted: only these three values may ever reach a class name or other markup.
const SENTIMENTS = ['pos', 'neg', 'neu'];

/** @param {unknown} value @returns {string} the value when it is a known sentiment, otherwise '' */
function cleanSentiment(value){
  return SENTIMENTS.includes(/** @type {string} */ (value)) ? /** @type {string} */ (value) : '';
}

export { cleanSentiment };
