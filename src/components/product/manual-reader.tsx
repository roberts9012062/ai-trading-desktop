"use client"
import { useEffect, useRef, useState } from "react"
import { ArrowLeft, ArrowRight, Search, X, BookOpen } from "lucide-react"
import { manualChapters } from "@/lib/manual-content"
import "./product.css"
import "./manual.css"

export function ManualReader({assetBase = "/manual"}: {assetBase?:string}) {
  const [active,setActive]=useState("install")
  const [query,setQuery]=useState("")
  const [menuOpen,setMenuOpen]=useState(false)
  const [zoom,setZoom]=useState(false)
  const dialogRef=useRef<HTMLDialogElement>(null)
  const articleRef=useRef<HTMLElement>(null)
  const selected=manualChapters.find(c=>c.id===active) ?? manualChapters[0]
  const index=manualChapters.indexOf(selected)
  const filtered=manualChapters.filter(c=>`${c.title} ${c.intro} ${c.steps.join(" ")} ${c.sections?.map(s=>s.title+" "+s.text).join(" ") ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()))
  const groups=[...new Set(filtered.map(c=>c.group))]
  useEffect(()=>{
    function sync(){const id=location.hash.slice(1);if(manualChapters.some(c=>c.id===id)){setActive(id);setMenuOpen(false);setZoom(false)}}
    sync();window.addEventListener("hashchange",sync);return()=>window.removeEventListener("hashchange",sync)
  },[])
  useEffect(()=>{if(zoom)dialogRef.current?.showModal();else dialogRef.current?.close()},[zoom])
  function choose(id:string){setActive(id);setMenuOpen(false);setZoom(false);history.replaceState(null,"",`#${id}`);articleRef.current?.scrollIntoView({block:"start",behavior:"instant"})}
  return <div className="cp-site cp-manual"><div className="cp-manual-head"><p className="cp-eyebrow"><BookOpen size={15}/> CYCLEPILOT FIELD GUIDE</p><h1>使用手册</h1><p>从第一次登录，到建立自己的研究与交易流程。</p><span>桌面端 v0.2.151 · 图示采集于 v0.2.150 · 更新于 2026.10.09</span></div><div className="cp-manual-grid"><aside className={`cp-manual-nav ${menuOpen ? "is-open" : ""}`}><button className="cp-mobile-menu" onClick={()=>setMenuOpen(!menuOpen)} aria-expanded={menuOpen}>目录 · {selected.title} <span>{menuOpen ? "−" : "+"}</span></button><div className="cp-manual-nav-inner"><label className="cp-manual-search"><Search size={16}/><input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索功能或操作…" aria-label="搜索使用手册" /></label><nav aria-label="使用手册目录">{groups.map(group=><div key={group}><h2>{group}</h2>{filtered.filter(c=>c.group===group).map(c=><a key={c.id} href={`#${c.id}`} aria-current={active===c.id ? "page" : undefined} onClick={e=>{e.preventDefault();choose(c.id)}}>{c.title}</a>)}</div>)}{filtered.length===0 && <p className="cp-no-results">未找到相关内容，请换个关键词。</p>}</nav><p className="cp-manual-count">{query ? `${filtered.length} 个匹配章节` : `${manualChapters.length} 个章节 · 按操作流程排列`}</p></div></aside><article className="cp-manual-article" id={selected.id} ref={articleRef}><div className="cp-chapter-label">{selected.group}<span>{String(index+1).padStart(2,"0")} / {manualChapters.length}</span></div><h2>{selected.title}</h2><p className="cp-chapter-intro">{selected.intro}</p><figure><button className="cp-shot-button" onClick={()=>setZoom(true)} aria-label={`放大${selected.title}截图`}><img src={`${assetBase}/${selected.image}.jpg`} alt={`周期领航${selected.title}功能界面`} loading="lazy"/><span>查看大图 ↗</span></button><figcaption>功能界面实拍 · 图片中的数据、金额和配置仅为当时示例，请以你的账号及当前版本为准。</figcaption></figure><h3>操作步骤</h3><ol className="cp-manual-steps">{selected.steps.map((step,i)=><li key={step}><span>{String(i+1).padStart(2,"0")}</span><p>{step}</p></li>)}</ol>{selected.sections?.map(section=><section key={section.title}><h3>{section.title}</h3><p>{section.text}</p></section>)}{selected.note && <aside className="cp-manual-note"><strong>使用提示</strong><p>{selected.note}</p></aside>}<div className="cp-manual-pagination">{index>0 ? <button onClick={()=>choose(manualChapters[index-1].id)}><ArrowLeft size={16}/><span><small>上一章</small>{manualChapters[index-1].title}</span></button>:<span/>}{index<manualChapters.length-1 && <button onClick={()=>choose(manualChapters[index+1].id)}><span><small>下一章</small>{manualChapters[index+1].title}</span><ArrowRight size={16}/></button>}</div></article></div><dialog className="cp-shot-dialog" ref={dialogRef} onCancel={()=>setZoom(false)} onClick={e=>{if(e.target===e.currentTarget)setZoom(false)}}><button onClick={()=>setZoom(false)} aria-label="关闭截图"><X size={22}/></button><img src={`${assetBase}/${selected.image}.jpg`} alt={`${selected.title}完整截图`}/><p>{selected.title} · 按 Esc 关闭</p></dialog></div>
}
