import React, { useEffect, useRef, useState } from 'react'
import Phaser from 'phaser'
import { api } from '../api'
import { useStore } from '../store'
import { bus } from '../phaser/battleBus'
import { startPhaser } from '../phaser/BattleScene.js'

export default function BattleView({ view }) {
  const mountRef = useRef(null)
  const gameRef = useRef(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState([])
  const runId = useStore((s) => s.runId)
  const applyRun = useStore((s) => s.applyRun)
  const cardMeta = useStore((s) => s.cardMeta)
  const [err, setErr] = useState('')

  useEffect(() => {
    gameRef.current = startPhaser(mountRef.current)
    const off = bus.on('phaser_ready', () => {
      const v = viewRef.current
      bus.emit('snapshot', (v && v.battle) || { player: null, enemy: null })
    })
    const offReset = bus.on('reset', () => {})
    return () => {
      bus.clear()
      off()
      offReset()
      gameRef.current?.destroy(true)
    }
  }, [])

  useEffect(() => {
    bus.emit('snapshot', view.battle || { player: null, enemy: null })
    // 若战斗中且有获胜/失败快照，展示
  }, [view.battle, view])

  async function doAct(action, extra = {}) {
    setBusy(true); setErr('')
    try {
      const res = await api.act(runId, { action, ...extra })
      // 播放结算日志到 Phaser
      ;(res.log || []).forEach((ev) => bus.emit('event', ev))
      setLog(res.log || [])
      applyRun(res.run)
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const b = view.battle
  const hand = b?.hand || []
  const energy = b?.energy ?? view.energy
  const inTurn = b?.in_turn

  // 手牌项兼容旧档裸 id；新档为 {uid,id,cost,forges}（费用已含锻造换算）
  const handCard = (item) => {
    if (typeof item === 'string') {
      return { uid: item, id: item, cost: cardMeta(item)?.cost ?? 0, forges: [] }
    }
    return { uid: item.uid, id: item.id, cost: item.cost ?? cardMeta(item.id)?.cost ?? 0, forges: item.forges || [] }
  }

  function canPlay(hc) {
    return inTurn && hc.cost <= energy && busy === false
  }

  return (
    <div className="battle">
      <div ref={mountRef} className="phaser" />
      <div className="handbar">
        <div className="energy">能量 {energy} / {b?.max_energy ?? view.energy}</div>
        <div className="hand">
          {hand.length === 0 && <span className="hint">手牌为空</span>}
          {hand.map((item) => {
            const hc = handCard(item)
            const c = cardMeta(hc.id) || { id: hc.id, name: hc.id, type: 'attack', desc: '' }
            return (
              <button
                key={hc.uid}
                className={`card ${c.type} ${canPlay(hc) ? 'playable' : ''} ${hc.forges.length ? 'forged' : ''}`}
                onClick={() => canPlay(hc) && doAct('play', { card: hc.uid })}
                disabled={!canPlay(hc)}
                title={c.desc}
              >
                <span className="ccost">{hc.cost}</span>
                <span className="cname">{c.name}</span>
                {hc.forges.length > 0 && (
                  <span className="handforges">
                    {hc.forges.map((f, i) => (
                      <i key={i} className={`ftag ${f}`}>{({ sharpen: '锋', empower: '强', refine: '炼' })[f] || f}</i>
                    ))}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <button className="primary" onClick={() => doAct('end_turn')} disabled={!inTurn || busy}>
          结束回合
        </button>
      </div>
      {log.length > 0 && (
        <div className="eventlog">
          {log.map((ev, i) => <span key={i} className="ev">{fmtEvent(ev)}</span>)}
        </div>
      )}
      {err && <div className="error">{err}</div>}
    </div>
  )
}

function fmtEvent(ev) {
  if (!ev) return ''
  const tgt = ev.target === 'player' ? '你' : '敌'
  switch (ev.action) {
    case 'damage':
    case 'echo_damage':
      return `${tgt} 受 ${ev.value} 伤害`
    case 'gain_block':
      return `${tgt} 获得 ${ev.value} 格挡`
    case 'heal':
      return `${tgt} 回复 ${ev.value}`
    case 'apply_status': {
      const s = ev.extra?.status || '状态'
      return `${tgt} ${s} +${ev.value}`
    }
    case 'truncated':
      return '⚠ 连锁被强制终止（触发上限）'
    default:
      return ev.action
  }
}