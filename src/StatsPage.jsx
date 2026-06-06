import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'

const EMPTY_GAMEPLAY = {
  available: false,
  filePath: '',
  firstSeenAt: '',
  firstSeenAtMs: 0,
  updatedAt: '',
  updatedAtMs: 0,
  sessionStartedAt: '',
  sessionStartedAtMs: 0,
  totals: {
    sessions: 0,
    combatEntries: 0,
    runtimeMs: 0,
    playtimeMs: 0,
    activeMs: 0,
    afkMs: 0,
    pvpMs: 0,
    pvpAfkMs: 0
  },
  currentSession: {
    sessions: 0,
    combatEntries: 0,
    runtimeMs: 0,
    playtimeMs: 0,
    activeMs: 0,
    afkMs: 0,
    pvpMs: 0,
    pvpAfkMs: 0
  },
  statusTotals: {
    menu: 0,
    connecting: 0,
    playing: 0,
    pvp: 0,
    afk: 0,
    pause: 0,
    death: 0
  },
  sessionStatusTotals: {
    menu: 0,
    connecting: 0,
    playing: 0,
    pvp: 0,
    afk: 0,
    pause: 0,
    death: 0
  },
  runtime: {
    status: '',
    statusLabel: '',
    serverName: '',
    serverAddress: '',
    worldType: '',
    isInWorld: false,
    isInPvp: false,
    isAfk: false
  }
}

const EMPTY_DASHBOARD = {
  generatedAt: '',
  selectedVersion: '',
  gameplay: EMPTY_GAMEPLAY,
  totals: {
    launches: 0,
    installs: 0,
    failures: 0,
    sessions: 0
  },
  periods: {
    today: { launches: 0, installs: 0, failures: 0, sessions: 0 },
    month: { launches: 0, installs: 0, failures: 0, sessions: 0 },
    allTime: { launches: 0, installs: 0, failures: 0, sessions: 0 }
  },
  highlights: {
    activeDays: 0,
    favoriteVersion: null,
    peakLaunchDay: null,
    lastLaunchAt: '',
    firstSeenAt: ''
  },
  timeline: [],
  versions: [],
  recent: []
}

const UNKNOWN_LABEL = 'Unknown'

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})

function formatDuration(milliseconds) {
  const numericValue = Number(milliseconds)
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return UNKNOWN_LABEL
  }

  const totalSeconds = Math.max(0, Math.floor(numericValue / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)

  if (hours > 0) return `${hours} ч ${minutes} м`
  return `${minutes} м`
}

function formatExactDuration(milliseconds) {
  const numericValue = Number(milliseconds)
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return UNKNOWN_LABEL
  }

  const totalSeconds = Math.max(0, Math.floor(numericValue / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts = []

  if (hours) parts.push(`${hours} ч`)
  if (minutes || hours) parts.push(`${minutes} м`)
  parts.push(`${seconds} с`)
  return parts.join(' ')
}

function formatDateTime(value) {
  if (!value) return UNKNOWN_LABEL

  try {
    return DATE_TIME_FORMATTER.format(new Date(value))
  } catch {
    return UNKNOWN_LABEL
  }
}

function mapRuntimeWorldLabel(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized || normalized === 'unknown' || normalized === 'vanilla') {
    return UNKNOWN_LABEL
  }

  if (normalized === 'overworld') return 'Верхний мир'
  if (normalized === 'the_nether' || normalized === 'nether') return 'Незер'
  if (normalized === 'the_end' || normalized === 'end') return 'Энд'
  if (normalized === 'singleplayer' || normalized === 'local') return 'Локальный мир'
  if (normalized === 'multiplayer' || normalized === 'server') return 'Сервер'

  return value
}

function formatRuntimeStatus(stats) {
  const runtime = stats?.runtime || {}
  if (!stats?.available || !runtime.isInWorld) {
    return 'Не в игре'
  }
  return runtime.statusLabel || 'В игре'
}

function formatRuntimeServer(stats) {
  const runtime = stats?.runtime || {}
  if (!stats?.available || !runtime.isInWorld) {
    return 'Не в игре'
  }
  const serverName = String(runtime.serverName || '').trim()
  const serverAddress = String(runtime.serverAddress || '').trim()
  if (!serverName && !serverAddress) {
    return 'Локальный мир'
  }
  if (/^vanilla$/i.test(serverName) || /^localhost$/i.test(serverName)) {
    return 'Локальный мир'
  }
  return serverName || serverAddress || UNKNOWN_LABEL
}

function formatRuntimeWorld(stats) {
  const runtime = stats?.runtime || {}
  if (!stats?.available || !runtime.isInWorld) {
    return 'Не в игре'
  }
  return mapRuntimeWorldLabel(runtime.worldType)
}

function formatPercent(value, total) {
  const safeValue = Math.max(0, Number(value) || 0)
  if (safeValue <= 0) return 0
  const safeTotal = Math.max(1, Number(total) || 0)
  return Math.max(10, Math.round((safeValue / safeTotal) * 100))
}

function formatRate(value, total, fallback = '0%') {
  const safeTotal = Math.max(0, Number(total) || 0)
  if (safeTotal <= 0) {
    return fallback
  }

  const safeValue = Math.max(0, Number(value) || 0)
  return `${Math.round((safeValue / safeTotal) * 100)}%`
}

function getGameplayRows(stats) {
  const durations = stats?.statusTotals || EMPTY_GAMEPLAY.statusTotals
  return [
    { key: 'playing', label: 'В мире', value: durations.playing },
    { key: 'pvp', label: 'PvP', value: durations.pvp },
    { key: 'afk', label: 'AFK', value: durations.afk },
    { key: 'pause', label: 'Пауза', value: durations.pause },
    { key: 'connecting', label: 'Подключение', value: durations.connecting },
    { key: 'menu', label: 'Меню', value: durations.menu }
  ]
}

function getDetailedRows(stats) {
  return [
    { label: 'Статус', value: formatRuntimeStatus(stats) },
    { label: 'Сервер', value: formatRuntimeServer(stats) },
    { label: 'Мир', value: formatRuntimeWorld(stats) },
    { label: 'Сессий', value: String(stats.totals.sessions || 0) },
    { label: 'Входов в PvP', value: String(stats.totals.combatEntries || 0) },
    { label: 'Полный runtime', value: formatExactDuration(stats.totals.runtimeMs) },
    { label: 'Наиграно', value: formatExactDuration(stats.totals.playtimeMs) },
    { label: 'Активно', value: formatExactDuration(stats.totals.activeMs) },
    { label: 'AFK', value: formatExactDuration(stats.totals.afkMs) },
    { label: 'PvP', value: formatExactDuration(stats.totals.pvpMs) },
    { label: 'PvP AFK', value: formatExactDuration(stats.totals.pvpAfkMs) },
    { label: 'Сессия начата', value: formatDateTime(stats.sessionStartedAt) },
    { label: 'Обновлено', value: formatDateTime(stats.updatedAt) }
  ]
}

function requestIdleTask(callback, timeout = 80) {
  if (typeof window.requestIdleCallback === 'function') {
    return window.requestIdleCallback(callback, { timeout })
  }

  return window.setTimeout(() => callback({
    didTimeout: false,
    timeRemaining: () => 0
  }), timeout)
}

function cancelIdleTask(handle) {
  if (!handle) return

  if (typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(handle)
    return
  }

  window.clearTimeout(handle)
}

const StatsMetricCard = memo(function StatsMetricCard({
  tone = 'amber',
  label,
  value,
  title,
  hint,
  interactive = false,
  onClick = null,
  onContextMenu = null
}) {
  function handleKeyDown(event) {
    if (!interactive) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onClick?.(event)
  }

  return (
    <article
      className={`stats-card stats-card--metric stats-card--${tone} ${interactive ? 'is-interactive' : ''}`}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onClick : undefined}
      onKeyDown={interactive ? handleKeyDown : undefined}
      onContextMenu={interactive ? onContextMenu : undefined}
    >
      <span className="stats-card__label">{label}</span>
      <strong className="stats-card__value">{value}</strong>
      <span className="stats-card__title">{title}</span>
      <span className="stats-card__hint">{hint}</span>
    </article>
  )
})

const StatsPage = memo(function StatsPage({
  api,
  selectedVersion,
  hasUpdateBanner = false,
  versions = [],
  onSelectVersion = null
}) {
  const pageRef = useRef(null)
  const chartPanelRef = useRef(null)
  const [dashboard, setDashboard] = useState(EMPTY_DASHBOARD)
  const [loading, setLoading] = useState(true)
  const [popover, setPopover] = useState(null)
  const [chartReady, setChartReady] = useState(false)
  const [chartVisible, setChartVisible] = useState(false)

  useEffect(() => {
    let cancelled = false
    let idleHandle = null
    let lastLoadedAt = 0

    async function loadDashboard() {
      try {
        const next = await api.getStatsDashboard(selectedVersion)
        if (cancelled) return

        setDashboard({
          ...EMPTY_DASHBOARD,
          ...next,
          gameplay: {
            ...EMPTY_GAMEPLAY,
            ...(next?.gameplay || {})
          }
        })
        lastLoadedAt = Date.now()
      } catch {
        if (!cancelled) {
          setDashboard(EMPTY_DASHBOARD)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    setLoading(true)
    idleHandle = requestIdleTask(() => {
      void loadDashboard()
    }, 160)

    function refreshOnFocus() {
      if (document.hidden) return
      if (Date.now() - lastLoadedAt < 180000) return
      void loadDashboard()
    }

    window.addEventListener('focus', refreshOnFocus)
    document.addEventListener('visibilitychange', refreshOnFocus)

    return () => {
      cancelled = true
      cancelIdleTask(idleHandle)
      window.removeEventListener('focus', refreshOnFocus)
      document.removeEventListener('visibilitychange', refreshOnFocus)
    }
  }, [api, selectedVersion])

  useEffect(() => {
    setChartReady(false)
    const idleHandle = requestIdleTask(() => {
      setChartReady(true)
    }, 360)

    return () => {
      cancelIdleTask(idleHandle)
    }
  }, [dashboard.timeline, selectedVersion])

  useEffect(() => {
    const rootNode = pageRef.current
    const targetNode = chartPanelRef.current

    if (!targetNode) {
      setChartVisible(false)
      return
    }

    if (typeof window.IntersectionObserver !== 'function') {
      setChartVisible(true)
      return
    }

    const observer = new window.IntersectionObserver((entries) => {
      const entry = entries[0]
      if (entry?.isIntersecting) {
        setChartVisible(true)
      }
    }, {
      root: rootNode,
      rootMargin: '140px 0px',
      threshold: 0.04
    })

    observer.observe(targetNode)
    return () => observer.disconnect()
  }, [selectedVersion, dashboard.generatedAt])

  useEffect(() => {
    function closePopover() {
      setPopover(null)
    }

    function handleEscape(event) {
      if (event.key === 'Escape') {
        setPopover(null)
      }
    }

    window.addEventListener('blur', closePopover)
    window.addEventListener('resize', closePopover)
    window.addEventListener('keydown', handleEscape)

    return () => {
      window.removeEventListener('blur', closePopover)
      window.removeEventListener('resize', closePopover)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [])

  useEffect(() => {
    const pageNode = pageRef.current
    const previousBodyOverflow = document.body.style.overflow
    const previousDocumentOverflow = document.documentElement.style.overflow

    if (!popover || !pageNode) {
      return
    }

    const previousOverflow = pageNode.style.overflowY

    pageNode.style.overflowY = 'clip'
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'

    return () => {
      pageNode.style.overflowY = previousOverflow
      document.body.style.overflow = previousBodyOverflow
      document.documentElement.style.overflow = previousDocumentOverflow
    }
  }, [popover])

  const deferredDashboard = useDeferredValue(dashboard)
  const gameplay = deferredDashboard.gameplay || EMPTY_GAMEPLAY
  const statusRows = useMemo(() => getGameplayRows(gameplay), [gameplay])
  const maxStatusValue = useMemo(() => Math.max(1, ...statusRows.map((row) => row.value)), [statusRows])
  const detailRows = useMemo(() => getDetailedRows(gameplay), [gameplay])
  const timeline = useMemo(() => (deferredDashboard.timeline || []).slice(-7), [deferredDashboard.timeline])
  const timelineMax = useMemo(
    () => Math.max(1, ...timeline.map((entry) => entry.launches + entry.installs + entry.failures)),
    [timeline]
  )
  const versionRows = useMemo(() => Array.isArray(deferredDashboard.versions) ? deferredDashboard.versions : [], [deferredDashboard.versions])
  const recentEvents = useMemo(() => Array.isArray(deferredDashboard.recent) ? deferredDashboard.recent : [], [deferredDashboard.recent])
  const favoriteVersion = deferredDashboard.highlights.favoriteVersion || null
  const gameplayAvailable = Boolean(gameplay.available)
  const activeVersion = deferredDashboard.selectedVersion || selectedVersion || ''
  const runtimeStatusLabel = useMemo(() => formatRuntimeStatus(gameplay), [gameplay])
  const runtimeServerLabel = useMemo(() => formatRuntimeServer(gameplay), [gameplay])
  const runtimeWorldLabel = useMemo(() => formatRuntimeWorld(gameplay), [gameplay])
  const playtimeLabel = gameplayAvailable ? formatDuration(gameplay.totals.playtimeMs) : UNKNOWN_LABEL
  const averageSessionLabel = gameplayAvailable && gameplay.totals.sessions > 0
    ? formatDuration(gameplay.totals.playtimeMs / gameplay.totals.sessions)
    : UNKNOWN_LABEL
  const launchAttempts = Math.max(0, Number(deferredDashboard.totals.launches) || 0) + Math.max(0, Number(deferredDashboard.totals.failures) || 0)
  const successRateLabel = formatRate(deferredDashboard.totals.launches, launchAttempts, '100%')
  const versionMax = useMemo(() => Math.max(1, ...versionRows.map((row) => row.total || 0)), [versionRows])

  const versionOptions = useMemo(() => {
    if (!Array.isArray(versions)) return []
    return versions
      .map((entry) => ({
        name: String(entry?.versionName || '').trim(),
        label: String(entry?.versionName || '').trim()
      }))
      .filter((entry) => entry.name)
  }, [versions])

  function openDetails(event) {
    event.preventDefault()
    event.stopPropagation()
    setPopover({ open: true })
  }

  function handleVersionSelect(versionName) {
    if (!versionName || versionName === selectedVersion) return
    onSelectVersion?.(versionName)
  }


  return (
    <section
      ref={pageRef}
      className={`stats-page page-surface ${hasUpdateBanner ? 'has-update-banner' : ''} ${popover ? 'is-modal-open' : ''}`}
    >
      <div className="stats-page__header">
        {versionOptions.length > 1 ? (
          <div className="stats-page__versions" role="tablist" aria-label="Версии клиента">
            {versionOptions.map((option) => (
              <button
                key={option.name}
                type="button"
                className={`stats-version ${option.name === activeVersion ? 'is-active' : ''}`}
                onClick={() => handleVersionSelect(option.name)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
        <span className="eyebrow">Royale Launcher</span>
        <h1>Статистика</h1>
        <p className="stats-page__lead">
          Наигранное время, активность и PvP по клиенту Royale Master.
        </p>
        <span className="stats-page__status">
          {loading ? 'Загрузка статистики' : `Версия ${deferredDashboard.selectedVersion || selectedVersion}`}
        </span>
      </div>

      <div className="stats-metrics">
        <StatsMetricCard
          tone="amber"
          label="Наиграно"
          value={playtimeLabel}
          title="Общее время в мире"
          hint={gameplayAvailable ? 'Нажмите для детальной разбивки' : 'Появится после первого запуска клиента'}
          interactive={gameplayAvailable}
          onClick={openDetails}
          onContextMenu={openDetails}
        />
        <StatsMetricCard
          tone="green"
          label="Средняя сессия"
          value={averageSessionLabel}
          title="Среднее время за заход"
          hint={`Сессий в версии: ${gameplay.totals.sessions || 0}`}
        />
        <StatsMetricCard
          tone="amber"
          label="Успешность"
          value={successRateLabel}
          title="Запуски без ошибок"
          hint={`${deferredDashboard.totals.launches || 0} успешных · ${deferredDashboard.totals.failures || 0} с ошибкой`}
        />
        <StatsMetricCard
          tone="red"
          label="Активные дни"
          value={String(deferredDashboard.highlights.activeDays || 0)}
          title="Дней с активностью"
          hint={`Последний запуск: ${formatDateTime(deferredDashboard.highlights.lastLaunchAt)}`}
        />
      </div>

      <div className="stats-grid stats-grid--compact">
        <article className="stats-panel">
          <div className="stats-panel__head">
            <div>
              <span className="section-label">Игровая активность</span>
              <h3>Выбранная версия</h3>
            </div>
            <div className="stats-panel__actions">
              <span className="stats-panel__meta">
                {runtimeStatusLabel}
              </span>
            </div>
          </div>

          <div className="stats-panel__split">
            <div className="stats-panel__section">
              <div className="stats-panel__subhead">
                <strong>Разбивка времени</strong>
                <span>{gameplayAvailable ? 'Состояния из игровой статистики' : 'Появится после первого запуска'}</span>
              </div>

              <div className="stats-breakdown">
                {statusRows.map((row) => (
                  <div key={row.key} className="stats-breakdown__row">
                    <div className="stats-breakdown__copy">
                      <strong>{row.label}</strong>
                      <span>{formatDuration(row.value)}</span>
                    </div>
                    <div className="stats-breakdown__track">
                      <span
                        className={`stats-breakdown__fill stats-breakdown__fill--${row.key}`}
                        style={{ width: `${formatPercent(row.value, maxStatusValue)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="stats-panel__section">
              <div className="stats-feed stats-feed--compact">
                <div className="stats-feed__item stats-feed__item--compact">
                  <div className="stats-feed__head">
                    <strong>Сейчас</strong>
                    <span>{runtimeStatusLabel}</span>
                  </div>
                  <div className="stats-feed__body">
                    {gameplay.runtime.isInWorld ? (
                      <>
                        <p>Сервер: {runtimeServerLabel}</p>
                        <p>Мир: {runtimeWorldLabel}</p>
                        <p>AFK: {gameplay.runtime.isAfk ? 'Да' : 'Нет'} · PvP: {gameplay.runtime.isInPvp ? 'Да' : 'Нет'}</p>
                      </>
                    ) : (
                      <p>Игровая сессия сейчас не активна.</p>
                    )}
                  </div>
                </div>

                <div className="stats-feed__item stats-feed__item--compact">
                  <div className="stats-feed__head">
                    <strong>По версии</strong>
                    <span>{activeVersion || UNKNOWN_LABEL}</span>
                  </div>
                  <div className="stats-feed__body">
                    <p>Сессий: {gameplay.totals.sessions || 0}</p>
                    <p>Активно без AFK: {gameplayAvailable ? formatDuration(gameplay.totals.activeMs) : UNKNOWN_LABEL}</p>
                    <p>PvP-входов: {gameplay.totals.combatEntries || 0}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </article>

        <article className="stats-panel">
          <div className="stats-panel__head">
            <div>
              <span className="section-label">Лаунчер</span>
              <h3>Сводка запусков</h3>
            </div>
            <span className="stats-panel__meta">
              Обновлено {formatDateTime(deferredDashboard.generatedAt)}
            </span>
          </div>

          <div className="stats-periods">
            <div className="stats-period">
              <span className="stats-period__label">Сегодня</span>
              <strong>{deferredDashboard.periods.today.launches}</strong>
              <span>запусков · {deferredDashboard.periods.today.failures} ошибок</span>
            </div>
            <div className="stats-period">
              <span className="stats-period__label">Месяц</span>
              <strong>{deferredDashboard.periods.month.launches}</strong>
              <span>запусков · {deferredDashboard.periods.month.installs} установок</span>
            </div>
            <div className="stats-period">
              <span className="stats-period__label">За всё время</span>
              <strong>{deferredDashboard.periods.allTime.launches}</strong>
              <span>запусков · {deferredDashboard.periods.allTime.sessions} игровых сессий</span>
            </div>
          </div>

          <div className="stats-highlights">
            <div className="stats-feed__item stats-feed__item--compact">
              <div className="stats-feed__head">
                <strong>Лучший день</strong>
                <span>{deferredDashboard.highlights.peakLaunchDay?.label || UNKNOWN_LABEL}</span>
              </div>
              <div className="stats-feed__body">
                <p>Запусков: {deferredDashboard.highlights.peakLaunchDay?.launches || 0}</p>
                <p>Активных дней: {deferredDashboard.highlights.activeDays || 0}</p>
              </div>
            </div>

            <div className="stats-feed__item stats-feed__item--compact">
              <div className="stats-feed__head">
                <strong>Любимая версия</strong>
                <span>{favoriteVersion?.versionName || UNKNOWN_LABEL}</span>
              </div>
              <div className="stats-feed__body">
                <p>{favoriteVersion?.title || UNKNOWN_LABEL}</p>
                <p>Последний запуск: {formatDateTime(deferredDashboard.highlights.lastLaunchAt)}</p>
              </div>
            </div>

            <div className="stats-feed__item stats-feed__item--compact">
              <div className="stats-feed__head">
                <strong>История</strong>
                <span>{formatDateTime(deferredDashboard.highlights.firstSeenAt)}</span>
              </div>
              <div className="stats-feed__body">
                <p>Первое зафиксированное событие лаунчера</p>
                <p>Установок: {deferredDashboard.totals.installs || 0}</p>
              </div>
            </div>
          </div>
        </article>

        <article className="stats-panel">
          <div className="stats-panel__head">
            <div>
              <span className="section-label">Версии</span>
              <h3>Что используется чаще</h3>
            </div>
            <span className="stats-panel__meta">По всем событиям лаунчера</span>
          </div>

          {versionRows.length > 0 ? (
            <div className="stats-versions">
              {versionRows.map((row) => (
                <div key={row.versionName} className={`stats-version-row ${row.versionName === activeVersion ? 'is-active' : ''}`}>
                  <div className="stats-version-row__copy">
                    <strong>{row.versionName}</strong>
                    <span>{row.title || row.channel || 'Royale Master'}</span>
                  </div>
                  <div className="stats-version-row__track">
                    <div
                      className="stats-version-row__fill"
                      style={{ width: `${formatPercent(row.total || 0, versionMax)}%` }}
                    />
                  </div>
                  <div className="stats-version-row__meta">
                    <span>Запусков: {row.launches || 0}</span>
                    <span>Ошибок: {row.failures || 0}</span>
                    <span>Успешность: {row.successRate || 0}%</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="stats-empty">Рейтинг версий появится после установок и запусков.</p>
          )}
        </article>

        <article className="stats-panel">
          <div className="stats-panel__head">
            <div>
              <span className="section-label">События</span>
              <h3>Последняя активность</h3>
            </div>
            <span className="stats-panel__meta">8 последних действий</span>
          </div>

          {recentEvents.length > 0 ? (
            <div className="stats-feed">
              {recentEvents.map((entry) => (
                <div key={entry.id} className="stats-feed__item stats-feed__item--compact">
                  <div className="stats-feed__head">
                    <strong>{entry.label || 'Событие'}</strong>
                    <span>{entry.atLabel || formatDateTime(entry.at)}</span>
                  </div>
                  <div className="stats-feed__body">
                    <p>Версия: {entry.versionName || 'Лаунчер'}</p>
                    <p>{entry.message || 'Без дополнительного сообщения.'}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="stats-empty">История событий появится после первого использования лаунчера.</p>
          )}
        </article>

        <article ref={chartPanelRef} className="stats-panel stats-panel--wide stats-panel--deferred">
          <div className="stats-panel__head">
            <div>
              <span className="section-label">График</span>
              <h3>Активность по дням</h3>
            </div>
            <span className="stats-panel__meta">Последние 7 дней</span>
          </div>

          {chartReady && chartVisible && timeline.length > 0 ? (
            <div className="stats-chart stats-chart--compact">
              <div className="stats-chart__bars stats-chart__bars--timeline stats-chart__bars--compact">
                {timeline.map((entry) => {
                  const total = entry.launches + entry.installs + entry.failures
                  return (
                    <div key={entry.dateKey} className="stats-chart__column">
                      <div
                        className={`stats-chart__single ${entry.failures > 0 ? 'has-failure' : ''}`}
                        style={{ height: `${formatPercent(total, timelineMax)}%` }}
                      >
                        {entry.sessions > 0 ? <span className="stats-chart__dot" /> : null}
                      </div>
                      <span className="stats-chart__label">{entry.label}</span>
                    </div>
                  )
                })}
              </div>

              <div className="stats-legend">
                <span><i className="stats-legend__swatch stats-legend__swatch--launch" /> Запуски и установки</span>
                <span><i className="stats-legend__swatch stats-legend__swatch--failure" /> Ошибки запуска</span>
                <span><i className="stats-legend__swatch stats-legend__swatch--session" /> Игровые сессии</span>
              </div>
            </div>
          ) : chartReady && chartVisible ? (
            <p className="stats-empty">За последние 7 дней пока нет событий.</p>
          ) : (
            <div className="stats-chart-placeholder" aria-hidden="true" />
          )}
        </article>
      </div>

      {popover ? (
        <div className="stats-context-backdrop" role="presentation" onClick={() => setPopover(null)}>
          <div
            className="stats-context"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="stats-context__head">
              <strong>Подробнее</strong>
              <span>Игровая сессия Royale Master</span>
            </div>
            <div className="stats-context__grid">
              {detailRows.map((row) => (
                <div key={row.label} className="stats-context__row">
                  <span>{row.label}</span>
                  <strong>{row.value}</strong>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
})

export default StatsPage
