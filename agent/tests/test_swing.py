import json, os, sys, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import agent as A

def up(n=120, step=1.0, start=100.0): return [start + i * step for i in range(n)]

class Macd(unittest.TestCase):
    def test_too_few_bars(self): self.assertIsNone(A.macd_state(up(40))); self.assertIsNone(A.macd_state(None))
    def test_steady_uptrend_is_above_zero(self):
        s = A.macd_state(up(120, 1.0)); self.assertTrue(s['zero']); self.assertGreater(s['h'], -1e-9)
    def test_downtrend_is_down(self):
        c = [200 - i for i in range(120)]; s = A.macd_state(c); self.assertEqual(s['kind'], 'down'); self.assertFalse(s['zero'])
    def test_fresh_cross_up(self):
        c = [200 - i * 0.8 for i in range(100)] + [120 + i * 3 for i in range(6)]; s = A.macd_state(c)
        self.assertEqual(s['kind'], 'fresh_up'); self.assertEqual(s['dir'], 'up'); self.assertLessEqual(s['since'], 6)
    def test_fading_after_a_spike(self):
        c = [100.0] * 80 + [100 + 4 * i for i in range(1, 7)] + [124, 123.5, 123, 122.7]; s = A.macd_state(c)
        self.assertIn(s['kind'], ('fading', 'down')); self.assertGreaterEqual(s['hp'], s['h'])
    def test_flip_level_really_flips_the_histogram(self):
        c = [100.0] * 80 + [100 + 4 * i for i in range(1, 7)] + [124, 123.5, 123]; s = A.macd_state(c)
        h_at = lambda px: A._macd(c + [px])[1][-1]
        if s['kind'] != 'down':
            self.assertLess(s['flip'], c[-1]); self.assertAlmostEqual(h_at(s['flip']), 0, delta=0.05); self.assertGreater(h_at(s['flip'] + 1), 0)
    def test_rising_kind(self):
        c = [100.0] * 80 + [100 + 0.5 * i * i for i in range(1, 12)]; self.assertIn(A.macd_state(c)['kind'], ('rising', 'fresh_up'))

# a live row: [close, wMACD, wSig, mMACD, mSig, rsiW, rsiM, ch1w, ch1m, volume, mcap, earn]
def row(close=100, rsim=70, vol=200000): return [close, 2, 1, 2, 1, 58, rsim, 1, 5, vol, 1e4, None]
def st3(kind='fresh_up', h=1.5, since=3, zero=True): return {'kind': kind, 'h': h, 'hp': h, 'since': since, 'dir': 'up', 'flip': 90, 'zero': zero, 'last': 100}
GOOD = [2.0, 1.0, 3.0, 1.0]      # 2-hour MACD, signal, 4-hour MACD, signal: both above their signal line and above zero
QUAL = ['A', 'G', 200, 5.0, None, None, 1.0]   # name, group, intrinsic value, score, verdict, profit growth, FII %: qualifies Positive MoS at a price of 100 (the live row adds volume and market cap)
def ideas(live, m3h=None, prox=None, wl=None, **kw): return A.swing_ideas(live, {**{k: QUAL for k in live}, **(wl or {})}, m3h, prox, **kw)

class Rules(unittest.TestCase):
    def test_rule_1_monthly_rsi_band_edges(self):
        for rsim, inside in ((65.9, 0), (66, 1), (76, 1), (76.1, 0)): self.assertEqual(ideas({'A': row(rsim=rsim)})['pool'], inside, rsim)
    def test_rule_2_needs_the_3h_macd_above_its_signal_and_above_zero(self):
        self.assertTrue(A.qualifies(st3())); self.assertFalse(A.qualifies(st3(h=0))); self.assertFalse(A.qualifies(st3(h=-1))); self.assertFalse(A.qualifies(st3(zero=False))); self.assertFalse(A.qualifies(None))
    def test_the_first_pass_needs_both_the_2h_and_4h_macd_above_signal_and_zero(self):
        self.assertTrue(A.prox_ok(GOOD))
        for bad in ([1.0, 2.0, 3.0, 1.0], [2.0, 1.0, 1.0, 3.0], [-1.0, -2.0, 3.0, 1.0], [2.0, 1.0, -1.0, -2.0], [2.0], None, 'x'): self.assertFalse(A.prox_ok(bad), bad)
    def test_without_the_first_pass_the_pool_is_listed_for_the_daily_run(self):
        r = ideas({'A': row(), 'B': row(rsim=50)}, sym={'A': 'NSE:AAA'}); self.assertEqual(r['needProx'], [{'k': 'A', 'y': 'NSE:AAA'}]); self.assertEqual((r['ideas'], r['shortlisted'], r['need3h']), ([], 0, []))
    def test_the_shortlist_is_the_freshest_first_and_capped(self):
        live = {'S%d' % i: row() for i in range(15)}; prox = {k: [2.0, 1.0, 3.0 + i * 0.5, 1.0] for i, k in enumerate(live)}
        pool = A.swing_pool(live, {}); short = A.shortlist(pool, prox)
        self.assertEqual(len(short), A.MAX_3H); self.assertEqual([p['k'] for p in short][:3], ['S0', 'S1', 'S2'])
        self.assertEqual(A.shortlist(pool, {'S0': [1.0, 2.0, 3.0, 1.0]}), [])
    def test_a_shortlisted_stock_without_a_3h_check_is_listed_for_the_daily_run_and_is_not_an_idea(self):
        r = ideas({'A': row()}, prox={'A': GOOD}, sym={'A': 'NSE:AAA'}); self.assertEqual(r['need3h'], [{'k': 'A', 'y': 'NSE:AAA'}]); self.assertEqual((r['ideas'], r['shortlisted'], r['checked']), ([], 1, 0))
    def test_only_stocks_that_meet_both_rules_are_ideas(self):
        live = {'A': row(), 'B': row(), 'C': row(), 'D': row(rsim=50)}; prox = {k: GOOD for k in live}
        m3h = {'A': st3(), 'B': st3(h=-0.5), 'C': st3(zero=False), 'D': st3()}; r = ideas(live, m3h, prox)
        self.assertEqual([i['k'] for i in r['ideas']], ['A']); self.assertEqual((r['pool'], r['shortlisted'], r['checked']), (3, 3, 3)); self.assertEqual(r['need3h'], [])
    def test_the_stock_that_crossed_up_most_recently_comes_first(self):
        live = {'A': row(), 'B': row(), 'C': row()}; prox = {k: GOOD for k in live}
        r = ideas(live, {'A': st3(since=9), 'B': st3(since=2), 'C': st3(since=None)}, prox); self.assertEqual([i['k'] for i in r['ideas']], ['B', 'A', 'C'])
    def test_nothing_else_selects_a_stock(self):
        wl = {'A': ['Aaa', 'G', 90, 3.0, 'avoid', 6354, 1.0]}; r = ideas({'A': row()}, {'A': st3()}, {'A': GOOD}, wl)
        i = r['ideas'][0]; self.assertEqual(i['k'], 'A'); w = ' | '.join(i['warn'])
        self.assertIn('Avoid verdict', w); self.assertIn('negative margin of safety', w); self.assertIn('Earnings spike: trailing profit growth 6,354%', w)
    def test_a_stock_without_a_verdict_has_no_reference_line(self):
        i = ideas({'A': row()}, {'A': st3()}, {'A': GOOD})['ideas'][0]; self.assertEqual(i['n'], 'A'); self.assertIsNone(i['ref']['vd']); self.assertFalse(any('For reference' in w for w in i['why']))
    def test_the_card_lists_both_rules_and_the_dashboard_view_for_reference_only(self):
        i = ideas({'A': row()}, {'A': st3()}, {'A': GOOD}, {'A': ['Aaa', 'G', 200, 8.0, 'buy', 40, 1.0]})['ideas'][0]
        self.assertEqual(i['why'][0], 'Monthly RSI 70, inside 66-76'); self.assertIn('3-hour MACD above its signal line and above zero (crossed up 3 bars ago', i['why'][1])
        one = ideas({'A': row()}, {'A': st3(since=1)}, {'A': GOOD})['ideas'][0]; self.assertIn('crossed up 1 bar ago', one['why'][1]); never = ideas({'A': row()}, {'A': st3(since=None)}, {'A': GOOD})['ideas'][0]; self.assertIn('crossed up a while ago', never['why'][1]); self.assertIn('For reference: dashboard verdict buy (score 8.0), margin of safety 50%', i['why'][2])
        self.assertEqual((i['action'], i['ref']['mos']), ('Buy zone', 50)); self.assertEqual(i['warn'], ['Stop is an estimate (8%): no volatility data'])
    def test_at_most_eight_ideas(self):
        live = {'S%d' % i: row() for i in range(11)}; r = ideas(live, {k: st3(since=i) for i, k in enumerate(live)}, {k: GOOD for k in live}); self.assertEqual(len(r['ideas']), 8)

class PositiveMos(unittest.TestCase):
    def info(self, **ch):
        i = dict(zip(('n', 'g', 'iv', 'score', 'vd', 'pg', 'fii'), QUAL)); i.update(ch); return list(i.values())
    def test_a_stock_that_meets_every_rule_qualifies(self): self.assertTrue(A.positive_mos(self.info(), row()))
    def test_each_rule_has_an_edge(self):
        for ch, r, ok in ((dict(score=2), row(), 1), (dict(score=1.9), row(), 0), (dict(iv=80), row(), 1), (dict(iv=80), row(107), 0), (dict(fii=0.1), row(), 1), (dict(fii=0.09), row(), 0),
                          ({}, row(vol=20000), 1), ({}, row(vol=19999), 0)):
            self.assertEqual(A.positive_mos(self.info(**ch), r), bool(ok), (ch, r))
    def test_an_unknown_market_cap_fails(self):
        r = row(); r[10] = None; self.assertFalse(A.positive_mos(self.info(), r)); r[10] = 0; self.assertFalse(A.positive_mos(self.info(), r))
    def test_a_missing_or_malformed_field_fails(self):
        for k in ('iv', 'score', 'fii'): self.assertFalse(A.positive_mos(self.info(**{k: None}), row()), k); self.assertFalse(A.positive_mos(self.info(**{k: 'x'}), row()), k)
        r = row(); r[9] = None; self.assertFalse(A.positive_mos(self.info(), r))
        self.assertFalse(A.positive_mos(self.info(iv=True), row())); self.assertFalse(A.positive_mos(self.info(iv=0), row())); self.assertFalse(A.positive_mos(None, row())); self.assertFalse(A.positive_mos(['n', 'g', 200, 5], row()))
    def test_only_strategy_stocks_enter_the_pool(self):
        live = {'A': row(), 'B': row(), 'C': row()}; r = A.swing_ideas(live, {'A': QUAL, 'B': QUAL[:2] + [200, 1.0] + QUAL[4:]}, None, None)
        self.assertEqual((r['pool'], [p['k'] for p in r['needProx']]), (1, ['A']))

class Levels(unittest.TestCase):
    def setUp(self): self._v = A.MOS_MIN_VOL; A.MOS_MIN_VOL = 0   # the strategy's volume floor would hide the liquidity cap being tested
    def tearDown(self): A.MOS_MIN_VOL = self._v
    def one(self, rsim=70, vol=200000, atr=None, held=()):
        return ideas({'A': row(rsim=rsim, vol=vol)}, {'A': st3()}, {'A': GOOD}, comp={'A': {'atr': atr}} if atr else None, held=held)['ideas'][0]
    def test_levels_follow_the_volatility_stop(self):
        i = self.one(atr=5.0); self.assertEqual(i['stopPct'], 4.5); self.assertAlmostEqual(i['stop'], 95.5); self.assertAlmostEqual(i['t1'], 110); self.assertAlmostEqual(i['t2'], 120); self.assertEqual(i['entry'], [100.0, 101.0]); self.assertAlmostEqual(i['rr'], 4.4, places=1)
        self.assertEqual(self.one(atr=20.0)['stopPct'], 9.0); self.assertEqual(self.one()['stopPct'], 8.0)
    def test_sizing_follows_the_monthly_rsi_tier_for_both_capitals(self):
        md = self.one(rsim=66, atr=20.0); hi = self.one(rsim=75, atr=20.0)
        self.assertEqual((md['tier'], hi['tier'], md['risk'], hi['risk']), ('medium', 'high', 0.0075, 0.005))
        self.assertEqual(md['qty']['1000000'], int(1e6 * 0.0075 / (100 - md['stop']))); self.assertEqual(hi['qty']['500000'], int(5e5 * 0.005 / (100 - hi['stop'])))
        self.assertGreater(md['qty']['1000000'], md['qty']['500000']); self.assertGreater(md['qty']['1000000'], hi['qty']['1000000'])
    def test_a_liquid_stock_is_not_capped_and_a_thin_one_is_limited_to_ten_percent_of_daily_volume(self):
        liquid = self.one(vol=10_000_000); self.assertFalse(liquid['liqLimited']); self.assertFalse(any('Size limited' in w for w in liquid['warn']))
        thin = self.one(vol=2000); self.assertTrue(thin['liqLimited'] and thin['thin']); self.assertEqual(thin['qty'], {'500000': 200, '1000000': 200})
        self.assertTrue(any('Size limited to 200 shares' in w and 'about Rs 20,000' in w for w in thin['warn'])); self.assertTrue(any('Thinly traded' in w for w in thin['warn']))
    def test_only_the_larger_capital_is_limited_when_that_is_all_that_binds(self):
        free = self.one(vol=10_000_000)['qty']; v = int((free['500000'] + free['1000000']) / 2 / A.LIQ_PART); i = self.one(vol=v)
        self.assertEqual(i['qty']['500000'], free['500000']); self.assertEqual(i['qty']['1000000'], int(v * A.LIQ_PART)); self.assertTrue(i['liqLimited'])
    def test_unknown_volume_leaves_the_size_alone(self):
        c = [100, 2, 1, 2, 1, 58, 70, 1, 5, None, 1e4, None]; i = A.swing_card({'k': 'A', 'y': None, 'close': 100, 'mrsi': 70}, st3(), c, QUAL, set()); self.assertFalse(i['liqLimited']); self.assertGreater(i['qty']['500000'], 0)
    def test_a_held_stock_is_noted(self): self.assertTrue(any('already held' in w.lower() for w in self.one(held={'A'})['warn']))

class Files(unittest.TestCase):
    def mk(self, with_watch=True):
        w = tempfile.mkdtemp(); os.makedirs(w + '/agent'); os.makedirs(w + '/liveSnapshot'); os.makedirs(w + '/stockData')
        json.dump({'stocks': [{'ticker': 'AAA ·x', 'name': 'Aaa Ltd', 'industryGroup': 'G', 'score': 7, 'verdict': 'buy', 'liquidity': {'marketCap': 50000, 'avgVolume': 300000}, 'valuation': {'intrinsicValue': 200, 'profitGrowth': 6353.55, 'fiiHolding': 1.0}}, {'ticker': 'NOIV', 'valuation': {}}]}, open(w + '/stockData/c001.json', 'w'))
        json.dump({'asof': A.today(), 'rows': [{'k': 'AAA', 'y': 'NSE:AAA', 'c': row()}]}, open(w + '/liveSnapshot/c001.json', 'w'))
        if with_watch: A.build_watch(w, w)
        return w
    def test_build_watch_keeps_only_stocks_with_an_intrinsic_value_and_the_rounded_profit_growth(self):
        w = self.mk(); d = A.J(w + '/agent/watch.json')['w']; self.assertEqual(list(d), ['AAA']); self.assertEqual(d['AAA'], ['Aaa Ltd', 'G', 200, 7, 'buy', 6354, 1.0])
        json.dump({'stocks': [{'ticker': 'B', 'valuation': {'intrinsicValue': 50}}]}, open(w + '/stockData/c001.json', 'w')); A.build_watch(w, w); self.assertIsNone(A.J(w + '/agent/watch.json')['w']['B'][5])
    def test_swing_run_lists_the_pool_for_the_first_pass(self):
        w = self.mk(); o = A.swing_run(w); self.assertEqual(A.J(w + '/agent/swing.json')['pool'], 1); self.assertEqual(o['needProx'], [{'k': 'AAA', 'y': 'NSE:AAA'}]); self.assertIsNone(o['proxAsof'])
    def test_swing_run_without_a_live_snapshot_does_nothing(self):
        w = tempfile.mkdtemp(); os.makedirs(w + '/agent'); self.assertIsNone(A.swing_run(w)); self.assertFalse(os.path.exists(w + '/agent/swing.json'))
    def test_the_whole_chain_prox_then_3h(self):
        w = self.mk()
        json.dump({'AAA': [2.0, 1.0, 3.0, 1.0], 'BAD': 'x', 'BAD2': [1], 'BAD3': ['a', 'b', 'c', 'd']}, open(w + '/agent/macdprox.json', 'w'))
        o = A.prox_run(w); self.assertEqual(A.J(w + '/agent/prox.json')['s'], {'AAA': [2.0, 1.0, 3.0, 1.0]}); self.assertEqual((o['shortlisted'], o['need3h'], o['proxAsof']), (1, [{'k': 'AAA', 'y': 'NSE:AAA'}], A.today())); self.assertEqual(o['needProx'], [])
        json.dump({'AAA': [100.0] * 80 + [100 + 4 * i for i in range(1, 8)], 'SHORT': [1, 2, 3]}, open(w + '/agent/bars3h.json', 'w'))
        o = A.m3h_run(w); self.assertEqual([i['k'] for i in o['ideas']], ['AAA']); self.assertEqual((o['checked'], o['need3h'], o['m3hAsof']), (1, [], A.today())); self.assertIn(o['ideas'][0]['m3h']['kind'], ('fresh_up', 'rising')); self.assertTrue(o['ideas'][0]['m3h']['zero'])
    def test_stale_first_pass_and_3h_states_are_ignored(self):
        w = self.mk(); old = {'d': '2000-01-01', 's': {'AAA': GOOD}}
        json.dump(old, open(w + '/agent/prox.json', 'w')); json.dump({'d': '2000-01-01', 's': {'AAA': st3()}}, open(w + '/agent/m3h.json', 'w'))
        o = A.swing_run(w); self.assertEqual((o['shortlisted'], o['ideas'], o['proxAsof'], o['m3hAsof']), (0, [], None, None)); self.assertEqual(len(o['needProx']), 1)

if __name__ == '__main__': unittest.main()
