import React, { useEffect, useState } from 'react'
import { api } from './api'
import { useStore } from './store'
import MapView from './components/MapView.jsx'
import BattleView from './components/BattleView.jsx'
import RewardView from './components/RewardView.jsx'
import ForgeView from './components/ForgeView.jsx'
import DeckView from './components/DeckView.jsx'

export default function App() {
  const { view, setCards, cards, runId, setRunId, applyRun } = useStore()
  const [seed, setSeed] = useState('')
  const [resumeId, setResumeId] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    api.cards().then(setCards).catch(() => {})
  }, [])

  async function create() {
    setLoading(true); setErr('')
    try {
      const run = await api.createRun(seed ? Number(seed) : undefined)
      applyRun(run)
      setRunId(run.run_id)
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function resume() {
    if (!resumeId) return
    setLoading(true); setErr('')
    try {
      const run = await api.resume(resumeId)
      applyRun(run)
      setRunId(run.run_id)
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function refreshRun() {
    if (!runId) return
    setErr('')
    try {
      const run = await api.resume(runId)
      applyRun(run)
    } catch (e) {
      setErr(e.message)
    }
  }

  async function newRun() {
    setErr('')
    const run = await api.createRun()
    applyRun(run)
    setRunId(run.run_id)
  }

  if (!view) {
    return (
      <div className="screen home">
        <div className="panel">
          <h1>卡牌闯关</h1>
          <p>选择路线 · 构筑牌组 · 挑战首领 · 失败解锁新卡</p>
          <div className="fieldrow">
            <span>种子（可选）</span>
            <input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="随机" />
          </div>
          <button className="primary" onClick={create} disabled={loading}>
            {loading ? '创建中…' : '新建一局（随机种子）'}
          </button>
          <div className="divider" />
          <div className="fieldrow">
            <span>续局 ID</span>
            <input value={resumeId} onChange={(e) => setResumeId(e.target.value)} placeholder="粘贴 run_id" />
            <button onClick={resume} disabled={loading}>续局</button>
          </div>
          {err && <div className="error">{err}</div>}
        </div>
        {cards.length > 0 && <DeckView mode="extras" />}
      </div>
    )
  }

  const hasReward = !view.reward_claimed && view.reward_options && view.reward_options.length > 0
  const hasForge = view.forge_available === true
  const ended = view.status === 'won' || view.status === 'lost'

  return (
    <div className="screen">
      <header className="topbar">
        <span className="brand">卡牌闯关</span>
        <span>生命 {view.health}/{view.max_health}</span>
        <span>金币 {view.gold}</span>
        <span>牌组 {view.deck.length}</span>
        <span className="sub">种子 {view.status === 'in_progress' && '#'}{view.seed === undefined ? '' : view.seed}</span>
        <button className="mini" onClick={refreshRun}>刷新</button>
        <button className="mini" onClick={newRun}>新局</button>
      </header>

      {ended && (
        <div className="overlay">
          <div className="endcard">
            <h2>{view.status === 'won' ? '🎉 通关！' : '💀 失败'}</h2>
            <p>{view.status === 'lost' && '失败解锁了一张新卡。'}</p>
            <DeckView />
            <div className="fieldrow"><button className="primary" onClick={newRun}>再来一局</button></div>
          </div>
        </div>
      )}

      <div className="content">
        <div className="leftcol">
          <DeckView />
          {view.unlocked_cards && <Unlocks unlocked={view.unlocked_cards} />}
        </div>
        <div className="maincol">
          {view.in_battle ? (
            <BattleView view={view} />
          ) : (
            <MapView view={view} />
          )}
          {hasReward && !ended && <RewardView view={view} />}
          {hasForge && !ended && <ForgeView view={view} />}
        </div>
      </div>

      {err && <div className="error toast">{err}</div>}
    </div>
  )
}

function Unlocks({ unlocked }) {
  const { cardMeta } = useStore()
  return (
    <div className="panellist">
      <h3>已解锁卡</h3>
      <div className="unlockgrid">
        {unlocked.unlocked.map((id) => {
          const c = cardMeta(id)
          return <span key={id} className="chip">{c ? c.name : id}</span>
        })}
      </div>
    </div>
  )
}