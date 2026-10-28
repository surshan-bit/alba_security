import pandas as pd,numpy as np,warnings,time
warnings.filterwarnings('ignore')
from sklearn.ensemble import HistGradientBoostingClassifier
D=pd.read_pickle('D.pkl').sort_values(['k','t']).reset_index(drop=True)
g=D.groupby('k')
D['t1']=g.t.shift(-1); D['y1']=g.y.shift(-1)
D['y2']=D.y+D.y1
D=D[(D.t1-D.t).between(5*86400,9*86400)&D.y2.notna()]
F=[c for c in D.columns if c not in('k','t','y','turn','rev1','t1','y1','y2')]
D['ex2']=D.y2-D.groupby('t').y2.transform('median')
D['labx']=(D.ex2>0).astype(int); D['labu']=(D.y2>0).astype(int)
L=D.dropna(subset=F).copy()
print(len(L),'base P(2w up) %.3f'%L.labu.mean(),'beat median 0.5')
ts=sorted(L.t.unique()); start=len(ts)-260; step=26
sets={'full':F,
 'trend-only':['r13','r26','r52','dhi52','sma40d','vol26'],
 'rebound-only':['r1','r2','r4','dlo52','rngpos','rsi','sma10d','macdh','vol8']}
def run(name,feats,lab):
    res=[]
    for i in range(start,len(ts),step):
        # 2-week label known only up to ts[i-3]
        tr=L[L.t<=ts[i-3]]; te=L[(L.t>=ts[i])&((L.t<ts[i+step]) if i+step<len(ts) else True)]
        m=HistGradientBoostingClassifier(max_depth=3,learning_rate=0.05,max_iter=150,min_samples_leaf=400,l2_regularization=5,random_state=0).fit(tr[feats],tr[lab])
        res.append(te[['k','t','y2','labu','labx']].assign(p=m.predict_proba(te[feats])[:,1]))
    o=pd.concat(res)
    o['dec']=np.floor(o.groupby('t').p.rank(pct=True,method='first')*10-1e-9).clip(upper=9)
    t5=o.sort_values(['t','p'],ascending=[True,False]).groupby('t').head(5); t10=o.sort_values(['t','p'],ascending=[True,False]).groupby('t').head(10)
    print('%-13s %-4s decile9 up %.3f beat %.3f | top5 up %.3f beat %.3f mean %.2f%% | top10 up %.3f | all up %.3f mean %.2f%%'%(name,lab,o[o.dec==9].labu.mean(),o[o.dec==9].labx.mean(),t5.labu.mean(),t5.labx.mean(),t5.y2.mean()*100,t10.labu.mean(),o.labu.mean(),o.y2.mean()*100),flush=True)
    return o
out={}
for n,f in sets.items():
    out[(n,'labx')]=run(n,f,'labx')
out[('full','labu')]=run('full',F,'labu')
pd.to_pickle(out,'oos2.pkl')
