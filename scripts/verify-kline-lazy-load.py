"""Browser regression for history prepend with an active crosshair and live updates.

Start pnpm dev, then run python scripts/verify-kline-lazy-load.py --url http://127.0.0.1:5173.
Uses the real React hooks, Zustand store and lightweight-charts, without account data.
"""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

SCENARIO = r"""async ({period, symbol, price, strengthVersion}) => {
  globalThis.process = {env:{}};
  const {default:React} = await import('/node_modules/.vite/deps/react.js');
  const {default:{createRoot}} = await import('/node_modules/.vite/deps/react-dom_client.js');
  const {createChart} = await import('/node_modules/.vite/deps/lightweight-charts.js');
  const {useChartSeries} = await import('/src/components/market/kline/use-chart-series.ts');
  const {useRealtimeKline} = await import('/src/components/market/kline/use-realtime-kline.ts');
  const {useMarketStore} = await import('/src/stores/market.ts');
  const {offerRtBar, clearRtAccumulator} = await import('/src/components/market/kline/realtime/accumulator.ts');
  const {DEFAULT_INDICATOR_CONFIG} = await import('/src/types/indicator-defaults.ts');
  const {calcSMA,calcMACD} = await import('/src/lib/indicators.ts');
  const {formatChartTime} = await import('/src/components/market/kline/utils.ts');
  const {recoverSeriesData} = await import('/src/components/market/kline/realtime/update.ts');
  const cfg = structuredClone(DEFAULT_INDICATOR_CONFIG);
  cfg.boll.enabled = cfg.rsi.enabled = cfg.jdk.enabled = true;
  cfg.strengthVersion = strengthVersion;
  cfg.strength.enabled = cfg.strengthV2.enabled = true;
  const minutes = {'1m':1,'5m':5,'15m':15,'30m':30,'60m':60,'240m':240,'1d':1440}[period];
  const bars = Array.from({length:1440},(_,i) => {
    const close = price * (1 + Math.sin(i/8)*.04 + i*.0001);
    const time = new Date(Date.UTC(2022,0,1) + i*minutes*60000).toISOString().replace('T',' ').slice(0,period==='1d'?10:19);
    return {time,open:close-price*.001,high:close+price*.01,low:close-price*.01,close,volume:20,market_source:'okx',is_closed:true};
  });
  const chart = createChart(document.querySelector('#chart'));
  const ref = current => ({current});
  const state = {mainApiRef:ref(chart),seriesRef:ref(null),tickSeriesRef:ref(null),volumeRef:ref(null),maSeriesRef:ref([]),bollSeriesRef:ref([null,null,null]),subHandlesRef:ref(new Map()),pivotMarkersRef:ref(null),currentBarsRef:ref([]),isNearLatest:ref(false),lastRealtimeTime:ref(null),scrollTimerRef:ref(null),skipScrollRef:ref(false),prevBarsCountRef:ref(0),savedRangeRef:ref(null),tickDataRef:ref([])};
  clearRtAccumulator();
  useMarketStore.setState({klineBars:{},klineRealtime:{}});
  useMarketStore.getState().setKlineBars(symbol,period,bars.slice(-240));
  function Harness() {
    const currentBars = useMarketStore(s=>s.klineBars[symbol][period]);
    const [,setMaLabels] = React.useState([]);
    state.currentBarsRef.current = currentBars;
    const props = {...state,currentBars,config:cfg,period,activeContract:symbol,setMaLabels,chartReady:1,onSeriesReady:null};
    useChartSeries(props);
    useRealtimeKline(props);
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  const wait = ms => new Promise(r=>setTimeout(r,ms));
  // The viewport anchor uses two animation frames; wall-clock sleeps alone
  // are not sufficient when Chrome is busy or its background frames throttle.
  const painted = () => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const failures = [], pages = [];
  root.render(React.createElement(Harness));
  await wait(500);
  await painted();
  try {
    for (const n of [240,480,720,960,1200,1440]) {
      if (n>240) {
        chart.timeScale().setVisibleLogicalRange({from:40,to:130});
        await wait(50);
        await painted();
        const old = bars.slice(-(n-240))[80];
        chart.setCrosshairPosition(old.close,formatChartTime(period,old.time),state.seriesRef.current);
        state.isNearLatest.current = false;
        state.skipScrollRef.current = true;
        state.savedRangeRef.current = chart.timeScale().getVisibleLogicalRange();
        state.prevBarsCountRef.current = n-240;
        useMarketStore.getState().prependKlineBars(symbol,period,bars.slice(-n,-n+240));
      }
      const latest = {...bars.at(-1),close:bars.at(-1).close+price*.0001,version:Date.now(),kind:'correction',is_closed:false};
      offerRtBar(symbol,period,latest);
      useMarketStore.getState().updateKlineRealtime([{symbol,period,bar:latest}]);
      await wait(150);
      await painted();
      const rendered = [...bars.slice(-n,-1),latest];
      const candle = state.seriesRef.current;
      if (n===720) {
        chart.setCrosshairPosition(rendered[300].close,formatChartTime(period,rendered[300].time),candle);
        recoverSeriesData({...state,config:cfg},rendered,period,ref(0));
        await painted();
      }
      const counts = {n,candle:candle.data().length,ma:state.maSeriesRef.current.map(s=>s.data().length),subs:[...state.subHandlesRef.current].map(([id,h])=>[id,h.series.map(s=>s.data().length)])};
      pages.push(counts);
      if (counts.candle!==n) failures.push(`${n}: candles ${counts.candle}`);
      state.maSeriesRef.current.forEach((s,i)=>{
        const expected = calcSMA(rendered,cfg.maLines[i].period);
        if(s.data().length!==expected.length || s.data().at(-1)?.value!==expected.at(-1)?.value) failures.push(`${n}: MA${cfg.maLines[i].period}`);
      });
      const macd = calcMACD(rendered,cfg.macd.fastPeriod,cfg.macd.slowPeriod,cfg.macd.signalPeriod);
      state.subHandlesRef.current.get('macd').series.forEach((s,i)=>{
        if(s.data().length!==macd.length || s.data().at(-1)?.value!==macd.at(-1)?.[['dif','dea','macd'][i]]) failures.push(`${n}: MACD ${i}`);
      });
      for(const [id,h] of state.subHandlesRef.current) {
        if(h.series.some(s=>s.data().length<n-40)) failures.push(`${n}: ${id} missing history`);
      }
      if (n>240) {
        const range = chart.timeScale().getVisibleLogicalRange();
        if(Math.abs(range.from-280)>.01 || Math.abs(range.to-370)>.01) failures.push(`${n}: viewport ${JSON.stringify(range)}`);
      }
      // Hovering remains usable immediately after the batch and recovery.
      chart.setCrosshairPosition(rendered[300 % n].close,formatChartTime(period,rendered[300 % n].time),candle);
    }
    return {period,symbol,strengthVersion,pages,failures};
  } finally {
    root.unmount();
    clearTimeout(state.scrollTimerRef.current);
    chart.remove();
  }
}"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:5173')
    parser.add_argument('--out', type=Path, default=Path('.local-data/kline-lazy/report.json'))
    parser.add_argument('--quick', action='store_true')
    args = parser.parse_args()
    reports, errors = [], []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel='chrome', headless=True)
        try:
            cases = [('1m','btcusdt',60000,'v1')] if args.quick else [
                (period,symbol,price,'v1' if symbol=='btcusdt' else 'v2')
                for period in ['1m','5m','15m','30m','60m','240m','1d']
                for symbol,price in [('btcusdt',60000),('pepeusdt',.000008)]
            ]
            for period,symbol,price,strength in cases:
                page = browser.new_page(viewport={'width':1200,'height':900})
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.on('console', lambda m: errors.append(m.text) if m.type=='warning' and '失败' in m.text else None)
                page.route('**/__kline_regression__',lambda r:r.fulfill(content_type='text/html',body='<div id="chart" style="width:1100px;height:800px"></div>'))
                page.goto(args.url.rstrip('/')+'/__kline_regression__',wait_until='networkidle')
                report = page.evaluate(SCENARIO,{'period':period,'symbol':symbol,'price':price,'strengthVersion':strength})
                reports.append(report)
                print(f'{period} {symbol}: {len(report["failures"])} failures',flush=True)
                page.close()
        finally:
            browser.close()
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps({'reports':reports,'errors':errors},ensure_ascii=False,indent=2),encoding='utf-8')
    failures = [failure for report in reports for failure in report['failures']]
    assert not failures and not errors, f'{len(failures)} data/viewport failures, {len(errors)} browser errors; see {args.out}'
    print(f'PASS: {len(reports)} scenarios, {sum(len(r["pages"]) for r in reports)} history pages, no chart errors')


if __name__ == '__main__':
    main()
