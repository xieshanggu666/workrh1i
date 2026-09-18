import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { bus } from '../phaser/battleBus'
import { startPhaser } from '../phaser/BattleScene.js'

// 单条结算动画的等待上限：Phaser 未就绪/异常时也能自动解锁操作
const ACK_TIMEOUT = 8000

export default function BattleView({ view }) {
  const mountRef = useRef(null)
  const gameRef = useRef(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const animatingRef = useRef(false)
  const seqRef = useRef(0)
  const [animating, setAnimating] = useState(false)
  const [log, setLog] = useState([])
  const [handTick, setHandTick] = useState(0) // 手牌重渲染节拍（发牌动画用）
  const runId = useStore((s) => s.runId)
  const applyRun = useStore((s) => s.applyRun)
  const setBattleAnimating = useStore((s) => s.setBattleAnimating)
  const cardMeta = useStore((s) => s.cardMeta)
  const [err, setErr] = useState('')

  // 挂载：启动 Phaser；就绪握手后重发当前快照（首帧/续局恢复都走这里）
  useEffect(() => {
    gameRef.current = startPhaser(mountRef.current)
    let mounted = true
    const pushSnapshot = () => {
      if (!mounted) return
      const v = viewRef.current
      // includeDead：续局/刷新恢复时按终态直接呈现，不等待死亡动画
      bus.emit('snapshot', { snapshot: (v && v.battle) || { player: null, enemy: null }, includeDead: true })
      setHandTick((t) => t + 1)
    }
    const offReady = bus.on('phaser_ready', pushSnapshot)
    return () => {
      mounted = false
      offReady()
      bus.clear()
      animatingRef.current = false
      setBattleAnimating(false)
      gameRef.current?.destroy(true)
    }
  }, [])

  // 续局/刷新恢复：服务端状态可能在战斗中被外部更新，整包同步给场景（无播放队列）
  useEffect(() => {
    bus.emit('snapshot', { snapshot: view.battle || { player: null, enemy: null }, includeDead: true })
  }, [view.battle])

  function emitAck(entry) {
    return new Promise((resolve) => {
      let done = false
      const finish = (p) => {
        if (done) return
        if (!p || (p.token === entry.token && p.seq === entry.seq)) {
          done = true
          off()
          clearTimeout(timer)
          resolve()
        }
      }
      const off = bus.on('entry_done', finish)
      const timer = setTimeout(() => finish({ token: entry.token, seq: entry.seq }), ACK_TIMEOUT)
      bus.emit('sequence', { token: entry.token, entry })
    })
  }

  function entryWithToken(raw, token, seq) {
    return { ...raw, token, seq }
  }

  async function doAct(action, extra = {}) {
    // 同步引用判定：动画播放期间严格锁定，任何重入/快速连点都直接忽略
    if (animatingRef.current) return
    animatingRef.current = true
    setAnimating(true)
    setBattleAnimating(true)
    setErr('')
    let res
    try {
      res = await api.act(runId, { action, ...extra })
    } catch (e) {
      animatingRef.current = false
      setAnimating(false)
      setBattleAnimating(false)
      setErr(e.message)
      return
    }
    const entries = (res.log || []).filter(Boolean)
    // 严格按服务端结算顺序播放连锁（出牌前摇 → 伤害/格挡/状态 → 快照 → 胜负）
    const token = ++seqRef.current
    try {
      for (let seq = 0; seq < entries.length; seq++) {
        await emitAck(entryWithToken(entries[seq], token, seq))
      }
    } finally {
      animatingRef.current = false
      setAnimating(false)
      setBattleAnimating(false)
    }
    // 战后领奖衔接：终态（含血量/护盾/手牌、奖励选项/通关结算）在死亡动画后提交
    setLog(entries.filter((e) => !e.phase && !e.snapshot && !e.result && !e.reward_claimed))
    applyRun(res.run)
  }

  const b = view.battle
  const hand = b?.hand || []
  const energy = b?.energy ?? view.energy
  const inTurn = b?.in_turn
  const ended = view.status === 'won' || view.status === 'lost'

  // 手牌项兼容旧档裸 id；新档为 {uid,id,cost,forges}（费用已含锻造换算）
  const handCard = (item) => {
    if (typeof item === 'string') {
      return { uid: item, id: item, cost: cardMeta(item)?.cost ?? 0, forges: [] }
    }
    return { uid: item.uid, id: item.id, cost: item.cost ?? cardMeta(item.id)?.cost ?? 0, forges: item.forges || [] }
  }

  const locked = animating || !inTurn || ended
  function canPlay(hc) {
    return inTurn && !ended && hc.cost <= energy && !animating
  }

  return (
    <div className={`battle ${animating ? 'is-animating' : ''}`}>
      <div ref={mountRef} className="phaser" />
      <div className="handbar" aria-busy={animating}>
        <div className={`energy ${animating ? 'syncing' : ''}`}>
          能量 <b>{energy}</b> / {b?.max_energy ?? view.energy}
        </div>
        <div className="hand" key={handTick}>
          {hand.length === 0 && <span className="hint">手牌为空</span>}
          {hand.map((item, i) => {
            const hc = handCard(item)
            const c = cardMeta(hc.id) || { id: hc.id, name: hc.id, type: 'attack', desc: '' }
            return (
              <button
                key={hc.uid}
                className={`card ${c.type} ${canPlay(hc) ? 'playable' : ''} ${hc.forges.length ? 'forged' : ''}`}
                style={{ animationDelay: `${Math.min(i, 7) * 55}ms` }}
                onClick={() => canPlay(hc) && doAct('play', { card: hc.uid })}
                disabled={!canPlay(hc)}
                title={c.desc}
              >
                <span className="ccost">{hc.cost}</span>
                <span className="cname">{c.name}</span>
                {hc.forges.length > 0 && (
                  <span className="handforges">
                    {hc.forges.map((f, j) => (
                      <i key={j} className={`ftag ${f}`}>{({ sharpen: '锋', empower: '强', refine: '炼' })[f] || f}</i>
                    ))}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <button
          className="primary"
          onClick={() => doAct('end_turn')}
          disabled={locked}
        >
          {animating ? '结算中…' : '结束回合'}
        </button>
      </div>
      {log.length > 0 && (
        <div className="eventlog">
          {log.map((ev, i) => <span key={i} className="ev">{fmtEvent(ev)}</span>)}
        </div>
      )}
      {animating && <div className="lockhint">动画播放中，操作已锁定</div>}
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
