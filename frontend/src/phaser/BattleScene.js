import Phaser from 'phaser'
import { bus } from './battleBus'

// 用一个可复用图形，简化未加载贴图的情况：Art: none needed, draw via Graphics.
// 敌人/玩家用一个圆 + 名字 + 血条表示，事件日志由 React 驱动，这里负责浮动数字与状态标签。
function drawEntity(scene, key, x, y, color, radius) {
  const g = scene.add.graphics()
  g.fillStyle(color, 1)
  g.fillCircle(0, 0, radius)
  const label = scene.add.text(x - 30, y + radius + 6, '', { font: '14px sans-serif', fill: '#fff' })
  const hp = scene.add.text(x - 30, y - radius - 26, '', { font: '13px sans-serif', fill: '#4f8' })
  const st = scene.add.text(x - 30, y - radius - 6, '', { font: '11px sans-serif', fill: '#fc6' })
  const container = { g, label, hp, st, x, y }
  scene._entities = scene._entities || {}
  scene._entities[key] = container
  return container
}

export default class BattleScene extends Phaser.Scene {
  constructor() {
    super('battle')
  }

  create() {
    this._entities = {}
    this._floats = {}

    drawEntity(this, 'player', 180, 300, 0x3a7bd5, 42)
    drawEntity(this, 'enemy', 820, 300, 0xe04850, 46)

    this.setSnapshot({ player: { name: '勇者', hp: 1, max_hp: 1, statuses: [] }, enemy: { name: '敌人', hp: 1, max_hp: 1, statuses: [] } })

    this._handlers = []
    this._handlers.push(bus.on('snapshot', (s) => this.setSnapshot(s)))
    this._handlers.push(bus.on('event', (ev) => this.playEvent(ev)))
    this._handlers.push(bus.on('reset', () => this.setSnapshot({ player: { hp: 0, max_hp: 1, statuses: [] }, enemy: { hp: 0, max_hp: 1, statuses: [] } })))
    // 就绪握手：通知 React 可以重发一次当前快照，避免首帧丢失
    bus.emit('phaser_ready')
  }

  setSnapshot(s) {
    for (const key of ['player', 'enemy']) {
      const d = s && s[key]
      const ent = this._entities[key]
      if (!d || !ent) continue
      ent.label.setText(d.name || key)
      ent.hp.setText(`${d.hp ?? 0} / ${d.max_hp ?? 0}`)
      const statuses = Array.isArray(d.statuses) ? d.statuses : []
      ent.st.setText(statuses.map((st) => `${st.name}${st.value}`).join(' ') || '')
      const alive = d.alive !== false && d.hp > 0
      ent.g.fillStyle(key === 'player' ? 0x3a7bd5 : 0xe04850, alive ? 1 : 0.2)
      ent.g.clear()
      ent.g.fillStyle(key === 'player' ? 0x3a7bd5 : 0xe04850, alive ? 1 : 0.2)
      ent.g.fillCircle(0, 0, key === 'player' ? 42 : 46)
      drawBar(this, key, d)
    }
  }

  playEvent(ev) {
    // ev: {action, target, value, source}
    if (!ev) return
    const targetKey = ev.target === 'player' ? 'player' : 'enemy'
    const ent = this._entities[targetKey]
    if (!ent) return
    if (ev.action === 'damage' || ev.action === 'echo_damage') {
      this.floatText(ent.x, ent.y - 40, `-${ev.value}`, 0xff5555)
    } else if (ev.action === 'gain_block') {
      this.floatText(ent.x, ent.y - 40, `格挡 +${ev.value}`, 0x88c0ff)
    } else if (ev.action === 'heal') {
      this.floatText(ent.x, ent.y - 40, `+${ev.value} 生命`, 0x55ff88)
    } else if (ev.action === 'apply_status' || ev.action === 'set_status') {
      this.floatText(ent.x, ent.y - 40, `状态 ${ev.extra?.status} +${ev.value}`, 0xffcc66)
    }
  }

  floatText(x, y, text, color) {
    const t = this.add.text(x, y, text, { font: '20px sans-serif', fill: Phaser.Display.Color.IntegerToColor(color).css })
    this.tweens.add({ targets: t, y: y - 40, alpha: 0, duration: 800, onComplete: () => t.destroy() })
  }

  destroy() {
    if (this._handlers) this._handlers.forEach((off) => off())
    super.destroy()
  }
}

function drawBar(scene, key, snapshot) {
  if (!scene._bars) scene._bars = {}
  if (scene._bars[key]) scene._bars[key][1].destroy()
  const w = 160
  const x = key === 'player' ? 120 : 780
  const y = 366
  const pct = Math.max(0, Math.min(1, (snapshot && snapshot.hp) / (snapshot && snapshot.max_hp || 1)))
  const bg = scene.add.rectangle(x + w / 2, y, w, 12, 0x222)
  const fg = scene.add.rectangle(x + (w * pct) / 2, y, w * pct, 12, key === 'player' ? 0x3a7bd5 : 0xe04850)
  scene._bars[key] = [bg, fg]
}

export function startPhaser(container) {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: container,
    width: 960,
    height: 480,
    backgroundColor: '#1a1a24',
    scene: BattleScene,
  })
  return game
}