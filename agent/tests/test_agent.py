import json, os, sys, tempfile, unittest, datetime as dt
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import agent as A

DAY = A.today()
def days_ago(n): return (dt.date.fromisoformat(DAY) - dt.timedelta(days=n)).isoformat()

def row(k, close, **kw):
    # c = close, wMA, wSig, mMA, mSig, rsiW, rsiM, ch1w, ch1m, vol, mcap, earn
    c = [close, 2, 1, 2, 1, 58, 55, 1, 10, 200000, 1e4, None]
    for i, v in kw.items(): c[int(i[1:])] = v
    return {'k': k, 'c': c}

def comp(k, g='G1', iv=200, sc=8, vd='buy', atr=5.0, hi=116, ma10=95, ma10p=94):
    return {'n': k, 'g': g, 'sc': sc, 'vd': vd, 'iv': iv, 'atr': atr, 'hi': hi, 'ma10': ma10, 'ma10p': ma10p}

class Env:
    def __init__(self, stocks, rows, state=None, weights=None):
        self.t = tempfile.TemporaryDirectory(); w = self.t.name; self.w = w
        os.makedirs(w + '/agent'); os.makedirs(w + '/liveSnapshot')
        json.dump({'stocks': stocks}, open(w + '/agent/compact.json', 'w'))
        json.dump({'asof': DAY, 'rows': rows}, open(w + '/liveSnapshot/c001.json', 'w'))
        if state: json.dump(state, open(w + '/agent/state.json', 'w'))
        if weights: json.dump(weights, open(w + '/agent/weights.json', 'w'))
    def run(self, nifty=None):
        A.daily(self.w, nifty); return {n: A.J('%s/agent/%s.json' % (self.w, n)) for n in ('state', 'picks', 'log')}

def pos(k, entry=100, stop=94, target=110, d=None, q=10, g='G1'):
    return {'k': k, 'n': k, 'g': g, 'd': d or days_ago(1), 'entry': entry, 'q': q, 'stop': stop, 'target': target, 'f': {n: .5 for n in A.FEATS}, 'last': entry}

def st(open_=(), cash=A.CAP, closed=()):
    return {'cash': cash, 'open': list(open_), 'closed': list(closed), 'curve': [], 'started': DAY}

class Exits(unittest.TestCase):
    def exit_reason(self, close, **kw):
        e = Env({}, [row('X', close)], st([pos('X', **kw)], cash=0))
        s = e.run()['state']
        return s['closed'][0]['why'] if s['closed'] else None
    def test_stop(self): self.assertEqual(self.exit_reason(93), 'stop')
    def test_target(self): self.assertEqual(self.exit_reason(111), 'target')
    def test_time(self): self.assertEqual(self.exit_reason(100, d=days_ago(30)), 'time')
    def test_hold(self): self.assertIsNone(self.exit_reason(100, d=days_ago(29)))
    def test_exit_charges_half_cost(self):
        e = Env({}, [row('X', 111)], st([pos('X')], cash=0)); c = e.run()['state']['closed'][0]
        self.assertAlmostEqual(c['exit'], round(111 * (1 - A.COST / 2), 2))

class Entries(unittest.TestCase):
    def test_opens_pick_with_risk_sizing_and_cost(self):
        e = Env({'A': comp('A')}, [row('A', 100)]); r = e.run(); p = r['state']['open'][0]
        self.assertAlmostEqual(p['entry'], round(100 * (1 + A.COST / 2), 2))
        self.assertAlmostEqual((p['target'] - p['entry']) / (p['entry'] - p['stop']), A.RR_MIN, places=1)
        sp = 1 - p['stop'] / p['entry']
        self.assertTrue(.045 - 1e-3 <= sp <= .09 + 1e-3)
        self.assertLessEqual(p['q'] * p['entry'], A.CAP * A.POSCAP + p['entry'])
    def test_stop_distance_clipped(self):
        for atr, lo, hi in ((1, .045, .045), (20, .09, .09)):
            e = Env({'A': comp('A', atr=atr, hi=101)}, [row('A', 100)]); p = e.run()['state']['open'][0]
            self.assertAlmostEqual(1 - p['stop'] / p['entry'], lo, places=2)
    def test_group_cap(self):
        stocks = {k: comp(k, g='SAME') for k in 'ABCD'}
        e = Env(stocks, [row(k, 100) for k in 'ABCD']); s = e.run()['state']
        self.assertEqual(len(s['open']), A.MAX_PER_GROUP)
    def test_max_positions(self):
        stocks = {'S%d' % i: comp('S%d' % i, g='G%d' % i) for i in range(12)}
        e = Env(stocks, [row(k, 100) for k in stocks]); self.assertEqual(len(e.run()['state']['open']), A.MAXPOS)
    def test_held_stock_not_reopened(self):
        e = Env({'A': comp('A')}, [row('A', 100)], st([pos('A', stop=50, target=500)], cash=A.CAP)); self.assertEqual(len(e.run()['state']['open']), 1)

class Blocks(unittest.TestCase):
    def blocked(self, m=None, **c):
        e = Env({'A': m or comp('A')}, [row('A', 100, **c)]); r = e.run()
        return not r['state']['open'] and r['picks']['blocked'] == 1
    def test_avoid(self): self.assertTrue(self.blocked(comp('A', vd='avoid')))
    def test_downtrend(self): self.assertTrue(self.blocked(c1=1, c2=2, c3=1, c4=2))
    def test_rsi_stretched(self): self.assertTrue(self.blocked(c5=85))
    def test_falling_knife(self): self.assertTrue(self.blocked(c8=-16))
    def test_thin_trading(self): self.assertTrue(self.blocked(c9=10))
    def test_results_within_7_days(self):
        ts = (dt.datetime.fromisoformat(DAY) + dt.timedelta(days=3)).replace(tzinfo=dt.timezone.utc).timestamp()
        self.assertTrue(self.blocked(c11=ts))
    def test_results_far_away_ok(self):
        ts = (dt.datetime.fromisoformat(DAY) + dt.timedelta(days=30)).replace(tzinfo=dt.timezone.utc).timestamp()
        self.assertFalse(self.blocked(c11=ts))

class EntryFilters(unittest.TestCase):
    def blocked(self, m=None, **c):
        e = Env({'A': m or comp('A')}, [row('A', 100, **c)]); r = e.run()
        return (not r['state']['open'] and r['picks']['blocked'] == 1), r
    def test_passes_with_everything_in_order(self):
        ok, r = self.blocked(); self.assertFalse(ok); self.assertEqual(len(r['state']['open']), 1)
    def test_below_the_10_week_average(self): self.assertTrue(self.blocked(comp('A', ma10=105, ma10p=104))[0])
    def test_at_the_10_week_average_is_blocked(self): self.assertTrue(self.blocked(comp('A', ma10=100, ma10p=99))[0])
    def test_falling_10_week_average(self): self.assertTrue(self.blocked(comp('A', ma10=95, ma10p=96))[0])
    def test_flat_10_week_average_is_fine(self): self.assertFalse(self.blocked(comp('A', ma10=95, ma10p=95))[0])
    def test_missing_trend_data_blocks(self): self.assertTrue(self.blocked(comp('A', ma10=None, ma10p=None))[0])
    def test_rsi_band_edges(self):
        self.assertFalse(self.blocked(c5=45)[0]); self.assertFalse(self.blocked(c5=75)[0])
        self.assertTrue(self.blocked(c5=44.9)[0]); self.assertTrue(self.blocked(c5=75.1)[0]); self.assertTrue(self.blocked(c5=None)[0])
    def test_needs_positive_one_month_momentum(self):
        self.assertTrue(self.blocked(c8=0)[0]); self.assertTrue(self.blocked(c8=None)[0]); self.assertFalse(self.blocked(c8=0.1)[0])
    def test_must_be_within_15pct_of_the_40_week_high(self):
        self.assertTrue(self.blocked(comp('A', hi=118))[0])      # 100 < 0.85 x 118
        self.assertFalse(self.blocked(comp('A', hi=117))[0])     # 100 >= 0.85 x 117 = 99.45
    def test_reasons_are_recorded(self):
        _, r = self.blocked(comp('A', ma10=105, ma10p=104), c5=80)
        why = r['picks']['top'][0]['blocks']; self.assertIn('Below the 10-week average', why); self.assertIn('Weekly RSI outside 45-75', why)

class Build(unittest.TestCase):
    def test_compact_carries_the_10_week_averages(self):
        import tempfile
        w = tempfile.mkdtemp(); os.makedirs(w + '/agent'); os.makedirs(w + '/stockData'); os.makedirs(w + '/liveSnapshot'); os.makedirs(w + '/barsRecent')
        json.dump({'stocks': [{'ticker': 'AAA', 'name': 'Aaa', 'industryGroup': 'G', 'score': 7, 'verdict': 'buy', 'valuation': {'intrinsicValue': 200, 'currentPrice': 100, 'fiiHolding': 1}}]}, open(w + '/stockData/c001.json', 'w'))
        json.dump({'rows': [{'k': 'AAA', 'c': [100, 2, 1, 2, 1, 58, 55, 1, 10, 200000, 1e4, None]}]}, open(w + '/liveSnapshot/c001.json', 'w'))
        bars = [[i, 1, 11 + i, 1, 10 + i, 1] for i in range(40)]            # closes 10, 11, ... 49
        json.dump({'rows': [{'k': 'AAA', 'w': bars}]}, open(w + '/barsRecent/c001.json', 'w'))
        A.build(w, w); m = A.J(w + '/agent/compact.json')['stocks']['AAA']
        self.assertAlmostEqual(m['ma10'], sum(range(40, 50)) / 10); self.assertAlmostEqual(m['ma10p'], sum(range(37, 47)) / 10)
    def test_short_history_leaves_the_averages_empty(self):
        import tempfile
        w = tempfile.mkdtemp(); os.makedirs(w + '/agent'); os.makedirs(w + '/stockData'); os.makedirs(w + '/liveSnapshot'); os.makedirs(w + '/barsRecent')
        json.dump({'stocks': [{'ticker': 'AAA', 'name': 'Aaa', 'industryGroup': 'G', 'score': 7, 'verdict': 'buy', 'valuation': {'intrinsicValue': 200, 'currentPrice': 100, 'fiiHolding': 1}}]}, open(w + '/stockData/c001.json', 'w'))
        json.dump({'rows': [{'k': 'AAA', 'c': [100, 2, 1, 2, 1, 58, 55, 1, 10, 200000, 1e4, None]}]}, open(w + '/liveSnapshot/c001.json', 'w'))
        json.dump({'rows': [{'k': 'AAA', 'w': [[i, 1, 11, 1, 10, 1] for i in range(9)]}]}, open(w + '/barsRecent/c001.json', 'w'))
        A.build(w, w); m = A.J(w + '/agent/compact.json')['stocks']['AAA']; self.assertIsNone(m['ma10']); self.assertIsNone(m['ma10p'])

class Tier(unittest.TestCase):
    def one(self, **c):
        r = Env({'A': comp('A')}, [row('A', 100, **c)]).run(); return r, r['state']['open'][0]
    def test_standard_tier_risks_one_percent(self):
        r, p = self.one(c6=55); self.assertEqual(p['tier'], 'standard'); self.assertEqual(p['risk'], A.RISK); self.assertEqual(r['picks']['picks'][0]['tier'], 'standard')
    def test_high_tier_when_monthly_rsi_above_70(self):
        r, p = self.one(c6=75); self.assertEqual(p['tier'], 'high'); self.assertEqual(p['risk'], A.RISK_HIGH); self.assertEqual(r['picks']['picks'][0]['tier'], 'high'); self.assertEqual(p['mrsi'], 75)
    def test_exactly_70_is_standard(self):
        self.assertEqual(self.one(c6=70)[1]['tier'], 'standard'); self.assertEqual(self.one(c6=70.1)[1]['tier'], 'high')
    def test_unknown_monthly_rsi_is_treated_as_high(self):
        self.assertEqual(self.one(c6=None)[1]['tier'], 'high')
    def test_high_tier_gets_about_half_the_shares(self):
        qs = self.one(c6=55)[1]['q']; qh = self.one(c6=75)[1]['q']
        self.assertAlmostEqual(qh / qs, A.RISK_HIGH / A.RISK, delta=0.03)
    def test_high_tier_never_exceeds_half_the_risk_or_half_the_position_cap(self):
        p = self.one(c6=75)[1]
        self.assertLessEqual(p['q'] * (p['entry'] - p['stop']) / A.CAP, A.RISK_HIGH + 1e-4); self.assertLessEqual(p['q'] * p['entry'] / A.CAP, A.POSCAP / 2 + 1e-3)
    def test_high_tier_with_a_wide_stop_risks_half_a_percent(self):
        r = Env({'A': comp('A', atr=20, hi=101)}, [row('A', 100, c6=75)]).run(); p = r['state']['open'][0]     # 9% stop: the risk limit binds, not the cap
        self.assertAlmostEqual(p['q'] * (p['entry'] - p['stop']) / A.CAP, A.RISK_HIGH, delta=0.0003)
    def test_risk_tier_function(self):
        self.assertEqual(A.risk_tier(69.9), 'standard'); self.assertEqual(A.risk_tier(80), 'high'); self.assertEqual(A.risk_tier(None), 'high')

class Gate(unittest.TestCase):
    def run1(self, hi, close=100, atr=5.0):
        return Env({'A': comp('A', hi=hi, atr=atr)}, [row('A', close)]).run()
    def test_target_is_three_times_stop_distance(self):
        p = self.run1(116)['state']['open'][0]; self.assertAlmostEqual((p['target'] - p['entry']) / (p['entry'] - p['stop']), 3.0, places=1); self.assertEqual(p['maxd'], A.GATE_DAYS)
    def test_rejects_when_high_leaves_no_room(self):
        r = self.run1(110); self.assertEqual(r['state']['open'], []); self.assertEqual(r['picks']['picks'], [])
        g = r['picks']['gated'][0]; self.assertEqual(g['k'], 'A'); self.assertIn('below', g['why'])
    def test_accepts_breakout_near_the_high(self):
        self.assertEqual(len(self.run1(101)['state']['open']), 1)           # entry within 3% of the 40-week high: no overhead
    def test_no_high_on_record_blocks_the_stock(self):
        r = self.run1(None); self.assertEqual(r['state']['open'], []); self.assertEqual(r['picks']['blocked'], 1)
    def test_volatile_stock_uses_9pct_stop_and_wider_target(self):
        p = self.run1(101, atr=20)['state']['open'][0]; self.assertAlmostEqual(1 - p['stop'] / p['entry'], .09, places=2); self.assertAlmostEqual(p['target'] / p['entry'] - 1, .27, places=2)
    def test_gated_stock_does_not_use_a_group_slot(self):
        stocks = {'A': comp('A', g='SAME', hi=110), 'B': comp('B', g='SAME'), 'C': comp('C', g='SAME'), 'D': comp('D', g='SAME')}
        r = Env(stocks, [row(k, 100) for k in stocks]).run(); self.assertEqual(len(r['state']['open']), A.MAX_PER_GROUP)
    def test_new_position_runs_to_70_days_legacy_to_30(self):
        new = pos('N', d=days_ago(40)); new['maxd'] = A.GATE_DAYS; old = pos('O', d=days_ago(40))
        s = Env({}, [row('N', 100), row('O', 100)], st([new, old], cash=0)).run()['state']
        self.assertEqual([c['k'] for c in s['closed']], ['O']); self.assertEqual([p['k'] for p in s['open']], ['N'])
    def test_trade_plan_reasons(self):
        r = {'close': 100, 'atr': 5.0}
        self.assertIsNone(A.trade_plan(r, 200)[1]); self.assertIsNotNone(A.trade_plan(r, 105)[1]); self.assertIsNotNone(A.trade_plan(r, None)[1])

class Regime(unittest.TestCase):
    def mk(self, up, n=40):
        stocks = {'S%d' % i: comp('S%d' % i, g='G%d' % i) for i in range(n)}
        rows = [row('S%d' % i, 100, c8=(5 if i < up else -5)) for i in range(n)]
        return Env(stocks, rows)
    def test_risk_on_opens_positions(self):
        r = self.mk(30).run(); self.assertTrue(r['picks']['regime']['on']); self.assertGreater(len(r['state']['open']), 0)
    def test_risk_off_opens_nothing_but_reports_picks(self):
        r = self.mk(10).run(); self.assertFalse(r['picks']['regime']['on']); self.assertEqual(r['state']['open'], []); self.assertEqual(r['picks']['regime']['breadth'], .25); self.assertEqual(r['picks']['regime']['min'], A.REGIME_MIN)
    def test_risk_off_still_manages_exits(self):
        e = self.mk(10); w = e.w
        import json; json.dump(st([pos('S0', stop=94, target=110)], cash=0), open(w + '/agent/state.json', 'w'))
        rows = json.load(open(w + '/liveSnapshot/c001.json')); rows['rows'][0]['c'][0] = 93; json.dump(rows, open(w + '/liveSnapshot/c001.json', 'w'))
        s = e.run()['state']; self.assertEqual(s['closed'][0]['why'], 'stop')
    def test_too_few_stocks_keeps_filter_on(self):
        self.assertTrue(A.regime({'A': [100] + [None] * 7 + [-5, None, None, None]}, {'A': {}})['on'])
    def test_exactly_at_minimum_is_on(self):
        self.assertTrue(self.mk(24).run()['picks']['regime']['on']); self.assertFalse(self.mk(23).run()['picks']['regime']['on'])

class Ledger(unittest.TestCase):
    def test_equity_is_cash_plus_positions_and_curve_idempotent(self):
        e = Env({}, [row('X', 105)], st([pos('X', q=10)], cash=1000))
        e.run(nifty=22000); s = e.run()['state']
        self.assertEqual(len(s['curve']), 1)
        self.assertEqual(s['curve'][0][1], 2050)

class Metrics(unittest.TestCase):
    def test_drawdown(self):
        m = A.metrics({'curve': [['a', 1100000, None], ['b', 880000, None], ['c', 990000, None]], 'closed': []})
        self.assertEqual(m['maxDD'], -20.0); self.assertEqual(m['curDD'], -10.0)
    def test_drawdown_from_start_capital(self):
        self.assertEqual(A.metrics({'curve': [['a', 900000, None]], 'closed': []})['maxDD'], -10.0)
    def test_no_drawdown_when_rising(self):
        m = A.metrics({'curve': [['a', 1010000, None], ['b', 1020000, None]], 'closed': []}); self.assertEqual((m['maxDD'], m['curDD']), (0, 0))
    def test_expectancy_and_payoff(self):
        m = A.metrics({'curve': [], 'closed': [{'ret': 10}, {'ret': 10}, {'ret': -5}, {'ret': -5}, {'ret': -5}]})
        self.assertEqual(m['expectancy'], 1.0); self.assertEqual(m['avgWin'], 10.0); self.assertEqual(m['avgLoss'], -5.0); self.assertEqual(m['payoff'], 2.0)
    def test_no_trades(self):
        m = A.metrics({'curve': [], 'closed': []}); self.assertIsNone(m['expectancy']); self.assertIsNone(m['payoff'])
    def test_alpha_uses_window_with_nifty_only(self):
        c = [['a', 1000000, None], ['b', 1100000, 20000], ['c', 1155000, 21000]]
        m = A.metrics({'curve': c, 'closed': []})
        self.assertEqual(m['niftyRet'], 5.0); self.assertEqual(m['agentRet'], 5.0); self.assertEqual(m['alpha'], 0.0); self.assertEqual(m['since'], 'b')
    def test_alpha_none_without_two_nifty_points(self):
        self.assertIsNone(A.metrics({'curve': [['a', 1e6, 20000]], 'closed': []})['alpha'])
    def test_daily_stores_metrics(self):
        e = Env({}, [row('X', 105)], st([pos('X')], cash=0)); self.assertIn('maxDD', e.run(nifty=22000)['state']['metrics'])

class Learning(unittest.TestCase):
    def weekly(self, n_closed, win_f=.9, lose_f=.1):
        w = tempfile.mkdtemp(); os.makedirs(w + '/agent')
        closed = [{'ret': 5 if i % 2 == 0 else -5, 'f': {n: (win_f if i % 2 == 0 else lose_f) for n in A.FEATS}} for i in range(n_closed)]
        json.dump(st(closed=closed), open(w + '/agent/state.json', 'w')); A.weekly(w)
        return A.J(w + '/agent/weights.json'), A.J(w + '/agent/learn.json')
    def test_no_learning_below_20(self):
        wd, ln = self.weekly(19); self.assertEqual(wd['w'], A.W0); self.assertEqual(wd['v'], 0); self.assertIn('note', ln)
    def test_learns_at_20_in_small_steps(self):
        wd, ln = self.weekly(20); self.assertEqual(wd['v'], 1)
        for n in A.FEATS:
            self.assertGreater(wd['w'][n], A.W0[n]); self.assertLess(wd['w'][n] - A.W0[n], 0.5)
            self.assertLessEqual(wd['w'][n], 3.0)

if __name__ == '__main__': unittest.main()
