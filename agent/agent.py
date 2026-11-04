#!/usr/bin/env python3
"""Alba Agent: paper-trading swing agent on the Alba dashboard data.
Modes (all file based; WORK dir holds the JSON docs):
  build   WORK  ALBADATA   -> writes WORK/compact.json (static fundamentals + bar stats for the Positive MoS universe)
  daily   WORK  [--nifty X] -> reads WORK/live/*.json (liveSnapshot docs), compact, state, weights -> updates state.json, picks.json, log.json
  weekly  WORK             -> recalibrates weights.json from closed paper trades, writes learn.json
  prox    WORK             -> reads WORK/agent/macdprox.json ({key: [2h MACD, 2h signal, 4h MACD, 4h signal]}), writes prox.json and refreshes swing.json
  m3h     WORK             -> reads WORK/agent/bars3h.json ({key: [3-hour closes]}), writes m3h.json and refreshes swing.json (best swing trades of the day)
"""
import json,glob,sys,os,math,datetime as dt
CAP=1_000_000; RISK=0.01; MAXPOS=8; POSCAP=0.125; COST=0.005  # round-trip costs+slippage
TIME_DAYS=30; MAX_PER_GROUP=2   # TIME_DAYS: legacy positions opened before the 1:3 gate
RSI_LO=45; RSI_HI=75; NEAR_HIGH=0.85   # hard entry filters (see entry_blocks)
TIER_RISK={'low':0.01,'medium':0.0075,'high':0.005}; MRSI_HIGH=70; MRSI_MEDIUM=60   # risk-reward tiers by monthly RSI: above 70 high, above 60 medium, otherwise low (unknown counts as high)
RR_MIN=3.0; GATE_DAYS=70       # 1:3 gate: target = RR_MIN x stop distance; new positions may run 70 days (10 weeks, as tested)
SPIKE_PG=300   # informational: trailing profit growth above 300% is flagged on a swing idea (it does not change the selection)
LIQ_PART=0.10   # a position may be at most 10% of the stock's average daily volume, so it can be sold without moving the price
SWING_MRSI=(66,76); MOS_MIN_SCORE=2; MOS_MIN_PCT=-25; MOS_MIN_FII=0.1; MOS_MIN_VOL=20000; LIQ_LAKH=50; T1_PCT=10.0; T2_PCT=20.0; CAPITALS=(500000,1000000); MAX_3H=12   # swing ideas: monthly-RSI band, liquid = turnover of at least Rs 50 lakh a day, targets, capitals shown, exact 3-hour checks per day
REGIME_MIN=0.6   # market filter: new entries only while at least this share of the universe has a positive 1-month change
FEATS=['fund','mos','trend','rsi','mom','near']
W0={'fund':1.0,'mos':1.0,'trend':1.5,'rsi':0.7,'mom':0.8,'near':0.8}
def J(p,d=None):
    try: return json.load(open(p))
    except Exception: return d
def S(p,o): json.dump(o,open(p,'w'),separators=(',',':'))
def clip(x,a,b): return max(a,min(b,x))
def today(): return (dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)+dt.timedelta(hours=5,minutes=30)).date().isoformat()

def metrics(st):
    """Performance metrics from the ledger. Returns plain numbers (percent) or None when not computable."""
    cv=st.get('curve') or []; eq=[CAP]+[p[1] for p in cv]
    peak=CAP; mdd=0.0
    for e in eq:
        peak=max(peak,e); mdd=min(mdd,(e/peak-1)*100)
    m={'maxDD':round(mdd,2),'curDD':round((eq[-1]/max(eq)-1)*100,2)}
    cl=st.get('closed') or []; win=[c['ret'] for c in cl if c['ret']>0]; lose=[c['ret'] for c in cl if c['ret']<=0]
    m['n']=len(cl)
    m['expectancy']=round(sum(c['ret'] for c in cl)/len(cl),2) if cl else None
    m['avgWin']=round(sum(win)/len(win),2) if win else None
    m['avgLoss']=round(sum(lose)/len(lose),2) if lose else None
    m['payoff']=round(m['avgWin']/-m['avgLoss'],2) if win and lose and m['avgLoss'] else None
    nf=[p for p in cv if len(p)>2 and p[2]]
    if len(nf)>=2:
        a,b=nf[0],nf[-1]; ar=(b[1]/a[1]-1)*100; nr=(b[2]/a[2]-1)*100
        m.update({'niftyRet':round(nr,2),'agentRet':round(ar,2),'alpha':round(ar-nr,2),'since':a[0]})
    else: m.update({'niftyRet':None,'agentRet':None,'alpha':None,'since':None})
    return m

def build_watch(work,D):
    """Every stock with an intrinsic value (not only Rocky's filtered universe): {ticker: [name, group, intrinsic value, score, verdict, trailing profit growth %]}.
    The swing ideas need it to find stocks such as thinly traded ones that the universe leaves out."""
    w={}
    for f in sorted(glob.glob(D+'/stockData/c*.json')):
        for s in J(f)['stocks']:
            v=s.get('valuation') or {}; iv=v.get('intrinsicValue')
            if isinstance(iv,(int,float)) and iv>0: pg=v.get('profitGrowth'); w[s['ticker'].split(' ·')[0].strip()]=[(s.get('name') or '')[:24],s.get('industryGroup'),iv,s.get('score'),s.get('verdict'),round(pg) if isinstance(pg,(int,float)) else None,v.get('fiiHolding')]
    S(work+'/agent/watch.json',{'built':today(),'w':w}); print('watch',len(w))

# ---- 3-hour MACD (12, 26, 9) ----
def _ema(v,n):
    k=2/(n+1); o=[v[0]]
    for x in v[1:]: o.append(x*k+o[-1]*(1-k))
    return o
def _macd(c):
    m=[a-b for a,b in zip(_ema(c,12),_ema(c,26))]; sg=_ema(m,9)
    return m,[a-b for a,b in zip(m,sg)]
def macd_state(c):
    """State of the 3-hour MACD from a list of closes (oldest first, at least 60 bars). None when there are too few.
    kind: fresh_up (crossed up within 6 bars), rising (histogram above zero and rising), fading (above zero, not rising), down (histogram at or below zero).
    flip: the next close at which the histogram changes sign (below it for fresh_up/rising/fading; above it for down)."""
    if not c or len(c)<60: return None
    m,h=_macd(c); n=len(c); cross=None
    for i in range(n-1,max(n-80,1),-1):
        if (h[i]>0)!=(h[i-1]>0): cross=(i,'up' if h[i]>0 else 'down'); break
    since=None if cross is None else n-1-cross[0]
    if h[-1]>0: kind='fresh_up' if cross and cross[1]=='up' and since<=6 else ('rising' if h[-1]>h[-2]>h[-3] else 'fading')
    else: kind='down'
    pos=h[-1]>0; lo,hi=(c[-1]*0.6,c[-1]) if pos else (c[-1],c[-1]*1.4)
    for _ in range(50):
        mid=(lo+hi)/2; up=_macd(c+[mid])[1][-1]>0
        if pos: lo,hi=(lo,mid) if up else (mid,hi)
        else: lo,hi=(mid,hi) if up else (lo,mid)
    flip=hi if pos else lo
    return {'kind':kind,'h':round(h[-1],2),'hp':round(max(h[-12:]),2),'since':since,'dir':cross[1] if cross else None,'flip':round(flip,2),'zero':m[-1]>0,'last':c[-1]}

def qualifies(st):
    """Rule 2 of the swing selection: the 3-hour MACD is above its signal line and above zero."""
    return bool(st) and st['h']>0 and st['zero']

def prox_ok(p):
    """First pass only (TradingView has no 3-hour MACD column): the 2-hour and 4-hour MACD are both above their signal line and above zero."""
    return isinstance(p,(list,tuple)) and len(p)>=4 and p[0]>p[1] and p[0]>0 and p[2]>p[3] and p[2]>0

def positive_mos(info,c):
    """The saved dashboard strategy "Positive MoS" (its month-RSI 30-80 and any-MACD rules are implied by rule 1): fundamental score >= 2,
    margin of safety >= -25% (green or orange), FII holding >= 0.1%, a known market cap and average volume >= 20,000 shares.
    info is the watch entry [name, group, intrinsic value, score, verdict, profit growth, FII %]; c is the live row (close in 0, average volume in 9, market cap in 10)."""
    if not info or len(info)<7: return False
    iv,score,fii,close,vol,mcap=info[2],info[3],info[6],c[0],c[9],c[10]
    nums=(iv,score,fii,close,vol,mcap)
    if not all(isinstance(x,(int,float)) and not isinstance(x,bool) for x in nums) or iv<=0: return False
    return score>=MOS_MIN_SCORE and (iv-close)/iv*100>=MOS_MIN_PCT and fii>=MOS_MIN_FII and mcap>0 and vol>=MOS_MIN_VOL

def swing_pool(live,sym,wl=None):
    """The candidates: stocks that qualify the Positive MoS strategy (when the watch list is given) and have a monthly RSI between 66 and 76."""
    return [{'k':k,'y':sym.get(k),'close':c[0],'mrsi':c[6]} for k,c in live.items() if c[0] and c[6] is not None and SWING_MRSI[0]<=c[6]<=SWING_MRSI[1] and (wl is None or positive_mos(wl.get(k),c))]

def shortlist(pool,prox):
    """The pool stocks whose 2-hour and 4-hour MACD agree, freshest first (smallest 4-hour gap as a share of price), at most MAX_3H: those get the exact 3-hour check."""
    ok=[p for p in pool if prox_ok(prox.get(p['k']))]
    ok.sort(key=lambda p:(prox[p['k']][2]-prox[p['k']][3])/p['close'])
    return ok[:MAX_3H]

def swing_card(p,st,c,info,held):
    """One idea: the two rules it met, the levels from Rocky's volatility stop, the sizes by risk tier, and warnings. The dashboard fields only inform; they never select."""
    n,g,iv,sc,vd,pg=(info+[None]*6)[:6] if info else [p['k'],None,None,None,None,None]
    close=p['close']; mos=(iv-close)/iv*100 if iv else None
    entry=close; sp=8.0 if not p.get('atr') else clip(p['atr']*0.9,4.5,9.0); stop=entry*(1-sp/100)
    tier=risk_tier(p['mrsi']); rk=TIER_RISK[tier]; turn=(c[9] or 0)*close/1e5; thin=turn<LIQ_LAKH
    qty={}; maxq=int(c[9]*LIQ_PART) if c[9] else None; limited=False
    for cap in CAPITALS:
        q=int(min(cap*rk/(entry-stop),cap*POSCAP*(rk/RISK)/entry))
        if maxq is not None and q>maxq: q=maxq; limited=True
        qty[str(cap)]=q
    why=['Monthly RSI %d, inside %d-%d'%(round(p['mrsi']),*SWING_MRSI),'3-hour MACD above its signal line and above zero (crossed up %s, histogram %s)'%('a while ago' if st['since'] is None else '%d bar%s ago'%(st['since'],'' if st['since']==1 else 's'),st['h'])]
    if vd: why.append('For reference: dashboard verdict %s (score %s)%s'%(vd,sc,'' if mos is None else ', margin of safety %d%%'%round(mos)))
    w=[]
    if thin: w.append('Thinly traded (about Rs %d lakh a day): exits may be hard, use limit orders'%round(turn))
    if limited: w.append('Size limited to %s shares (10%% of the average daily volume) so you can exit: about Rs %s'%(format(maxq,','),format(round(maxq*entry),',')))
    if vd=='avoid': w.append('The dashboard has an Avoid verdict on this stock')
    if mos is not None and mos<=0: w.append('Price is above the dashboard\'s intrinsic value (negative margin of safety)')
    if isinstance(pg,(int,float)) and pg>SPIKE_PG: w.append('Earnings spike: trailing profit growth %s%%. Check what the revenue is made of before buying'%format(pg,',.0f'))
    if not p.get('atr'): w.append('Stop is an estimate (8%): no volatility data')
    if p['k'] in held: w.append('Already held in Rocky\'s paper ledger')
    return {'k':p['k'],'y':p['y'],'n':n,'g':g,'close':round(close,2),'mrsi':round(p['mrsi'],1),'tier':tier,'risk':rk,'thin':thin,'m3h':st,'action':'Buy zone','entry':[round(entry,2),round(entry*1.01,2)],'stop':round(stop,2),'stopPct':round(sp,1),
            't1':round(entry*(1+T1_PCT/100),2),'t2':round(entry*(1+T2_PCT/100),2),'rr':round(T2_PCT/sp,1),'qty':qty,'liqLimited':limited,'ref':{'vd':vd,'sc':sc,'mos':None if mos is None else round(mos),'pg':pg},'why':why,'warn':w}

def swing_ideas(live,wl,m3h=None,prox=None,held=(),sym=None,comp=None):
    """The best swing trades: (1) monthly RSI 66-76 and (2) the 3-hour MACD above its signal line and above zero. Nothing else selects or ranks:
    freshest 3-hour cross-up first. Because TradingView has no 3-hour MACD column, the 2-hour and 4-hour MACD shortlist at most MAX_3H stocks,
    and only those get the exact 3-hour check; the result says how many were checked. A ranking of candidates, not a prediction."""
    m3h=m3h or {}; prox=prox or {}; sym=sym or {}; comp=comp or {}; wl=wl or {}
    pool=swing_pool(live,sym,wl); short=shortlist(pool,prox) if prox else []
    for p in pool: p['atr']=(comp.get(p['k']) or {}).get('atr')
    ideas=[swing_card(p,m3h[p['k']],live[p['k']],wl.get(p['k']),held) for p in short if qualifies(m3h.get(p['k']))]
    ideas.sort(key=lambda i:(i['m3h']['since'] if i['m3h']['since'] is not None else 999,-i['m3h']['h']/i['close']))
    return {'band':list(SWING_MRSI),'pool':len(pool),'shortlisted':len(short),'checked':sum(1 for p in short if p['k'] in m3h),'ideas':ideas[:8],
            'needProx':[{'k':p['k'],'y':p['y']} for p in pool] if not prox else [],'need3h':[{'k':p['k'],'y':p['y']} for p in short if p['k'] not in m3h],'capitals':list(CAPITALS)}

def swing_run(work):
    live={};sym={};asof=None
    for f in sorted(glob.glob(work+'/liveSnapshot/*.json')):
        d=J(f); asof=max(asof or '',d.get('asof') or '')
        for r in d['rows']: live[r['k']]=(r['c']+[None]*12)[:12]; sym[r['k']]=r.get('y')
    if not live: return None
    fresh=lambda name:(lambda m:m.get('s',{}) if m.get('d')==today() else {})(J(work+'/agent/%s.json'%name,{}) or {})
    m3h=fresh('m3h'); prox=fresh('prox'); wl=(J(work+'/agent/watch.json') or {}).get('w',{}); comp=(J(work+'/agent/compact.json') or {}).get('stocks',{})
    held={o['k'] for o in (J(work+'/agent/state.json',{}) or {}).get('open',[])}
    out=swing_ideas(live,wl,m3h,prox,held,sym,comp); out.update({'asof':today(),'dataAsof':asof,'proxAsof':today() if prox else None,'m3hAsof':today() if m3h else None})
    S(work+'/agent/swing.json',out); print('swing pool',out['pool'],'shortlisted',out['shortlisted'],'checked',out['checked'],'ideas',[i['k'] for i in out['ideas']],'needProx',len(out['needProx']),'need3h',[x['k'] for x in out['need3h']]); return out

def prox_run(work):
    raw=J(work+'/agent/macdprox.json',{}) or {}
    res={k:[float(x) for x in v[:4]] for k,v in raw.items() if isinstance(v,(list,tuple)) and len(v)>=4 and all(isinstance(x,(int,float)) for x in v[:4])}
    S(work+'/agent/prox.json',{'d':today(),'s':res}); print('2h/4h MACD for',len(res),'stocks'); return swing_run(work)

def m3h_run(work):
    bars=J(work+'/agent/bars3h.json',{}) or {}; res={}
    for k,c in bars.items():
        st=macd_state(c)
        if st: res[k]=st
    S(work+'/agent/m3h.json',{'d':today(),'s':res}); print('m3h states',{k:v['kind'] for k,v in res.items()}); return swing_run(work)   # keys are the dashboard tickers

def build(work,D):
    uni=set(J('%s/universe.json'%work)) if os.path.exists('%s/universe.json'%work) else None
    stocks={};live={};bars={}
    for f in sorted(glob.glob(D+'/stockData/c*.json')):
        for s in J(f)['stocks']: stocks[s['ticker'].split(' ·')[0].strip()]=s
    for f in sorted(glob.glob(D+'/liveSnapshot/c*.json')):
        for r in J(f)['rows']: live[r['k']]=(r['c']+[None]*12)[:12]
    for f in sorted(glob.glob(D+'/barsRecent/c*.json')):
        for r in J(f)['rows']: bars[r['k']]=r['w']
    out={}
    for k,s in stocks.items():
        c=live.get(k); v=s.get('valuation') or {}
        i=v.get('intrinsicValue'); p=v.get('currentPrice')
        if not c or not(isinstance(i,(int,float)) and i>0 and isinstance(p,(int,float))): continue
        m=(i-p)/i*100
        if m<-25 or s.get('score') is None or s['score']<2: continue
        if c[6] is None or not 30<=c[6]<=80 or c[9] is None or c[9]<50000 or (v.get('fiiHolding') or 0)<0.1 or c[10] is None: continue
        w=bars.get(k,[]); atr=None; off=None; ma10=ma10p=None
        if len(w)>=8:
            atr=sum((b[2]-b[3])/b[4] for b in w[-8:] if b[4])/8*100
            hi=max(b[2] for b in w[-40:]); off=(w[-1][4]/hi-1)*100
        if len(w)>=13:
            ma10=sum(b[4] for b in w[-10:])/10; ma10p=sum(b[4] for b in w[-13:-3])/10   # 10-week average now and 3 weeks ago
        out[k]={'n':s.get('name'),'g':s.get('industryGroup'),'sc':s['score'],'vd':s.get('verdict'),'iv':i,'atr':atr,'hi':max(b[2] for b in w[-40:]) if w else None,'ma10':ma10,'ma10p':ma10p}
    S('%s/agent/compact.json'%work,{'built':today(),'stocks':out}); print('compact',len(out))
    build_watch(work,D)

def entry_blocks(m,close,rw,ch1m):
    """Hard entry filters, the same ones the backtest tested: above a rising 10-week average, weekly RSI 45-75,
    positive 1-month change, within 15% of the 40-week high. Missing data blocks the stock (never buys unchecked)."""
    b=[]
    ma,mp=m.get('ma10'),m.get('ma10p')
    if ma is None or mp is None: b.append('No trend data (needs a rebuild)')
    else:
        if close<=ma: b.append('Below the 10-week average')
        elif ma<mp: b.append('10-week average falling')
    if rw is None or not RSI_LO<=rw<=RSI_HI: b.append('Weekly RSI outside %d-%d'%(RSI_LO,RSI_HI))
    if ch1m is None or ch1m<=0: b.append('No positive 1-month momentum')
    hi=m.get('hi')
    if not hi or close<NEAR_HIGH*hi: b.append('More than 15% below the 40-week high')
    return b

def feats(k,m,c):
    close,wm,ws,mm,ms,rw,rm,ch1w,ch1m,vol,mc,earn=c
    mos=(m['iv']-close)/m['iv']*100
    wb=None if wm is None or ws is None else wm>ws
    mb=None if mm is None or ms is None else mm>ms
    trend=((1 if wb else 0)+(1 if mb else 0))/2 if (wb is not None or mb is not None) else 0.5
    off=(close/m['hi']-1)*100 if m.get('hi') else -10
    f={'fund':clip((m['sc']-2)/8,0,1),'mos':clip(mos,0,60)/60,'trend':trend,
       'rsi':clip(1-abs((rw if rw is not None else 55)-58)/22,0,1),
       'mom':clip((ch1m or 0)/20,-0.5,1),'near':clip(1+off/15,0,1)}
    blocks=[]
    if m['vd']=='avoid': blocks.append('Avoid verdict')
    if wb is False and mb is False: blocks.append('Downtrend')
    blocks+=entry_blocks(m,close,rw,ch1m)
    if (ch1m or 0)<=-15: blocks.append('Falling >15% in a month')
    if vol is not None and vol*close/1e5<50: blocks.append('Thin trading')
    if earn:
        try:
            d=(dt.datetime.fromtimestamp(earn,dt.timezone.utc).date()-dt.date.fromisoformat(today())).days
            if 0<=d<=7: blocks.append('Results in %dd'%d)
        except Exception: pass
    return f,mos,blocks

def regime(live,comp,minimum=REGIME_MIN):
    """Market breadth over the scored universe: share of stocks with a positive 1-month change (live column 8).
    Returns dict(breadth, n, min, on). With too little data (<30 stocks) the filter stays on rather than blocking everything."""
    ch=[live[k][8] for k in comp if k in live and live[k][8] is not None]
    if len(ch)<30: return {'breadth':None,'n':len(ch),'min':minimum,'on':True}
    b=sum(1 for x in ch if x>0)/len(ch)
    return {'breadth':round(b,3),'n':len(ch),'min':minimum,'on':b>=minimum}

def risk_tier(mrsi):
    """Risk-reward tier from the monthly RSI: 'high' above 70 (or unknown), 'medium' above 60, else 'low'.
    Backtest (3 weeks after entry): the higher the monthly RSI, the more often a stock reaches +10% (27% -> 38%) and the more
    often it is down 7% at some point (36% -> 50%), so riskier tiers get a smaller position (TIER_RISK, and a proportionally smaller position cap)."""
    if mrsi is None or mrsi>MRSI_HIGH: return 'high'
    return 'medium' if mrsi>MRSI_MEDIUM else 'low'

def trade_plan(r,hi):
    """Entry, stop, target for candidate r under the 1:3 gate. Returns (plan, reason); reason is None when the gate passes.
    Stop distance = ATR-based, clipped 4.5-9%. Target = entry + RR_MIN x risk. Gate: the 40-week high must leave room for the
    target, or the stock must already be within 3% of that high (breakout, no overhead). No high on record -> rejected."""
    atr=r['atr'] or 6.0; sp=clip(atr*0.9,4.5,9.0)
    entry=r['close']*(1+COST/2); stop=entry*(1-sp/100); target=entry+RR_MIN*(entry-stop)
    p={'entry':round(entry,2),'stop':round(stop,2),'target':round(target,2),'sp':round(sp,2),'hi':hi}
    if not hi: return p,'no 40-week high on record'
    if hi>=target or entry>=0.97*hi: return p,None
    return p,'40-week high %.0f is below the %.0f target'%(hi,target)

def daily(work,nifty=None):
    comp=J(work+'/agent/compact.json')['stocks']; wts=J(work+'/agent/weights.json',{'w':W0,'v':0})['w']
    live={}
    for f in sorted(glob.glob(work+'/liveSnapshot/*.json')):
        d=J(f)
        for r in d['rows']: live[r['k']]=(r['c']+[None]*12)[:12]
        asof=max(asof or '',d.get('asof') or '') if 'asof' in dir() else d.get('asof')
    st=J(work+'/agent/state.json',{'cash':CAP,'open':[],'closed':[],'curve':[],'started':today()})
    day=today(); log=J(work+'/agent/log.json',{'items':[]})['items']
    px={k:v[0] for k,v in live.items() if v[0]}
    # 1) mark / exit open positions (close-based; no intraday data)
    keep=[]
    for p in st['open']:
        c=px.get(p['k'])
        if c is None: keep.append(p); continue
        p['last']=c; held=(dt.date.fromisoformat(day)-dt.date.fromisoformat(p['d'])).days
        why=None
        if c<=p['stop']: why='stop'
        elif c>=p['target']: why='target'
        elif held>=p.get('maxd',TIME_DAYS): why='time'
        if why:
            exitp=c*(1-COST/2); pnl=(exitp-p['entry'])*p['q']
            st['cash']+=exitp*p['q']
            st['closed'].append({**{x:p[x] for x in('k','d','entry','q','stop','target','f','g')},'exit':round(exitp,2),'xd':day,'why':why,'pnl':round(pnl,2),'ret':round((exitp/p['entry']-1)*100,2)})
        else: keep.append(p)
    st['open']=keep
    eq=st['cash']+sum(p.get('last',p['entry'])*p['q'] for p in keep)
    # 2) score universe
    rows=[]
    for k,m in comp.items():
        c=live.get(k)
        if not c or not c[0]: continue
        f,mos,bl=feats(k,m,c)
        sc=sum(wts[n]*f[n] for n in FEATS)/sum(wts.values())*10
        rows.append({'k':k,'n':m['n'],'g':m['g'],'close':c[0],'mos':round(mos,1),'score':round(sc,2),'f':{a:round(b,3) for a,b in f.items()},'blocks':bl,'atr':m['atr'],'rsiW':c[5],'mrsi':None if c[6] is None else round(c[6],1),'tier':risk_tier(c[6])})
    rows.sort(key=lambda r:-r['score'])
    held={p['k'] for p in keep}; gcount={}
    for p in keep: gcount[p['g']]=gcount.get(p['g'],0)+1
    picks=[]; gated=[]
    for r in rows:
        if r['blocks'] or r['k'] in held: continue
        if gcount.get(r['g'],0)>=MAX_PER_GROUP: continue
        if r['score']<6.0: continue
        plan,why=trade_plan(r,comp[r['k']].get('hi'))
        if why:
            gated.append({**{k:r[k] for k in('k','n','g','close','score')},'stop':plan['stop'],'target':plan['target'],'why':why}); continue
        r['plan']=plan
        picks.append(r); gcount[r['g']]=gcount.get(r['g'],0)+1
        if len(picks)>=MAXPOS: break
    # 3) open new paper positions
    reg=regime(live,comp)
    slots=(MAXPOS-len(keep)) if reg['on'] else 0; new=[]   # risk-off: manage exits, open nothing
    for r in picks[:max(slots,0)]:
        pl=r['plan']; entry=pl['entry']
        rk=TIER_RISK[r['tier']]
        q=int(min(eq*rk/(entry-pl['stop']), eq*POSCAP*(rk/RISK)/entry, st['cash']/entry))   # riskier tiers shrink both the risk and the position-size cap
        if q<1: continue
        st['cash']-=q*entry
        pos={'k':r['k'],'n':r['n'],'g':r['g'],'d':day,'entry':entry,'q':q,'stop':pl['stop'],'target':pl['target'],'rr':RR_MIN,'maxd':GATE_DAYS,'tier':r['tier'],'risk':rk,'mrsi':r['mrsi'],'f':r['f'],'last':r['close']}
        st['open'].append(pos); new.append(pos)
    eq=st['cash']+sum(p.get('last',p['entry'])*p['q'] for p in st['open'])
    ub=[px[k] for k in comp if k in px]
    st['curve']=[x for x in st['curve'] if x[0]!=day]+[[day,round(eq,0),nifty]]
    st['metrics']=metrics(st)
    S(work+'/agent/state.json',st)
    S(work+'/agent/picks.json',{'asof':day,'dataAsof':asof,'weightsVersion':J(work+'/agent/weights.json',{'v':0})['v'],'top':rows[:15],'picks':[{**{k:r[k] for k in('k','n','g','close','score','mos','rsiW','mrsi','tier')},'stop':r['plan']['stop'],'target':r['plan']['target']} for r in picks],'gated':gated,'new':new,'regime':reg,'universe':len(rows),'blocked':sum(1 for r in rows if r['blocks'])})
    log=[l for l in log if l['d']!=day]+[{'d':day,'equity':round(eq),'open':len(st['open']),'new':[p['k'] for p in new],'closed':[c['k']+':'+c['why'] for c in st['closed'] if c['xd']==day],'regime':reg['on'],'breadth':reg['breadth']}]
    S(work+'/agent/log.json',{'items':log[-120:]})
    print('equity',round(eq),'open',len(st['open']),'new',[p['k'] for p in new],'dataAsof',asof,'regime',reg)
    swing_run(work)

def weekly(work):
    st=J(work+'/agent/state.json'); wd=J(work+'/agent/weights.json',{'w':dict(W0),'v':0,'hist':[]})
    cl=[c for c in st['closed'] if c.get('f')]
    out={'d':today(),'closed':len(cl)}
    if len(cl)<20:
        out['note']='Fewer than 20 closed paper trades; weights unchanged (no learning from noise).'
    else:
        win=[c for c in cl if c['ret']>0]; lose=[c for c in cl if c['ret']<=0]
        out['hit']=round(len(win)/len(cl)*100,1); out['avg']=round(sum(c['ret'] for c in cl)/len(cl),2)
        if win and lose:
            ch={}
            for n in FEATS:
                mw=sum(c['f'][n] for c in win)/len(win); ml=sum(c['f'][n] for c in lose)/len(lose)
                edge=mw-ml; old=wd['w'][n]
                new=clip(old*0.8+0.2*clip(old+edge*2.0,0.0,3.0),0.0,3.0)   # shrink toward old, small step
                ch[n]=[round(old,3),round(new,3)]; wd['w'][n]=round(new,3)
            wd['v']+=1; wd.setdefault('hist',[]).append({'d':today(),'ch':ch,'n':len(cl)}); out['changes']=ch
    S(work+'/agent/weights.json',wd); S(work+'/agent/learn.json',out); print(out)

if __name__=='__main__':
    m,w=sys.argv[1],sys.argv[2]
    if m=='build': build(w,sys.argv[3])
    elif m=='daily':
        n=float(sys.argv[sys.argv.index('--nifty')+1]) if '--nifty' in sys.argv else None
        daily(w,n)
    elif m=='weekly': weekly(w)
    elif m=='m3h': m3h_run(w)
    elif m=='prox': prox_run(w)
