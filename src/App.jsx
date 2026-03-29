import { useEffect, useMemo, useRef, useState } from 'react'

const DEFAULT_SETTINGS = {
  installFolder: 'C:\\Royale',
  javaArgs: '',
  memoryMb: 4096,
  lastSelectedVersion: '1.21.11',
  versions: [
    { versionName: '1.21.11', channel: 'Основная сборка', title: 'Royale Master', source: 'client-assets/1.21.11.zip', notes: 'Готовая сборка Royale Master для модифицированного Minecraft-клиента.' },
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
  total: 0
}

const DEFAULT_VERSION_STATE = {
  installed: false,
  installDir: '',
  hasSource: false,
  sourceKind: 'none',
  launchableFile: '',
  title: '',
  channel: '',
  notes: ''
}

const DEFAULT_UPDATE_INFO = {
  available: false,
  version: '',
  url: '',
  currentVersion: ''
}

const DEFAULT_MEMORY_PROFILE = {
  totalMemoryMb: 8192,
  recommendedMemoryMb: 4096
}

const TEXT = {
  appName: 'Royale Launcher',
  home: 'Главная',
  settings: 'Настройки',
  heroEyebrow: 'Minecraft launcher',
  heroLead: 'Лаунчер для модифицированного Minecraft-клиента Royale Master: скачивает готовую сборку, обновляет файлы в выбранной папке и запускает ее из одного окна.',
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
  actionUnavailable: 'Скоро',
  actionPreparing: 'Подготовка',
  actionDownloading: 'Загрузка',
  actionInstalling: 'Установка',
  actionCopying: 'Замена файлов',
  stateInstalled: 'Установлено',
  statePending: 'Доступно',
  stateSoon: 'Скоро',
  stateReady: 'Готово',
  versionReady: 'Версия установлена и готова к запуску.',
  versionInstall: 'Клиент еще не установлен. Нажмите «Скачать», чтобы поставить или обновить сборку.',
  versionSoon: 'Эта версия пока не подключена.',
  progressHint: 'Во время установки прогресс появится прямо внутри кнопки.',
  objectUnit: 'объектов',
  updateLabel: 'Доступно обновление лаунчера',
  updateAction: 'Обновить',
  settingsLead: 'Изменения сохраняются автоматически, а AUTO подбирает память по вашему ПК.',
  settingsVersions: 'Доступные версии',
  launchError: 'Операция завершилась с ошибкой'
}

const initialPage = new URLSearchParams(window.location.search).get('page') === 'settings' ? 'settings' : 'home'

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

function NavButton({ active, label, onClick, children }) {
  return (
    <button className={`rail__nav ${active ? 'is-active' : ''}`} onClick={onClick}>
      <span className="rail__nav-icon">{children}</span>
      <span className="rail__nav-label">{label}</span>
    </button>
  )
}

function VersionItem({ active, version, subtitle, state, onClick }) {
  return (
    <button className={`version-item ${active ? 'is-active' : ''}`} onClick={onClick}>
      <div className="version-item__copy">
        <strong>{version}</strong>
        <span>{subtitle}</span>
      </div>
      <span className={`version-item__state version-item__state--${state.tone}`}>{state.label}</span>
    </button>
  )
}

function VersionListRow({ version, subtitle, state }) {
  return (
    <div className="catalog-row">
      <div className="catalog-row__copy">
        <strong>{version}</strong>
        <span>{subtitle}</span>
      </div>
      <span className={`catalog-row__state catalog-row__state--${state.tone}`}>{state.label}</span>
    </div>
  )
}

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

function getProgressMeta(progressState) {
  const percent = getProgressPercent(progressState)

  if ((progressState.stage === 'extract' || progressState.stage === 'copy') && progressState.total > 0) {
    return `${progressState.current} / ${progressState.total} ${TEXT.objectUnit}`
  }

  return percent > 0 ? `${percent}%` : 'Подключение'
}

function getProgressCaption(progressState) {
  const percent = getProgressPercent(progressState)

  if (progressState.stage === 'download') {
    return `Загружаем пакет версии · ${percent}%`
  }

  if ((progressState.stage === 'extract' || progressState.stage === 'copy') && progressState.total > 0) {
    return `Обновляем клиент · ${progressState.current}/${progressState.total} · ${percent}%`
  }

  return 'Подготавливаем установку версии'
}

function getVersionStateChip(entry, selectedVersion, versionState) {
  if (entry.versionName === selectedVersion && versionState.installed) {
    return { label: TEXT.stateInstalled, tone: 'ready' }
  }

  if (entry.source) {
    return { label: TEXT.statePending, tone: 'pending' }
  }

  return { label: TEXT.stateSoon, tone: 'muted' }
}

function formatSystemMemory(memoryProfile) {
  const totalGb = Math.max(1, Math.round((memoryProfile.totalMemoryMb || 0) / 1024))
  return `Система: ${totalGb} GB · AUTO: ${memoryProfile.recommendedMemoryMb} MB`
}

function App() {
  const api = window.royaleApi
  const autosaveReadyRef = useRef(false)
  const autosaveTimerRef = useRef(null)

  const [page, setPage] = useState(initialPage)
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [draft, setDraft] = useState(DEFAULT_SETTINGS)
  const [selectedVersion, setSelectedVersion] = useState(DEFAULT_SETTINGS.lastSelectedVersion)
  const [versionState, setVersionState] = useState(DEFAULT_VERSION_STATE)
  const [installProgress, setInstallProgress] = useState(DEFAULT_PROGRESS)
  const [busy, setBusy] = useState(false)
  const [statusText, setStatusText] = useState('')
  const [updateInfo, setUpdateInfo] = useState(DEFAULT_UPDATE_INFO)
  const [memoryProfile, setMemoryProfile] = useState(DEFAULT_MEMORY_PROFILE)

  const selectedProfile = useMemo(
    () => settings.versions.find((entry) => entry.versionName === selectedVersion) || settings.versions[0],
    [settings, selectedVersion]
  )

  useEffect(() => {
    let offProgress = () => {}
    let offStatus = () => {}

    async function bootstrap() {
      const payload = await api.getSettings()
      const preferredVersion = payload.versions.find((entry) => entry.versionName === payload.lastSelectedVersion && entry.source)
      const fallbackVersion = preferredVersion?.versionName || payload.versions.find((entry) => entry.source)?.versionName || payload.lastSelectedVersion
      const nextPayload = fallbackVersion === payload.lastSelectedVersion ? payload : { ...payload, lastSelectedVersion: fallbackVersion }

      setSettings(nextPayload)
      setDraft({
        ...nextPayload,
        javaArgs: nextPayload.javaArgs || ''
      })
      setSelectedVersion(nextPayload.lastSelectedVersion)

      if (fallbackVersion !== payload.lastSelectedVersion) {
        await api.saveSettings(nextPayload)
      }

      const [state, update, memory] = await Promise.all([
        api.getVersionState(nextPayload.lastSelectedVersion),
        api.checkLauncherUpdate(),
        api.getMemoryProfile()
      ])

      setVersionState({ ...DEFAULT_VERSION_STATE, ...state })
      setUpdateInfo({ ...DEFAULT_UPDATE_INFO, ...update })
      setMemoryProfile({ ...DEFAULT_MEMORY_PROFILE, ...memory })
      autosaveReadyRef.current = true
    }

    bootstrap()

    offProgress = api.onInstallProgress((payload) => {
      setInstallProgress({ ...DEFAULT_PROGRESS, ...payload })
    })

    offStatus = api.onInstallStatus(({ message }) => {
      setStatusText(message)
    })

    return () => {
      offProgress()
      offStatus()
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current)
      }
    }
  }, [api])

  useEffect(() => {
    if (!autosaveReadyRef.current) return undefined

    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current)
    }

    autosaveTimerRef.current = setTimeout(async () => {
      const nextSettings = {
        ...draft,
        memoryMb: Math.max(1024, Number(draft.memoryMb) || 4096),
        lastSelectedVersion: selectedVersion
      }
      const previousInstallFolder = settings.installFolder

      const saved = await api.saveSettings(nextSettings)
      setSettings(saved)
      setDraft((current) => ({
        ...current,
        installFolder: saved.installFolder,
        javaArgs: saved.javaArgs || '',
        memoryMb: saved.memoryMb,
        versions: saved.versions,
        lastSelectedVersion: saved.lastSelectedVersion
      }))

      if (saved.installFolder !== previousInstallFolder) {
        await refreshVersionState(saved.lastSelectedVersion)
      }
    }, 260)

    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current)
      }
    }
  }, [api, draft.installFolder, draft.javaArgs, draft.memoryMb])

  async function refreshVersionState(versionName) {
    const state = await api.getVersionState(versionName)
    setVersionState({ ...DEFAULT_VERSION_STATE, ...state })
  }

  async function selectVersion(nextVersion) {
    setSelectedVersion(nextVersion)
    const nextSettings = { ...settings, lastSelectedVersion: nextVersion }
    setSettings(nextSettings)
    await api.saveSettings(nextSettings)
    await refreshVersionState(nextVersion)
  }

  async function handlePrimaryAction() {
    if (busy || (!versionState.installed && !versionState.hasSource)) return

    setBusy(true)
    setInstallProgress(DEFAULT_PROGRESS)

    try {
      if (versionState.installed) {
        await api.launchVersion(selectedVersion)
      } else {
        await api.installVersion(selectedVersion)
        await refreshVersionState(selectedVersion)
      }
    } catch (error) {
      setStatusText(error?.message || TEXT.launchError)
    } finally {
      setBusy(false)
      setInstallProgress(DEFAULT_PROGRESS)
    }
  }

  async function handleBrowseFolder() {
    const picked = await api.pickFolder()
    if (!picked) return
    setDraft((current) => ({ ...current, installFolder: picked }))
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

  function updateDraftField(field, value) {
    setDraft((current) => ({ ...current, [field]: value }))
  }

  function handleAutoMemory() {
    setDraft((current) => ({ ...current, memoryMb: memoryProfile.recommendedMemoryMb }))
  }

  const buttonTitle = busy
    ? getProgressTitle(installProgress)
    : versionState.installed
      ? TEXT.actionLaunch
      : versionState.hasSource
        ? TEXT.actionInstall
        : TEXT.actionUnavailable

  const buttonMeta = busy
    ? getProgressMeta(installProgress)
    : versionState.installed
      ? 'Клиент готов к запуску'
      : versionState.hasSource
        ? 'Скачает или обновит файлы клиента'
        : 'Версия появится позже'

  const buttonSide = busy ? `${getProgressPercent(installProgress)}%` : ''
  const buttonDisabled = busy || (!versionState.installed && !versionState.hasSource)

  const featureLead = versionState.installed
    ? TEXT.versionReady
    : versionState.hasSource
      ? selectedProfile?.notes || TEXT.versionInstall
      : TEXT.versionSoon

  return (
    <div className="app-shell">
      <header className="titlebar" data-drag-region>
        <div className="titlebar__brand">
          <span className="titlebar__mark">R</span>
          <span>{TEXT.appName}</span>
        </div>
        <div className="titlebar__actions" data-no-drag-region>
          <button className="window-button" onClick={() => api.windowAction('minimize')} aria-label="Minimize">
            <MinimizeIcon />
          </button>
          <button className="window-button" onClick={() => api.windowAction('close')} aria-label="Close">
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
            <NavButton active={page === 'home'} label={TEXT.home} onClick={() => setPage('home')}>
              <HomeIcon />
            </NavButton>
            <NavButton active={page === 'settings'} label={TEXT.settings} onClick={() => setPage('settings')}>
              <SettingsIcon />
            </NavButton>
          </div>
        </aside>

        <main className="content">
          {updateInfo.available ? (
            <div className="update-banner">
              <span>{TEXT.updateLabel} {updateInfo.version}</span>
              <button className="update-banner__button" onClick={handleOpenUpdate}>
                {TEXT.updateAction}
              </button>
            </div>
          ) : null}

          {page === 'home' ? (
            <section className={`hero page-surface ${updateInfo.available ? 'has-update-banner' : ''}`}>
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
                          onClick={() => selectVersion(entry.versionName)}
                        />
                      ))}
                    </div>
                  </div>
                </section>
              </div>

              <aside className="feature-stage">
                <div className="feature-stage__art" />

                <div className="feature-stage__overlay">
                  <span className="feature-stage__badge">{TEXT.featureBadge}</span>

                  <div className="feature-stage__panel">
                    <div className="feature-stage__header">
                      <span className="section-label">{TEXT.featureLabel}</span>
                      <h2>{selectedProfile?.versionName || '-'}</h2>
                      <p className="feature-stage__title">{selectedProfile?.title || 'Royale Master'}</p>
                      <p className="feature-stage__lead">{featureLead}</p>
                    </div>

                    <div className="feature-stage__status">
                      <div>
                        <span>{versionState.installed ? TEXT.stateInstalled : versionState.hasSource ? TEXT.statePending : TEXT.stateSoon}</span>
                        <strong>{versionState.installed ? TEXT.versionReady : versionState.hasSource ? TEXT.versionInstall : TEXT.versionSoon}</strong>
                      </div>
                    </div>

                    <div className="feature-stage__details">
                      <div className="feature-detail feature-detail--wide">
                        <span>{TEXT.folderLabel}</span>
                        <strong>{versionState.installDir || 'Папка будет создана при первой установке'}</strong>
                      </div>
                    </div>

                    <button
                      className={`primary-action ${busy ? 'is-busy' : ''} ${buttonDisabled ? 'is-locked' : ''}`}
                      onClick={handlePrimaryAction}
                      disabled={buttonDisabled}
                      style={{ '--progress': `${Math.max(getProgressPercent(installProgress), installProgress.stage === 'prepare' ? 12 : 0)}%` }}
                    >
                      <span className="primary-action__fill" />
                      <span className="primary-action__body">
                        <span className="primary-action__title">{buttonTitle}</span>
                        <span className="primary-action__meta">{buttonMeta}</span>
                      </span>
                      {buttonSide ? <span className="primary-action__side">{buttonSide}</span> : null}
                    </button>

                    {busy ? <p className="feature-stage__hint">{getProgressCaption(installProgress)}</p> : null}
                    {statusText ? <p className="feature-stage__status-line">{statusText}</p> : null}
                  </div>
                </div>
              </aside>
            </section>
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
                    />
                  </label>

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
                        type="number"
                        min="1024"
                        step="512"
                        value={draft.memoryMb}
                        onChange={(event) => updateDraftField('memoryMb', event.target.value)}
                      />
                      <button className="field__action" type="button" onClick={handleAutoMemory}>
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
    </div>
  )
}

export default App
