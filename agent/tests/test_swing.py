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
def row(close=100, rsiw=58, rsim=70, ch1m=5, vol=200000): return [close, 2, 1, 2, 1, rsiw, rsim, 1, ch1m, vol, 1e4, None]
def wl(**kw): d = {'A': ['Aaa', 'G', 200, 8.0, 'buy']}; d.update(kw); return d
def comp(k='A', atr=5.0, hi=110, ma10=95, ma10p=94): return {k: {'n': k, 'g': 'G', 'sc': 8, 'vd': 'buy', 'iv': 200, 'atr': atr, 'hi': hi, 'ma10': ma10, 'ma10p': ma10p}}

class Ideas(unittest.TestCase):
    def test_in_band_with_positive_mos_is_listed(self):
        r = A.swing_ideas({'A': row()}, comp(), wl()); i = r['ideas'][0]
        self.assertEqual(r['pool'], 1); self.assertEqual(i['k'], 'A'); self.assertEqual(i['mos'], 50); self.assertEqual(i['tier'], 'medium')
    def test_monthly_rsi_band_edges(self):
        for rsim, listed in ((65.9, 0), (66, 1), (76, 1), (76.1, 0)): self.assertEqual(len(A.swing_ideas({'A': row(rsim=rsim)}, comp(), wl())['ideas']), listed, rsim)
    def test_needs_positive_margin_of_safety(self):
        self.assertEqual(A.swing_ideas({'A': row(close=200)}, comp(), wl())['ideas'], []); self.assertEqual(A.swing_ideas({'A': row(close=250)}, comp(), wl())['ideas'], [])
    def test_avoid_verdict_is_skipped_with_a_reason(self):
        r = A.swing_ideas({'A': row()}, comp(), wl(A=['Aaa', 'G', 200, 8, 'avoid'])); self.assertEqual(r['ideas'], []); self.assertEqual(r['skipped'][0]['why'], 'Avoid verdict')
    def test_rocky_filters_apply_inside_the_universe(self):
        r = A.swing_ideas({'A': row()}, comp(ma10=105, ma10p=104), wl()); self.assertEqual(r['ideas'], []); self.assertIn('Below the 10-week average', r['skipped'][0]['why'])
    def test_outside_the_universe_is_kept_with_a_warning(self):
        i = A.swing_ideas({'A': row()}, {}, wl())['ideas'][0]; self.assertFalse(i['inU']); self.assertTrue(any('not applied' in w for w in i['warn'])); self.assertTrue(any('estimate' in w for w in i['warn']))
    def test_thin_trading_is_flagged_and_ranked_lower(self):
        both = wl(B=['Bbb', 'G', 200, 8.0, 'buy']); live = {'A': row(), 'B': row(vol=1000)}
        r = A.swing_ideas(live, {**comp('A'), **comp('B')}, both); self.assertEqual([i['k'] for i in r['ideas']], ['A', 'B']); self.assertTrue(r['ideas'][1]['thin']); self.assertTrue(any('Thinly' in w for w in r['ideas'][1]['warn']))
    def test_levels_follow_the_volatility_stop(self):
        i = A.swing_ideas({'A': row()}, comp(atr=5.0), wl())['ideas'][0]
        self.assertEqual(i['stopPct'], 4.5); self.assertAlmostEqual(i['stop'], 95.5); self.assertAlmostEqual(i['t1'], 110); self.assertAlmostEqual(i['t2'], 120); self.assertEqual(i['entry'], [100.0, 101.0]); self.assertAlmostEqual(i['rr'], 4.4, places=1)
        self.assertEqual(A.swing_ideas({'A': row()}, comp(atr=20.0), wl())['ideas'][0]['stopPct'], 9.0)
    def test_sizing_follows_the_tier_and_both_capitals(self):
        md = A.swing_ideas({'A': row(rsim=66)}, comp(atr=20.0), wl())['ideas'][0]; hi = A.swing_ideas({'A': row(rsim=75)}, comp(atr=20.0), wl())['ideas'][0]
        self.assertEqual((md['tier'], hi['tier']), ('medium', 'high')); self.assertEqual(md['risk'], 0.0075); self.assertEqual(hi['risk'], 0.005)    # the band 66-76 holds only the medium and high tiers
        self.assertEqual(md['qty']['1000000'], int(1e6 * 0.0075 / (100 - md['stop']))); self.assertEqual(hi['qty']['500000'], int(5e5 * 0.005 / (100 - hi['stop'])))
        self.assertGreater(md['qty']['1000000'], md['qty']['500000']); self.assertGreater(md['qty']['1000000'], hi['qty']['1000000'])
    def test_3h_state_moves_the_ranking_and_the_action(self):
        both = wl(B=['Bbb', 'G', 200, 8.0, 'buy']); live = {'A': row(), 'B': row()}; cp = {**comp('A'), **comp('B')}
        m = {'A': {'kind': 'down', 'h': -1, 'hp': 3, 'since': 4, 'dir': 'down', 'flip': 101, 'zero': True, 'last': 100}, 'B': {'kind': 'rising', 'h': 2, 'hp': 2, 'since': 9, 'dir': 'up', 'flip': 90, 'zero': True, 'last': 100}}
        r = A.swing_ideas(live, cp, both, m); self.assertEqual([i['k'] for i in r['ideas']], ['B', 'A']); self.assertEqual(r['ideas'][0]['action'], 'Buy zone'); self.assertEqual(r['ideas'][1]['action'], 'Wait for a 3-hour cross-up')
        self.assertTrue(any('cross up' in w for w in r['ideas'][1]['why']))
    def test_needs_3h_lists_the_candidates_without_a_state(self):
        r = A.swing_ideas({'A': row()}, comp(), wl(), None, (), {'A': 'NSE:AAA'}); self.assertEqual(r['need3h'], [{'k': 'A', 'y': 'NSE:AAA'}])
    def test_held_stock_is_noted(self):
        self.assertTrue(any('already held' in w.lower() for w in A.swing_ideas({'A': row()}, comp(), wl(), None, {'A'})['ideas'][0]['warn']))
    def test_top_five_and_the_rest(self):
        big = {'S%d' % i: ['S', 'G', 200, 5 + i * 0.1, 'buy'] for i in range(9)}; live = {k: row() for k in big}; cp = {}
        for k in big: cp.update(comp(k))
        r = A.swing_ideas(live, cp, big); self.assertEqual(len(r['ideas']), 5); self.assertEqual(len(r['also']), 4); self.assertEqual(r['pool'], 9)
        self.assertEqual([i['k'] for i in r['ideas']], ['S8', 'S7', 'S6', 'S5', 'S4'])

class Spike(unittest.TestCase):
    def one(self, pg, **kw): return A.swing_ideas({'A': row()}, comp(), {'A': ['Aaa', 'G', 200, 8.0, 'buy', pg]}, **kw)['ideas'][0]
    def test_trailing_growth_above_300_is_flagged_with_a_warning_and_the_action_is_qualified(self):
        i = self.one(6354); self.assertTrue(i['spike']); self.assertEqual(i['pg'], 6354)
        self.assertTrue(any('Earnings spike: trailing profit growth 6,354%' in w for w in i['warn'])); self.assertEqual(i['action'], 'Check the 3-hour chart (verify earnings first)')
    def test_boundary(self):
        self.assertFalse(self.one(300)['spike']); self.assertTrue(self.one(300.1)['spike']); self.assertFalse(self.one(-50)['spike'])
    def test_missing_or_old_style_entries_are_not_flagged(self):
        self.assertFalse(self.one(None)['spike']); self.assertIsNone(self.one(None)['pg'])
        old = A.swing_ideas({'A': row()}, comp(), {'A': ['Aaa', 'G', 200, 8.0, 'buy']})['ideas'][0]; self.assertFalse(old['spike']); self.assertEqual(old['action'], 'Check the 3-hour chart')
    def test_the_penalty_lowers_the_score_by_25(self):
        self.assertAlmostEqual(self.one(None)['score'] - self.one(5000)['score'], A.SPIKE_PENALTY, places=1)
    def test_a_spike_stock_no_longer_wins_over_a_clean_one_with_the_same_setup(self):
        both = {'A': ['Aaa', 'G', 200, 8.37, 'buy', 6354], 'B': ['Bbb', 'G', 200, 7.0, 'buy', 40]}; live = {'A': row(), 'B': row()}; cp = {**comp('A'), **comp('B')}
        r = A.swing_ideas(live, cp, both); self.assertEqual([i['k'] for i in r['ideas']], ['B', 'A'])
    def test_a_buy_zone_stock_with_a_spike_keeps_the_buy_colour_prefix_but_says_to_verify(self):
        m = {'A': {'kind': 'rising', 'h': 1, 'hp': 1, 'since': 9, 'dir': 'up', 'flip': 90, 'zero': True, 'last': 100}}
        self.assertEqual(self.one(900, m3h=m)['action'], 'Buy zone (verify earnings first)')
    def test_build_watch_stores_the_rounded_trailing_profit_growth(self):
        w = tempfile.mkdtemp(); os.makedirs(w + '/agent'); os.makedirs(w + '/stockData')
        json.dump({'stocks': [{'ticker': 'AAA', 'name': 'Aaa', 'industryGroup': 'G', 'score': 7, 'verdict': 'buy', 'valuation': {'intrinsicValue': 200, 'profitGrowth': 6353.55}}, {'ticker': 'BBB', 'valuation': {'intrinsicValue': 50}}]}, open(w + '/stockData/c001.json', 'w'))
        A.build_watch(w, w); d = A.J(w + '/agent/watch.json')['w']; self.assertEqual(d['AAA'][5], 6354); self.assertIsNone(d['BBB'][5])

class Files(unittest.TestCase):
    def mk(self):
        w = tempfile.mkdtemp(); os.makedirs(w + '/agent'); os.makedirs(w + '/liveSnapshot'); os.makedirs(w + '/stockData')
        json.dump({'stocks': [{'ticker': 'AAA ·x', 'name': 'Aaa Ltd', 'industryGroup': 'G', 'score': 7, 'verdict': 'buy', 'valuation': {'intrinsicValue': 200}}, {'ticker': 'NOIV', 'valuation': {}}]}, open(w + '/stockData/c001.json', 'w'))
        json.dump({'asof': A.today(), 'rows': [{'k': 'AAA', 'y': 'NSE:AAA', 'c': row()}]}, open(w + '/liveSnapshot/c001.json', 'w'))
        json.dump({'stocks': {}}, open(w + '/agent/compact.json', 'w')); return w
    def test_build_watch_keeps_only_stocks_with_an_intrinsic_value(self):
        w = self.mk(); A.build_watch(w, w); d = A.J(w + '/agent/watch.json')['w']; self.assertEqual(list(d), ['AAA']); self.assertEqual(d['AAA'], ['Aaa Ltd', 'G', 200, 7, 'buy', None])
    def test_swing_run_writes_swing_json(self):
        w = self.mk(); A.build_watch(w, w); o = A.swing_run(w); self.assertEqual(A.J(w + '/agent/swing.json')['ideas'][0]['k'], 'AAA'); self.assertEqual(o['need3h'], [{'k': 'AAA', 'y': 'NSE:AAA'}])
    def test_swing_run_without_a_watch_file_does_nothing(self):
        w = self.mk(); self.assertIsNone(A.swing_run(w)); self.assertFalse(os.path.exists(w + '/agent/swing.json'))
    def test_m3h_run_merges_the_states(self):
        w = self.mk(); A.build_watch(w, w)
        json.dump({'AAA': [200 - i * 0.8 for i in range(100)] + [120 + i * 3 for i in range(6)]}, open(w + '/agent/bars3h.json', 'w'))
        o = A.m3h_run(w); i = o['ideas'][0]; self.assertEqual(i['m3h']['kind'], 'fresh_up'); self.assertEqual(i['action'], 'Buy zone'); self.assertEqual(o['need3h'], []); self.assertEqual(o['m3hAsof'], A.today())
    def test_stale_3h_states_are_ignored(self):
        w = self.mk(); A.build_watch(w, w)
        json.dump({'d': '2000-01-01', 's': {'AAA': {'kind': 'rising', 'h': 1, 'hp': 1, 'since': 3, 'dir': 'up', 'flip': 1, 'zero': True, 'last': 1}}}, open(w + '/agent/m3h.json', 'w'))
        self.assertIsNone(A.swing_run(w)['ideas'][0]['m3h'])

if __name__ == '__main__': unittest.main()
