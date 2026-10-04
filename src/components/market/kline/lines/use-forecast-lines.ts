"use client"
import {useEffect,type RefObject} from 'react'
import {LineStyle,type ISeriesApi,type AutoscaleInfo} from 'lightweight-charts'
import type {AITradingTask} from '@/lib/ai-trading-api'
import {forecastLines} from '@/lib/ai-forecast'
export function useForecastLines({seriesRef,tasks,symbol,ready}:{seriesRef:RefObject<ISeriesApi<'Candlestick'>|null>;tasks:AITradingTask[];symbol:string;ready:number}):void {
 const lines=JSON.stringify(tasks.filter(t=>t.symbol.toLowerCase()===symbol.toLowerCase()).flatMap(t=>forecastLines(t).map(x=>({...x,title:`${t.name} · ${x.title}`}))))
 useEffect(()=>{const current=seriesRef.current;if(!current)return
  return drawForecastLines(current,JSON.parse(lines) as ReturnType<typeof forecastLines>)
 },[seriesRef,ready,lines])
}

/** Keep all prediction levels visible while retaining the chart's original scale provider. */
export function drawForecastLines(current:ISeriesApi<'Candlestick'>,lines:ReturnType<typeof forecastLines>):()=>void {
 const drawn=lines.map(x=>current.createPriceLine({...x,lineWidth:2,lineStyle:LineStyle.Dashed,axisLabelVisible:true}))
 const original=current.options().autoscaleInfoProvider
 if(lines.length)current.applyOptions({autoscaleInfoProvider:(base:()=>AutoscaleInfo|null)=>{
  const info=original?original(base):base();if(!info?.priceRange)return info
  return {...info,priceRange:{minValue:Math.min(info.priceRange.minValue,...lines.map(x=>x.price)),maxValue:Math.max(info.priceRange.maxValue,...lines.map(x=>x.price))}}
 }})
 return()=>{try{for(const line of drawn)current.removePriceLine(line);if(lines.length)current.applyOptions({autoscaleInfoProvider:original})}catch{/* disposed chart */}}
}
