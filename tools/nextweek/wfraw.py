import pandas as pd,numpy as np,warnings,time
warnings.filterwarnings('ignore')
from sklearn.ensemble import HistGradientBoostingClassifier
D=pd.read_pickle('D.pkl')
F=[c for c in D.columns if c not in('k','t','y','turn','rev1')]
D['ex']=D.y-D.groupby('t').y.transform('median'); D['lab']=(D.ex>0).astype(int)
L=D.dropna(subset=F+['y']).copy()
ts=sorted(L.t.unique()); start=len(ts)-260; step=26
res=[];t0=time.time()
for i in range(start,len(ts),step):
    tr=L[L.t<=ts[i-2]]; te=L[(L.t>=ts[i])&((L.t<ts[i+step]) if i+step<len(ts) else True)]
    m=HistGradientBoostingClassifier(max_depth=3,learning_rate=0.05,max_iter=150,min_samples_leaf=400,l2_regularization=5,random_state=0).fit(tr[F],tr.lab)
    res.append(te[['k','t','y','ex','lab']].assign(p=m.predict_proba(te[F])[:,1]))
    print(i,len(tr),round(time.time()-t0),flush=True)
o=pd.concat(res); o['up']=(o.y>0).astype(int)
o['dec']=np.floor(o.groupby('t').p.rank(pct=True,method='first')*10-1e-9).clip(upper=9)
o.to_pickle('oos_raw.pkl')
g=o.groupby('dec')[['up','lab']].mean(); print('RAW decile P(up)',' '.join('%.3f'%x for x in g.up)); print('beat median   ',' '.join('%.3f'%x for x in g.lab))
ic=o.groupby('t').apply(lambda g:g.p.corr(g.ex,method='spearman')); print('IC %.4f t=%.2f'%(ic.mean(),ic.mean()/ic.std()*len(ic)**.5))
t5=o.sort_values(['t','p'],ascending=[True,False]).groupby('t').head(5)
print('top5/wk P(up) %.3f beat %.3f mean %.2f%% | all %.3f %.2f%%'%(t5.up.mean(),t5.lab.mean(),t5.y.mean()*100,o.up.mean(),o.y.mean()*100))
