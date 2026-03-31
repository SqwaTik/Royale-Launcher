import { Suspense, lazy, memo, startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { MINECRAFT_FACTS } from './minecraftFacts'

const LazyStatsPage = lazy(() => import('./StatsPage'))

const VERSION_ART_IMAGES = {
  '1.21.11': new URL('./assets/version-art/1.21.11.jpg', import.meta.url).href,
  '26.1': new URL('./assets/version-art/26.1.jpg', import.meta.url).href,
  '1.21.4': new URL('./assets/version-art/1.21.4.jpg', import.meta.url).href,
  '1.16.5': new URL('./assets/version-art/1.16.5.jpg', import.meta.url).href,
  '1.12.2': new URL('./assets/version-art/1.12.2.jpg', import.meta.url).href
}

const DEFAULT_SETTINGS = {
  installFolder: 'C:\\Royale',
  javaArgs: '',
  memoryMb: 4096,
  autoMemoryEnabled: true,
  lastSelectedVersion: '1.21.11',
  hideLauncherOnGameLaunch: true,
  reopenLauncherOnGameExit: true,
  skipCancelConfirm: false,
  skipJavaPromptVersions: [],
  versions: [
    { versionName: '1.21.11', channel: 'Основная сборка', title: 'Royale Master', source: 'https://github.com/SqwaTik/Royale-Launcher-Versions/releases/latest/download/1.21.11.zip', notes: 'Клиент Royale Master для Minecraft 1.21.11 с отдельной установкой и прямым запуском.' },
    { versionName: '26.1', channel: 'Скоро', title: 'Версия готовится', source: '', notes: 'Эта версия появится позже.' },
    { versionName: '1.21.4', channel: 'Скоро', title: 'Версия готовится', source: '', notes: 'Эта версия появится позже.' },
    { versionName: '1.16.5', channel: 'Скоро', title: 'Версия готовится', source: '', notes: 'Эта версия появится позже.' },
    { versionName: '1.12.2', channel: 'Скоро', title: 'Версия готовится', source: '', notes: 'Эта версия появится позже.' }
  ]
}

const DEFAULT_PROGRESS = {
  stage: 'idle',
  progress: 0,
  current: 0,
  total: 0,
  section: '',
  sectionCurrent: 0,
  sectionTotal: 0,
  label: ''
}

const UNKNOWN_LABEL = 'Unknown'

const DEFAULT_GAMEPLAY_STATS = {
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

const DEFAULT_VERSION_STATE = {
  installed: false,
  installDir: '',
  hasSource: false,
  sourceKind: 'none',
  launchableFile: '',
  channel: '',
  notes: '',
  gameplayStats: DEFAULT_GAMEPLAY_STATS,
  pendingInstall: null,
  running: false,
  runningPid: 0
}

const DEFAULT_UPDATE_INFO = {
  available: false,
  version: '',
  url: '',
  currentVersion: ''
}

const DEFAULT_JAVA_PROMPT = {
  visible: false,
  versionName: '',
  requiredJavaVersion: 0,
  rememberChoice: false,
  installing: false,
  status: '',
  progress: 0,
  current: 0,
  total: 0
}

const DEFAULT_MEMORY_PROFILE = {
  totalMemoryMb: 8192,
  freeMemoryMb: 4096,
  reserveMb: 2048,
  recommendedMemoryMb: 4096
}

const DEFAULT_STORAGE_INFO = {
  available: false,
  drive: '',
  freeBytes: 0,
  totalBytes: 0
}

const DEFAULT_STATS_DASHBOARD = {
  generatedAt: '',
  selectedVersion: '',
  gameplay: DEFAULT_GAMEPLAY_STATS,
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
  hourly: [],
  versions: [],
  recent: []
}

const DEFAULT_APP_VERSION = '1.0.1'

const HERO_FACTS = [
  'Факт Royale: хороший лаунчер должен исчезать в тень, а не мешать запуску мира.',
  'Факт Minecraft: меньше лишних эффектов в лаунчере — быстрее первый вход в игру.',
  'Факт Royale: AUTO-память подбирается прямо перед запуском, а не живёт старым значением.',
  'Факт Minecraft: чистый путь клиента помогает ставить обновления без лишнего мусора.',
  'Факт Royale: один запуск, один клиент, одна понятная папка без лишних хвостов.'
]

const VERSION_ART = {
  '1.21.11': {
    tone: 'main',
    image: VERSION_ART_IMAGES['1.21.11'],
    position: 'center center'
  },
  '26.1': {
    tone: 'next',
    image: VERSION_ART_IMAGES['26.1'],
    position: 'center center'
  },
  '1.21.4': {
    tone: 'alt',
    image: VERSION_ART_IMAGES['1.21.4'],
    position: 'center 34%'
  },
  '1.16.5': {
    tone: 'legacy',
    image: VERSION_ART_IMAGES['1.16.5'],
    position: 'center 28%'
  },
  '1.12.2': {
    tone: 'classic',
    image: VERSION_ART_IMAGES['1.12.2'],
    position: 'center center'
  }
}

const TEXT = {
  appName: 'Royale Launcher',
  stats: 'Статистика',
  home: 'Главная',
  settings: 'Настройки',
  heroEyebrow: 'Minecraft launcher',
  heroLead: 'Лаунчер для клиента Royale Master. Устанавливает выбранную сборку и запускает её напрямую.',
  chooseVersionTitle: 'Выберите версию',
  chooseVersionLead: 'Выберите нужную сборку клиента. Остальные версии открываются прокруткой внутри блока.',
  featureBadge: 'Royale Launcher',
  featureLabel: 'Версия клиента',
  folderLabel: 'Папка клиента',
  installPathLabel: 'Путь установки',
  memoryLabel: 'Память',
  memoryShortLabel: 'Память Java (MB)',
  memoryAuto: 'AUTO',
  javaArgsLabel: 'Java аргументы',
  javaArgsHint: 'Например: -Dfile.encoding=UTF-8 -XX:+UnlockExperimentalVMOptions. Память подставляется автоматически из поля выше.',
  openFolder: 'Открыть папку',
  chooseFolder: 'Выбрать папку',
  actionInstall: 'Скачать',
  actionLaunch: 'Запустить',
  actionRunning: 'Запущено',
  actionUnavailable: 'Скоро',
  actionPreparing: 'Подготовка',
  actionDownloading: 'Загрузка',
  actionInstalling: 'Установка',
  actionCopying: 'Замена файлов',
  statePending: 'Доступно',
  stateSoon: 'Скоро',
  stateReady: 'Готово',
  versionInstall: 'Клиент еще не установлен. Нажмите «Скачать», чтобы подготовить Minecraft с клиентом Royale Master.',
  versionSoon: 'Эта версия пока не подключена.',
  updateLabel: 'Доступно обновление лаунчера',
  updateAction: 'Обновить до',
  settingsLead: 'Изменения сохраняются автоматически, а AUTO подбирает память по вашему ПК.',
  settingsVersions: 'Доступные версии',
  settingsBehavior: 'Поведение лаунчера',
  hideLauncherOnLaunch: 'Скрывать лаунчер в трей при запуске Minecraft',
  hideLauncherOnLaunchHint: 'Если включено, окно исчезает из рабочего стола и остаётся в системном трее, пока игра запущена.',
  reopenLauncherOnExit: 'Возвращать лаунчер после закрытия Minecraft',
  reopenLauncherOnExitHint: 'Если выключить, лаунчер останется в трее и не откроется сам после выхода из игры.',
  closeLauncherTitle: 'Закрыть лаунчер?',
  closeLauncherLead: 'Minecraft уже запущен. Лаунчер можно закрыть, игра продолжит работать.',
  closeLauncherConfirm: 'Да',
  closeLauncherCancel: 'Нет',
  storageLabel: 'Свободное место',
  storageUnknown: 'Свободное место определится после выбора диска.',
  launchError: 'Операция завершилась с ошибкой'
}

const requestedPage = new URLSearchParams(window.location.search).get('page')
const initialPage = requestedPage === 'settings' || requestedPage === 'stats' ? requestedPage : 'home'

function detectLowPerformanceDevice() {
  try {
    const cpuThreads = Number(window.navigator?.hardwareConcurrency) || 0
    const deviceMemory = Number(window.navigator?.deviceMemory) || 0
    const prefersReducedMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)
    return prefersReducedMotion || (cpuThreads > 0 && cpuThreads <= 4) || (deviceMemory > 0 && deviceMemory <= 4)
  } catch {
    return false
  }
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 10.7 12 4l7.5 6.7" />
      <path d="M6.8 9.8V20h10.4V9.8" />
      <path d="M10 20v-5.1h4V20" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 8.8A3.2 3.2 0 1 0 12 15.2A3.2 3.2 0 0 0 12 8.8z" />
      <path d="M20 13.1v-2.2l-2-.4a6.4 6.4 0 0 0-.5-1.2l1.2-1.7-1.6-1.6-1.7 1.2a6.4 6.4 0 0 0-1.2-.5L13.1 4h-2.2l-.4 2a6.4 6.4 0 0 0-1.2.5L7.6 5.3 6 6.9l1.2 1.7a6.4 6.4 0 0 0-.5 1.2L4 10.9v2.2l2 .4c.1.4.3.8.5 1.2L5.3 16.4 6.9 18l1.7-1.2c.4.2.8.4 1.2.5l.4 2h2.2l.4-2c.4-.1.8-.3 1.2-.5l1.7 1.2 1.6-1.6-1.2-1.7c.2-.4.4-.8.5-1.2l2-.4Z" />
    </svg>
  )
}

function StatsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 19V11" />
      <path d="M12 19V6" />
      <path d="M19 19v-9" />
      <path d="M4 19h16" />
    </svg>
  )
}

function MinimizeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 12h12" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 7l10 10" />
      <path d="M17 7 7 17" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 6v12" />
      <path d="M16 6v12" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="1.8" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5.8 12.4 10 16.6 18.4 8.2" />
    </svg>
  )
}

const NavButton = memo(function NavButton({ active, label, onClick, children }) {
  return (
    <button className={`rail__nav ${active ? 'is-active' : ''}`} onClick={onClick}>
      <span className="rail__nav-icon">{children}</span>
      <span className="rail__nav-label">{label}</span>
    </button>
  )
})

const ConfirmModal = memo(function ConfirmModal({
  title,
  description,
  confirmLabel,
  cancelLabel,
  checkboxLabel = '',
  checkboxChecked = false,
  onCheckboxChange = null,
  onConfirm,
  onCancel
}) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="confirm-title">{title}</h3>
        <p>{description}</p>
        {checkboxLabel ? (
          <label className="modal-checkbox">
            <input
              type="checkbox"
              checked={checkboxChecked}
              onChange={(event) => onCheckboxChange?.(event.target.checked)}
            />
            <span className="modal-checkbox__box" aria-hidden="true">
              <CheckIcon />
            </span>
            <span className="modal-checkbox__label">{checkboxLabel}</span>
          </label>
        ) : null}
        <div className="modal-actions">
          <button className="soft-button" onClick={onCancel}>{cancelLabel}</button>
          <button className="primary-action primary-action--compact" onClick={onConfirm}>
            <span className="primary-action__body">
              <span className="primary-action__title">{confirmLabel}</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  )
})

const JavaRuntimeModal = memo(function JavaRuntimeModal({
  requiredJavaVersion,
  rememberChoice,
  installing,
  status,
  progress,
  onRememberChoiceChange,
  onCancel,
  onInstall
}) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={installing ? undefined : onCancel}>
      <div
        className="modal-dialog modal-dialog--java"
        role="dialog"
        aria-modal="true"
        aria-labelledby="java-runtime-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="java-runtime-title">Нужна Java {requiredJavaVersion}</h3>
        <p>
          Для этой версии клиента нужна Java {requiredJavaVersion}. Лаунчер может скачать и подготовить её автоматически.
        </p>
        <div className="java-runtime-status">
          <span>{status || `Ожидаю подтверждение на установку Java ${requiredJavaVersion}`}</span>
          <strong>{Math.round(Math.max(0, Math.min(1, Number(progress) || 0)) * 100)}%</strong>
        </div>
        <div className="java-runtime-progress" aria-hidden="true">
          <span style={{ width: `${Math.max(0, Math.min(100, ((Number(progress) || 0) * 100)))}%` }} />
        </div>
        <label className="modal-checkbox">
          <input
            type="checkbox"
            checked={rememberChoice}
            disabled={installing}
            onChange={(event) => onRememberChoiceChange?.(event.target.checked)}
          />
          <span className="modal-checkbox__box" aria-hidden="true">
            <CheckIcon />
          </span>
          <span className="modal-checkbox__label">Больше не показывать</span>
        </label>
        <div className="modal-actions">
          <button className="soft-button" onClick={onCancel} disabled={installing}>Нет</button>
          <button className="primary-action primary-action--compact" onClick={onInstall} disabled={installing}>
            <span className="primary-action__body">
              <span className="primary-action__title">{installing ? 'Скачиваю...' : 'Скачать'}</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  )
})

const StatsStubPage = memo(function StatsStubPage({ hasUpdateBanner = false }) {
  return (
    <section className={`stats-page page-surface ${hasUpdateBanner ? 'has-update-banner' : ''}`}>
      <div className="stats-page__header">
        <span className="eyebrow">Royale analytics</span>
        <h1>Статистика</h1>
        <p className="stats-page__lead">
          Раздел временно отключен, чтобы не грузить лаунчер лишним UI и фоновыми задачами.
        </p>
      </div>

      <article className="settings-card stats-stub">
        <span className="section-label">Заглушка</span>
        <h3>Вкладка скрыта из меню</h3>
        <p className="stats-page__lead">
          Код оставлен в проекте, так что позже статистику можно вернуть без сборки с нуля.
        </p>
      </article>
    </section>
  )
})

const VersionItem = memo(function VersionItem({ active, version, subtitle, state, onClick, disabled }) {
  return (
    <button
      className={`version-item ${active ? 'is-active' : ''} ${disabled ? 'is-disabled' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      <div className="version-item__copy">
        <strong>{version}</strong>
        <span>{subtitle}</span>
      </div>
      <span className={`version-item__state version-item__state--${state.tone}`}>{state.label}</span>
    </button>
  )
})

const VersionListRow = memo(function VersionListRow({ version, subtitle, state }) {
  return (
    <div className="catalog-row">
      <div className="catalog-row__copy">
        <strong>{version}</strong>
        <span>{subtitle}</span>
      </div>
      <span className={`catalog-row__state catalog-row__state--${state.tone}`}>{state.label}</span>
    </div>
  )
})

function getProgressPercent(progressState) {
  return Math.max(0, Math.min(100, Math.round((progressState.progress || 0) * 100)))
}

function getProgressTitle(progressState) {
  if (progressState.stage === 'download') return TEXT.actionDownloading
  if (progressState.stage === 'extract') return TEXT.actionInstalling
  if (progressState.stage === 'copy') return TEXT.actionCopying
  if (progressState.stage === 'prepare') return TEXT.actionPreparing
  return TEXT.actionPreparing
}

function normalizeRemoteErrorMessage(message) {
  const value = String(message || '').trim()
  if (!value) {
    return TEXT.launchError
  }

  const normalized = value
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()

  return normalized || TEXT.launchError
}

function formatProgressBytes(bytes) {
  const value = Number(bytes) || 0
  if (value <= 0) return '0 MB'

  const mb = value / (1024 * 1024)
  if (mb < 1024) {
    return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`
  }

  return `${(mb / 1024).toFixed(1)} GB`
}

function formatProgressStatus(progressState) {
  if (progressState.label) {
    return progressState.label
  }

  if (progressState.stage === 'download') {
    if (progressState.total > 0) {
      return `Загружаю пакет ${formatProgressBytes(progressState.current)} / ${formatProgressBytes(progressState.total)}`
    }

    return `Загружаю пакет ${formatProgressBytes(progressState.current)}`
  }

  if (progressState.stage === 'extract') {
    if (progressState.section) {
      return `Устанавливаю ${progressState.section} ${progressState.sectionCurrent}/${progressState.sectionTotal || 1}`
    }

    return `Устанавливаю файлы ${progressState.current}/${progressState.total || 1}`
  }

  if (progressState.stage === 'copy') {
    return `Копирую файлы ${progressState.current}/${progressState.total || 1}`
  }

  if (progressState.stage === 'prepare') {
    return 'Подготавливаю клиент'
  }

  return ''
}

function getVersionStateChip(entry, selectedVersion, versionState) {
  if (entry.versionName === selectedVersion && versionState.running) {
    return { label: TEXT.actionRunning, tone: 'ready' }
  }

  if (entry.versionName === selectedVersion && versionState.pendingInstall?.paused) {
    return { label: 'Пауза', tone: 'pending' }
  }

  if (entry.versionName === selectedVersion && versionState.installed) {
    return { label: TEXT.stateReady, tone: 'ready' }
  }

  if (entry.source) {
    return { label: TEXT.statePending, tone: 'pending' }
  }

  return { label: TEXT.stateSoon, tone: 'muted' }
}

function formatSystemMemory(memoryProfile) {
  const totalGb = Math.max(1, Math.round((memoryProfile.totalMemoryMb || 0) / 1024))
  const freeGb = Math.max(1, (memoryProfile.freeMemoryMb || 0) / 1024).toFixed(1)
  return `Система: ${totalGb} GB · Свободно: ${freeGb} GB · AUTO: ${memoryProfile.recommendedMemoryMb} MB`
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value <= 0) return '0 GB'
  const gb = value / (1024 ** 3)
  return `${gb >= 100 ? gb.toFixed(0) : gb.toFixed(1)} GB`
}

function formatStorageInfo(storageInfo) {
  if (!storageInfo.available) {
    return TEXT.storageUnknown
  }

  return `${storageInfo.drive} · ${formatBytes(storageInfo.freeBytes)} свободно из ${formatBytes(storageInfo.totalBytes)}`
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)

  if (days > 0) {
    return `${days}д ${hours}ч ${minutes}м`
  }

  if (hours > 0) {
    return `${hours}ч ${minutes}м`
  }

  return `${Math.max(0, minutes)}м`
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
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value))
  } catch {
    return UNKNOWN_LABEL
  }
}

function formatGameplayStatusLabel(stats) {
  return stats?.runtime?.statusLabel || UNKNOWN_LABEL
}

function getGameplayStatusRows(stats) {
  const durations = stats?.statusTotals || DEFAULT_GAMEPLAY_STATS.statusTotals
  return [
    { key: 'playing', label: 'В игре', value: formatDuration(durations.playing) },
    { key: 'pvp', label: 'В PvP', value: formatDuration(durations.pvp) },
    { key: 'afk', label: 'АФК', value: formatDuration(durations.afk) },
    { key: 'pause', label: 'Пауза', value: formatDuration(durations.pause) },
    { key: 'menu', label: 'Меню', value: formatDuration(durations.menu) },
    { key: 'connecting', label: 'Подключение', value: formatDuration(durations.connecting) }
  ]
}

function requestIdleTask(callback, timeout = 1) {
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

function getToastToneFromMessage(message) {
  const value = String(message || '').toLowerCase()
  if (!value) return 'neutral'
  if (value.includes('отмен')) return 'warning'
  if (value.includes('установлено') || value.includes('применен')) return 'success'
  return 'error'
}

function App() {
  const api = window.royaleApi
  const autosaveReadyRef = useRef(false)
  const autosaveTimerRef = useRef(null)
  const toastDismissTimerRef = useRef(null)
  const updateCheckScheduledRef = useRef(false)
  const memoryLoadedRef = useRef(false)
  const pendingSettingsToastRef = useRef(false)
  const settingsRef = useRef(DEFAULT_SETTINGS)
  const toastQueueRef = useRef([])
  const toastTimerRef = useRef(null)
  const hiddenToastQueueRef = useRef([])
  const lastToastStampRef = useRef({ key: '', at: 0 })

  const [page, setPage] = useState(initialPage)
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [draft, setDraft] = useState(DEFAULT_SETTINGS)
  const [selectedVersion, setSelectedVersion] = useState(DEFAULT_SETTINGS.lastSelectedVersion)
  const [versionState, setVersionState] = useState(DEFAULT_VERSION_STATE)
  const [installProgress, setInstallProgress] = useState(DEFAULT_PROGRESS)
  const [appVersion, setAppVersion] = useState(DEFAULT_APP_VERSION)
  const [busy, setBusy] = useState(false)
  const [actionMode, setActionMode] = useState('idle')
  const [statusText, setStatusText] = useState('')
  const [showCloseLauncherPrompt, setShowCloseLauncherPrompt] = useState(false)
  const [installPaused, setInstallPaused] = useState(false)
  const [showCancelPrompt, setShowCancelPrompt] = useState(false)
  const [skipCancelConfirm, setSkipCancelConfirm] = useState(false)
  const [cancelRememberChoice, setCancelRememberChoice] = useState(false)
  const [javaPrompt, setJavaPrompt] = useState(DEFAULT_JAVA_PROMPT)
  const [updateInfo, setUpdateInfo] = useState(DEFAULT_UPDATE_INFO)
  const [memoryProfile, setMemoryProfile] = useState(DEFAULT_MEMORY_PROFILE)
  const [storageInfo, setStorageInfo] = useState(DEFAULT_STORAGE_INFO)
  const [bootstrapped, setBootstrapped] = useState(false)
  const [showVersionArt, setShowVersionArt] = useState(false)
  const [activeToast, setActiveToast] = useState(null)
  const [heroFactIndex, setHeroFactIndex] = useState(0)
  const lowPerformanceMode = useMemo(() => detectLowPerformanceDevice(), [])
  const deferredSelectedVersion = useDeferredValue(selectedVersion)

  const selectedProfile = useMemo(
    () => settings.versions.find((entry) => entry.versionName === selectedVersion) || settings.versions[0],
    [settings, selectedVersion]
  )
  const selectedArt = VERSION_ART[deferredSelectedVersion] || VERSION_ART['1.21.11']
  const shouldPollVersionState = page === 'home' || versionState.running || showCloseLauncherPrompt
  const shellLiteMode = lowPerformanceMode || page === 'settings' || !showVersionArt
  const heroFact = MINECRAFT_FACTS[heroFactIndex % MINECRAFT_FACTS.length]
  const gameplayStats = versionState.gameplayStats || DEFAULT_GAMEPLAY_STATS
  const hasPendingInstall = Boolean(versionState.pendingInstall && !versionState.installed)
  const pendingInstallPaused = Boolean(hasPendingInstall && versionState.pendingInstall?.paused)
  const gameplayPlaytimeLabel = gameplayStats.available ? formatDuration(gameplayStats.totals.playtimeMs) : 'Пока нет данных'
  const gameplayStatusLabel = gameplayStats.available ? formatGameplayStatusLabel(gameplayStats) : UNKNOWN_LABEL
  const gameplayActivityLabel = gameplayStats.available ? formatDuration(gameplayStats.totals.activeMs) : 'Появится после первого запуска'
  const gameplayServerLabel = gameplayStats.runtime.serverName || gameplayStats.runtime.serverAddress || UNKNOWN_LABEL
  const heroSurfaceStyle = useMemo(() => ({
    '--hero-art-image': showVersionArt ? `url("${selectedArt.image}")` : 'none',
    '--hero-art-position': selectedArt.position || 'center center'
  }), [selectedArt.image, selectedArt.position, showVersionArt])

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  function applyVersionState(nextState) {
    startTransition(() => {
      setVersionState({ ...DEFAULT_VERSION_STATE, ...nextState })
    })
  }

  function processToastQueue() {
    if (toastTimerRef.current || activeToast) {
      return
    }

    const nextToast = toastQueueRef.current.shift()
    if (!nextToast) {
      return
    }

    setActiveToast({ ...nextToast, closing: false })
    toastTimerRef.current = window.setTimeout(() => {
      beginToastClose()
    }, nextToast.duration || 5000)
  }

  function clearToastTimers() {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current)
      toastTimerRef.current = null
    }
    if (toastDismissTimerRef.current) {
      clearTimeout(toastDismissTimerRef.current)
      toastDismissTimerRef.current = null
    }
  }

  function beginToastClose() {
    if (!activeToast) {
      clearToastTimers()
      return
    }

    if (toastDismissTimerRef.current) {
      return
    }

    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current)
      toastTimerRef.current = null
    }

    setActiveToast((current) => (current ? { ...current, closing: true } : null))
    toastDismissTimerRef.current = window.setTimeout(() => {
      setActiveToast(null)
      toastDismissTimerRef.current = null
      processToastQueue()
    }, 180)
  }

  function dismissActiveToast() {
    beginToastClose()
  }

  function enqueueToast(message, tone = 'neutral', key = message) {
    const normalizedMessage = String(message || '').trim()
    if (!normalizedMessage) return

    const now = Date.now()
    if (lastToastStampRef.current.key === key && now - lastToastStampRef.current.at < 1200) {
      return
    }

    lastToastStampRef.current = { key, at: now }
    const nextToast = {
      id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
      message: normalizedMessage,
      tone,
      duration: 5000
    }

    if (document.hidden) {
      hiddenToastQueueRef.current.push(nextToast)
      return
    }

    toastQueueRef.current.push(nextToast)
    processToastQueue()
  }

  async function persistSettingsSnapshot(nextSettings, options = {}) {
    const previousInstallFolder = settingsRef.current.installFolder
    const saved = await api.saveSettings(nextSettings)
    settingsRef.current = saved
    setSettings(saved)
    setDraft((current) => ({
      ...current,
      installFolder: saved.installFolder,
      javaArgs: saved.javaArgs || '',
      memoryMb: saved.memoryMb,
      autoMemoryEnabled: saved.autoMemoryEnabled,
      hideLauncherOnGameLaunch: saved.hideLauncherOnGameLaunch,
      reopenLauncherOnGameExit: saved.reopenLauncherOnGameExit,
      skipCancelConfirm: saved.skipCancelConfirm,
      versions: saved.versions,
      lastSelectedVersion: saved.lastSelectedVersion
    }))

    if (saved.installFolder !== previousInstallFolder) {
      await refreshVersionState(saved.lastSelectedVersion)
    }

    if (options.notify) {
      enqueueToast('Настройки применены', 'success', `settings-applied-${saved.installFolder}-${saved.memoryMb}-${saved.autoMemoryEnabled}`)
    }

    return saved
  }

  async function commitInstallFolderDraft(nextValue = draft.installFolder, options = {}) {
    const normalizedPath = String(nextValue || '').trim() || DEFAULT_SETTINGS.installFolder

    if (normalizedPath === settingsRef.current.installFolder && normalizedPath === draft.installFolder) {
      return settingsRef.current
    }

    const nextSettings = {
      ...settingsRef.current,
      installFolder: normalizedPath,
      lastSelectedVersion: selectedVersion
    }

    return persistSettingsSnapshot(nextSettings, { notify: options.notify !== false })
  }

  useEffect(() => {
    let offProgress = () => {}
    let offStatus = () => {}
    let offLaunchStatus = () => {}
    let offJavaProgress = () => {}
    let offJavaStatus = () => {}

    async function bootstrap() {
      const bootstrapPayload = await api.getBootstrap()
      const nextPayload = bootstrapPayload?.settings || DEFAULT_SETTINGS
      const nextVersionState = bootstrapPayload?.versionState || DEFAULT_VERSION_STATE
      const nextMemoryProfile = bootstrapPayload?.memoryProfile || DEFAULT_MEMORY_PROFILE

      setAppVersion(String(bootstrapPayload?.appVersion || DEFAULT_APP_VERSION))
      setSettings(nextPayload)
      setDraft({
        ...nextPayload,
        javaArgs: nextPayload.javaArgs || ''
      })
      setMemoryProfile({ ...DEFAULT_MEMORY_PROFILE, ...nextMemoryProfile })
      memoryLoadedRef.current = true
      setSkipCancelConfirm(Boolean(nextPayload.skipCancelConfirm))
      setSelectedVersion(nextPayload.lastSelectedVersion)
      applyVersionState(nextVersionState)
      autosaveReadyRef.current = true
      setBootstrapped(true)
    }

    bootstrap()

    offProgress = api.onInstallProgress((payload) => {
      setInstallProgress({ ...DEFAULT_PROGRESS, ...payload })
    })

    offStatus = api.onInstallStatus((payload) => {
      setStatusText(String(payload?.message || ''))
    })

    offLaunchStatus = api.onLaunchStatus((payload) => {
      setStatusText(String(payload?.message || ''))
    })

    offJavaProgress = api.onJavaInstallProgress((payload) => {
      setJavaPrompt((current) => current.visible ? {
        ...current,
        progress: Number(payload?.progress) || 0,
        current: Number(payload?.current) || 0,
        total: Number(payload?.total) || 0,
        installing: String(payload?.phase || '') !== 'done'
      } : current)
    })

    offJavaStatus = api.onJavaInstallStatus((payload) => {
      setJavaPrompt((current) => current.visible ? {
        ...current,
        status: String(payload?.message || '').trim(),
        installing: current.installing && String(payload?.message || '').trim() !== ''
      } : current)
    })

    return () => {
      offProgress()
      offStatus()
      offLaunchStatus()
      offJavaProgress()
      offJavaStatus()
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current)
      }
      clearToastTimers()
    }
  }, [api])

  useEffect(() => {
    if (!autosaveReadyRef.current) return undefined

    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current)
    }

    autosaveTimerRef.current = setTimeout(async () => {
      const parsedMemoryMb = Number(draft.memoryMb)
      const hasValidMemory = Number.isFinite(parsedMemoryMb) && parsedMemoryMb >= 1024
      if (String(draft.memoryMb).trim() && !hasValidMemory) {
        return
      }

      const nextSettings = {
        ...settingsRef.current,
        ...draft,
        installFolder: settingsRef.current.installFolder,
        memoryMb: hasValidMemory ? parsedMemoryMb : settingsRef.current.memoryMb,
        lastSelectedVersion: selectedVersion
      }
      const shouldNotify = pendingSettingsToastRef.current
      pendingSettingsToastRef.current = false
      await persistSettingsSnapshot(nextSettings, { notify: shouldNotify })
    }, 260)

    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current)
      }
    }
  }, [api, draft.javaArgs, draft.memoryMb, draft.autoMemoryEnabled, draft.hideLauncherOnGameLaunch, draft.reopenLauncherOnGameExit, draft.skipCancelConfirm, selectedVersion])

  useEffect(() => {
    if (!activeToast && !document.hidden) {
      processToastQueue()
    }
  }, [activeToast])

  useEffect(() => {
    function flushHiddenToasts() {
      if (document.hidden || hiddenToastQueueRef.current.length === 0) {
        return
      }

      toastQueueRef.current.push(...hiddenToastQueueRef.current.splice(0, hiddenToastQueueRef.current.length))
      processToastQueue()
    }

    document.addEventListener('visibilitychange', flushHiddenToasts)
    window.addEventListener('focus', flushHiddenToasts)

    return () => {
      document.removeEventListener('visibilitychange', flushHiddenToasts)
      window.removeEventListener('focus', flushHiddenToasts)
    }
  }, [activeToast])

  useEffect(() => {
    if (page !== 'home') {
      return undefined
    }

    const intervalId = window.setInterval(() => {
      setHeroFactIndex((current) => (current + 1) % MINECRAFT_FACTS.length)
    }, 15000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [page])

  useEffect(() => {
    if (!bootstrapped || updateCheckScheduledRef.current) return undefined

    updateCheckScheduledRef.current = true
    let cancelled = false
    const idleHandle = requestIdleTask(() => {
      api.checkLauncherUpdate()
        .then((update) => {
          if (!cancelled) {
            startTransition(() => {
              setUpdateInfo({ ...DEFAULT_UPDATE_INFO, ...update })
            })
          }
        })
        .catch(() => {})
    }, 1400)

    return () => {
      cancelled = true
      cancelIdleTask(idleHandle)
    }
  }, [api, bootstrapped])

  useEffect(() => {
    if (!bootstrapped || page !== 'settings') return undefined

    let cancelled = false
    const syncMemoryProfile = () => {
      api.getMemoryProfile()
        .then((memory) => {
          if (!cancelled) {
            memoryLoadedRef.current = true
            setMemoryProfile({ ...DEFAULT_MEMORY_PROFILE, ...memory })
          }
        })
        .catch(() => {})
    }

    const idleHandle = requestIdleTask(syncMemoryProfile, 220)
    const intervalId = window.setInterval(syncMemoryProfile, 15000)

    return () => {
      cancelled = true
      cancelIdleTask(idleHandle)
      window.clearInterval(intervalId)
    }
  }, [api, page, bootstrapped])

  useEffect(() => {
    if (!bootstrapped || page !== 'settings') return undefined

    let cancelled = false
    const idleHandle = requestIdleTask(async () => {
      try {
        const info = await api.getStorageInfo(settings.installFolder)
        if (!cancelled) {
          setStorageInfo({ ...DEFAULT_STORAGE_INFO, ...info })
        }
      } catch {}
    }, 320)

    return () => {
      cancelled = true
      cancelIdleTask(idleHandle)
    }
  }, [api, settings.installFolder, page, bootstrapped])

  useEffect(() => {
    if (page !== 'home' || lowPerformanceMode) {
      setShowVersionArt(false)
      return undefined
    }

    setShowVersionArt(false)
    const idleHandle = requestIdleTask(() => {
      setShowVersionArt(true)
    }, bootstrapped ? 160 : 320)

    return () => {
      cancelIdleTask(idleHandle)
    }
  }, [page, selectedVersion, bootstrapped, lowPerformanceMode])

  useEffect(() => {
    if (busy || !shouldPollVersionState) return undefined

    let cancelled = false
    const intervalId = setInterval(async () => {
      try {
        const state = await api.getVersionState(selectedVersion)
        if (!cancelled) {
          applyVersionState(state)
        }
      } catch {}
    }, versionState.running ? 4000 : 15000)

    return () => {
      cancelled = true
      clearInterval(intervalId)
    }
  }, [api, selectedVersion, versionState.running, busy, shouldPollVersionState])

  async function openPage(nextPage) {
    if (page === 'settings' && draft.installFolder !== settingsRef.current.installFolder) {
      await commitInstallFolderDraft(draft.installFolder, { notify: true })
    }
    startTransition(() => {
      setPage(nextPage)
    })
  }

  async function refreshVersionState(versionName) {
    const state = await api.getVersionState(versionName)
    applyVersionState(state)
  }

  async function ensureJavaReadyForLaunch(versionName) {
    const javaStatus = await api.getJavaStatus(versionName)
    if (javaStatus?.available) {
      return true
    }

    const requiredJavaVersion = Math.max(0, Number(javaStatus?.requiredJavaVersion) || 0)
    const suppressed = Array.isArray(settingsRef.current.skipJavaPromptVersions)
      && settingsRef.current.skipJavaPromptVersions.includes(requiredJavaVersion)

    if (suppressed) {
      enqueueToast(`Нужна Java ${requiredJavaVersion}. Установка пропущена по настройке.`, 'warning', `java-suppressed-${requiredJavaVersion}`)
      return false
    }

    setJavaPrompt({
      ...DEFAULT_JAVA_PROMPT,
      visible: true,
      versionName,
      requiredJavaVersion
    })
    return false
  }

  function closeJavaPrompt() {
    setJavaPrompt(DEFAULT_JAVA_PROMPT)
  }

  async function handleCancelJavaPrompt() {
    if (javaPrompt.rememberChoice && javaPrompt.requiredJavaVersion) {
      await persistSkipJavaPrompt(javaPrompt.requiredJavaVersion, true)
    }
    closeJavaPrompt()
  }

  async function handleInstallJavaPrompt() {
    setJavaPrompt((current) => ({
      ...current,
      installing: true,
      status: current.status || `Скачиваю Java ${current.requiredJavaVersion}...`
    }))

    try {
      await api.installJava(javaPrompt.versionName)
      if (javaPrompt.rememberChoice && javaPrompt.requiredJavaVersion) {
        await persistSkipJavaPrompt(javaPrompt.requiredJavaVersion, false)
      }
      enqueueToast(`Java ${javaPrompt.requiredJavaVersion} установлена`, 'success', `java-installed-${javaPrompt.requiredJavaVersion}`)
      closeJavaPrompt()
      await handlePrimaryAction()
    } catch (error) {
      const message = normalizeRemoteErrorMessage(error?.message)
      setJavaPrompt((current) => ({
        ...current,
        installing: false,
        status: message || current.status
      }))
      enqueueToast(message || 'Не удалось установить Java', 'error', `java-install-error-${message}`)
    }
  }

  function handleCloseLauncherRequest() {
    if (versionState.running) {
      setShowCloseLauncherPrompt(true)
      return
    }

    api.windowAction('close')
  }

  async function selectVersion(nextVersion) {
    if (busy) return
    setStatusText('')
    setSelectedVersion(nextVersion)
    const nextSettings = { ...settingsRef.current, lastSelectedVersion: nextVersion }
    settingsRef.current = nextSettings
    setSettings(nextSettings)
    await api.saveSettings(nextSettings)
    await refreshVersionState(nextVersion)
  }

  async function handlePrimaryAction() {
    if (busy || (!versionState.installed && !versionState.hasSource && !hasPendingInstall)) return
    if (versionState.running) {
      handleCloseLauncherRequest()
      return
    }

    const nextActionMode = versionState.installed ? 'launch' : 'install'

    if (versionState.installed) {
      const javaReady = await ensureJavaReadyForLaunch(selectedVersion)
      if (!javaReady) {
        return
      }
    }

    setBusy(true)
    setActionMode(nextActionMode)
    setStatusText('')
    if (!(nextActionMode === 'install' && hasPendingInstall)) {
      setInstallProgress(DEFAULT_PROGRESS)
    }

    try {
      if (nextActionMode === 'launch') {
        await api.launchVersion(selectedVersion)
        setStatusText('')
        await refreshVersionState(selectedVersion)
      } else {
        await api.installVersion(selectedVersion)
        await refreshVersionState(selectedVersion)
        enqueueToast('Установлено', 'success', `installed-${selectedVersion}`)
      }
    } catch (error) {
      const message = normalizeRemoteErrorMessage(error?.message)
      if (nextActionMode === 'install') {
        await refreshVersionState(selectedVersion).catch(() => {})
      }
      setStatusText('')
      enqueueToast(message, getToastToneFromMessage(message), `${nextActionMode}-${message}`)
    } finally {
      setBusy(false)
      setActionMode('idle')
      setInstallProgress(DEFAULT_PROGRESS)
    }
  }

  async function persistSkipCancelConfirm(nextValue) {
    pendingSettingsToastRef.current = true
    setSkipCancelConfirm(nextValue)
    setDraft((current) => ({ ...current, skipCancelConfirm: nextValue }))
    const nextSettings = { ...settings, skipCancelConfirm: nextValue }
    setSettings(nextSettings)
    await api.saveSettings(nextSettings)
  }

  async function persistSkipJavaPrompt(requiredJavaVersion, nextValue) {
    const currentList = Array.isArray(settingsRef.current.skipJavaPromptVersions)
      ? settingsRef.current.skipJavaPromptVersions
      : []
    const normalizedVersion = Math.max(0, Number(requiredJavaVersion) || 0)
    const nextList = nextValue
      ? [...new Set([...currentList, normalizedVersion])].filter(Boolean)
      : currentList.filter((item) => item !== normalizedVersion)

    const nextSettings = {
      ...settingsRef.current,
      skipJavaPromptVersions: nextList
    }

    const saved = await api.saveSettings(nextSettings)
    settingsRef.current = saved
    setSettings(saved)
  }

  async function handlePauseInstall() {
    if (!busy && pendingInstallPaused) {
      setInstallPaused(false)
      await handlePrimaryAction()
      return
    }

    if (!busy || actionMode !== 'install') return
    const nextPaused = !installPaused
    setInstallPaused(nextPaused)
    await api.pauseInstall(nextPaused)
  }

  function requestCancelBusyOperation() {
    if (!busy && !hasPendingInstall) return
    if (skipCancelConfirm) {
      void confirmCancelBusyOperation(false)
      return
    }

    setCancelRememberChoice(false)
    setShowCancelPrompt(true)
  }

  async function confirmCancelBusyOperation(rememberChoice) {
    setShowCancelPrompt(false)
    if (rememberChoice) {
      await persistSkipCancelConfirm(true)
    }

    const cancelMode = busy ? actionMode : (hasPendingInstall ? 'install' : 'idle')
    const detachedPendingInstall = false
    const shouldFinalizeDetachedPendingInstall = !busy && hasPendingInstall

    if (cancelMode === 'install') {
      await api.cancelInstall()
      if (detachedPendingInstall) {
        setInstallPaused(false)
        setInstallProgress(DEFAULT_PROGRESS)
        setStatusText('')
        await refreshVersionState(selectedVersion)
        enqueueToast('РЈСЃС‚Р°РЅРѕРІРєР° РѕС‚РјРµРЅРµРЅР° РїРѕР»СЊР·РѕРІР°С‚РµР»РµРј.', 'warning', `install-cancelled-${selectedVersion}`)
      }
      if (shouldFinalizeDetachedPendingInstall) {
        setInstallPaused(false)
        setInstallProgress(DEFAULT_PROGRESS)
        setStatusText('')
        await refreshVersionState(selectedVersion)
        enqueueToast('\u0423\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0430 \u043e\u0442\u043c\u0435\u043d\u0435\u043d\u0430 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u0435\u043c.', 'warning', `install-cancelled-${selectedVersion}`)
      }
      return
    }

    if (cancelMode === 'launch') {
      await api.cancelLaunch()
    }
  }

  async function handleConfirmCloseLauncher() {
    setShowCloseLauncherPrompt(false)
    await api.windowAction('close')
  }

  useEffect(() => {
    if (busy) return
    setInstallPaused(Boolean(versionState.pendingInstall?.paused))
    setShowCancelPrompt(false)
    setCancelRememberChoice(false)
  }, [busy, versionState.pendingInstall])

  useEffect(() => {
    if (busy) return

    if (pendingInstallPaused) {
      setInstallProgress({
        ...DEFAULT_PROGRESS,
        ...versionState.pendingInstall
      })
      setStatusText(versionState.pendingInstall.statusMessage || 'Загрузка на паузе')
      return
    }

    setInstallProgress(DEFAULT_PROGRESS)
    setStatusText('')
  }, [pendingInstallPaused, versionState.pendingInstall, busy, selectedVersion])

  async function handleBrowseFolder() {
    const picked = await api.pickFolder()
    if (!picked) return
    setDraft((current) => ({ ...current, installFolder: picked }))
    await commitInstallFolderDraft(picked, { notify: true })
  }

  async function handleOpenFolder() {
    const target = page === 'settings' ? draft.installFolder : versionState.installDir
    if (!target) return
    await api.openFolder(target)
  }

  async function handleOpenUpdate() {
    if (!updateInfo.url) return
    await api.openExternal(updateInfo.url)
  }

  async function handleInstallFolderBlur() {
    if (draft.installFolder !== settingsRef.current.installFolder) {
      await commitInstallFolderDraft(draft.installFolder, { notify: true })
    }
  }

  async function handleInstallFolderKeyDown(event) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    await commitInstallFolderDraft(event.currentTarget.value, { notify: true })
    event.currentTarget.blur()
  }

  function updateDraftField(field, value, options = {}) {
    if (options.notifySettings) {
      pendingSettingsToastRef.current = true
    }
    setDraft((current) => ({ ...current, [field]: value }))
  }

  function handleAutoMemory() {
    pendingSettingsToastRef.current = true
    setDraft((current) => {
      return {
        ...current,
        autoMemoryEnabled: !current.autoMemoryEnabled
      }
    })
  }

  const buttonTitle = busy
    ? actionMode === 'launch'
      ? 'Запускаю...'
      : getProgressTitle(installProgress)
    : hasPendingInstall
      ? 'Продолжить'
    : versionState.running
      ? TEXT.actionRunning
      : versionState.installed
        ? TEXT.actionLaunch
        : versionState.hasSource
        ? TEXT.actionInstall
        : TEXT.actionUnavailable

  const buttonDisabled = busy || (!versionState.installed && !versionState.hasSource && !hasPendingInstall)
  const progressStatusText = formatProgressStatus(installProgress)
  const memoryInputDisabled = Boolean(draft.autoMemoryEnabled)

  const buttonMeta = busy
    ? actionMode === 'launch'
      ? statusText || 'Подготавливаю запуск Minecraft'
      : progressStatusText || statusText || 'Подготавливаю клиент'
    : hasPendingInstall
      ? progressStatusText || versionState.pendingInstall.statusMessage || 'Загрузка на паузе'
    : versionState.running
      ? `Minecraft уже запущен${versionState.runningPid ? ` · PID ${versionState.runningPid}` : ''}. Нажмите, чтобы закрыть лаунчер.`
    : versionState.installed
      ? 'Откроет профиль Royale Master'
      : versionState.hasSource
        ? 'Установит клиент Royale Master'
        : 'Версия появится позже'
  const pendingInstallMeta = hasPendingInstall
    ? progressStatusText || versionState.pendingInstall.statusMessage || (pendingInstallPaused ? 'Р—Р°РіСЂСѓР·РєР° РЅР° РїР°СѓР·Рµ' : 'Р—Р°РіСЂСѓР·РєСѓ РјРѕР¶РЅРѕ РїСЂРѕРґРѕР»Р¶РёС‚СЊ')
    : buttonMeta
  const resolvedPendingInstallMeta = hasPendingInstall
    ? progressStatusText || versionState.pendingInstall.statusMessage || (pendingInstallPaused ? '\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430 \u043d\u0430 \u043f\u0430\u0443\u0437\u0435' : '\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0443 \u043c\u043e\u0436\u043d\u043e \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0438\u0442\u044c')
    : buttonMeta
  const displayButtonMeta = (busy && actionMode === 'install' && installPaused) || pendingInstallPaused
    ? 'Загрузка на паузе'
    : resolvedPendingInstallMeta
  const showInstallPauseControl = (busy && actionMode === 'install') || pendingInstallPaused
  const showBusyCancelControl = busy || hasPendingInstall

  const featureLead = versionState.running
    ? `Клиент ${selectedProfile?.title || 'Royale Master'} уже запущен. Лаунчер можно закрыть, Minecraft продолжит работать.`
    : (selectedProfile?.notes || 'Лаунчер для клиента Royale Master с отдельной установкой и прямым запуском.')

  return (
    <div className={`app-shell ${shellLiteMode ? 'app-shell--lite' : ''}`}>
      <header className="titlebar" data-drag-region>
        <div className="titlebar__brand">
          <span className="titlebar__mark">R</span>
          <span>{TEXT.appName}</span>
        </div>
        <div className="titlebar__actions" data-no-drag-region>
          <span className="titlebar__version">v{appVersion}</span>
          <button className="window-button" onClick={() => api.windowAction('minimize')} aria-label="Minimize">
            <MinimizeIcon />
          </button>
          <button className="window-button" onClick={handleCloseLauncherRequest} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
      </header>

      <div className="layout">
        <aside className="rail">
          <div className="rail__brand">
            <img className="rail__logo" src="./launcher-mark.png" alt="Royale logo" />
            <div className="rail__text">
              <strong>Royale</strong>
              <span>Launcher</span>
            </div>
          </div>

          <div className="rail__stack">
            <NavButton active={page === 'home'} label={TEXT.home} onClick={() => openPage('home')}>
              <HomeIcon />
            </NavButton>
            <NavButton active={page === 'stats'} label={TEXT.stats} onClick={() => openPage('stats')}>
              <StatsIcon />
            </NavButton>
            <NavButton active={page === 'settings'} label={TEXT.settings} onClick={() => openPage('settings')}>
              <SettingsIcon />
            </NavButton>
          </div>
        </aside>

        <main className="content">
          {updateInfo.available ? (
            <div className="update-banner" role="status" aria-live="polite">
              <button className="update-banner__button" onClick={handleOpenUpdate}>
                {`${TEXT.updateAction} v${updateInfo.version}`}
              </button>
            </div>
          ) : null}

          {page === 'home' ? (
            <section
              className={`hero page-surface ${updateInfo.available ? 'has-update-banner' : ''}`}
              style={heroSurfaceStyle}
            >
              <div className="hero__column hero__column--main">
                <div className="hero__intro">
                  <span className="eyebrow">{TEXT.heroEyebrow}</span>
                  <h1>Royale Master</h1>
                  <p className="hero__lead">{TEXT.heroLead}</p>
                </div>

                <section className="version-dock">
                  <div className="version-dock__head">
                    <div>
                      <span className="section-label">{TEXT.chooseVersionTitle}</span>
                      <h3>{TEXT.chooseVersionTitle}</h3>
                    </div>

                    <button className="soft-button" onClick={handleOpenFolder} disabled={!versionState.installDir}>
                      {TEXT.openFolder}
                    </button>
                  </div>

                  <p className="version-dock__lead">{TEXT.chooseVersionLead}</p>

                  <div className="version-dock__viewport">
                    <div className="version-dock__list">
                      {settings.versions.map((entry) => (
                        <VersionItem
                          key={entry.versionName}
                          active={entry.versionName === selectedVersion}
                          version={entry.versionName}
                          subtitle={entry.channel || entry.title || 'Royale'}
                          state={getVersionStateChip(entry, selectedVersion, versionState)}
                          disabled={busy}
                          onClick={() => selectVersion(entry.versionName)}
                        />
                      ))}
                    </div>
                  </div>
                </section>
              </div>

              <aside className="feature-stage">
                <div className={`feature-stage__art feature-stage__art--${selectedArt.tone}`} />

                <div className="feature-stage__overlay">
                  <span className="feature-stage__badge">{TEXT.featureBadge}</span>

                  <div className="feature-stage__panel">
                    <div className={`feature-stage__visual feature-stage__visual--${selectedArt.tone}`}>
                      {showVersionArt ? (
                        <img
                          className="feature-stage__visual-image"
                          src={selectedArt.image}
                          alt=""
                          decoding="async"
                          loading="lazy"
                          fetchPriority="low"
                          style={{ objectPosition: selectedArt.position || 'center center' }}
                        />
                      ) : null}
                    </div>

                    <div className="feature-stage__header">
                      <span className="section-label">{TEXT.featureLabel}</span>
                      <h2>{selectedProfile?.versionName || '-'}</h2>
                      <p className="feature-stage__title">{selectedProfile?.title || 'Royale Master'}</p>
                      <p className="feature-stage__lead">{featureLead}</p>
                      <div className="feature-stage__fact-inline">
                        <span className="section-label section-label--fact">Minecraft</span>
                        <p key={heroFactIndex} className="feature-stage__fact-text">{heroFact}</p>
                      </div>
                    </div>

                    <div className="feature-stage__details">
                      <div className="feature-detail feature-detail--wide">
                        <span>{TEXT.folderLabel}</span>
                        <strong>{versionState.installDir || 'Папка будет создана при первой установке'}</strong>
                      </div>
                      <div className="feature-detail">
                        <span>Наиграно</span>
                        <strong>{gameplayPlaytimeLabel}</strong>
                        <small>{gameplayActivityLabel}</small>
                      </div>
                      <div className="feature-detail">
                        <span>Статус</span>
                        <strong>{gameplayStatusLabel}</strong>
                        <small>{gameplayServerLabel}</small>
                      </div>
                    </div>

                    <div className={`feature-stage__action-shell ${busy ? 'is-busy' : ''}`}>
                      <button
                        className={`primary-action ${busy ? 'is-busy' : ''} ${buttonDisabled ? 'is-locked' : ''} ${(showInstallPauseControl || showBusyCancelControl) ? 'has-inline-actions' : ''}`}
                        onClick={handlePrimaryAction}
                        disabled={buttonDisabled}
                        style={{ '--progress': `${getProgressPercent(installProgress)}%` }}
                      >
                        <span className="primary-action__fill" />
                        <span className="primary-action__body">
                          <span className="primary-action__title">{buttonTitle}</span>
                          {displayButtonMeta ? <span className="primary-action__meta">{displayButtonMeta}</span> : null}
                        </span>
                      </button>

                      {showInstallPauseControl || showBusyCancelControl ? (
                        <div className="feature-stage__busy-actions">
                          {showInstallPauseControl ? (
                            <button
                              className={`icon-action ${installPaused ? 'is-active' : ''}`}
                              type="button"
                              onClick={handlePauseInstall}
                              aria-label={installPaused ? 'Resume install' : 'Pause install'}
                              title={installPaused ? 'Продолжить' : 'Пауза'}
                            >
                              <PauseIcon />
                            </button>
                          ) : null}
                          {showBusyCancelControl ? (
                            <button
                              className="icon-action"
                              type="button"
                              onClick={requestCancelBusyOperation}
                              aria-label="Cancel operation"
                              title="Отменить"
                            >
                              <StopIcon />
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </aside>
            </section>
          ) : page === 'stats' ? (
            <Suspense
              fallback={(
                <section className={`stats-page page-surface ${updateInfo.available ? 'has-update-banner' : ''}`}>
                  <div className="stats-page__header">
                    <span className="eyebrow">Royale stats</span>
                    <h1>{TEXT.stats}</h1>
                    <p className="stats-page__lead">Загружаю игровую статистику и историю запусков.</p>
                  </div>
                </section>
              )}
            >
              <LazyStatsPage
                api={api}
                selectedVersion={selectedVersion}
                hasUpdateBanner={updateInfo.available}
              />
            </Suspense>
          ) : (
            <section className={`settings page-surface ${updateInfo.available ? 'has-update-banner' : ''}`}>
              <div className="settings__header">
                <span className="eyebrow">Launcher setup</span>
                <h1>{TEXT.settings}</h1>
                <p className="settings__lead">{TEXT.settingsLead}</p>
              </div>

              <div className="settings-grid">
                <div className="settings-card settings-card--path">
                  <label className="field">
                    <span className="field__label">{TEXT.installPathLabel}</span>
                    <input
                      value={draft.installFolder}
                      onChange={(event) => updateDraftField('installFolder', event.target.value)}
                      onBlur={handleInstallFolderBlur}
                      onKeyDown={handleInstallFolderKeyDown}
                    />
                  </label>
                  <p className="settings-note settings-note--compact">
                    {TEXT.storageLabel}: {formatStorageInfo(storageInfo)}
                  </p>

                  <div className="settings-actions">
                    <button className="soft-button" onClick={handleBrowseFolder}>
                      {TEXT.chooseFolder}
                    </button>
                    <button className="soft-button" onClick={handleOpenFolder}>
                      {TEXT.openFolder}
                    </button>
                  </div>
                </div>

                <div className="settings-card settings-card--memory">
                  <label className="field">
                    <span className="field__label">{TEXT.memoryShortLabel}</span>
                    <div className="field__control field__control--with-action">
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        value={draft.autoMemoryEnabled ? memoryProfile.recommendedMemoryMb : draft.memoryMb}
                        disabled={memoryInputDisabled}
                        onChange={(event) => updateDraftField('memoryMb', event.target.value)}
                      />
                      <button className={`field__action ${draft.autoMemoryEnabled ? 'is-active' : ''}`} type="button" onClick={handleAutoMemory}>
                        {TEXT.memoryAuto}
                      </button>
                    </div>
                  </label>
                  <p className="settings-note settings-note--compact">{formatSystemMemory(memoryProfile)}</p>
                </div>

                <div className="settings-card settings-card--java">
                  <label className="field">
                    <span className="field__label">{TEXT.javaArgsLabel}</span>
                    <input
                      value={draft.javaArgs || ''}
                      onChange={(event) => updateDraftField('javaArgs', event.target.value)}
                      placeholder="-Dfile.encoding=UTF-8"
                    />
                  </label>
                  <p className="settings-note">{TEXT.javaArgsHint}</p>

                  <div className="settings-behavior">
                    <span className="field__label">{TEXT.settingsBehavior}</span>

                    <label className="toggle-field">
                      <span className="toggle-field__copy">
                        <strong>{TEXT.hideLauncherOnLaunch}</strong>
                        <span>{TEXT.hideLauncherOnLaunchHint}</span>
                      </span>
                      <span className="toggle-field__control">
                        <input
                          type="checkbox"
                          checked={Boolean(draft.hideLauncherOnGameLaunch)}
                          onChange={(event) => updateDraftField('hideLauncherOnGameLaunch', event.target.checked, { notifySettings: true })}
                        />
                        <span className="toggle-switch" aria-hidden="true" />
                      </span>
                    </label>

                    <label className={`toggle-field ${!draft.hideLauncherOnGameLaunch ? 'is-disabled' : ''}`}>
                      <span className="toggle-field__copy">
                        <strong>{TEXT.reopenLauncherOnExit}</strong>
                        <span>{TEXT.reopenLauncherOnExitHint}</span>
                      </span>
                      <span className="toggle-field__control">
                        <input
                          type="checkbox"
                          checked={Boolean(draft.reopenLauncherOnGameExit)}
                          disabled={!draft.hideLauncherOnGameLaunch}
                          onChange={(event) => updateDraftField('reopenLauncherOnGameExit', event.target.checked, { notifySettings: true })}
                        />
                        <span className="toggle-switch" aria-hidden="true" />
                      </span>
                    </label>
                  </div>
                </div>

                <div className="settings-card settings-card--versions">
                  <div className="links-header">
                    <div>
                      <span className="field__label">{TEXT.settingsVersions}</span>
                    </div>
                  </div>

                  <div className="catalog-list">
                    {settings.versions.map((entry) => (
                      <VersionListRow
                        key={entry.versionName}
                        version={entry.versionName}
                        subtitle={entry.channel || entry.title || 'Royale'}
                        state={entry.source ? { label: TEXT.statePending, tone: 'pending' } : { label: TEXT.stateSoon, tone: 'muted' }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </section>
          )}
        </main>
      </div>

      {showCloseLauncherPrompt ? (
        <ConfirmModal
          title={TEXT.closeLauncherTitle}
          description={TEXT.closeLauncherLead}
          confirmLabel={TEXT.closeLauncherConfirm}
          cancelLabel={TEXT.closeLauncherCancel}
          onConfirm={handleConfirmCloseLauncher}
          onCancel={() => setShowCloseLauncherPrompt(false)}
        />
      ) : null}

      {showCancelPrompt ? (
        <ConfirmModal
          title={actionMode === 'launch' ? 'Отменить запуск?' : 'Отменить загрузку?'}
          description={actionMode === 'launch'
            ? 'Подготовка клиента прервётся. Если отменить слишком поздно, Minecraft уже может успеть открыться.'
            : 'Текущая загрузка или установка будет остановлена. Недокачанные файлы можно будет запустить заново позже.'}
          confirmLabel="Да"
          cancelLabel="Нет"
          checkboxLabel="Больше не показывать"
          checkboxChecked={cancelRememberChoice}
          onCheckboxChange={setCancelRememberChoice}
          onConfirm={() => confirmCancelBusyOperation(cancelRememberChoice)}
          onCancel={() => {
            setCancelRememberChoice(false)
            setShowCancelPrompt(false)
          }}
        />
      ) : null}

      {javaPrompt.visible ? (
        <JavaRuntimeModal
          requiredJavaVersion={javaPrompt.requiredJavaVersion}
          rememberChoice={javaPrompt.rememberChoice}
          installing={javaPrompt.installing}
          status={javaPrompt.status}
          progress={javaPrompt.progress}
          onRememberChoiceChange={(value) => setJavaPrompt((current) => ({ ...current, rememberChoice: value }))}
          onCancel={handleCancelJavaPrompt}
          onInstall={handleInstallJavaPrompt}
        />
      ) : null}

      {activeToast ? (
        <div className={`toast toast--${activeToast.tone} ${activeToast.closing ? 'is-leaving' : ''}`} role="status" aria-live="polite">
          <div className="toast__body">
            <strong>{activeToast.message}</strong>
            <button className="toast__close" type="button" onClick={dismissActiveToast} aria-label="Закрыть уведомление">
              <CloseIcon />
            </button>
          </div>
          <span className="toast__timer" />
        </div>
      ) : null}
    </div>
  )
}

export default App
