import { memo, useDeferredValue, useEffect, useMemo, useState } from 'react'

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
  timeline: []
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
  const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)

  if (days > 0) return `${days} д ${hours} ч ${minutes} м`
  if (hours > 0) return `${hours} ч ${minutes} м`
  return `${minutes} м`
}

function formatExactDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts = []

  if (days) parts.push(`${days} д`)
  if (hours || days) parts.push(`${hours} ч`)
  if (minutes || hours || days) parts.push(`${minutes} м`)
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

function formatPercent(value, total) {
  const safeValue = Math.max(0, Number(value) || 0)
  if (safeValue <= 0) return 0
  const safeTotal = Math.max(1, Number(total) || 0)
  return Math.max(10, Math.round((safeValue / safeTotal) * 100))
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
    { label: 'Статус', value: stats.runtime.statusLabel || UNKNOWN_LABEL },
    { label: 'Сервер', value: stats.runtime.serverName || stats.runtime.serverAddress || UNKNOWN_LABEL },
    { label: 'Мир', value: stats.runtime.worldType || UNKNOWN_LABEL },
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
  onContextMenu = null,
  actionLabel = '',
  onAction = null
}) {
  return (
    <article
      className={`stats-card stats-card--metric stats-card--${tone} ${interactive ? 'is-interactive' : ''}`}
      onContextMenu={interactive ? onContextMenu : undefined}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onAction?.(event)
        }
      } : undefined}
    >
      <span className="stats-card__label">{label}</span>
      <strong className="stats-card__value">{value}</strong>
      <span className="stats-card__title">{title}</span>
      <span className="stats-card__hint">{hint}</span>
      {actionLabel && onAction ? (
        <button
          type="button"
          className="stats-card__action"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onAction(event)
          }}
        >
          {actionLabel}
        </button>
      ) : null}
    </article>
  )
})

const StatsPage = memo(function StatsPage({ api, selectedVersion, hasUpdateBanner = false }) {
  const [dashboard, setDashboard] = useState(EMPTY_DASHBOARD)
  const [loading, setLoading] = useState(true)
  const [popover, setPopover] = useState(null)
  const [chartReady, setChartReady] = useState(false)

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
      if (Date.now() - lastLoadedAt < 30000) return
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
    function closePopover() {
      setPopover(null)
    }

    function handleEscape(event) {
      if (event.key === 'Escape') {
        setPopover(null)
      }
    }

    window.addEventListener('click', closePopover)
    window.addEventListener('blur', closePopover)
    window.addEventListener('resize', closePopover)
    window.addEventListener('keydown', handleEscape)

    return () => {
      window.removeEventListener('click', closePopover)
      window.removeEventListener('blur', closePopover)
      window.removeEventListener('resize', closePopover)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [])

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
  const favoriteVersion = deferredDashboard.highlights.favoriteVersion || null

  function openDetails(event) {
    event.preventDefault()
    event.stopPropagation()
    setPopover({
      x: Math.min(event.clientX, window.innerWidth - 360),
      y: Math.min(event.clientY, window.innerHeight - 320)
    })
  }

  function openDetailsFromButton() {
    setPopover({
      x: Math.min(Math.round(window.innerWidth * 0.5) - 180, window.innerWidth - 360),
      y: Math.min(Math.round(window.innerHeight * 0.28), window.innerHeight - 320)
    })
  }

  return (
    <section className={`stats-page page-surface ${hasUpdateBanner ? 'has-update-banner' : ''}`}>
      <div className="stats-page__header">
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
          value={formatDuration(gameplay.totals.playtimeMs)}
          title="Общее время в мире"
          hint={gameplay.available ? 'ПКМ или кнопка ниже для детальной разбивки' : 'Появится после первого запуска клиента'}
          interactive={gameplay.available}
          onContextMenu={openDetails}
          actionLabel={gameplay.available ? 'Подробнее' : ''}
          onAction={gameplay.available ? openDetailsFromButton : null}
        />
        <StatsMetricCard
          tone="green"
          label="Активно"
          value={formatDuration(gameplay.totals.activeMs)}
          title="Без AFK"
          hint="Время с действиями игрока"
        />
        <StatsMetricCard
          tone="amber"
          label="PvP"
          value={formatDuration(gameplay.totals.pvpMs)}
          title="Боевые сессии"
          hint={`Входов в бой: ${gameplay.totals.combatEntries || 0}`}
        />
        <StatsMetricCard
          tone="red"
          label="AFK"
          value={formatDuration(gameplay.totals.afkMs)}
          title="Паузы и бездействие"
          hint={`Сессий: ${gameplay.totals.sessions || 0}`}
        />
      </div>

      <div className="stats-grid stats-grid--compact">
        <article className="stats-panel">
          <div className="stats-panel__head">
            <div>
              <span className="section-label">Игровая активность</span>
              <h3>По состояниям</h3>
            </div>
            <div className="stats-panel__actions">
              <span className="stats-panel__meta">
                {gameplay.runtime.statusLabel || UNKNOWN_LABEL}
              </span>
              {gameplay.available ? (
                <button type="button" className="stats-panel__action" onClick={openDetailsFromButton}>
                  Подробнее
                </button>
              ) : null}
            </div>
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

          <div className="stats-highlights">
            <div className="stats-feed__item stats-feed__item--compact">
              <div className="stats-feed__head">
                <strong>Сейчас</strong>
                <span>{gameplay.runtime.isInWorld ? 'В игре' : 'Не в мире'}</span>
              </div>
              <div className="stats-feed__body">
                <p>Сервер: {gameplay.runtime.serverName || gameplay.runtime.serverAddress || UNKNOWN_LABEL}</p>
                <p>Режим: {gameplay.runtime.worldType || UNKNOWN_LABEL}</p>
                <p>AFK: {gameplay.runtime.isAfk ? 'Да' : 'Нет'} · PvP: {gameplay.runtime.isInPvp ? 'Да' : 'Нет'}</p>
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
              <span>запусков · {deferredDashboard.periods.today.installs} установок</span>
            </div>
            <div className="stats-period">
              <span className="stats-period__label">Месяц</span>
              <strong>{deferredDashboard.periods.month.launches}</strong>
              <span>запусков · {deferredDashboard.periods.month.failures} ошибок</span>
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
          </div>
        </article>

        <article className="stats-panel stats-panel--wide">
          <div className="stats-panel__head">
            <div>
              <span className="section-label">График</span>
              <h3>Активность по дням</h3>
            </div>
            <span className="stats-panel__meta">Последние 7 дней</span>
          </div>

          {chartReady && timeline.length > 0 ? (
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
                <span><i className="stats-legend__swatch stats-legend__swatch--launch" /> Дневная активность</span>
                <span><i className="stats-legend__swatch stats-legend__swatch--failure" /> Ошибки запуска</span>
                <span><i className="stats-legend__swatch stats-legend__swatch--session" /> Игровые сессии</span>
              </div>
            </div>
          ) : chartReady ? (
            <p className="stats-empty">Unknown</p>
          ) : (
            <div className="stats-chart-placeholder" aria-hidden="true" />
          )}
        </article>
      </div>

      {popover ? (
        <div
          className="stats-context"
          role="dialog"
          aria-modal="false"
          style={{ left: `${popover.x}px`, top: `${popover.y}px` }}
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
      ) : null}
    </section>
  )
})

export default StatsPage
