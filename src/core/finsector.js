// Which kind of financial company a stock is (bank, lender such as an NBFC or housing-finance firm, insurer), from its industry labels.
// Debt, liquidity, distress-model and debtor figures are built for companies that sell goods and services. For a bank or insurer they
// do not describe financial health at all, and for a lender only the debt and interest-cover figures do. Pure helpers, no imports,
// shared by the Fundamental Score engine, the metric dots and the research prompts.
const BANK = /\bbanks?\b/i;
const INSURER = /insurance|insurer/i;
const LENDER = /non[\s-]*banking|nbfc|housing finance|micro[\s-]*finance|gold loan/i;

/** 'bank' | 'insurer' | 'lender' | null. `s` needs any of industryGroup, exactIndustry (the dashboard's label) and industry (the CSV label). */
function financialKind(s){
  if(!s) return null;
  const label = String(s.exactIndustry || s.industry || '');
  const group = String(s.industryGroup || '');
  if(INSURER.test(label) || INSURER.test(group)) return 'insurer';
  if(LENDER.test(label)) return 'lender';
  if(BANK.test(label) || /^banks?$/i.test(group.trim())) return 'bank';
  return null;
}
// Financial Health metrics that carry no meaning for each kind (CSV field names used by the engine).
const FIN_NOT_APPLICABLE = {
  bank: ['de', 'interestCoverage', 'quickRatio', 'altmanZ', 'currentRatio', 'avgDebtorDays3'],
  insurer: ['de', 'interestCoverage', 'quickRatio', 'altmanZ', 'currentRatio', 'avgDebtorDays3'],
  lender: ['quickRatio', 'altmanZ', 'currentRatio', 'avgDebtorDays3'],
};
const KIND_WORD = { bank: 'banks', insurer: 'insurers', lender: 'lenders' };
/** True when the whole Financial Health factor is left out for this kind (nothing in it applies). */
const finFactorNotApplicable = kind => !!kind && kind !== 'lender';
/** One line for the research prompts, so Claude does not write about figures that do not apply. */
function sectorPromptNote(kind){
  if(kind === 'bank') return 'SECTOR NOTE: this is a bank. Debt, interest cover, liquidity ratios, Altman Z and debtor days do not apply to a bank and are not scored. Do not write about them.\n';
  if(kind === 'insurer') return 'SECTOR NOTE: this is an insurer. Debt, interest cover, liquidity ratios, Altman Z and debtor days do not apply to an insurer and are not scored. Do not write about them.\n';
  if(kind === 'lender') return 'SECTOR NOTE: this is a lender. High debt is normal for a lender and only matters against other lenders. Liquidity ratios, Altman Z and debtor days do not apply and are not scored. Do not write about them.\n';
  return '';
}
export { financialKind, FIN_NOT_APPLICABLE, KIND_WORD, finFactorNotApplicable, sectorPromptNote };
