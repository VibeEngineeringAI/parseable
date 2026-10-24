#!/usr/bin/env python3
"""Render measured server results; no component estimates enter these charts."""
import argparse, json, pathlib, statistics
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

p=argparse.ArgumentParser()
p.add_argument('--burst',type=pathlib.Path,required=True)
p.add_argument('--sustained',type=pathlib.Path)
p.add_argument('--output',type=pathlib.Path,required=True)
a=p.parse_args();a.output.mkdir(exist_ok=True,parents=True)
rows=[json.loads(x) for x in (a.burst/'measurements.jsonl').read_text().splitlines()]
names=list(dict.fromkeys(r['case'] for r in rows))
colors={'baseline':'#64748b','candidate':'#0d9488'}
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':10,'axes.spines.top':False,'axes.spines.right':False,'figure.facecolor':'white'})
summary=[]
fig,axes=plt.subplots(1,3,figsize=(15,5.8),layout='constrained')
metrics=[('rows_per_s',1e-3,'Throughput (thousand rows / second)'),('cpu_per_row',1,'Server CPU (µs / row)'),('p95_ms',1,'Request latency p95 (ms)')]
for row in rows:row['cpu_per_row']=row['cpu_s']*1e6/row['rows']
for ax,(metric,scale,title) in zip(axes,metrics):
    for i,name in enumerate(names):
        for arm,offset in [('baseline',-.18),('candidate',.18)]:
            values=[r[metric]*scale for r in rows if r['case']==name and r['arm']==arm]
            ax.barh(i+offset,statistics.median(values),height=.32,color=colors[arm],label=arm.title() if i==0 else None,alpha=.85)
            ax.scatter(values,[i+offset]*len(values),color='#172033',s=13,zorder=3)
    ax.set_yticks(range(len(names)),[n.replace('_c',' · c=') for n in names]);ax.invert_yaxis();ax.set_title(title,loc='left',pad=15);ax.grid(axis='x',alpha=.15);ax.set_axisbelow(True)
axes[0].legend(loc='lower right')
fig.suptitle('Parseable ingestion • real HTTP requests, local filesystem storage',fontsize=16,x=.01,ha='left')
fig.supxlabel('Bars: medians. Dots: individual runs. Four server CPUs; identical payloads and settings; shared host.\nBackground work remains enabled. Standard release build, without production fat LTO.',fontsize=10)
for ext in ['png','svg']:fig.savefig(a.output/f'http-throughput.{ext}',dpi=170,bbox_inches='tight')
for name in names:
    grouped={arm:{r['pair']:r for r in rows if r['case']==name and r['arm']==arm} for arm in colors}
    ratios=[grouped['candidate'][k]['rows_per_s']/grouped['baseline'][k]['rows_per_s'] for k in grouped['baseline']]
    summary.append({'case':name,'pairs':len(ratios),'paired_throughput_ratios':ratios,'median_paired_speedup':statistics.median(ratios),'arms':{arm:{key:statistics.median([r[key] for r in grouped[arm].values()]) for key in ['rows_per_s','p95_ms','cpu_per_row']} for arm in colors}})
(a.output/'http-summary.json').write_text(json.dumps(summary,indent=2))
if a.sustained:
    fig,axes=plt.subplots(4,1,figsize=(11,10),sharex=True,layout='constrained')
    for arm in colors:
        document=json.loads((a.sustained/f'{arm}-samples.json').read_text());result=document['result'];samples=result['samples'];x=[s['elapsed_s'] for s in samples]
        axes[0].plot(x,[s['rss_bytes']/2**20 for s in samples],label=arm.title(),color=colors[arm])
        axes[1].plot(x,[s['staging_bytes']/2**20 for s in samples],color=colors[arm])
        cpu=np.diff([s['cpu_s'] for s in samples])/np.diff(x)
        axes[2].plot(x[1:],cpu,color=colors[arm],alpha=.8)
        observations=sorted(document['observations'],key=lambda o:o['request'])
        rate=result['offered_rows_per_s']/1000
        axes[3].plot([o['request']/rate for o in observations],[o['scheduled_latency_s']*1000 for o in observations],color=colors[arm],lw=.6,alpha=.75)
        axes[3].set_yscale('log')
    for ax,label in zip(axes,['Server RSS (MiB)','Staged file size (MiB)','CPU seconds / second','Scheduled latency (ms, log)']):ax.set_ylabel(label);ax.grid(alpha=.15);ax.axvline(result['duration_s'],color='#334155',ls='--',lw=1)
    axes[0].legend();axes[-1].set_xlabel('Seconds since scheduled start; dashed line ends offered load, followed by background drain')
    fig.suptitle(f'Sustained ingestion • {result["offered_rows_per_s"]:,.0f} offered rows/s • one run per arm',fontsize=15)
    for ext in ['png','svg']:fig.savefig(a.output/f'sustained-resources.{ext}',dpi=170,bbox_inches='tight')
print(json.dumps(summary,indent=2))
