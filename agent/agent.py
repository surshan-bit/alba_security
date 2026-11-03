#!/usr/bin/env python3
"""Alba Agent: paper-trading swing agent on the Alba dashboard data.
Modes (all file based; WORK dir holds the JSON docs):
  build   WORK  ALBADATA   -> writes WORK/compact.json (static fundamentals + bar stats for the Positive MoS universe)
  daily   WORK  [--nifty X] -> reads WORK/live/*.json (liveSnapshot docs), compact, state, weights -> updates state.json, picks.json, log.json
  weekly  WORK             -> recalibrates weights.json from closed paper trades, writes learn.json
  m3h     WORK             -> reads WORK/agent/bars3h.json ({key: [3-hour closes]}), writes m3h.json and refreshes swing.json (best swing trades of the day)
"""
import json,glob,sys,os,math,datetime as dt
CAP=1_000_000; RISK=0.01; MAXPOS=8; POSCAP=0.125; COST=0.005  # round-trip costs+slippage
TIME_DAYS=30; MAX_PER_GROUP=2   # TIME_DAYS: legacy positions opened before the 1:3 gate
RSI_LO=45; RSI_HI=75; NEAR_HIGH=0.85   # hard entry filters (see entry_blocks)
TIER_RISK={'low':0.01,'medium':0.0075,'high':0.005}; MRSI_HIGH=70; MRSI_MEDIUM=60   # risk-reward tiers by monthly RSI: above 70 high, above 60 medium, otherwise low (unknown counts as high)
RR_MIN=3.0; GATE_DAYS=70       # 1:3 gate: target = RR_MIN x stop distance; new positions may run 70 days (10 weeks, as tested)
SWING_MRSI=(66,76); LIQ_LAKH=50; T1_PCT=10.0; T2_PCT=20.0; CAPITALS=(500000,1000000)   # swing ideas: monthly-RSI band, liquid = turnover of at least Rs 50 lakh a day, targets, capitals shown
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
    """Every stock with an intrinsic value (not only Rocky's filtered universe): {ticker: [name, group, intrinsic value, score, verdict]}.
    The swing ideas need it to find stocks such as thinly traded ones that the universe leaves out."""
    w={}
    for f in sorted(glob.glob(D+'/stockData/c*.json')):
        for s in J(f)['stocks']:
            v=s.get('valuation') or {}; iv=v.get('intrinsicValue')
            if isinstance(iv,(int,float)) and iv>0: w[s['ticker'].split(' ·')[0].strip()]=[(s.get('name') or '')[:24],s.get('industryGroup'),iv,s.get('score'),s.get('verdict')]
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

def m3h_text(st):
    if not st: return None
    if st['kind']=='fresh_up': return '3-hour MACD crossed up %d bars ago (histogram %s)'%(st['since'],st['h'])
    if st['kind']=='rising': return '3-hour MACD histogram rising (%s)'%st['h']
    if st['kind']=='fading': return '3-hour MACD histogram fading (%s, peak %s); a 3-hour close below %s would cross down'%(st['h'],st['hp'],st['flip'])
    return '3-hour MACD below its signal line; a 3-hour close above %s would cross up'%st['flip']

M3H_POINTS={'fresh_up':25,'rising':25,'fading':12,'down':0,None:10}
M3H_ACTION={'fresh_up':'Buy zone','rising':'Buy zone','fading':'Wait: momentum fading','down':'Wait for a 3-hour cross-up',None:'Check the 3-hour chart'}

def swing_ideas(live,comp,wl,m3h=None,held=(),sym=None):
    """Best swing trades of the day. Pool: monthly RSI 66-76, positive margin of safety, not an 'Avoid' verdict. Stocks inside Rocky's universe must also pass its
    hard entry filters (otherwise they are listed as skipped); others are kept with 'trend not checked'. Ranked by fundamentals, margin of safety, trend,
    the 3-hour MACD state and liquidity. Entry zone = last close to +1%; stop = Rocky's volatility stop; Target 1 = +10%, Target 2 = +20%.
    Sizing follows the monthly-RSI risk tier. A ranking of candidates, not a prediction."""
    m3h=m3h or {}; sym=sym or {}; ideas=[]; skipped=[]; pool=0
    for k,(n,g,iv,sc,vd) in wl.items():
        c=live.get(k)
        if not c or not c[0] or c[6] is None: continue
        close=c[0]; mrsi=c[6]; mos=(iv-close)/iv*100
        if not (SWING_MRSI[0]<=mrsi<=SWING_MRSI[1]) or mos<=0: continue
        pool+=1
        if vd=='avoid': skipped.append({'k':k,'n':n,'why':'Avoid verdict'}); continue
        m=comp.get(k)
        if m:
            bl=entry_blocks(m,close,c[5],c[8])
            if bl: skipped.append({'k':k,'n':n,'why':'; '.join(bl)}); continue
        turn=(c[9] or 0)*close/1e5; thin=turn<LIQ_LAKH
        atr=m.get('atr') if m else None; sp=clip(atr*0.9,4.5,9.0) if atr else 8.0
        entry=close; stop=entry*(1-sp/100); tier=risk_tier(mrsi); rk=TIER_RISK[tier]
        st=m3h.get(k)
        score=(sc or 0)/10*30+min(mos,50)/50*15+(25 if m else 10)+(5 if 69<=mrsi<=72 else 0)+M3H_POINTS[st['kind'] if st else None]-(15 if thin else 0)
        why=['Fundamentals: %s (score %s)'%(vd,sc),'Margin of safety %d%%'%round(mos),'Monthly RSI %d, inside your 66-76 band'%round(mrsi)]
        why.append('Passes Rocky\'s trend filters (above a rising 10-week average, weekly RSI %d)'%round(c[5]) if m else 'Trend not checked: outside Rocky\'s filtered universe')
        if st: why.append(m3h_text(st))
        warns=[]
        if thin: warns.append('Thinly traded (about Rs %d lakh a day): exits may be hard, use limit orders'%round(turn))
        if not m: warns.append('Outside Rocky\'s universe, so its trend filters were not applied')
        if not atr: warns.append('Stop is an estimate (8%%): no volatility data')
        if k in held: warns.append('Already held in Rocky\'s paper ledger')
        qty={}
        for cap in CAPITALS: qty[str(cap)]=int(min(cap*rk/(entry-stop),cap*POSCAP*(rk/RISK)/entry))
        ideas.append({'k':k,'y':sym.get(k),'n':n,'g':g,'close':round(close,2),'mrsi':round(mrsi,1),'mos':round(mos),'sc':sc,'vd':vd,'wrsi':None if c[5] is None else round(c[5]),'turn':round(turn),'thin':thin,'inU':bool(m),
            'tier':tier,'risk':rk,'score':round(max(0,min(100,score)),1),'m3h':st,'action':M3H_ACTION[st['kind'] if st else None],
            'entry':[round(entry,2),round(entry*1.01,2)],'stop':round(stop,2),'stopPct':round(sp,1),'t1':round(entry*(1+T1_PCT/100),2),'t2':round(entry*(1+T2_PCT/100),2),'rr':round(T2_PCT/sp,1),'qty':qty,'why':why,'warn':warns})
    ideas.sort(key=lambda x:-x['score'])
    return {'band':list(SWING_MRSI),'pool':pool,'ideas':ideas[:5],'also':[{k:i[k] for k in('k','n','score','close','mrsi','mos','vd','thin','action')} for i in ideas[5:12]],'skipped':skipped[:10],
            'need3h':[{'k':i['k'],'y':i['y']} for i in ideas[:6] if not i['m3h']],'capitals':list(CAPITALS)}

def swing_run(work):
    wl=J(work+'/agent/watch.json'); comp=(J(work+'/agent/compact.json') or {}).get('stocks',{})
    if not wl: return None
    live={};sym={};asof=None
    for f in sorted(glob.glob(work+'/liveSnapshot/*.json')):
        d=J(f); asof=max(asof or '',d.get('asof') or '')
        for r in d['rows']: live[r['k']]=(r['c']+[None]*12)[:12]; sym[r['k']]=r.get('y')
    m=J(work+'/agent/m3h.json',{}); m3h=m.get('s',{}) if m.get('d')==today() else {}
    held={o['k'] for o in (J(work+'/agent/state.json',{}) or {}).get('open',[])}
    out=swing_ideas(live,comp,wl['w'],m3h,held,sym); out.update({'asof':today(),'dataAsof':asof,'m3hAsof':m.get('d') if m3h else None})
    S(work+'/agent/swing.json',out); print('swing pool',out['pool'],'ideas',[i['k']+':'+str(i['score']) for i in out['ideas']],'need3h',[x['k'] for x in out['need3h']]); return out

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
