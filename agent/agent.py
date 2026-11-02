#!/usr/bin/env python3
"""Alba Agent: paper-trading swing agent on the Alba dashboard data.
Modes (all file based; WORK dir holds the JSON docs):
  build   WORK  ALBADATA   -> writes WORK/compact.json (static fundamentals + bar stats for the Positive MoS universe)
  daily   WORK  [--nifty X] -> reads WORK/live/*.json (liveSnapshot docs), compact, state, weights -> updates state.json, picks.json, log.json
  weekly  WORK             -> recalibrates weights.json from closed paper trades, writes learn.json
"""
import json,glob,sys,os,math,datetime as dt
CAP=1_000_000; RISK=0.01; MAXPOS=8; POSCAP=0.125; COST=0.005  # round-trip costs+slippage
TARGET=10.0; TIME_DAYS=30; MAX_PER_GROUP=2
FEATS=['fund','mos','trend','rsi','mom','near']
W0={'fund':1.0,'mos':1.0,'trend':1.5,'rsi':0.7,'mom':0.8,'near':0.8}
def J(p,d=None):
    try: return json.load(open(p))
    except Exception: return d
def S(p,o): json.dump(o,open(p,'w'),separators=(',',':'))
def clip(x,a,b): return max(a,min(b,x))
def today(): return (dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)+dt.timedelta(hours=5,minutes=30)).date().isoformat()

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
        w=bars.get(k,[]); atr=None; off=None
        if len(w)>=8:
            atr=sum((b[2]-b[3])/b[4] for b in w[-8:] if b[4])/8*100
            hi=max(b[2] for b in w[-40:]); off=(w[-1][4]/hi-1)*100
        out[k]={'n':s.get('name'),'g':s.get('industryGroup'),'sc':s['score'],'vd':s.get('verdict'),'iv':i,'atr':atr,'hi':max(b[2] for b in w[-40:]) if w else None}
    S('%s/agent/compact.json'%work,{'built':today(),'stocks':out}); print('compact',len(out))

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
    if rw is not None and rw>=80: blocks.append('Weekly RSI stretched')
    if (ch1m or 0)<=-15: blocks.append('Falling >15% in a month')
    if vol is not None and vol*close/1e5<50: blocks.append('Thin trading')
    if earn:
        try:
            d=(dt.datetime.fromtimestamp(earn,dt.timezone.utc).date()-dt.date.fromisoformat(today())).days
            if 0<=d<=7: blocks.append('Results in %dd'%d)
        except Exception: pass
    return f,mos,blocks

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
        elif held>=TIME_DAYS: why='time'
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
        rows.append({'k':k,'n':m['n'],'g':m['g'],'close':c[0],'mos':round(mos,1),'score':round(sc,2),'f':{a:round(b,3) for a,b in f.items()},'blocks':bl,'atr':m['atr'],'rsiW':c[5]})
    rows.sort(key=lambda r:-r['score'])
    held={p['k'] for p in keep}; gcount={}
    for p in keep: gcount[p['g']]=gcount.get(p['g'],0)+1
    picks=[]
    for r in rows:
        if r['blocks'] or r['k'] in held: continue
        if gcount.get(r['g'],0)>=MAX_PER_GROUP: continue
        if r['score']<6.0: continue
        picks.append(r); gcount[r['g']]=gcount.get(r['g'],0)+1
        if len(picks)>=MAXPOS: break
    # 3) open new paper positions
    slots=MAXPOS-len(keep); new=[]
    for r in picks[:max(slots,0)]:
        atr=r['atr'] or 6.0
        sp=clip(atr*0.9,4.5,9.0)   # stop distance %, ~weekly range
        entry=r['close']*(1+COST/2)
        q=int(min(eq*RISK/(entry*sp/100), eq*POSCAP/entry, st['cash']/entry))
        if q<1: continue
        st['cash']-=q*entry
        pos={'k':r['k'],'n':r['n'],'g':r['g'],'d':day,'entry':round(entry,2),'q':q,'stop':round(entry*(1-sp/100),2),'target':round(entry*(1+TARGET/100),2),'f':r['f'],'last':r['close']}
        st['open'].append(pos); new.append(pos)
    eq=st['cash']+sum(p.get('last',p['entry'])*p['q'] for p in st['open'])
    ub=[px[k] for k in comp if k in px]
    st['curve']=[x for x in st['curve'] if x[0]!=day]+[[day,round(eq,0),nifty]]
    S(work+'/agent/state.json',st)
    S(work+'/agent/picks.json',{'asof':day,'dataAsof':asof,'weightsVersion':J(work+'/agent/weights.json',{'v':0})['v'],'top':rows[:15],'picks':[{k:r[k] for k in('k','n','g','close','score','mos','rsiW')} for r in picks],'new':new,'universe':len(rows),'blocked':sum(1 for r in rows if r['blocks'])})
    log=[l for l in log if l['d']!=day]+[{'d':day,'equity':round(eq),'open':len(st['open']),'new':[p['k'] for p in new],'closed':[c['k']+':'+c['why'] for c in st['closed'] if c['xd']==day]}]
    S(work+'/agent/log.json',{'items':log[-120:]})
    print('equity',round(eq),'open',len(st['open']),'new',[p['k'] for p in new],'dataAsof',asof)

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
