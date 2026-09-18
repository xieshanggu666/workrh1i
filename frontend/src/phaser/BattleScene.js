import Phaser from 'phaser'
import { bus } from './battleBus'

// 设计分辨率：960x540（16:9）。Phaser 以 Scale.FIT 整体等比缩放，
// 战斗场景/玩家/敌人在任何容器宽度下都完整可见，不会被裁切。
const W = 960
const H = 540
const GROUND_Y = 400

const COLORS = {
  player: 0x3a7bd5,
  playerDark: 0x24568f,
  enemy: 0xe04850,
  enemyDark: 0x9c2f37,
  hpPlayer: 0x4fa8ff,
  hpEnemy: 0xe04850,
  block: 0x8fd0ff,
  hpText: '#dcecff',
}

// 各类结算条目的节拍（毫秒）。整个连锁严格按服务端日志顺序逐条播放。
const BEAT = {
  banner: 520,
  playCard: 360,
  attackLunge: 170,
  attackReturn: 190,
  hit: 320,
  float: 900,
  block: 420,
  heal: 460,
  status: 520,
  draw: 300,
  death: 1100,
  resultHold: 900,
}

export default class BattleScene extends Phaser.Scene {
  constructor() {
    super('battle')
  }

  create() {
    this._seqToken = 0
    this._queue = []
    this._running = false
    this._destroyed = false
    this._entities = {}

    this._buildArena()

    this._entities.player = this._makeEntity('player', 190, GROUND_Y, {
      color: COLORS.player, dark: COLORS.playerDark, radius: 40,
    })
    this._entities.enemy = this._makeEntity('enemy', 770, GROUND_Y, {
      color: COLORS.enemy, dark: COLORS.enemyDark, radius: 48, boss: false,
    })

    this.setSnapshot({
      player: { name: '勇者', hp: 1, max_hp: 1, block: 0, statuses: [], alive: true },
      enemy: { name: '敌人', hp: 1, max_hp: 1, block: 0, statuses: [], alive: true },
    })

    this._handlers = [
      bus.on('snapshot', (payload) => {
        // 两种载荷：裸快照（动作链内）或 {snapshot, includeDead}（续局/刷新恢复）
        if (payload && payload.snapshot && 'includeDead' in payload) {
          this.setSnapshot(payload.snapshot, { includeDead: !!payload.includeDead })
        } else {
          this.setSnapshot(payload)
        }
      }),
      bus.on('sequence', ({ token, entry }) => this._enqueue(token, entry)),
    ]
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.shutdown())
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.shutdown())
    // 就绪握手：React 收到后重发当前快照（续局/刷新恢复关键路径）
    bus.emit('phaser_ready')
  }

  // ---------- 场景美术（全部 Graphics 绘制，无需贴图资源） ----------
  _buildArena() {
    const bg = this.add.graphics()
    bg.fillGradientStyle(0x20203a, 0x20203a, 0x14141f, 0x14141f, 1)
    bg.fillRect(0, 0, W, H)

    // 远景装饰：星点 + 两侧廊柱，营造战场纵深
    const dots = this.add.graphics()
    const rng = mulberry(20260918)
    for (let i = 0; i < 60; i++) {
      const a = 0.08 + rng() * 0.3
      dots.fillStyle(0xbfc8ff, a)
      dots.fillCircle(rng() * W, rng() * (GROUND_Y - 60), 1 + rng() * 1.6)
    }
    for (const px of [60, W - 60]) {
      dots.fillStyle(0x171724, 1)
      dots.fillRect(px - 18, 90, 36, GROUND_Y - 90)
      dots.fillStyle(0x23233a, 1)
      dots.fillRect(px - 26, 82, 52, 12)
    }

    const ground = this.add.graphics()
    ground.fillGradientStyle(0x2b2b44, 0x2b2b44, 0x1c1c2e, 0x1c1c2e, 1)
    ground.fillRect(0, GROUND_Y + 26, W, H - GROUND_Y)
    ground.lineStyle(2, 0x3a3a5c, 0.7)
    ground.beginPath()
    ground.moveTo(0, GROUND_Y + 26)
    ground.lineTo(W, GROUND_Y + 26)
    ground.strokePath()
    // 双方站位光圈
    for (const [x, c] of [[190, 0x3a7bd5], [770, 0xe04850]]) {
      ground.lineStyle(2, c, 0.35)
      ground.strokeEllipse(x, GROUND_Y + 30, 130, 24)
    }

    // 居中横幅（回合/胜负）
    this._banner = this.add.text(W / 2, 130, '', {
      font: 'bold 34px sans-serif', fill: '#ffffff',
      stroke: '#000000', strokeThickness: 6,
    }).setOrigin(0.5).setAlpha(0).setDepth(60)
  }

  _makeEntity(key, x, y, { color, dark, radius, boss }) {
    const texKey = `body_${key}`
    if (!this.textures.exists(texKey)) this._makeBodyTexture(texKey, color, dark, radius)

    const shadow = this.add.ellipse(x, y + radius + 16, radius * 2.5, radius * 0.55, 0x000000, 0.35)
    const body = this.add.image(x, y, texKey).setDepth(10)

    const name = this.add.text(x, y - radius - 58, '', {
      font: 'bold 15px sans-serif', fill: '#ffffff',
      stroke: '#000000', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(20)

    // 血条
    const barW = 158
    const barH = 12
    const barY = y - radius - 34
    const barBg = this.add.rectangle(x, barY, barW + 4, barH + 4, 0x000000, 0.55)
      .setStrokeStyle(1, 0x000000, 0.8).setDepth(18)
    const hpFill = this.add.rectangle(x - barW / 2, barY, barW, barH, key === 'player' ? COLORS.hpPlayer : COLORS.hpEnemy)
      .setOrigin(0, 0.5).setDepth(19)
    const hpText = this.add.text(x, barY, '', {
      font: '11px sans-serif', fill: COLORS.hpText,
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(21)

    // 护盾徽章（block>0 时出现，带碰撞弹动）
    const shield = this.add.container(x + radius * 0.8, y - radius * 0.75).setDepth(22).setVisible(false)
    const sg = this.add.graphics()
    sg.fillStyle(0x0e2233, 0.9)
    sg.fillRoundedRect(-18, -15, 36, 30, 8)
    sg.lineStyle(2, COLORS.block, 1)
    sg.strokeRoundedRect(-18, -15, 36, 30, 8)
    shield.add(sg)
    const shieldTxt = this.add.text(0, 1, '', { font: 'bold 15px sans-serif', fill: '#bfe4ff' }).setOrigin(0.5)
    shield.add(shieldTxt)

    // 状态徽标行
    const statusRow = this.add.container(x, y + radius + 24).setDepth(20)

    const ent = {
      key, x, y, radius, color, body, shadow, name, barW, hpFill, hpText,
      shield, shieldTxt, statusRow, alive: true, dying: false,
      _idleTween: null, _shadowIdle: null, _blockValue: 0,
    }
    this._startIdle(ent)
    return ent
  }

  _makeBodyTexture(key, color, dark, r) {
    // 用 RenderTexture 离屏绘制生成实体贴图（无需外部美术资源）
    const size = r * 2 + 12
    const c = r + 6
    const rt = this.add.renderTexture(0, 0, size, size).setVisible(false)
    const g = this.add.graphics().setVisible(false)
    // 主体（圆球 + 描边 + 高光），敌人加角
    g.fillStyle(dark, 1)
    g.fillCircle(c, c, r + 2)
    g.fillStyle(color, 1)
    g.fillCircle(c, c, r)
    g.fillStyle(0xffffff, 0.18)
    g.fillEllipse(c - r * 0.3, c - r * 0.42, r * 0.7, r * 0.42)
    // 眼睛
    g.fillStyle(0x10131c, 1)
    g.fillCircle(c - r * 0.32, c - r * 0.05, r * 0.13)
    g.fillCircle(c + r * 0.32, c - r * 0.05, r * 0.13)
    g.fillStyle(0xffffff, 0.9)
    g.fillCircle(c - r * 0.28, c - r * 0.1, r * 0.045)
    g.fillCircle(c + r * 0.36, c - r * 0.1, r * 0.045)
    if (key.includes('enemy')) {
      // 敌人尖角
      g.fillStyle(dark, 1)
      g.beginPath()
      g.moveTo(c - r * 0.7, c - r * 0.62)
      g.lineTo(c - r * 0.95, c - r * 1.25)
      g.lineTo(c - r * 0.3, c - r * 0.92)
      g.closePath()
      g.fillPath()
      g.beginPath()
      g.moveTo(c + r * 0.7, c - r * 0.62)
      g.lineTo(c + r * 0.95, c - r * 1.25)
      g.lineTo(c + r * 0.3, c - r * 0.92)
      g.closePath()
      g.fillPath()
    }
    rt.draw(g, 0, 0)
    rt.saveTexture(key)
    g.destroy()
    rt.destroy()
  }

  // 攻击/受击前摇期间暂停待机呼吸（避免两个补间争抢同一属性）
  _pauseIdle(ent) {
    if (ent._idleTween && ent._idleTween.isPlaying()) ent._idleTween.pause()
  }

  _resumeIdle(ent) {
    if (!ent.alive) return
    if (ent._idleTween) ent._idleTween.resume()
    else this._startIdle(ent)
  }

  _startIdle(ent) {
    if (ent._idleTween) ent._idleTween.stop()
    ent._idleTween = this.tweens.add({
      targets: ent.body, y: ent.y - 7, duration: 1100 + (ent.key === 'enemy' ? 260 : 0),
      yoyo: true, repeat: -1, ease: 'Sine.inOut',
    })
    if (!ent._shadowIdle) {
      ent._shadowIdle = this.tweens.add({
        targets: ent.shadow, scaleX: 0.94, scaleY: 0.94, duration: 1100,
        yoyo: true, repeat: -1, ease: 'Sine.inOut',
      })
    }
  }

  // ---------- 快照同步（血量/护盾/手牌由服务端权威；续局时整包重建画面） ----------
  setSnapshot(s, opts = {}) {
    if (!s) return
    for (const key of ['player', 'enemy']) {
      const d = s[key]
      const ent = this._entities[key]
      if (!d || !ent) continue
      const aliveNow = d.alive !== false && (d.hp ?? 0) > 0
      // 血条/护盾/状态始终跟服务端终态对齐（包括 0 血）
      ent.name.setText(d.name || key)
      this._renderHp(ent, d.hp ?? 0, d.max_hp ?? 1)
      this._renderBlock(ent, d.block || 0, false)
      this._renderStatuses(ent, Array.isArray(d.statuses) ? d.statuses : [])
      // 死亡实体的身体表现交给死亡动画（链中快照）或直接静态死亡外观（续局 includeDead）
      if (!aliveNow && !opts.includeDead) continue
      ent.alive = aliveNow
      if (!ent.alive && !ent.dying) this._applyDeadLook(ent)
      else if (ent.alive && ent.body.alpha < 1) {
        // 续局恢复：把死亡外观还原
        ent.dying = false
        ent.body.setAlpha(1).setAngle(0).setScale(1).setPosition(ent.x, ent.y)
        if (!ent._idleTween || !ent._idleTween.isPlaying()) this._startIdle(ent)
      }
    }
  }

  _renderHp(ent, hp, maxHp) {
    const pct = Phaser.Math.Clamp(hp / (maxHp || 1), 0, 1)
    // 全宽填充条 + scaleX 缩放（Phaser 直接改 Rectangle.width 不会刷新几何缓存）
    ent.hpFill.setScale(Math.max(pct, 0.0001), 1)
    ent.hpText.setText(`${Math.max(0, hp)} / ${maxHp}`)
  }

  _renderBlock(ent, value, pop) {
    ent._blockValue = value
    ent.shield.setVisible(value > 0)
    if (value > 0) {
      ent.shieldTxt.setText(`${value}`)
      if (pop) {
        ent.shield.setScale(0.6)
        this.tweens.add({ targets: ent.shield, scale: 1, duration: 220, ease: 'Back.easeOut' })
      } else {
        ent.shield.setScale(1)
      }
    }
  }

  _renderStatuses(ent, statuses) {
    ent.statusRow.removeAll(true)
    const gap = 8
    let totalW = 0
    const chips = statuses.map((st) => {
      const txt = this.add.text(0, 0, `${st.name}${st.value ?? ''}`, {
        font: '11px sans-serif', fill: '#1a1408', backgroundColor: '#ffcc66', padding: { x: 5, y: 2 },
      })
      totalW += txt.width + gap
      return txt
    })
    let cx = -totalW / 2
    for (const t of chips) {
      t.x = cx
      cx += t.width + gap
      ent.statusRow.add(t)
    }
  }

  // ---------- 顺序播放队列（严格按服务端结算顺序） ----------
  _enqueue(token, entry) {
    // 新一轮播放（新的行动/重发）以更大的 token 作废旧队列
    if (token !== this._seqToken) {
      if (token < this._seqToken) return
      this._seqToken = token
      this._queue = []
    }
    this._queue.push(entry)
    this._pump(token)
  }

  async _pump(token) {
    if (this._running || this._destroyed) return
    this._running = true
    while (!this._destroyed) {
      if (token !== this._seqToken) break
      const entry = this._queue.shift()
      if (!entry) break
      await this._playEntry(entry)
      bus.emit('entry_done', { token, seq: entry.seq })
    }
    this._running = false
  }

  _playEntry(entry) {
    // 阶段标记 / 结算事件 / 快照 / 战斗结果
    if (entry.phase) return this._playPhase(entry)
    if (entry.result) return this._playResult(entry)
    if (entry.snapshot) {
      this.setSnapshot(entry.snapshot)
      return Promise.resolve()
    }
    return this._playEffect(entry)
  }

  _playPhase(ph) {
    switch (ph.phase) {
      case 'play_card':
        return this._animPlayCard(ph)
      case 'enemy_turn':
        return this._showBanner('敌人回合', '#ff9f9f')
      case 'enemy_intent':
        return this._showBanner(`敌方行动 · ${ph.name || ''}`, '#ffd1a8', 460)
      case 'player_turn':
        return this._showBanner(`你的回合 · 第 ${ph.turn ?? ''} 回合`, '#a8e0ff')
      default:
        return Promise.resolve()
    }
  }

  _animPlayCard(ph) {
    const ent = this._entities.player
    // 卡牌飞出：从手牌方向（屏幕底部）飞向战场中央后淡出
    const card = this.add.text(240, H - 90, ph.card_name || ph.card_id || '', {
      font: 'bold 18px sans-serif', fill: '#fff', backgroundColor: '#2a3d66',
      padding: { x: 12, y: 8 },
    }).setOrigin(0.5).setDepth(70).setAlpha(0)
    this._pauseIdle(ent)
    return Promise.all([
      this.tween(card, { y: H - 150, alpha: 1, duration: 120 }),
      this.tween(ent.body, { y: ent.y - 16, duration: 120, yoyo: true }),
    ]).then(() => this.tween(card, {
      x: W / 2, y: 180, alpha: 0, scale: 1.25, duration: 240, ease: 'Quad.in',
    })).then(() => {
      card.destroy()
      this._resumeIdle(ent)
    })
  }

  _playEffect(ev) {
    if (!ev || !ev.action) return Promise.resolve()
    const targetKey = ev.target === 'player' ? 'player' : 'enemy'
    const target = this._entities[targetKey]
    if (!target) return Promise.resolve()
    const sourceKey = ev.source === 'enemy' ? 'enemy' : 'player'
    const source = this._entities[sourceKey]

    switch (ev.action) {
      case 'damage':
      case 'echo_damage': {
        const isAttack = (ev.tags || []).includes('attack')
        const chain = []
        if (isAttack && source && source.alive && source !== target) {
          const dir = target.x > source.x ? 1 : -1
          chain.push(() => {
            this._pauseIdle(source)
            return this.tween(source.body, {
              x: source.x + dir * 34, duration: BEAT.attackLunge, ease: 'Quad.out',
            }).then(() => this.tween(source.body, { x: source.x, duration: BEAT.attackReturn, ease: 'Quad.in' }))
              .then(() => this._resumeIdle(source))
          })
        }
        chain.push(() => this._hitReact(target, ev.value || 0))
        return this._series(chain)
      }
      case 'gain_block': {
        this._float(target.x, target.y - target.radius - 8, `格挡 +${ev.value}`, '#8fc8ff')
        // value 是“获得量”而非总量：在快照基线之上累加；格挡被伤害打掉的差额由链末快照纠正
        this._renderBlock(target, (target._blockValue || 0) + (ev.value || 0), true)
        return this.wait(BEAT.block)
      }
      case 'heal': {
        this._float(target.x, target.y - 20, `+${ev.value}`, '#66ff99')
        this._ring(target, 0x55ff88)
        return this.wait(BEAT.heal)
      }
      case 'apply_status':
      case 'set_status': {
        const label = STATUS_ZH[ev.extra?.status] || ev.extra?.status || '状态'
        this._float(target.x, target.y - target.radius - 8, `${label} +${ev.value ?? ''}`, '#ffcc66')
        this._ring(target, 0xffcc66)
        return this.wait(BEAT.status)
      }
      case 'draw': {
        const p = this._entities.player
        this._float(p.x + 50, H - 90, `抽 ${ev.value} 张`, '#cfe2ff')
        return this.wait(BEAT.draw)
      }
      case 'gain_energy':
        this._float(this._entities.player.x - 40, H - 90, `能量 +${ev.value}`, '#ffe08a')
        return this.wait(BEAT.draw)
      case 'truncated':
        return this._showBanner('⚠ 连锁触发上限，被强制终止', '#ff8a5c', 900)
      default:
        return Promise.resolve()
    }
  }

  // 受击：红闪 + 震动 + 后倾
  _hitReact(ent, value) {
    this._float(ent.x, ent.y - ent.radius - 14, `-${value}`, '#ff5a5a')
    ent.body.setTint(0xff8888)
    this._ring(ent, 0xff5555)
    const dx = ent.key === 'player' ? -12 : 12
    this._pauseIdle(ent)
    return this.tween(ent.body, {
      x: ent.x + dx, angle: dx > 0 ? 8 : -8, duration: 70, ease: 'Quad.out', yoyo: true,
    }).then(() => {
      ent.body.clearTint()
      ent.body.setAngle(0)
      ent.body.x = ent.x
      return this.wait(BEAT.hit - 70)
    }).then(() => this._resumeIdle(ent))
  }

  _playResult(entry) {
    const won = entry.result === 'won' || entry.result === 'run_won'
    if (entry.snapshot) this.setSnapshot(entry.snapshot)
    const deadKey = won ? 'enemy' : 'player'
    const dead = this._entities[deadKey]
    return this._deathAnim(dead).then(() => new Promise((resolve) => {
      this.time.delayedCall(BEAT.resultHold, resolve)
      this._showBanner(won ? '胜利！' : '战败…', won ? '#ffd166' : '#ff8a8a', 900)
    }))
  }

  _deathAnim(ent) {
    if (!ent || ent.dying) return Promise.resolve()
    ent.dying = true
    ent.alive = false
    if (ent._idleTween) ent._idleTween.stop()
    if (ent._shadowIdle) ent._shadowIdle.stop()
    this._float(ent.x, ent.y - ent.radius - 14, '✖', '#ff6b6b')
    return this.tween(ent.shadow, { alpha: 0.1, duration: BEAT.death }).then(() =>
      this.tween(ent.body, {
        y: ent.y + 26, angle: ent.key === 'player' ? -90 : 90,
        alpha: 0.15, scale: 0.85, duration: BEAT.death, ease: 'Quad.in',
      }))
  }

  _applyDeadLook(ent) {
    ent.dying = true
    if (ent._idleTween) ent._idleTween.stop()
    ent.body.setAlpha(0.2).setAngle(ent.key === 'player' ? -90 : 90).setY(ent.y + 20)
    ent.shadow.setAlpha(0.15)
  }

  // ---------- 小工具 ----------
  tween(targets, props) {
    return new Promise((resolve) => {
      if (this._destroyed) return resolve()
      this.tweens.add({ targets, ...props, onComplete: () => resolve() })
    })
  }

  wait(ms) {
    return new Promise((resolve) => {
      if (this._destroyed) return resolve()
      this.time.delayedCall(ms, resolve)
    })
  }

  _series(steps) {
    return steps.reduce((p, fn) => p.then(() => fn()), Promise.resolve())
  }

  _float(x, y, text, color) {
    const t = this.add.text(x, y, text, {
      font: 'bold 20px sans-serif', fill: color,
      stroke: '#000000', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(80)
    this.tweens.add({ targets: t, y: y - 46, alpha: 0, duration: BEAT.float, ease: 'Quad.out',
      onComplete: () => t.destroy() })
  }

  _ring(ent, color) {
    const g = this.add.graphics().setDepth(9)
    const driver = { k: 0 }
    this.tweens.add({
      targets: driver, k: 1, duration: 420,
      onUpdate: () => {
        g.clear()
        g.lineStyle(3, color, 0.9 * (1 - driver.k))
        g.strokeCircle(ent.x, ent.y, ent.radius * (1 + driver.k * 0.9))
      },
      onComplete: () => g.destroy(),
    })
  }

  _showBanner(text, color = '#ffffff', hold = BEAT.banner) {
    this._banner.setText(text).setColor(color)
    return this.tween(this._banner, { alpha: 1, duration: 160, ease: 'Quad.out' })
      .then(() => this.wait(hold))
      .then(() => this.tween(this._banner, { alpha: 0, duration: 260 }))
  }

  shutdown() {
    this._destroyed = true
    if (this._handlers) this._handlers.forEach((off) => off())
    this._handlers = []
  }
}

const STATUS_ZH = {
  strength: '力量', vulnerable: '易伤', fragile: '易碎',
  echo: '回响', strength_per_turn: '力量成长', power_up: '增伤',
}

// 小型确定性随机（装饰星点用，避免每次场景重建星位跳动）
function mulberry(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function startPhaser(container) {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent: container,
    width: W,
    height: H,
    backgroundColor: '#14141f',
    scale: {
      mode: Phaser.Scale.FIT,       // 等比缩放适配容器，整体永远完整可见
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: BattleScene,
  })
}
