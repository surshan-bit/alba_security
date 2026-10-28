import json,glob,numpy as np,pandas as pd,warnings
warnings.filterwarnings('ignore')
from load import bars as recent
H={}
for f in glob.glob('/tmp/dbph/priceHistory/*.json'):
    d=json.load(open(f)); k=d['ticker']
    H[k]={b[0]:b for b in d['bars']}
for k,w in recent.items():
    if k in H:
        for b in w: H[k][b[0]]=b   # recent overrides
rows=[]
for k,m in H.items():
    ts=sorted(m)
    if len(ts)<80: continue
    a=np.array([m[t] for t in ts],float)
    df=pd.DataFrame(a,columns=['t','o','h','l','c','v']); df['k']=k
    df=df[df.c>0]
    c=df.c; r=np.log(c).diff()
    f=pd.DataFrame({'k':k,'t':df.t})
    for n in (1,2,4,8,13,26,52): f[f'r{n}']=np.log(c/c.shift(n))
    f['vol8']=r.rolling(8).std(); f['vol26']=r.rolling(26).std()
    f['dhi52']=c/df.h.rolling(52,min_periods=26).max()-1
    f['dlo52']=c/df.l.rolling(52,min_periods=26).min()-1
    f['rngpos']=(c-df.l)/(df.h-df.l).replace(0,np.nan)
    f['rev1']=f.r1  # short-term reversal
    d_=c.diff(); up=d_.clip(lower=0).rolling(14).mean(); dn=(-d_.clip(upper=0)).rolling(14).mean()
    f['rsi']=100-100/(1+up/dn.replace(0,np.nan))
    e12=c.ewm(span=12).mean(); e26=c.ewm(span=26).mean(); mac=e12-e26
    f['macdh']=(mac-mac.ewm(span=9).mean())/c
    f['volr']=np.log((df.v.rolling(4).mean()+1)/(df.v.rolling(26).mean()+1))
    f['sma10d']=c/c.rolling(10).mean()-1
    f['sma40d']=c/c.rolling(40).mean()-1
    f['y']=r.shift(-1)   # next week log return
    f['turn']=(df.v*c).rolling(8).mean()
    rows.append(f)
D=pd.concat(rows); D=D[D.turn>1e7]
D.to_pickle('D.pkl'); print(D.shape,D.t.nunique())
