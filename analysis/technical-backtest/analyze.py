import json,numpy as np,pandas as pd
from scipy.stats import spearmanr
df=pd.DataFrame(json.load(open('rows.json')),columns=['s','t','score','f4','f13','f26','tr13','m35'])
df['d']=pd.to_datetime(df.t,unit='s').dt.date
cnt0=df.groupby('d').s.transform('count'); df=df[cnt0>=20].copy()
print('rows',len(df),'stocks',df.s.nunique(),'dates',df.d.nunique(), df.d.min(),df.d.max())
cnt=df.groupby('d').s.count(); print('stocks per date median',cnt.median(),'min',cnt.min(),'max',cnt.max())
def ic(col,sig='score',sub=None):
    x=df if sub is None else df[sub]
    out=[]
    for d,g in x.groupby('d'):
        if len(g)>=20 and g[sig].nunique()>3: out.append((d,spearmanr(g[sig],g[col])[0]))
    s=pd.Series([v for _,v in out],index=[d for d,_ in out]).dropna()
    return s
def rep(name,s,h):
    # overlapping windows: effective n ~ n/h
    n_eff=len(s)/h; t=s.mean()/(s.std()/np.sqrt(max(n_eff,1)))
    print(f'{name:28s} meanIC {s.mean():+.3f}  hit {np.mean(s>0):.0%}  dates {len(s)}  t(adj) {t:+.1f}')
for col,h in (('f4',4),('f13',13),('f26',26)):
    print('--- forward',col)
    rep('technical score',ic(col),h)
    rep('  only when monthly>=35 bars',ic(col,sub=df.m35==1),h)
    rep('trailing 13w momentum',ic(col,'tr13'),h)
    s=ic(col); mid=s.index[len(s)//2]
    rep('  score, first half',s[s.index<mid],h); rep('  score, second half',s[s.index>=mid],h)
# quintile / bucket returns, market-relative
for col in ('f13','f26'):
    df[col+'x']=df[col]-df.groupby('d')[col].transform('mean')
    df['q']=(df.groupby('d').score.rank(method='first',pct=True)*5-1e-9).astype(int)
    q=df.groupby('q')[col+'x'].mean()*100
    print(f'\nquintile excess return {col} (Q0 lowest score -> Q4 highest), %:',[round(v,2) for v in q])
    b=pd.cut(df.score,[-.1,3,5,7,10.1],labels=['0-3','3-5','5-7','7-10'])
    print(' by score band (raw mean fwd %, n):',{k:(round(v*100,1),int((b==k).sum())) for k,v in df.groupby(b,observed=True)[col].mean().items()})
