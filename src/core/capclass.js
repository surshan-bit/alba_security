// Size classes by market cap in ₹ crore, following the SEBI / AMFI rule (Large = the 100 biggest companies, Mid = the next 150, Small = the rest).
// AMFI republishes the cut-offs every six months; these are the October 2026 values and are the only place to change.
const MCAP_LARGE_CR = 104000, MCAP_MID_CR = 36000;
const capClass = (cr) => (typeof cr !== 'number' || !isFinite(cr) ? null : cr >= MCAP_LARGE_CR ? 'large' : cr >= MCAP_MID_CR ? 'mid' : 'small');
const CAP_NAME = { large: 'Large cap', mid: 'Mid cap', small: 'Small cap' };
export { CAP_NAME, MCAP_LARGE_CR, MCAP_MID_CR, capClass };
