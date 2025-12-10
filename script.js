// Frontend code: shared TrueSkill list, persistent state, functional dropdowns
// ----- App state and configuration -----
let API_BASE = '';
let TS_MU = 1500;
let TS_SIGMA = 400;

let movies = [];
let movieByTitle = {};
let ratings = {};
let comparisonCount = {};
let persons = [];
let personCount = 1;
let currentPerson = 'person1';
let currentPair = null;
let totalVotes = 0;
let pairCoverage = { coveredPairs: 0, totalPairs: 0, ratio: 0 };
let pairCoveragePerPerson = {};
let rankerConfirmed = false;
let csvFallbackAttempted = false;
// Swiper state
let swipeSuggestions = [];
let swipeSuggestionsMap = {};
let swipeSelectedMovies = [];
let swipeLikes = {};
let swipeMatches = new Set();
let swipePersonCount = 2;
let swipePersons = [];
let swipeCurrentPerson = 'p1';
let swipeCurrentIndex = 0;
let swipeOrder = [];
let swipeCompleted = false;
let swipeProgress = {};
let swipeLocked = false;
let swipeStateReadyToPersist = false;
let swipePollTimer = null;
let SWIPE_POLL_MS = 3000;
let activeSection = 'ranker';
let matchQueue = [];
let seenMatches = new Set();
let matchModalOpen = false;
let swMaxMovies = Infinity;
let rankMaxMovies = Infinity;
let uiLanguage = '';
let titleLanguage = '';
let translations = {};
let languageDefaults = {};
let languageConfigLoaded = false;
const DEBUG_SWIPE_FILTER = true;
const GAMEPAD_DEADZONE = 0.25;
const GAMEPAD_BUTTONS = { A: 0, B: 1, START: 9, DPAD_UP: 12, DPAD_DOWN: 13, DPAD_LEFT: 14, DPAD_RIGHT: 15 };
let gamepadFocus = 'left';
let gamepadPrevButtons = [];
let gamepadPollId = null;
let gamepadPrevScroll = 0;
let focusIndex = 0;
const LOG_CATEGORIES = { dom: 'dom', api: 'api', frontend: 'frontend', errors: 'errors' };
let appConfig = {
  api: { base: '', port: 5000 },
  ui: { defaultTab: 'ranker' },
  ranker: {
    defaultFilters: ['IsUnplayed', 'IsPlayed'],
    include4k: false,
    runtime: { min: 20, max: 300 },
    critic: { min: 0, max: 10, step: 0.1 },
    year: { min: 1950, max: 'current' },
    defaultR: 2
  },
  swipe: {
    defaultFilters: ['IsUnplayed', 'IsPlayed'],
    include4k: false,
    runtime: { min: 20, max: 300 },
    critic: { min: 0, max: 10, step: 0.1 },
    year: { min: 1950, max: 'current' },
    pollMs: 5000
  }
};
let initialTab = 'ranker';

function mergeConfig(base, incoming) {
  if (!incoming || typeof incoming !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  Object.entries(incoming).forEach(([key, val]) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      out[key] = mergeConfig(base ? base[key] : {}, val);
    } else {
      out[key] = val;
    }
  });
  return out;
}

function resolveYearValue(val) {
  if (val === 'current') return new Date().getFullYear();
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? new Date().getFullYear() : parsed;
}

function computeApiBase() {
  const base = appConfig?.api?.base;
  if (base) return base.replace(/\/$/, '');
  const host = window.location.hostname || 'localhost';
  const protocol = window.location.protocol.startsWith('http') ? window.location.protocol : 'http:';
  const port = appConfig?.api?.port ?? 5000;
  return `${protocol}//${host}:${port}`;
}

function logClient(category, message, data) {
  try {
    fetch(`${API_BASE || computeApiBase()}/client-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, message, data })
    }).catch(() => {});
  } catch (_) {
    /* ignore */
  }
}

function debugLog(message, data) {
  if (!DEBUG_SWIPE_FILTER) return;
  logClient(LOG_CATEGORIES.dom, message, data);
}

function logError(context, err, extra) {
  const base = { context };
  if (err && err.message) base.error = err.message;
  else if (typeof err === 'string') base.error = err;
  const payload = extra ? { ...base, ...extra } : base;
  logClient(LOG_CATEGORIES.errors, 'error', payload);
}

async function loadAppConfig() {
  try {
    const resp = await fetch('config/client.json');
    if (resp.ok) {
      const data = await resp.json();
      appConfig = mergeConfig(appConfig, data || {});
    }
  } catch (err) {
    console.error('Failed to load app config', err);
    logError('loadAppConfig', err);
  } finally {
    initialTab = appConfig?.ui?.defaultTab || initialTab;
    SWIPE_POLL_MS = parseInt(appConfig?.swipe?.pollMs ?? SWIPE_POLL_MS, 10) || SWIPE_POLL_MS;
    API_BASE = computeApiBase();
  }
}

function getRankerDefaults() {
  const cfg = appConfig?.ranker || {};
  const runtime = cfg.runtime || {};
  const critic = cfg.critic || {};
  const year = cfg.year || {};
  return {
    filters: Array.isArray(cfg.defaultFilters) ? cfg.defaultFilters : ['IsUnplayed', 'IsPlayed'],
    include4k: !!cfg.include4k,
    runtimeMin: parseFloat(runtime.min ?? 20),
    runtimeMax: parseFloat(runtime.max ?? 300),
    criticMin: parseFloat(critic.min ?? 0),
    criticMax: parseFloat(critic.max ?? 10),
    yearMin: parseInt(year.min ?? 1950, 10),
    yearMax: resolveYearValue(year.max ?? new Date().getFullYear())
  };
}

function getSwipeDefaults() {
  const cfg = appConfig?.swipe || {};
  const runtime = cfg.runtime || {};
  const critic = cfg.critic || {};
  const year = cfg.year || {};
  return {
    filters: Array.isArray(cfg.defaultFilters) ? cfg.defaultFilters : ['IsUnplayed', 'IsPlayed'],
    include4k: !!cfg.include4k,
    runtimeMin: parseFloat(runtime.min ?? 20),
    runtimeMax: parseFloat(runtime.max ?? 300),
    criticMin: parseFloat(critic.min ?? 0),
    criticMax: parseFloat(critic.max ?? 10),
    yearMin: parseInt(year.min ?? 1950, 10),
    yearMax: resolveYearValue(year.max ?? new Date().getFullYear())
  };
}

function applyRankerDefaultsFromConfig() {
  const defaults = getRankerDefaults();
  if (filterMenu) {
    const checkboxes = Array.from(filterMenu.querySelectorAll('input[type="checkbox"]'));
    if (!defaults.filters.length) {
      checkboxes.forEach(cb => { cb.checked = true; });
    } else {
      checkboxes.forEach(cb => { cb.checked = defaults.filters.includes(cb.value); });
    }
  }
  if (filter4kMain) filter4kMain.checked = defaults.include4k;
  if (runtimeMinInput && runtimeMaxInput && runtimeMinNumInput && runtimeMaxNumInput) {
    runtimeMinInput.min = runtimeMinNumInput.min = defaults.runtimeMin;
    runtimeMaxInput.max = runtimeMaxNumInput.max = defaults.runtimeMax;
    runtimeMinInput.value = runtimeMinNumInput.value = defaults.runtimeMin;
    runtimeMaxInput.value = runtimeMaxNumInput.value = defaults.runtimeMax;
  }
  if (criticMinInput && criticMaxInput && criticMinNumInput && criticMaxNumInput) {
    const criticStep = appConfig?.ranker?.critic?.step ?? 0.1;
    [criticMinInput, criticMinNumInput, criticMaxInput, criticMaxNumInput].forEach(el => { el.step = criticStep; });
    criticMinInput.min = criticMinNumInput.min = defaults.criticMin;
    criticMaxInput.max = criticMaxNumInput.max = defaults.criticMax;
    criticMinInput.value = criticMinNumInput.value = defaults.criticMin;
    criticMaxInput.value = criticMaxNumInput.value = defaults.criticMax;
  }
  if (yearMinInput && yearMaxInput && yearMinNumInput && yearMaxNumInput) {
    const yearMaxBound = Math.max(defaults.yearMax, new Date().getFullYear());
    yearMinInput.min = yearMinNumInput.min = defaults.yearMin;
    yearMaxInput.max = yearMaxNumInput.max = yearMaxBound;
    yearMinInput.value = yearMinNumInput.value = defaults.yearMin;
    yearMaxInput.value = yearMaxNumInput.value = defaults.yearMax;
  }
  updateFilterLabel();
  updateRuntimeLabel();
  updateCriticLabel();
  updateYearLabel();
}

function applySwipeDefaultsFromConfig() {
  const defaults = getSwipeDefaults();
  if (swFilterMenu) {
    const checkboxes = Array.from(swFilterMenu.querySelectorAll('input[type="checkbox"]'));
    if (!defaults.filters.length) {
      checkboxes.forEach(cb => { cb.checked = true; });
    } else {
      checkboxes.forEach(cb => { cb.checked = defaults.filters.includes(cb.value); });
    }
  }
  if (swFilter4kInline) swFilter4kInline.checked = defaults.include4k;
  if (swRuntimeMin && swRuntimeMax && swRuntimeMinNum && swRuntimeMaxNum) {
    swRuntimeMin.min = swRuntimeMinNum.min = defaults.runtimeMin;
    swRuntimeMax.max = swRuntimeMaxNum.max = defaults.runtimeMax;
    swRuntimeMin.value = swRuntimeMinNum.value = defaults.runtimeMin;
    swRuntimeMax.value = swRuntimeMaxNum.value = defaults.runtimeMax;
  }
  if (swCriticMin && swCriticMax && swCriticMinNum && swCriticMaxNum) {
    const criticStep = appConfig?.swipe?.critic?.step ?? 0.1;
    [swCriticMin, swCriticMinNum, swCriticMax, swCriticMaxNum].forEach(el => { el.step = criticStep; });
    swCriticMin.min = swCriticMinNum.min = defaults.criticMin;
    swCriticMax.max = swCriticMaxNum.max = defaults.criticMax;
    swCriticMin.value = swCriticMinNum.value = defaults.criticMin;
    swCriticMax.value = swCriticMaxNum.value = defaults.criticMax;
  }
  if (swYearMin && swYearMax && swYearMinNum && swYearMaxNum) {
    const yearMaxBound = Math.max(defaults.yearMax, new Date().getFullYear());
    swYearMin.min = swYearMinNum.min = defaults.yearMin;
    swYearMax.max = swYearMaxNum.max = yearMaxBound;
    swYearMin.value = swYearMinNum.value = defaults.yearMin;
    swYearMax.value = swYearMaxNum.value = defaults.yearMax;
  }
  updateSwFilterLabel();
  updateSwRuntimeLabel();
  updateSwCriticLabel();
  updateSwYearLabel();
}

function applyAppConfigDefaults() {
  applyRankerDefaultsFromConfig();
  applySwipeDefaultsFromConfig();
}

// Language data and settings
async function loadLanguageConfig() {
  if (languageConfigLoaded) return;
  try {
    const resp = await fetch('i18n.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    translations = data.translations || {};
    languageDefaults = data.defaults || {};
  } catch (err) {
    console.error('Failed to load language configuration', err);
  } finally {
    languageConfigLoaded = true;
  }
}

function getDefaultUILanguage() {
  return languageDefaults.uiLanguage || Object.keys(translations)[0] || 'de';
}

function getDefaultTitleLanguage() {
  return languageDefaults.titleLanguage || 'en';
}

function getT() {
  const fallback = getDefaultUILanguage();
  return translations[uiLanguage] || translations[fallback] || {};
}

function loadLanguageSettings() {
  uiLanguage = localStorage.getItem('uiLanguage') || getDefaultUILanguage();
  titleLanguage = localStorage.getItem('titleLanguage') || getDefaultTitleLanguage();
  if (!translations[uiLanguage]) uiLanguage = getDefaultUILanguage();
  if (uiLanguageSelect) uiLanguageSelect.value = uiLanguage;
  if (titleLanguageSelect) titleLanguageSelect.value = titleLanguage;
}

function applyUILanguage() {
  const t = getT();
  const setText = (selOrEl, text) => {
    if (text === undefined || text === null) return;
    if (typeof selOrEl === 'string') {
      document.querySelectorAll(selOrEl).forEach(el => { if (el) el.textContent = text; });
      return;
    }
    const el = selOrEl;
    if (el) el.textContent = text;
  };
  if (!t || Object.keys(t).length === 0) return;
  if (t.documentTitle) document.title = t.documentTitle;
  setText(tabRanker, t.tabRanker);
  setText(tabSwiper, t.tabSwiper);
  setText('#setup .page-subtitle h2', t.setupTitle);
  setText('label[for="numPersonsSelect"]', t.personsLabel);
  setText(applyPersonsBtn, t.applyBtn);
  setText('.hint.warn', t.hintReset);
  setText('#addMoviesLabel', t.addMoviesLabel);
  setText(addMovieBtn, t.addMovieBtn);
  if (movieInput && t.moviePlaceholder !== undefined) movieInput.placeholder = t.moviePlaceholder;
  setText('#swipeSetupTitle', t.swipeHeading);
  if (swipeStatus) swipeStatus.textContent = '';
  if (swipeFilteredStatus) swipeFilteredStatus.textContent = '';
  setText('#activePersonLabel', t.activePersonLabel);
  setText('#filterLabel', t.filterLabel);
  setText(filterToggle, t.filterToggle);
  updateFilterMenuLabels(t);
  setText('#runtimeLabel', t.runtimeLabel);
  setText('#criticLabel', t.criticLabel);
  setText('#releaseLabel', t.releaseLabel);
  setText('label[for="filter4kMain"]', t.filter4k);
  setText(fetchMoviesBtn, t.fetchBtn);
  setText(loadMoviesBtn, t.csvBtn);
  setText(resetFiltersBtn, t.resetFilters);
  setText('#voteSection .hint', t.voteHint);
  setText(showResultsBtn, t.showResults);
  setText('#resultsSection h2', t.resultsTitle);
  setText('#voteSection h2', t.compareTitle);
  setText('#top10Card h3', t.top10Title);
  setText(downloadTop10Btn, t.downloadTop10);
  setText(downloadRankingCsvBtn, t.downloadRankingCsv || 'CSV Download');
  setText('#rankingCard summary', t.rankingTitle);
  setText('#swiperSection .page-subtitle h2', t.swiperTitle);
  setText('#swipeSetupTitle', t.swipeHeading);
  if (swipeStatus) swipeStatus.textContent = '';
  if (swipeFilteredStatus) swipeFilteredStatus.textContent = '';
  setText('#swiperPersonsLabel', t.swiperPersonsLabel);
  setText('label[for="swipeSourceMode"]', t.swipeSourceLabel);
  const sourceManualOption = document.querySelector('#swipeSourceMode option[value="manual"]');
  const sourceFilteredOption = document.querySelector('#swipeSourceMode option[value="filtered"]');
  setText(sourceManualOption, t.swipeSourceManual);
  setText(sourceFilteredOption, t.swipeSourceFiltered);
  setText(swLoadFilteredBtn, t.loadFiltered || t.fetchBtn);
  setText(swResetFiltersBtn, t.resetFilters);
  setText(swClearListBtn, t.clearList);
  setText(confirmSetupBtn, t.confirm);
  setText(confirmSwipeBtn, t.confirm);
  setText(resetAllBtn, t.resetServerState || t.resetAll || 'Reset');
  setText('#swiperActivePersonLabel', t.activePersonLabel);
  const swFilterLabel = swFilterDropdown?.querySelector('label');
  const swRuntimeLabel = swRuntimeDropdown?.querySelector('label');
  const swCriticLabel = swCriticDropdown?.querySelector('label');
  const swYearLabel = swYearDropdown?.querySelector('label');
  setText(swFilterLabel, t.filterLabel);
  setText(swRuntimeLabel, t.runtimeLabel);
  setText(swCriticLabel, t.criticLabel);
  setText(swYearLabel, t.releaseLabel);
  setText('label[for="swFilter4kInline"]', t.filter4k);
  updateSwFilterMenuLabels(t);
  const matchLabel = document.querySelector('#matchList')?.previousElementSibling;
  if (matchLabel) matchLabel.textContent = t.matchesTitle;
  setText('#settingsOverlay h3', t.settingsTitle);
  setText('label[for="uiLanguageSelect"]', t.uiLangLabel);
  setText('label[for="titleLanguageSelect"]', t.titleLangLabel);
  const uiLangDeOption = document.querySelector('#uiLanguageSelect option[value="de"]');
  const uiLangEnOption = document.querySelector('#uiLanguageSelect option[value="en"]');
  const titleLangEnOption = document.querySelector('#titleLanguageSelect option[value="en"]');
  const titleLangDeOption = document.querySelector('#titleLanguageSelect option[value="de"]');
  setText(uiLangDeOption, t.uiLangOptionDe);
  setText(uiLangEnOption, t.uiLangOptionEn);
  setText(titleLangEnOption, t.titleLangOptionEn);
  setText(titleLangDeOption, t.titleLangOptionDe);
  setText(settingsSave, t.settingsSave);
  setText(settingsCancel, t.settingsCancel);
  setText(applySwiperPersonsBtn, t.applyBtn);
  setText(confirmTitle, t.clearList);
  setText(confirmMessage, t.clearConfirm);
  setText(confirmOk, t.confirm);
  setText(confirmCancel, t.settingsCancel);
  settingsBtn?.setAttribute('aria-label', t.settingsTitle || '');
  settingsClose?.setAttribute('aria-label', t.settingsCancel || '');
  toggleThemeBtn?.setAttribute('aria-label', t.themeToggle || '');
  swipeYesBtn?.setAttribute('aria-label', t.yes);
  swipeNoBtn?.setAttribute('aria-label', t.no);
  swipeCard?.setAttribute('aria-label', t.swipeHeading);
  updateFilterLabel();
  updateSwFilterLabel();
  updateRuntimeLabel();
  updateCriticLabel();
  updateYearLabel();
  updateSwRuntimeLabel();
  updateSwCriticLabel();
  updateSwYearLabel();
  updateMovieCountLabel();
  updateSwipeCard();
  updateSelectedMoviesSummary();
}

function setSaveStatus(msg) {
  if (saveStatus) saveStatus.textContent = msg || '';
}

function renderSaveList(saves = []) {
  if (!saveList) return;
  saveList.innerHTML = '';
  if (!saves.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No saves yet';
    opt.value = '';
    saveList.appendChild(opt);
    return;
  }
  saves.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.name;
    const label = s.createdAt ? `${s.name} (${new Date(s.createdAt).toLocaleString()})` : s.name;
    opt.textContent = label;
    saveList.appendChild(opt);
  });
}

async function fetchSaveList() {
  if (!saveList) return;
  try {
    const resp = await fetch(`${API_BASE}/saves`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);
    renderSaveList(data.saves || []);
    setSaveStatus('');
  } catch (err) {
    console.error(err);
    setSaveStatus(`Could not load saves: ${err.message}`);
  }
}

async function saveSnapshot() {
  const name = (saveNameInput?.value || '').trim();
  setSaveStatus('Saving snapshot...');
  try {
    const resp = await fetch(`${API_BASE}/save-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || null })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);
    renderSaveList(data.saves || []);
    setSaveStatus(`Saved as "${data.name}"`);
  } catch (err) {
    console.error(err);
    setSaveStatus(`Save failed: ${err.message}`);
  }
}

async function loadSnapshot() {
  const selected = saveList?.value || '';
  if (!selected) {
    setSaveStatus('Select a save first');
    return;
  }
  setSaveStatus(`Loading "${selected}"...`);
  try {
    const resp = await fetch(`${API_BASE}/load-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: selected })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);
    if (data.state) applyState(data.state, false, true);
    setSaveStatus(`Loaded "${selected}"`);
    await fetchSaveList();
  } catch (err) {
    console.error(err);
    setSaveStatus(`Load failed: ${err.message}`);
  }
}

function updateFilterMenuLabels(t) {
  const labels = filterMenu ? Array.from(filterMenu.querySelectorAll('label')) : [];
  const map = [
    { idx: 0, text: t.filterUnplayed },
    { idx: 1, text: t.filterPlayed }
  ];
  map.forEach(({ idx, text }) => {
    if (!labels[idx]) return;
    const nodes = labels[idx].childNodes;
    const last = nodes[nodes.length - 1];
    if (last && last.nodeType === 3) last.nodeValue = ` ${text}`;
    else labels[idx].append(document.createTextNode(` ${text}`));
  });
}

function updateSwFilterMenuLabels(t) {
  const labels = swFilterMenu ? Array.from(swFilterMenu.querySelectorAll('label')) : [];
  const map = [
    { idx: 0, text: t.filterUnplayed },
    { idx: 1, text: t.filterPlayed }
  ];
  map.forEach(({ idx, text }) => {
    if (!labels[idx]) return;
    const nodes = labels[idx].childNodes;
    const last = nodes[nodes.length - 1];
    if (last && last.nodeType === 3) last.nodeValue = ` ${text}`;
    else labels[idx].append(document.createTextNode(` ${text}`));
  });
}

function ensureSwipeFilterMenuIntegrity(reason) {
  if (!swFilterMenu) return;
  const hasUnplayed = !!document.getElementById('swFilterUnplayed');
  const hasPlayed = !!document.getElementById('swFilterPlayed');
  if (hasUnplayed && hasPlayed) return;
  debugLog('swFilterMenu rebuild', { reason, hasUnplayed, hasPlayed });
  swFilterMenu.innerHTML = `
    <label><input type="checkbox" id="swFilterUnplayed" value="IsUnplayed" checked> Unplayed</label>
    <label><input type="checkbox" id="swFilterPlayed" value="IsPlayed" checked> Played</label>
  `;
  swFilterUnplayed = document.getElementById('swFilterUnplayed');
  swFilterPlayed = document.getElementById('swFilterPlayed');
  attachSwipeFilterChangeHandlers();
  updateSwFilterMenuLabels(getT());
}

// Detects an open modal overlay, if any.
function getActiveOverlay() {
  return document.querySelector('.modal-overlay:not(.hidden)');
}

// Returns visible, focusable elements in DOM order for controller navigation.
function getFocusableElements(container) {
  const overlay = getActiveOverlay();
  const root = container || overlay || document;
  const selectors = ['button', '[tabindex]:not([tabindex="-1"])', 'a', 'input', 'select', 'textarea'];
  const nodes = Array.from(root.querySelectorAll(selectors.join(',')));
  return nodes.filter((el) => {
    if (!el) return false;
    if (typeof el.disabled === 'boolean' && el.disabled) return false;
    if (el.tabIndex !== undefined && el.tabIndex < 0) return false;
    const isVisible = el.offsetParent !== null || (typeof el.getClientRects === 'function' && el.getClientRects().length > 0);
    return isVisible;
  });
}

// Keeps focusIndex aligned with the currently focused DOM element.
function syncFocusIndex(focusables = getFocusableElements()) {
  if (!focusables.length) return -1;
  const activeIdx = focusables.indexOf(document.activeElement);
  if (activeIdx !== -1) {
    focusIndex = activeIdx;
    return focusIndex;
  }
  if (focusIndex >= focusables.length) focusIndex = 0;
  return focusIndex;
}

function moveFocus(delta) {
  const focusables = getFocusableElements();
  if (!focusables.length || !delta) return;
  syncFocusIndex(focusables);
  focusIndex = (focusIndex + delta + focusables.length) % focusables.length;
  const target = focusables[focusIndex];
  if (target && typeof target.focus === 'function') target.focus();
}

function clickFocused() {
  const focusables = getFocusableElements();
  if (!focusables.length) return false;
  syncFocusIndex(focusables);
  const target = focusables[focusIndex];
  if (!target) return false;
  if (typeof target.focus === 'function') target.focus();
  if (typeof target.click === 'function') target.click();
  return true;
}

function setGamepadFocus(side) {
  gamepadFocus = side === 'right' ? 'right' : 'left';
  leftCard?.classList.toggle('hover', gamepadFocus === 'left');
  rightCard?.classList.toggle('hover', gamepadFocus === 'right');
}

// Edge-detection helper: returns true only on the transition to pressed.
function wasButtonPressed(buttonIndex, gp) {
  const pressedNow = !!(gp?.buttons?.[buttonIndex]?.pressed);
  const pressedBefore = !!gamepadPrevButtons[buttonIndex];
  gamepadPrevButtons[buttonIndex] = pressedNow;
  return pressedNow && !pressedBefore;
}

function focusFirstInOverlay(overlay) {
  if (!overlay || overlay.classList.contains('hidden')) return;
  const focusables = getFocusableElements(overlay);
  if (!focusables.length) return;
  focusIndex = 0;
  if (typeof focusables[0].focus === 'function') focusables[0].focus();
}

function stopGamepadLoop() {
  if (gamepadPollId) cancelAnimationFrame(gamepadPollId);
  gamepadPollId = null;
  gamepadPrevButtons = [];
  leftCard?.classList.remove('hover');
  rightCard?.classList.remove('hover');
}

function gamepadFrame() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = pads && pads[0];
  if (!gp) {
    gamepadPrevButtons = [];
    gamepadPollId = requestAnimationFrame(gamepadFrame);
    return;
  }
  const axisX = gp.axes && gp.axes.length ? gp.axes[0] : 0;
  const axisScroll = gp.axes && gp.axes.length > 3 ? gp.axes[3] : 0;

  const dpadRight = wasButtonPressed(GAMEPAD_BUTTONS.DPAD_RIGHT, gp);
  const dpadDown = wasButtonPressed(GAMEPAD_BUTTONS.DPAD_DOWN, gp);
  const dpadLeft = wasButtonPressed(GAMEPAD_BUTTONS.DPAD_LEFT, gp);
  const dpadUp = wasButtonPressed(GAMEPAD_BUTTONS.DPAD_UP, gp);
  const moveNext = dpadRight || dpadDown;
  const movePrev = dpadLeft || dpadUp;
  if (moveNext) moveFocus(1);
  if (movePrev) moveFocus(-1);

  if (wasButtonPressed(GAMEPAD_BUTTONS.A, gp)) clickFocused();

  const settingsOpen = settingsOverlay && !settingsOverlay.classList.contains('hidden');
  if (wasButtonPressed(GAMEPAD_BUTTONS.START, gp)) {
    settingsOverlay?.classList.remove('hidden');
    focusFirstInOverlay(settingsOverlay);
  }
  if (settingsOpen && wasButtonPressed(GAMEPAD_BUTTONS.B, gp)) {
    settingsOverlay?.classList.add('hidden');
    if (settingsBtn && typeof settingsBtn.focus === 'function') settingsBtn.focus();
  }

  // Left stick horizontal still toggles the two voting cards.
  if (axisX < -GAMEPAD_DEADZONE) setGamepadFocus('left');
  if (axisX > GAMEPAD_DEADZONE) setGamepadFocus('right');

  // Right stick vertical scroll
  if (Math.abs(axisScroll) > GAMEPAD_DEADZONE) {
    const delta = axisScroll * 15; // tune scroll speed
    window.scrollBy(0, delta);
    gamepadPrevScroll = axisScroll;
  } else {
    gamepadPrevScroll = 0;
  }

  gamepadPollId = requestAnimationFrame(gamepadFrame);
}

// Keep controller navigation in sync when focus changes via mouse/keyboard.
function handleFocusChange(e) {
  const focusables = getFocusableElements();
  const idx = focusables.indexOf(e.target);
  if (idx !== -1) focusIndex = idx;
  if (e.target === leftCard) setGamepadFocus('left');
  else if (e.target === rightCard) setGamepadFocus('right');
  else {
    leftCard?.classList.remove('hover');
    rightCard?.classList.remove('hover');
  }
}

function ensureSwipeFilterCheckboxes() {
  if (!swFilterMenu) return;
  swFilterUnplayed = document.getElementById('swFilterUnplayed');
  swFilterPlayed = document.getElementById('swFilterPlayed');
  debugLog('ensureSwipeFilterCheckboxes', {
    hasMenu: !!swFilterMenu,
    unplayedExists: !!swFilterUnplayed,
    playedExists: !!swFilterPlayed,
    innerHTML: swFilterMenu.innerHTML
  });
  ensureSwipeFilterMenuIntegrity('initial');
  attachSwipeFilterChangeHandlers();
  updateSwFilterMenuLabels(getT());
}

function attachSwipeFilterChangeHandlers() {
  if (!swFilterMenu) return;
  swFilterMenu.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.removeEventListener('change', updateSwFilterLabel);
    cb.addEventListener('change', updateSwFilterLabel);
  });
}

window.addEventListener('error', (e) => {
  logError('window_error', e.error || e.message || 'unknown', { filename: e.filename, lineno: e.lineno, colno: e.colno });
});
window.addEventListener('unhandledrejection', (e) => {
  logError('unhandled_rejection', e.reason || 'unknown');
});


function setupSettingsModal() {
  const openModal = () => {
    settingsOverlay?.classList.remove('hidden');
    focusFirstInOverlay(settingsOverlay);
  };
  const closeModal = () => {
    settingsOverlay?.classList.add('hidden');
    if (settingsBtn && typeof settingsBtn.focus === 'function') settingsBtn.focus();
  };
  settingsBtn?.addEventListener('click', openModal);
  settingsClose?.addEventListener('click', closeModal);
  settingsCancel?.addEventListener('click', closeModal);
  resetAllBtn?.addEventListener('click', resetAllStates);
  settingsOverlay?.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) closeModal();
  });
  titleLanguageSelect?.addEventListener('change', () => {
    titleLanguage = titleLanguageSelect.value;
  });
  uiLanguageSelect?.addEventListener('change', () => {
    uiLanguage = uiLanguageSelect.value;
    applyUILanguage();
  });
  settingsSave?.addEventListener('click', async () => {
    uiLanguage = uiLanguageSelect?.value || getDefaultUILanguage();
    titleLanguage = titleLanguageSelect?.value || getDefaultTitleLanguage();
    localStorage.setItem('uiLanguage', uiLanguage);
    localStorage.setItem('titleLanguage', titleLanguage);
    applyUILanguage();
    settingsOverlay?.classList.add('hidden');
    await loadSwipeSuggestions(true);
  });
}

let pendingConfirmAction = null;

function setupConfirmModal() {
  const closeConfirm = () => {
    if (confirmOverlay) confirmOverlay.classList.add('hidden');
    pendingConfirmAction = null;
  };
  confirmCancel?.addEventListener('click', closeConfirm);
  confirmOverlay?.addEventListener('click', (e) => {
    if (e.target === confirmOverlay) closeConfirm();
  });
  confirmOk?.addEventListener('click', () => {
    const action = pendingConfirmAction;
    closeConfirm();
    if (typeof action === 'function') action();
  });
}

function openConfirmModal(title, message, onConfirm) {
  const t = getT();
  if (confirmTitle) confirmTitle.textContent = title || t.clearList || 'Confirm';
  if (confirmMessage) confirmMessage.textContent = message || t.clearConfirm || '';
  if (confirmOk) confirmOk.textContent = t.confirm || 'OK';
  if (confirmCancel) confirmCancel.textContent = t.settingsCancel || 'Cancel';
  pendingConfirmAction = onConfirm;
  confirmOverlay?.classList.remove('hidden');
  focusFirstInOverlay(confirmOverlay);
}

// ----- DOM references -----
const statusEl = document.getElementById('status');
const voteSection = document.getElementById('voteSection');
const resultsSection = document.getElementById('resultsSection');
const currentPersonLabel = document.getElementById('currentPersonLabel');
const movieCountLabel = document.getElementById('movieCountLabel');
const comparisonCountEl = document.getElementById('comparisonCount');
const top10Container = document.getElementById('top10Container');
const tableAverage = document.getElementById('tableAverage');
const numPersonsSelect = document.getElementById('numPersonsSelect');
const applyPersonsBtn = document.getElementById('applyPersonsBtn');
const personButtons = document.getElementById('personButtons');
const tabRanker = document.getElementById('tabRanker');
const tabSwiper = document.getElementById('tabSwiper');
const rankerSection = document.getElementById('rankerSection');
const swiperSection = document.getElementById('swiperSection');
const swipeDeckSection = document.getElementById('swipeDeckSection');
// Swiper DOM
const swipeCard = document.getElementById('swipeCard');
const swipeStatus = document.getElementById('swipeStatus');
const swipeYesBtn = document.getElementById('swipeYesBtn');
const swipeNoBtn = document.getElementById('swipeNoBtn');
const movieInput = document.getElementById('movieInput');
const movieSuggestList = document.getElementById('movieSuggestList');
const addMovieBtn = document.getElementById('addMovieBtn');
const selectedMoviesManualEl = document.getElementById('selectedMoviesManual');
const selectedMoviesAutoEl = document.getElementById('selectedMoviesAuto');
const swiperPersonButtons = document.getElementById('swiperPersonButtons');
const swipeSourceMode = document.getElementById('swipeSourceMode');
const swipeManualBlock = document.getElementById('swipeManualBlock');
const swipeFilteredBlock = document.getElementById('swipeFilteredBlock');
const swFilterDropdown = document.getElementById('swFilterDropdown');
const swFilterToggle = document.getElementById('swFilterToggle');
const swFilterMenu = document.getElementById('swFilterMenu');
let swFilterUnplayed = document.getElementById('swFilterUnplayed');
let swFilterPlayed = document.getElementById('swFilterPlayed');
const swFilter4kInline = document.getElementById('swFilter4kInline');
const swRuntimeDropdown = document.getElementById('swRuntimeDropdown');
const swRuntimeToggle = document.getElementById('swRuntimeToggle');
const swRuntimeMenu = document.getElementById('swRuntimeMenu');
const swRuntimeMin = document.getElementById('swRuntimeMin');
const swRuntimeMax = document.getElementById('swRuntimeMax');
const swRuntimeMinNum = document.getElementById('swRuntimeMinNum');
const swRuntimeMaxNum = document.getElementById('swRuntimeMaxNum');
const swCriticDropdown = document.getElementById('swCriticDropdown');
const swCriticToggle = document.getElementById('swCriticToggle');
const swCriticMenu = document.getElementById('swCriticMenu');
const swCriticMin = document.getElementById('swCriticMin');
const swCriticMax = document.getElementById('swCriticMax');
const swCriticMinNum = document.getElementById('swCriticMinNum');
const swCriticMaxNum = document.getElementById('swCriticMaxNum');
const swYearDropdown = document.getElementById('swYearDropdown');
const swYearToggle = document.getElementById('swYearToggle');
const swYearMenu = document.getElementById('swYearMenu');
const swYearMin = document.getElementById('swYearMin');
const swYearMax = document.getElementById('swYearMax');
const swYearMinNum = document.getElementById('swYearMinNum');
const swYearMaxNum = document.getElementById('swYearMaxNum');
const swMaxMoviesInput = document.getElementById('swMaxMovies');
const rankMaxMoviesInput = document.getElementById('rankMaxMovies');
const swLoadFilteredBtn = document.getElementById('swLoadFilteredBtn');
const swResetFiltersBtn = document.getElementById('swResetFiltersBtn');
const swipeFilteredStatus = document.getElementById('swipeFilteredStatus');
const swiperPersonSelect = document.getElementById('swiperPersonSelect');
const applySwiperPersonsBtn = document.getElementById('applySwiperPersonsBtn');
const swipeTitle = document.getElementById('swipeTitle');
const swipeMeta = document.getElementById('swipeMeta');
const selectedMoviesSummaryManual = document.querySelector('#selectedMoviesWrapManual summary');
const selectedMoviesSummaryAuto = document.querySelector('#selectedMoviesWrapAuto summary');
const matchList = document.getElementById('matchList');
const swClearListBtn = document.getElementById('swClearListBtn');
const settingsBtn = document.getElementById('settingsBtn');
const settingsOverlay = document.getElementById('settingsOverlay');
const settingsClose = document.getElementById('settingsClose');
const settingsSave = document.getElementById('settingsSave');
const settingsCancel = document.getElementById('settingsCancel');
const resetAllBtn = document.getElementById('resetAllBtn');
const confirmOverlay = document.getElementById('confirmOverlay');
const confirmTitle = document.getElementById('confirmTitle');
const confirmMessage = document.getElementById('confirmMessage');
const confirmOk = document.getElementById('confirmOk');
const confirmCancel = document.getElementById('confirmCancel');
const uiLanguageSelect = document.getElementById('uiLanguageSelect');
const titleLanguageSelect = document.getElementById('titleLanguageSelect');
const matchOverlay = document.getElementById('matchOverlay');
const matchPoster = document.getElementById('matchPoster');
const matchTitleEl = document.getElementById('matchTitle');
const matchContinue = document.getElementById('matchContinue');
const leftCard = document.getElementById('leftCard');
const rightCard = document.getElementById('rightCard');
const fetchMoviesBtn = document.getElementById('fetchMoviesBtn');
const loadMoviesBtn = document.getElementById('loadMoviesBtn');
const resetFiltersBtn = document.getElementById('resetFiltersBtn');
const filterDropdown = document.getElementById('filterDropdown');
const filterToggle = document.getElementById('filterToggle');
const filterMenu = document.getElementById('filterMenu');
const filter4kMain = document.getElementById('filter4kMain');
const runtimeDropdown = document.getElementById('runtimeDropdown');
const runtimeMinInput = document.getElementById('runtimeMin');
const runtimeMaxInput = document.getElementById('runtimeMax');
const runtimeMinNumInput = document.getElementById('runtimeMinNum');
const runtimeMaxNumInput = document.getElementById('runtimeMaxNum');
const criticDropdown = document.getElementById('criticDropdown');
const criticMinInput = document.getElementById('criticMin');
const criticMaxInput = document.getElementById('criticMax');
const criticMinNumInput = document.getElementById('criticMinNum');
const criticMaxNumInput = document.getElementById('criticMaxNum');
const yearDropdown = document.getElementById('yearDropdown');
const yearMinInput = document.getElementById('yearMin');
const yearMaxInput = document.getElementById('yearMax');
const yearMinNumInput = document.getElementById('yearMinNum');
const yearMaxNumInput = document.getElementById('yearMaxNum');
const runtimeToggle = document.getElementById('runtimeToggle');
const runtimeMenu = document.getElementById('runtimeMenu');
const criticToggle = document.getElementById('criticToggle');
const criticMenu = document.getElementById('criticMenu');
const yearToggle = document.getElementById('yearToggle');
const yearMenu = document.getElementById('yearMenu');
const progressBar = document.getElementById('progressBar');
const progressLabel = document.getElementById('progressLabel');
const personProgress = document.getElementById('personProgress');
const confirmSetupBtn = document.getElementById('confirmSetupBtn');
const confirmSwipeBtn = document.getElementById('confirmSwipeBtn');
const downloadTop10Btn = document.getElementById('downloadTop10Btn');
const downloadRankingCsvBtn = document.getElementById('downloadRankingCsvBtn');
const showResultsBtn = document.getElementById('showResultsBtn');
const pairContainer = document.getElementById('pairContainer');
const leftImage = document.getElementById('leftImage');
const rightImage = document.getElementById('rightImage');
const leftTitleEl = document.getElementById('leftTitle');
const rightTitleEl = document.getElementById('rightTitle');
const swipeProgressEl = document.getElementById('swipeProgress');
const swipeProgressLabel = document.getElementById('swipeProgressLabel');
const swipeProgressBar = document.getElementById('swipeProgressBar');
const ACCENT_CLASSES = ['accent-person1', 'accent-person2', 'accent-person3', 'accent-person4', 'accent-person5'];
const toggleThemeBtn = document.getElementById('toggleThemeBtn');
const saveNameInput = document.getElementById('saveNameInput');
const saveStateBtn = document.getElementById('saveStateBtn');
const refreshSavesBtn = document.getElementById('refreshSavesBtn');
const loadSaveBtn = document.getElementById('loadSaveBtn');
const saveList = document.getElementById('saveList');
const saveStatus = document.getElementById('saveStatus');

init();

async function init() {
  logClient(LOG_CATEGORIES.frontend, 'init_start');
  await loadAppConfig();
  API_BASE = computeApiBase();
  ensureSwipeFilterCheckboxes();
  if (swFilterMenu) {
    debugLog('swFilterMenu init snapshot', { innerHTML: swFilterMenu.innerHTML });
    const observer = new MutationObserver(() => {
      const hasUnplayed = !!document.getElementById('swFilterUnplayed');
      const hasPlayed = !!document.getElementById('swFilterPlayed');
      debugLog('swFilterMenu mutated', { innerHTML: swFilterMenu.innerHTML, hasUnplayed, hasPlayed });
      if (!hasUnplayed || !hasPlayed) ensureSwipeFilterMenuIntegrity('mutation');
    });
    observer.observe(swFilterMenu, { childList: true, subtree: true });
  }
  window.addEventListener('gamepadconnected', () => { if (!gamepadPollId) gamepadFrame(); });
  window.addEventListener('gamepaddisconnected', stopGamepadLoop);
  applyAppConfigDefaults();
  await initLanguages();
  bindEvents();
  fetchSaveList();
  setDefaults();
  fetchState(true, { allowCsvFallback: true }).catch(err => logError('fetchState', err));
  logClient(LOG_CATEGORIES.frontend, 'init_done');
}

async function initLanguages() {
  await loadLanguageConfig();
  loadLanguageSettings();
  applyUILanguage();
  setupSettingsModal();
}

function bindEvents() {
  loadMoviesBtn?.addEventListener('click', loadMoviesFromCsv);
  fetchMoviesBtn?.addEventListener('click', () => fetchAndLoadMovies());
  resetFiltersBtn?.addEventListener('click', resetFilters);
  showResultsBtn?.addEventListener('click', showResults);
  downloadTop10Btn?.addEventListener('click', downloadTop10Image);
  saveStateBtn?.addEventListener('click', saveSnapshot);
  refreshSavesBtn?.addEventListener('click', fetchSaveList);
  loadSaveBtn?.addEventListener('click', loadSnapshot);
  applyPersonsBtn?.addEventListener('click', onApplyPersons);

  // person buttons handled in renderPersonButtons

  leftCard?.addEventListener('click', () => vote(0));
  rightCard?.addEventListener('click', () => vote(1));

  filterToggle?.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(filterMenu); });
  runtimeToggle?.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(runtimeMenu); });
  criticToggle?.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(criticMenu); });
  yearToggle?.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(yearMenu); });
  swFilterToggle?.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(swFilterMenu); });
  swRuntimeToggle?.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(swRuntimeMenu); });
  swCriticToggle?.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(swCriticMenu); });
  swYearToggle?.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(swYearMenu); });

  filterMenu?.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.addEventListener('change', updateFilterLabel));
  attachSwipeFilterChangeHandlers();

  [runtimeMenu, criticMenu, yearMenu, swFilterMenu, swRuntimeMenu, swCriticMenu, swYearMenu].forEach(menu => menu?.addEventListener('click', (e) => e.stopPropagation()));
  document.addEventListener('click', handleOutsideClick);
  document.addEventListener('focusin', handleFocusChange);

  const rankDefaults = getRankerDefaults();
  const swipeDefaults = getSwipeDefaults();
  const currentYear = new Date().getFullYear();
  const rankYearMaxBound = Math.max(rankDefaults.yearMax, currentYear);
  const swipeYearMaxBound = Math.max(swipeDefaults.yearMax, currentYear);
  linkRangeInputs(runtimeMinInput, runtimeMaxInput, runtimeMinNumInput, runtimeMaxNumInput, rankDefaults.runtimeMin, rankDefaults.runtimeMax, updateRuntimeLabel);
  linkRangeInputs(criticMinInput, criticMaxInput, criticMinNumInput, criticMaxNumInput, rankDefaults.criticMin, rankDefaults.criticMax, updateCriticLabel, appConfig?.ranker?.critic?.step ?? 0.1);
  if (yearMaxInput) yearMaxInput.max = rankYearMaxBound;
  if (yearMaxNumInput) yearMaxNumInput.max = rankYearMaxBound;
  linkRangeInputs(yearMinInput, yearMaxInput, yearMinNumInput, yearMaxNumInput, rankDefaults.yearMin, rankYearMaxBound, updateYearLabel);
  // Swipe filter controls
  linkRangeInputs(swRuntimeMin, swRuntimeMax, swRuntimeMinNum, swRuntimeMaxNum, swipeDefaults.runtimeMin, swipeDefaults.runtimeMax, updateSwRuntimeLabel);
  linkRangeInputs(swCriticMin, swCriticMax, swCriticMinNum, swCriticMaxNum, swipeDefaults.criticMin, swipeDefaults.criticMax, updateSwCriticLabel, appConfig?.swipe?.critic?.step ?? 0.1);
  if (swYearMax) swYearMax.max = swipeYearMaxBound;
  if (swYearMaxNum) swYearMaxNum.max = swipeYearMaxBound;
  linkRangeInputs(swYearMin, swYearMax, swYearMinNum, swYearMaxNum, swipeDefaults.yearMin, swipeYearMaxBound, updateSwYearLabel);

  if (swMaxMoviesInput) {
    const updateSwMaxLabel = () => {
      const val = parseInt(swMaxMoviesInput.value, 10);
      swMaxMovies = !val ? Infinity : Math.max(0, val);
    };
    swMaxMoviesInput.addEventListener('input', updateSwMaxLabel);
    swMaxMoviesInput.addEventListener('change', updateSwMaxLabel);
    updateSwMaxLabel();
  }

  if (rankMaxMoviesInput) {
    const updateRankMax = () => {
      const val = parseInt(rankMaxMoviesInput.value, 10);
      rankMaxMovies = !val ? Infinity : Math.max(0, val);
      rankMaxMoviesInput.value = isNaN(val) || val < 0 ? 0 : val;
    };
    rankMaxMoviesInput.addEventListener('input', updateRankMax);
    rankMaxMoviesInput.addEventListener('change', updateRankMax);
    updateRankMax();
  }

  touchSetup();
  setupHeaderButtons();
  initTabs(initialTab);
  initSwiper();
  loadSwipeStateFromServer();
  confirmSetupBtn?.addEventListener('click', confirmRankerSetup);
  confirmSwipeBtn?.addEventListener('click', confirmSwipeSetup);
  setupConfirmModal();
  downloadRankingCsvBtn?.addEventListener('click', downloadRankingCsv);
  matchContinue?.addEventListener('click', closeMatchModal);
  matchOverlay?.addEventListener('click', (e) => { if (e.target === matchOverlay) closeMatchModal(); });
}

function setDefaults() {
  personCount = Math.max(1, parseInt(numPersonsSelect?.value || '1', 10));
  persons = Array.from({ length: personCount }, (_, i) => `person${i + 1}`);
  comparisonCount = persons.reduce((acc, p) => ({ ...acc, [p]: 0 }), {});
  currentPerson = persons[0];
  renderPersonButtons();
  updateCurrentPersonLabel();
  setAccentForPerson(currentPerson);
  updateMovieCountLabel();
  updateFilterLabel();
  updateRuntimeLabel();
  updateCriticLabel();
  updateYearLabel();
  pairCoverage = { coveredPairs: 0, totalPairs: 0, ratio: 0 };
  pairCoveragePerPerson = persons.reduce((acc, p) => ({ ...acc, [p]: { coveredPairs: 0, totalPairs: 0, ratio: 0 } }), {});
  updateProgress();
  updatePersonProgress();
}

async function fetchState(showStatus = false, opts = {}) {
  const allowCsvFallback = !!opts.allowCsvFallback && !csvFallbackAttempted;
  const preservePair = !!opts.preservePair;
  const skipPickPair = !!opts.skipPickPair;
  try {
    const resp = await fetch(`${API_BASE}/state`);
    if (!resp.ok) throw new Error(getT().statusNoState);
    const data = await resp.json();
    if (!data.ok || !data.state) throw new Error(data.error || getT().statusNoState);
    applyState(data.state, preservePair, skipPickPair);
    if (allowCsvFallback && (movies || []).length < 2) {
      csvFallbackAttempted = true;
      const loaded = await loadMoviesFromCsv();
      return loaded;
    }
    if (showStatus) setStatus(getT().statusLoaded);
    return true;
  } catch (err) {
    console.error(err);
    if (showStatus) setStatus(getT().statusNoState);
    rankerConfirmed = false;
    updateVoteVisibility(preservePair, skipPickPair);
    voteSection?.classList.add('hidden');
    return false;
  }
}

async function loadMoviesFromCsv() {
  const t = getT();
  const btn = loadMoviesBtn;
  const loadingMsg = t.statusCsvLoading || t.statusFetching || '';
  if (loadingMsg) setStatus(loadingMsg);
  resultsSection?.classList.add('hidden');
  voteSection?.classList.add('hidden');
  try {
    if (btn) btn.disabled = true;
    const resp = await fetch(`${API_BASE}/load-csv`, { method: 'POST' });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);
    if (data.state) applyState(data.state, false);
    else await fetchState(false, { preservePair: false, allowCsvFallback: false });
    const count = data.count ?? data.state?.movies?.length;
    const okTpl = t.statusCsvOk || t.statusLoaded || '';
    if (okTpl && count !== undefined) setStatus(okTpl.replace('{count}', count));
    else if (okTpl) setStatus(okTpl);
    rankerConfirmed = false;
    updateVoteVisibility();
    return true;
  } catch (err) {
    console.error(err);
    const prefix = t.statusCsvError || t.statusFetchError || '';
    setStatus(prefix + err.message);
    rankerConfirmed = false;
    updateVoteVisibility();
    return false;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function applyState(state, preservePair = false, skipPickPair = false) {
  if (!state) return;
  const defaults = getRankerDefaults();
  movies = (state.movies || []).map(normalizeMovieImage);
  const tsCfg = state.tsConfig || {};
  TS_MU = !isNaN(parseFloat(tsCfg.mu)) ? parseFloat(tsCfg.mu) : TS_MU;
  TS_SIGMA = !isNaN(parseFloat(tsCfg.sigma)) ? parseFloat(tsCfg.sigma) : TS_SIGMA;
  movieByTitle = Object.fromEntries((movies || []).map(m => [m.title, m]));
  const incomingRatings = state.ratings || {};
  const normalizedRatings = {};
  movies.forEach((m) => { normalizedRatings[m.title] = ensureTsRating(incomingRatings[m.title]); });
  Object.keys(incomingRatings).forEach((title) => {
    if (!normalizedRatings[title]) normalizedRatings[title] = ensureTsRating(incomingRatings[title]);
  });
  ratings = normalizedRatings;
  comparisonCount = state.comparisonCount || {};
  personCount = Math.max(1, parseInt(state.personCount || 1, 10));
  persons = Array.from({ length: personCount }, (_, i) => `person${i + 1}`);
  persons.forEach(p => { if (comparisonCount[p] === undefined) comparisonCount[p] = 0; });
  currentPerson = persons.includes(currentPerson) ? currentPerson : persons[0];
  totalVotes = state.totalVotes || 0;
  const rawCoverage = state.pairCoverage || { coveredPairs: 0, totalPairs: 0, ratio: 0 };
  const inferredTotalPairs = rawCoverage.totalPairs ?? (movies.length > 1 ? (movies.length * (movies.length - 1)) / 2 : 0);
  const totalPairsOverall = rawCoverage.totalPairs ?? inferredTotalPairs;
  const coveredOverall = rawCoverage.coveredPairs ?? 0;
  pairCoverage = { coveredPairs: coveredOverall, totalPairs: totalPairsOverall, ratio: totalPairsOverall ? coveredOverall / totalPairsOverall : 0 };
  pairCoveragePerPerson = state.pairCoveragePerPerson || {};
  persons.forEach((p) => {
    const entry = pairCoveragePerPerson[p] || { coveredPairs: 0, totalPairs: inferredTotalPairs, ratio: 0 };
    const totalPairs = entry.totalPairs ?? inferredTotalPairs;
    const covered = entry.coveredPairs ?? 0;
    pairCoveragePerPerson[p] = { coveredPairs: covered, totalPairs, ratio: totalPairs ? covered / totalPairs : 0 };
  });
  rankerConfirmed = !!state.rankerConfirmed;

  if (numPersonsSelect) numPersonsSelect.value = personCount.toString();
  if (!persons.includes(currentPerson)) currentPerson = persons[0];
  renderPersonButtons();
  updateCurrentPersonLabel();
  if (activeSection === 'ranker') setAccentForPerson(currentPerson);

  // Filterwerte aus Zustand uebernehmen
  const filters = state.filters || defaults.filters;
  if (filterMenu) {
    filterMenu.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (filters.length === 0) cb.checked = true; // beide aktiv
      else cb.checked = filters.includes(cb.value);
    });
    updateFilterLabel();
  }
  if (filter4kMain) filter4kMain.checked = filters.includes('Is4K') || defaults.include4k;
  if (runtimeMinInput && runtimeMaxInput) {
    runtimeMinInput.value = state.runtimeMin ?? defaults.runtimeMin;
    runtimeMaxInput.value = state.runtimeMax ?? defaults.runtimeMax;
    runtimeMinNumInput.value = runtimeMinInput.value;
    runtimeMaxNumInput.value = runtimeMaxInput.value;
    updateRuntimeLabel();
  }
  if (criticMinInput && criticMaxInput) {
    criticMinInput.value = state.criticMin ?? defaults.criticMin;
    criticMaxInput.value = state.criticMax ?? defaults.criticMax;
    criticMinNumInput.value = criticMinInput.value;
    criticMaxNumInput.value = criticMaxInput.value;
    updateCriticLabel();
  }
  if (yearMinInput && yearMaxInput) {
    const cy = new Date().getFullYear();
    yearMinInput.value = state.yearMin ?? defaults.yearMin;
    yearMaxInput.value = state.yearMax ?? defaults.yearMax ?? cy;
    yearMinNumInput.value = yearMinInput.value;
    yearMaxNumInput.value = yearMaxInput.value;
    updateYearLabel();
  }

  updateProgress();
  updateMovieCountLabel();
  updateComparisonCountText();
  updatePersonProgress();
  updateVoteVisibility(preservePair, skipPickPair);
}

async function fetchAndLoadMovies(statusHandler) {
  const t = getT();
  const setStatusFn = typeof statusHandler === 'function' ? statusHandler : setStatus;
  const selected = getSelectedFilters();
  const bothChecked = selected.length === 2;
  const filters = bothChecked ? [] : selected; // leeres Array = beide
  const runtimeMin = getNumber(runtimeMinInput, 20);
  const runtimeMax = getNumber(runtimeMaxInput, 300);
  const criticMin = getNumber(criticMinInput, 0);
  const criticMax = getNumber(criticMaxInput, 10);
  const yearMin = getNumber(yearMinInput, 1950);
  const yearMax = getNumber(yearMaxInput, new Date().getFullYear());

  setStatusFn(t.statusFetching);
  fetchMoviesBtn.disabled = true;
  resultsSection?.classList.add('hidden');
  voteSection?.classList.add('hidden');
  try {
    const maxMoviesVal = isFinite(rankMaxMovies) ? rankMaxMovies : 0;
    const resp = await fetch(`${API_BASE}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters, runtimeMin, runtimeMax, criticMin, criticMax, yearMin, yearMax, personCount, lang: titleLanguage || 'en', maxMovies: maxMoviesVal })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);
    const countLabel = data.count ?? t.unknownCount;
    setStatusFn(t.statusFetchOk.replace('{count}', countLabel));
    await fetchState(false, { preservePair: false, allowCsvFallback: false });
  } catch (err) {
    console.error(err);
    setStatusFn(t.statusFetchError + err.message);
  } finally {
    fetchMoviesBtn.disabled = false;
  }
}

function resetFilters() {
  const defaults = getRankerDefaults();
  applyRankerDefaultsFromConfig();
  setStatus(getT().statusFiltersReset);
}

function resetSwipeFilters() {
  applySwipeDefaultsFromConfig();
  if (swipeFilteredStatus) swipeFilteredStatus.textContent = '';
}

function updateToggleLabelFromMenu(menu, toggle) {
  if (!toggle || !menu) return;
  const selected = Array.from(menu.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.parentElement.textContent.trim());
  const total = menu.querySelectorAll('input[type="checkbox"]').length;
  const t = getT();
  let label = t.filterNone;
  if (selected.length === total && total > 0) label = t.filterToggle;
  else if (selected.length === 1) label = selected[0];
  toggle.textContent = label;
}

function updateRangeToggleLabel(toggle, minInput, maxInput) {
  if (toggle && minInput && maxInput) toggle.textContent = `${minInput.value} - ${maxInput.value}`;
}

function updateYearToggleLabel(toggle, minInput, maxInput) {
  if (!toggle || !minInput || !maxInput) return;
  const t = getT();
  const currentLabel = t.yearCurrent || 'current';
  const maxVal = maxInput.value;
  const currentYearStr = new Date().getFullYear().toString();
  const isCurrent = maxVal === '2100' || maxVal === currentYearStr;
  toggle.textContent = `${minInput.value} - ${isCurrent ? currentLabel : maxVal}`;
}

function toggleMenu(menu) {
  if (!menu) return;
  [filterMenu, runtimeMenu, criticMenu, yearMenu, swFilterMenu, swRuntimeMenu, swCriticMenu, swYearMenu].forEach(m => { if (m && m !== menu) m.classList.add('hidden'); });
  menu.classList.toggle('hidden');
}

function handleOutsideClick(e) {
  const keep = [filterDropdown, runtimeDropdown, criticDropdown, yearDropdown, swFilterDropdown, swRuntimeDropdown, swCriticDropdown, swYearDropdown].filter(Boolean);
  const inside = keep.some(el => el.contains(e.target));
  if (!inside) [filterMenu, runtimeMenu, criticMenu, yearMenu, swFilterMenu, swRuntimeMenu, swCriticMenu, swYearMenu].forEach(m => m?.classList.add('hidden'));
}

function updateFilterLabel() {
  updateToggleLabelFromMenu(filterMenu, filterToggle);
}

function updateSwFilterLabel() {
  updateToggleLabelFromMenu(swFilterMenu, swFilterToggle);
}

function updateRuntimeLabel() { updateRangeToggleLabel(runtimeToggle, runtimeMinInput, runtimeMaxInput); }
function updateCriticLabel() { updateRangeToggleLabel(criticToggle, criticMinInput, criticMaxInput); }
function updateYearLabel() { updateYearToggleLabel(yearToggle, yearMinInput, yearMaxInput); }
function updateSwRuntimeLabel() { updateRangeToggleLabel(swRuntimeToggle, swRuntimeMin, swRuntimeMax); }
function updateSwCriticLabel() { updateRangeToggleLabel(swCriticToggle, swCriticMin, swCriticMax); }
function updateSwYearLabel() { updateYearToggleLabel(swYearToggle, swYearMin, swYearMax); }

function getSelectedFilters() {
  if (!filterMenu) return [];
  const base = Array.from(filterMenu.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
  if (filter4kMain?.checked) base.push('Is4K');
  return base;
}

function getSwSelectedFilters() {
  if (!swFilterMenu) return [];
  const base = Array.from(swFilterMenu.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
  if (swFilter4kInline?.checked) base.push('Is4K');
  return base;
}

function linkRangeInputs(rangeMin, rangeMax, numMin, numMax, minVal, maxVal, onChange, step = 1) {
  if (!rangeMin || !rangeMax || !numMin || !numMax) return;
  [rangeMin, rangeMax, numMin, numMax].forEach(el => { el.step = step; });
  const syncFromRange = () => {
    let vMin = clamp(parseFloat(rangeMin.value), minVal, maxVal);
    let vMax = clamp(parseFloat(rangeMax.value), minVal, maxVal);
    if (vMin > vMax) vMin = vMax;
    rangeMin.value = vMin; rangeMax.value = vMax;
    numMin.value = vMin; numMax.value = vMax;
    onChange?.(vMin, vMax);
  };
  const syncFromNum = (forceClamp = false) => {
    let rawMin = parseFloat(numMin.value);
    let rawMax = parseFloat(numMax.value);
    if (isNaN(rawMin) || isNaN(rawMax)) {
      if (!forceClamp) return; // allow user to finish typing
      if (isNaN(rawMin)) rawMin = minVal;
      if (isNaN(rawMax)) rawMax = maxVal;
    }
    let vMin = clamp(rawMin, minVal, maxVal);
    let vMax = clamp(rawMax, minVal, maxVal);
    if (vMin > vMax) vMin = vMax;
    rangeMin.value = vMin; rangeMax.value = vMax;
    numMin.value = vMin; numMax.value = vMax;
    onChange?.(vMin, vMax);
  };
  rangeMin.addEventListener('input', syncFromRange);
  rangeMax.addEventListener('input', syncFromRange);
  numMin.addEventListener('input', () => syncFromNum(false));
  numMax.addEventListener('input', () => syncFromNum(false));
  numMin.addEventListener('change', () => syncFromNum(true));
  numMax.addEventListener('change', () => syncFromNum(true));
  syncFromRange();
}

function ensureTsRating(entry) {
  const base = entry || {};
  const mu = parseFloat(base.ts_mu ?? base.rating ?? TS_MU);
  const sigma = parseFloat(base.ts_sigma ?? TS_SIGMA);
  return {
    ts_mu: isNaN(mu) ? TS_MU : mu,
    ts_sigma: isNaN(sigma) ? TS_SIGMA : Math.max(sigma, 0.0001),
    games: parseInt(base.games ?? 0, 10) || 0,
    wins: parseInt(base.wins ?? 0, 10) || 0
  };
}

function thompsonSample(title) {
  const entry = ratings[title];
  if (!entry) return -Infinity;
  const mu = entry.ts_mu ?? TS_MU;
  const sigma = entry.ts_sigma ?? TS_SIGMA;
  return mu + randomNormal() * sigma;
}

function pickPair() {
  if (!movies || movies.length < 2) return;
  if (currentPair && currentPair.length === 2) {
    const [left, right] = currentPair;
    const leftStill = left && movieByTitle[left.title];
    const rightStill = right && movieByTitle[right.title];
    if (leftStill && rightStill) {
      currentPair = [movieByTitle[left.title], movieByTitle[right.title]];
      renderPair();
      return;
    }
  }
  const sampled = Object.keys(ratings).map(title => ({ title, score: thompsonSample(title) }));
  sampled.sort((a, b) => b.score - a.score);
  const topTwo = sampled.slice(0, 2);
  if (topTwo.length < 2) return;
  currentPair = [movieByTitle[topTwo[0].title], movieByTitle[topTwo[1].title]];
  renderPair();
}

function renderPair() {
  if (!currentPair || currentPair.length < 2) return;
  const [left, right] = currentPair;
  const leftLabel = left.display || getDisplayTitle(left.title);
  const rightLabel = right.display || getDisplayTitle(right.title);
  leftTitleEl.textContent = leftLabel;
  rightTitleEl.textContent = rightLabel;
  leftImage.src = resolveMovieImage(left);
  leftImage.alt = leftLabel;
  rightImage.src = resolveMovieImage(right);
  rightImage.alt = rightLabel;
  setGamepadFocus(gamepadFocus);
}

async function vote(winnerIndex) {
  if (!currentPair) return;
  const [left, right] = currentPair;
  const winner = winnerIndex === 0 ? left : right;
  const loser = winnerIndex === 0 ? right : left;
  try {
    const resp = await fetch(`${API_BASE}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ winner: winner.title, loser: loser.title, person: currentPerson })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);
    applyState(data.state);
  } catch (err) {
    console.error(err);
    setStatus(getT().statusVoteError + err.message);
  }
}

function updateComparisonCountText() {
  if (!comparisonCountEl) return;
  comparisonCountEl.textContent = '';
}

function computeRanking() {
  const arr = Object.keys(ratings).map(title => {
    const r = ratings[title];
    return { title, rating: r.ts_mu ?? r.rating ?? 0, sigma: r.ts_sigma ?? TS_SIGMA, games: r.games, wins: r.wins };
  });
  arr.sort((a, b) => b.rating - a.rating);
  arr.forEach((item, idx) => { item.rank = idx + 1; });
  return arr;
}

function getDisplayTitle(title) {
  const movie = movieByTitle[title];
  return movie?.display || movie?.title || title;
}

function normalizeMovieImage(movie) {
  const img = movie?.image || movie?.imageAbsolute || '';
  let filename = img;
  if (/^https?:/i.test(img)) {
    filename = img.split('/').pop() || img;
  }
  const imageAbsolute = resolveMovieImage({ image: filename });
  return { ...movie, image: filename, imageAbsolute, source: movie?.source || 'manual' };
}

function fillTable(tableEl, headers, rows) {
  tableEl.innerHTML = '';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headers.forEach(h => { const th = document.createElement('th'); th.textContent = h; headRow.appendChild(th); });
  thead.appendChild(headRow);
  tableEl.appendChild(thead);
  const tbody = document.createElement('tbody');
  rows.forEach(r => {
    const tr = document.createElement('tr');
    r.forEach(val => { const td = document.createElement('td'); td.textContent = val; tr.appendChild(td); });
    tbody.appendChild(tr);
  });
  tableEl.appendChild(tbody);
}

function renderTop10(ranking) {
  if (!top10Container) return;
  top10Container.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'top10-grid';
  ranking.slice(0, 10).forEach((item, idx) => {
    const movie = movieByTitle[item.title] || { image: '', title: item.title };
    const display = movie.display || getDisplayTitle(item.title);
    const card = document.createElement('div');
    card.className = 'top10-card';
    const media = document.createElement('div');
    media.className = 'top10-media';
    const img = document.createElement('img');
    img.src = resolveMovieImage(movie);
    img.alt = display;
    media.appendChild(img);
    const title = document.createElement('div');
    title.className = 'top10-title';
    title.textContent = `${idx + 1}. ${display}`;
    const meta = document.createElement('div');
    meta.className = 'top10-meta';
    const t = getT();
    meta.innerHTML = `${t.ratingLabel} ${item.rating.toFixed(0)}<br>${t.gamesLabel} ${item.games}<br>${t.winsLabel} ${item.wins}`;
    card.appendChild(media);
    card.appendChild(title);
    card.appendChild(meta);
    grid.appendChild(card);
  });
  top10Container.appendChild(grid);
}

function showResults() {
  const ranking = computeRanking();
  const t = getT();
  fillTable(
    tableAverage,
    [t.rankLabel, t.titleLabel, t.ratingLabel, t.gamesLabel, t.winsLabel],
    ranking.map(r => {
      const display = getDisplayTitle(r.title);
      return [r.rank, display, r.rating.toFixed(0), r.games, r.wins];
    })
  );
  renderTop10(ranking);
  const rankingCard = document.getElementById('rankingCard');
  if (rankingCard && rankingCard.tagName === 'DETAILS') rankingCard.open = false;
  resultsSection?.classList.remove('hidden');
}

function updateVoteVisibility(preservePair = false, skipPickPair = false) {
  const canShow = rankerConfirmed && (movies?.length || 0) >= 2;
  voteSection?.classList.toggle('hidden', !canShow);
  if (!canShow) return;
  if (skipPickPair) {
    if (currentPair && currentPair.length === 2) {
      const [left, right] = currentPair;
      const leftExists = left && movieByTitle[left.title];
      const rightExists = right && movieByTitle[right.title];
      if (leftExists && rightExists) {
        currentPair = [leftExists, rightExists];
        renderPair();
      }
    }
    return;
  }
  if (preservePair && currentPair && currentPair.length === 2) {
    const [left, right] = currentPair;
    const leftExists = left && movieByTitle[left.title];
    const rightExists = right && movieByTitle[right.title];
    if (leftExists && rightExists) {
      currentPair = [movieByTitle[left.title], movieByTitle[right.title]];
      renderPair();
      // preserve current pair; do not pick a new one now
      return;
    }
  }
  // force new pair selection
  currentPair = null;
  pickPair();
}

function updateProgress() {
  if (!progressBar || !progressLabel) return;
  const covered = pairCoverage?.coveredPairs ?? 0;
  const total = pairCoverage?.totalPairs ?? 0;
  const pct = total > 0 ? Math.min(100, (covered / total) * 100) : 0;
  progressBar.style.width = pct + '%';
  const pctLabel = Math.round(pct);
  progressLabel.textContent = total > 0 ? `${pctLabel}% coverage (${covered} / ${total} pairs)` : 'Pair coverage: 0%';
}

function updatePersonProgress() {
  if (!personProgress) return;
  personProgress.innerHTML = '';
  persons.forEach((p) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'person-progress-item';
    const label = document.createElement('div');
    label.className = 'progress-label';
    const coverage = pairCoveragePerPerson?.[p] || { coveredPairs: 0, totalPairs: pairCoverage.totalPairs ?? 0, ratio: 0 };
    const totalPairs = coverage.totalPairs ?? pairCoverage.totalPairs ?? 0;
    label.textContent = `${formatPersonLabel(p)}: ${coverage.coveredPairs} / ${totalPairs} pairs`;
    const track = document.createElement('div');
    track.className = 'progress-track';
    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    const pct = totalPairs > 0 ? Math.min(100, (coverage.coveredPairs / totalPairs) * 100) : 0;
    bar.style.width = pct + '%';
    track.appendChild(bar);
    wrapper.appendChild(label);
    wrapper.appendChild(track);
    personProgress.appendChild(wrapper);
  });
}

// Tab handling
function initTabs(defaultTab = 'ranker') {
  const startTab = defaultTab === 'swiper' ? 'swiper' : 'ranker';
  showSection(startTab);
  tabRanker?.addEventListener('click', () => showSection('ranker'));
  tabSwiper?.addEventListener('click', () => showSection('swiper'));
}

function showSection(which) {
  const isSwiper = which === 'swiper';
  rankerSection?.classList.toggle('hidden', isSwiper);
  swiperSection?.classList.toggle('hidden', !isSwiper);
  tabRanker?.classList.toggle('active', !isSwiper);
  tabSwiper?.classList.toggle('active', isSwiper);
  activeSection = isSwiper ? 'swiper' : 'ranker';
  if (isSwiper) {
    setAccentForSwiper();
  } else {
    setAccentForPerson(currentPerson);
  }
}

// Swiper logic
function initSwiper() {
  if (!swipeCard) return;
  let startX = 0;
  let currentX = 0;
  let dragging = false;
  const threshold = 90;

  setSwipePersons(2);
  loadSwipeSuggestions();
  updateSwipeCard();

  const setCardTransform = (x) => {
    swipeCard.style.transform = `translateX(${x}px) rotate(${x * 0.05}deg)`;
    const opacity = Math.min(Math.abs(x) / threshold, 1);
    swipeCard.style.boxShadow = `0 20px 40px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.05), 0 0 0 2px rgba(255,255,255,${opacity * 0.05})`;
  };

  const hideButtons = () => {
    swipeYesBtn?.classList.add('hidden');
    swipeNoBtn?.classList.add('hidden');
  };
  const showButtons = () => {
    swipeYesBtn?.classList.remove('hidden');
    swipeNoBtn?.classList.remove('hidden');
  };

  const resetCard = () => {
    dragging = false;
    currentX = 0;
    swipeCard.classList.remove('dragging');
    swipeCard.style.transform = '';
    swipeCard.style.boxShadow = '';
    showButtons();
  };

  const sendSwipeDecision = async (decision, title, person) => {
    try {
      const resp = await fetch(`${API_BASE}/swipe-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, title, person })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);
      applySwipeStateFromServer(data.state || {});
    } catch (err) {
      console.error(err);
      if (decision === 'Ja') recordSwipeLike(title, person);
      else recordSwipeDislike(title, person);
      swipeCurrentIndex = Math.min(swipeCurrentIndex + 1, swipeOrder.length);
      swipeCompleted = swipeCurrentIndex >= swipeOrder.length;
      saveSwipeProgress(person);
    }
    updateSwipeCard();
  };

  const decide = (decision) => {
    const t = getT();
    if (swipeCompleted) return;
    if (!swipeOrder.length || !swipeSelectedMovies.length) {
      if (swipeStatus) swipeStatus.textContent = t.swipeAddFirst || '';
      resetCard();
      return;
    }
    const currentEntry = swipeOrder[swipeCurrentIndex];
    const movie = typeof currentEntry === 'string' ? getSwipeMovieByTitle(currentEntry) : currentEntry;
    const title = movie?.title;
    if (!title) return;
    const label = decision === 'Ja' ? (t.yes || '') : (t.no || '');
    const prefix = t.swipeDecisionPrefix || '';
    swipeStatus.textContent = `${prefix}${label}`;
    swipeCard.classList.add(decision === 'Ja' ? 'swipe-yes' : 'swipe-no');
    swipeCard.style.transform = `translateX(${decision === 'Ja' ? 300 : -300}px) rotate(${decision === 'Ja' ? 12 : -12}deg)`;
    hideButtons();
    setTimeout(() => {
      swipeCard.classList.remove('swipe-yes', 'swipe-no');
      resetCard();
      sendSwipeDecision(decision, title, swipeCurrentPerson);
    }, 250);
  };

  const handleStart = (clientX) => {
    dragging = true;
    startX = clientX;
    swipeCard.classList.add('dragging');
    hideButtons();
  };
  const handleMove = (clientX) => {
    if (!dragging) return;
    currentX = clientX - startX;
    setCardTransform(currentX);
  };
  const handleEnd = () => {
    if (!dragging) return;
    const decision = currentX > threshold ? 'Ja' : currentX < -threshold ? 'Nein' : null;
    if (decision) {
      decide(decision);
    } else {
      swipeStatus.textContent = '';
      resetCard();
    }
  };

  swipeCard.addEventListener('pointerdown', (e) => { e.preventDefault(); handleStart(e.clientX); });
  window.addEventListener('pointermove', (e) => { if (!dragging) return; e.preventDefault(); handleMove(e.clientX); });
  window.addEventListener('pointerup', handleEnd);
  window.addEventListener('pointercancel', handleEnd);
  swipeCard.addEventListener('touchstart', (e) => handleStart(e.touches[0].clientX), { passive: true });
  swipeCard.addEventListener('touchmove', (e) => handleMove(e.touches[0].clientX), { passive: true });
  swipeCard.addEventListener('touchend', handleEnd);
  swipeCard.addEventListener('touchcancel', handleEnd);

  swipeYesBtn?.addEventListener('click', () => decide('Ja'));
  swipeNoBtn?.addEventListener('click', () => decide('Nein'));
  addMovieBtn?.addEventListener('click', addSwipeFromInput);
  movieInput?.addEventListener('input', () => renderSwipeSuggestList(movieInput.value));
  movieInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSwipeFromInput(); } });
  document.addEventListener('click', (e) => {
  if (!movieSuggestList) return;
  if (!movieSuggestList.contains(e.target) && e.target !== movieInput) movieSuggestList.classList.add('hidden');
});
  renderSwiperPersonButtons();
  applySwiperPersonsBtn?.addEventListener('click', () => {
    const val = Math.max(2, Math.min(5, parseInt(swiperPersonSelect.value || '2', 10)));
    setSwipePersons(val);
  });
  if (swiperPersonSelect) swiperPersonSelect.value = swipePersonCount.toString();
  swipeSourceMode?.addEventListener('change', handleSwipeSourceChange);
  handleSwipeSourceChange();
  swLoadFilteredBtn?.addEventListener('click', loadSwipeFilteredList);
  swResetFiltersBtn?.addEventListener('click', resetSwipeFilters);
  swClearListBtn?.addEventListener('click', () => {
    const t = getT();
    openConfirmModal(t.clearList, t.clearConfirm, performClearSwipeList);
  });
  updateSwFilterLabel();
  updateSwRuntimeLabel();
  updateSwCriticLabel();
  updateSwYearLabel();
}

function setSwipePersons(n) {
  swipePersonCount = Math.max(2, Math.min(5, n));
  swipePersons = Array.from({ length: swipePersonCount }, (_, i) => `p${i + 1}`);
  swipeCurrentPerson = swipePersons[0];
  renderSwiperPersonButtons();
  setAccentForSwiper();
  resetSwipeProgressAll();
  applySwipeProgress(swipeCurrentPerson);
  persistSwipeState();
}

function renderSwiperPersonButtons() {
  if (!swiperPersonButtons) return;
  swiperPersonButtons.innerHTML = '';
  swipePersons.forEach((p, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'person-btn' + (p === swipeCurrentPerson ? ' active' : '');
    btn.textContent = formatSwipePersonLabel(p);
    btn.addEventListener('click', () => {
      saveSwipeProgress(swipeCurrentPerson);
      swipeCurrentPerson = p;
      renderSwiperPersonButtons();
      if (activeSection === 'swiper') setAccentForSwiper();
      applySwipeProgress(swipeCurrentPerson);
      persistSwipeState();
    });
    swiperPersonButtons.appendChild(btn);
  });
}

function renderSwipeSuggestList(query = '') {
  if (!movieSuggestList) return;
  const q = (query || '').toLowerCase();
  if (!q) {
    movieSuggestList.classList.add('hidden');
    movieSuggestList.innerHTML = '';
    return;
  }
  const filtered = swipeSuggestions.filter(s => (s.display || s.title || '').toLowerCase().includes(q)).slice(0, 12);
  movieSuggestList.innerHTML = '';
  if (!filtered.length) { movieSuggestList.classList.add('hidden'); return; }
  filtered.forEach(s => {
    const el = document.createElement('div');
    el.className = 'suggest-item';
    el.textContent = s.display || s.title;
    el.addEventListener('click', () => {
      addSwipeMovie(s.display || s.title);
      movieSuggestList.classList.add('hidden');
      if (movieInput) movieInput.value = '';
    });
    movieSuggestList.appendChild(el);
  });
  movieSuggestList.classList.remove('hidden');
}

async function loadSwipeSuggestions(force = false) {
  try {
    const params = new URLSearchParams();
    params.set('lang', titleLanguage || 'en');
    const resp = await fetch(`${API_BASE}/movies?${params.toString()}`);
    const data = await resp.json();
    if (resp.ok && data.ok) {
      const items = data.items || [];
      swipeSuggestionsMap = {};
      swipeSuggestions = items.map(i => {
        const baseTitle = i.display || i.title;
        const display = i.year ? `${baseTitle} (${i.year})` : baseTitle;
        const obj = { display, title: baseTitle, image: i.image, imageAbsolute: i.image };
        swipeSuggestionsMap[display] = obj;
        return obj;
      });
      renderSwipeSuggestList(movieInput?.value || '');
    }
  } catch (e) {
    console.error(e);
  }
}

function addSwipeFromInput() {
  const val = (movieInput?.value || '').trim();
  if (!val) return;
  addSwipeMovie(val);
  movieInput.value = '';
  movieSuggestList?.classList.add('hidden');
}

function updateSelectedMoviesSummary() {
  const manualCount = swipeSelectedMovies.filter(m => (m.source || 'manual') === 'manual').length;
  const autoCount = swipeSelectedMovies.filter(m => m.source === 'auto').length;
  const t = getT();
  if (selectedMoviesSummaryManual) selectedMoviesSummaryManual.textContent = `${t.manualList || 'Manual List'} (${manualCount})`;
  if (selectedMoviesSummaryAuto) selectedMoviesSummaryAuto.textContent = `${t.autoList || 'Auto List'} (${autoCount})`;
}

function enqueueMatchModal(title) {
  if (!title || seenMatches.has(title)) return;
  matchQueue.push(title);
  processMatchQueue();
}

function processMatchQueue() {
  if (matchModalOpen) return;
  const next = matchQueue.shift();
  if (!next) return;
  showMatchModal(next);
}

function showMatchModal(title) {
  const movie = swipeSelectedMovies.find(m => m.title === title) || { title };
  const poster = resolveMovieImage(movie);
  if (matchPoster) {
    if (poster) {
      matchPoster.src = poster;
      matchPoster.classList.remove('hidden');
    } else {
      matchPoster.classList.add('hidden');
    }
  }
  if (matchTitleEl) matchTitleEl.textContent = movie.display || movie.title || title;
  matchOverlay?.classList.remove('hidden');
  matchModalOpen = true;
  seenMatches.add(title);
  focusFirstInOverlay(matchOverlay);
}

function closeMatchModal() {
  matchOverlay?.classList.add('hidden');
  matchModalOpen = false;
  processMatchQueue();
}

function addSwipeMovie(displayTitle) {
  if (!displayTitle) return;
  const info = swipeSuggestionsMap[displayTitle] || { title: displayTitle };
  if (swipeSelectedMovies.find(m => m.title === info.title)) return;
  const movieObj = {
    title: info.title,
    display: info.display || displayTitle,
    image: info.image || '',
    imageAbsolute: info.image && /^https?:/.test(info.image) ? info.image : '',
    addedBy: swipeCurrentPerson,
    source: 'manual'
  };
  swipeSelectedMovies.push(movieObj);
  swipeLikes[info.title] = swipeLikes[info.title] || [];
  resetSwipeProgressAll();
  renderSwipeSelectedMovies();
  updateSwipeCard();
  updateSwipeDeckVisibility();
  persistSwipeState();
}

function removeSwipeMovie(title) {
  swipeSelectedMovies = swipeSelectedMovies.filter(t => t.title !== title);
  delete swipeLikes[title];
  swipeMatches.delete(title);
  resetSwipeProgressAll();
  renderSwipeSelectedMovies();
  updateSwipeMatches();
  updateSwipeCard();
  updateSwipeDeckVisibility();
  persistSwipeState();
}

function renderSwipeSelectedMovies() {
  if (!selectedMoviesManualEl || !selectedMoviesAutoEl) return;
  selectedMoviesManualEl.innerHTML = '';
  selectedMoviesAutoEl.innerHTML = '';
  const manual = swipeSelectedMovies.filter(m => (m.source || 'manual') === 'manual');
  const auto = swipeSelectedMovies.filter(m => m.source === 'auto');
  const renderList = (list, container) => {
    list.forEach(m => {
      const tag = document.createElement('div');
      const personCls = m.addedBy ? ` tag-${m.addedBy}` : '';
      tag.className = `tag${personCls}`;
      tag.textContent = m.display || m.title;
      const x = document.createElement('span');
      x.className = 'tag-close';
      x.textContent = 'x';
      x.addEventListener('click', () => removeSwipeMovie(m.title));
      tag.appendChild(x);
      container.appendChild(tag);
    });
  };
  renderList(manual, selectedMoviesManualEl);
  renderList(auto, selectedMoviesAutoEl);
  updateSelectedMoviesSummary();
}

function rebuildSwipeOrder() {
  resetSwipeProgressAll();
}

function performClearSwipeList() {
  const t = getT();
  swipeSelectedMovies = [];
  swipeOrder = [];
  swipeLikes = {};
  swipeMatches = new Set();
  swipeLocked = false;
  resetSwipeProgressAll();
  renderSwipeSelectedMovies();
  updateSwipeMatches();
  updateSwipeCard();
  updateSwipeDeckVisibility();
  if (swipeStatus) swipeStatus.textContent = t.clearDone;
  persistSwipeState();
}

async function resetAllStates() {
  const t = getT();
  const title = t.resetAll || t.resetServerState || 'Reset';
  const msg = t.resetAllMessage || t.clearConfirm || 'Alles zuruecksetzen? Ranking und Swipe werden geleert.';
  openConfirmModal(title, msg, async () => {
    try {
      const resp = await fetch(`${API_BASE}/reset-all`, { method: 'POST' });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);
      // Ranking auf Default
      rankerConfirmed = false;
        applyState(data.rank || data.state || {
          movies: [],
          ratings: {},
          comparisonCount: {},
          totalVotes: 0,
          personCount: 1,
          filters: [],
          runtimeMin: 20,
          runtimeMax: 300,
          criticMin: 0,
          criticMax: 10,
          yearMin: 1950,
          yearMax: new Date().getFullYear(),
          rankerConfirmed: false,
          pairCounts: {},
          pairCoverage: { coveredPairs: 0, totalPairs: 0, ratio: 0 },
          pairCoveragePerPerson: {},
          tsConfig: { mu: TS_MU, sigma: TS_SIGMA }
        });
      // Swipe auf Default
      swipeSelectedMovies = [];
      swipeLikes = {};
      swipeMatches = new Set();
      swipeProgress = {};
      swipeLocked = false;
      swipeCompleted = false;
      swipeCurrentIndex = 0;
      renderSwipeSelectedMovies();
      updateSwipeMatches();
      updateSwipeCard();
      updateSwipeDeckVisibility();
      persistSwipeState(true);
      setStatus(t.statusLoaded || '');
      settingsOverlay?.classList.add('hidden');
    } catch (err) {
      console.error(err);
      setStatus((t.statusFetchError || 'Fehler: ') + err.message);
    }
  });
}

function resetSwipeProgressAll() {
  swipeProgress = {};
  swipePersons.forEach(p => {
    swipeProgress[p] = { idx: 0, done: false, order: randomOrderTitles() };
  });
  const current = swipeProgress[swipeCurrentPerson] || { idx: 0, done: false, order: randomOrderTitles() };
  swipeOrder = titlesToMovieOrder(current.order);
  swipeCurrentIndex = current.idx;
  swipeCompleted = current.done || swipeOrder.length === 0;
  updateSwipeProgressBar();
  persistSwipeState();
}

function saveSwipeProgress(person) {
  if (!person) return;
  const orderTitles = (swipeOrder || []).map(m => m.title);
  if (!swipeProgress[person] || (swipeProgress[person].order || []).length !== swipeSelectedMovies.length) {
    swipeProgress[person] = { idx: 0, done: false, order: orderTitles.length ? orderTitles : randomOrderTitles() };
  }
  swipeProgress[person].idx = Math.min(swipeCurrentIndex, orderTitles.length);
  swipeProgress[person].done = swipeCompleted;
  swipeProgress[person].order = orderTitles;
  persistSwipeState();
}

function applySwipeProgress(person) {
  if (!person) return;
  if (!swipeProgress[person] || !(swipeProgress[person].order || []).length) {
    swipeProgress[person] = { idx: 0, done: false, order: randomOrderTitles() };
  }
  const st = swipeProgress[person];
  swipeOrder = titlesToMovieOrder(st.order);
  const maxIdx = swipeOrder.length;
  swipeCurrentIndex = Math.min(st.idx || 0, maxIdx);
  swipeCompleted = st.done || maxIdx === 0 || swipeCurrentIndex >= maxIdx;
  updateSwipeProgressBar();
  updateSwipeCard();
}

function updateSwipeProgressBar() {
  if (!swipeProgressEl || !swipeProgressBar || !swipeProgressLabel) return;
  const st = swipeProgress[swipeCurrentPerson] || { idx: 0, order: [] };
  const total = (st.order || []).length;
  const idx = clamp(parseInt(st.idx, 10) || 0, 0, total);
  const pct = total ? Math.min(100, (idx / total) * 100) : 0;
  swipeProgressBar.style.width = pct + '%';
  const label = `${formatSwipePersonLabel(swipeCurrentPerson)}: ${idx} / ${total || 0}`;
  swipeProgressLabel.textContent = label;
  swipeProgressEl.classList.toggle('hidden', total === 0);
}

async function loadSwipeStateFromServer(silent = false) {
  try {
    const resp = await fetch(`${API_BASE}/swipe-state`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) return;
    applySwipeStateFromServer(data.state || {});
    if (!silent) showSection('swiper');
  } catch (e) {
    console.error(e);
  } finally {
    swipeStateReadyToPersist = true;
    if (!silent) startSwipePolling();
  }
}

function normalizeSwipeProgress(progress, persons, titles) {
  const normalized = {};
  persons.forEach(p => {
    const st = progress[p] || {};
    let order = Array.isArray(st.order) ? st.order.filter(t => titles.includes(t)) : [];
    const missing = titles.filter(t => !order.includes(t));
    if (missing.length) order = order.concat(shuffleArray(missing));
    if (!order.length) order = randomOrderTitles();
    const idx = clamp(parseInt(st.idx, 10) || 0, 0, order.length);
    normalized[p] = { idx, done: st.done || idx >= order.length, order };
  });
  return normalized;
}

function applySwipeStateFromServer(state) {
  const prevMatches = new Set(swipeMatches);
  swipeSelectedMovies = (state.movies || []).map(normalizeMovieImage);
  swipePersons = (state.persons && state.persons.length ? state.persons : swipePersons.length ? swipePersons : ['p1', 'p2']);
  swipePersonCount = swipePersons.length || 2;
  swipeLikes = state.likes || {};
  swipeMatches = new Set(state.matches || []);
  swipeMatches.forEach(m => {
    if (!prevMatches.has(m)) enqueueMatchModal(m);
  });
  seenMatches = new Set([...seenMatches, ...swipeMatches]);
  swipeLocked = !!state.locked;
  const titles = swipeSelectedMovies.map(m => m.title);
  swipeProgress = normalizeSwipeProgress(state.progress || {}, swipePersons, titles);
  if (!swipePersons.includes(swipeCurrentPerson)) swipeCurrentPerson = swipePersons[0] || 'p1';
  if (swiperPersonSelect) swiperPersonSelect.value = swipePersonCount.toString();
  renderSwiperPersonButtons();
  renderSwipeSelectedMovies();
  applySwipeProgress(swipeCurrentPerson);
  updateSwipeMatches();
  if (activeSection === 'swiper') setAccentForSwiper();
  updateSwipeDeckVisibility();
}

function startSwipePolling() {
  if (swipePollTimer) clearInterval(swipePollTimer);
  swipePollTimer = setInterval(() => {
    loadSwipeStateFromServer(true);
    fetchState(false, { preservePair: true, skipPickPair: true });
  }, SWIPE_POLL_MS);
}

async function persistSwipeState(force = false) {
  if (!force && !swipeStateReadyToPersist) return;
  try {
    await fetch(`${API_BASE}/swipe-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        movies: serializeSwipeMovies(),
        progress: swipeProgress,
        persons: swipePersons,
        likes: swipeLikes,
        matches: Array.from(swipeMatches),
        locked: swipeLocked
      })
    });
  } catch (e) {
    console.error(e);
  }
}

async function confirmRankerSetup() {
  if ((movies || []).length < 2) {
    const loaded = await loadMoviesFromCsv();
    if ((movies || []).length < 2) {
      if (loaded) setStatus(getT().swipeAddFirst || 'Bitte zuerst Filme laden.');
      return;
    }
  }
  try {
    const resp = await fetch(`${API_BASE}/rank-confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);
    rankerConfirmed = true;
    applyState(data.state || {}, true);
    setStatus(getT().statusLoaded || '');
  } catch (err) {
    console.error(err);
    setStatus((getT().statusFetchError || 'Error: ') + err.message);
    if ((movies || []).length >= 2) {
      // Fallback: lokal freigeben, damit der Vergleich trotzdem starten kann.
      rankerConfirmed = true;
      updateVoteVisibility(true);
    }
  }
}

async function confirmSwipeSetup() {
  swipeLikes = {};
  swipeMatches = new Set();
  resetSwipeProgressAll();
  applySwipeProgress(swipeCurrentPerson);
  renderSwiperPersonButtons();
  renderSwipeSelectedMovies();
  updateSwipeMatches();
  updateSwipeCard();
  try {
    swipeLocked = true;
    await fetch(`${API_BASE}/swipe-confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        movies: serializeSwipeMovies(),
        progress: swipeProgress,
        persons: swipePersons,
        likes: swipeLikes,
        matches: Array.from(swipeMatches),
        locked: true
      })
    });
    if (swipeStatus) swipeStatus.textContent = getT().statusLoaded;
    showSection('swiper');
    updateSwipeDeckVisibility();
  } catch (e) {
    console.error(e);
  }
}

function updateSwipeCard() {
  if (!swipeSelectedMovies.length) {
    if (swipeTitle) swipeTitle.textContent = getT().swipeEmptyTitle;
    if (swipeMeta) swipeMeta.textContent = getT().swipeEmptyMeta;
    updateSwipeProgressBar();
    swipeCard?.classList.remove('has-image');
    if (swipeCard) swipeCard.style.backgroundImage = '';
    swipeYesBtn?.classList.remove('hidden');
    swipeNoBtn?.classList.remove('hidden');
    return;
  }
  if (swipeCompleted || swipeCurrentIndex >= swipeOrder.length) {
    if (swipeTitle) swipeTitle.textContent = getT().swipeCompleteTitle.replace('{count}', swipeSelectedMovies.length);
    if (swipeMeta) swipeMeta.textContent = '';
    updateSwipeProgressBar();
    swipeCard?.classList.remove('has-image');
    if (swipeCard) swipeCard.style.backgroundImage = '';
    swipeYesBtn?.classList.add('hidden');
    swipeNoBtn?.classList.add('hidden');
    return;
  }
  const current = swipeOrder[swipeCurrentIndex];
  const movie = typeof current === 'string' ? getSwipeMovieByTitle(current) : current || {};
  if (swipeTitle) swipeTitle.textContent = movie.display || movie.title;
  if (swipeMeta) swipeMeta.textContent = '';
   updateSwipeProgressBar();
  if (swipeCard) {
    const img = resolveMovieImage(movie);
    if (img) {
      swipeCard.classList.add('has-image');
      swipeCard.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,0.15), rgba(0,0,0,0.45)), url('${img}')`;
    } else {
      swipeCard.classList.remove('has-image');
      swipeCard.style.backgroundImage = '';
    }
  }
  swipeYesBtn?.classList.remove('hidden');
  swipeNoBtn?.classList.remove('hidden');
}

function updateSwipeMatches() {
  if (!matchList) return;
  matchList.innerHTML = '';
  Array.from(swipeMatches).forEach(title => {
    const movie = swipeSelectedMovies.find(m => m.title === title) || { title };
    const card = document.createElement('div');
    card.className = 'match-item';
    const img = document.createElement('img');
    const poster = resolveMovieImage(movie);
    if (poster) img.src = poster;
    img.alt = movie.display || movie.title || title;
    const span = document.createElement('div');
    span.className = 'title';
    span.textContent = movie.display || movie.title || title;
    card.appendChild(img);
    card.appendChild(span);
    matchList.appendChild(card);
  });
}

function updateSwipeDeckVisibility() {
  const shouldShow = swipeLocked && swipeSelectedMovies.length > 0;
  swipeDeckSection?.classList.toggle('hidden', !shouldShow);
}

function recordSwipeLike(movie, person) {
  if (!swipeLikes[movie]) swipeLikes[movie] = [];
  if (!swipeLikes[movie].includes(person)) swipeLikes[movie].push(person);
  if (swipeLikes[movie].length >= swipePersonCount) {
    swipeMatches.add(movie);
    updateSwipeMatches();
    enqueueMatchModal(movie);
  }
  persistSwipeState();
}

function recordSwipeDislike(movie, person) {
  if (!swipeLikes[movie]) return;
  swipeLikes[movie] = swipeLikes[movie].filter(p => p !== person);
  persistSwipeState();
}

function nextSwipeMovie() {
  if (!swipeOrder.length) return;
  swipeCurrentIndex += 1;
  if (swipeCurrentIndex >= swipeOrder.length) {
    swipeCompleted = true;
    saveSwipeProgress(swipeCurrentPerson);
    updateSwipeCard();
    return;
  }
  saveSwipeProgress(swipeCurrentPerson);
  updateSwipeCard();
}

function handleSwipeSourceChange() {
  const useFiltered = swipeSourceMode?.value === 'filtered';
  swipeManualBlock?.classList.toggle('hidden', useFiltered);
  swipeFilteredBlock?.classList.toggle('hidden', !useFiltered);
}

async function loadSwipeFilteredList() {
  const t = getT();
  updateSwFilterLabel();
  updateSwRuntimeLabel();
  updateSwCriticLabel();
  updateSwYearLabel();
  const statusHandler = (msg) => {
    setStatus(msg);
    if (swipeFilteredStatus) swipeFilteredStatus.textContent = msg;
  };
  try {
    const desired = [];
    if (swFilterUnplayed?.checked) desired.push('IsUnplayed');
    if (swFilterPlayed?.checked) desired.push('IsPlayed');
    if (swFilter4kInline?.checked) desired.push('Is4K');
    if (filterMenu) {
      const cbs = Array.from(filterMenu.querySelectorAll('input[type="checkbox"]'));
      if (desired.length === 0) {
        cbs.forEach(cb => cb.checked = true);
      } else {
        cbs.forEach(cb => cb.checked = desired.includes(cb.value));
      }
    }
    if (filter4kMain) filter4kMain.checked = desired.includes('Is4K');
    if (runtimeMinInput && swRuntimeMin) runtimeMinInput.value = swRuntimeMin.value || runtimeMinInput.value;
    if (runtimeMaxInput && swRuntimeMax) runtimeMaxInput.value = swRuntimeMax.value || runtimeMaxInput.value;
    if (criticMinInput && swCriticMin) criticMinInput.value = swCriticMin.value || criticMinInput.value;
    if (criticMaxInput && swCriticMax) criticMaxInput.value = swCriticMax.value || criticMaxInput.value;
    if (yearMinInput && swYearMin) yearMinInput.value = swYearMin.value || yearMinInput.value;
    if (yearMaxInput && swYearMax) yearMaxInput.value = swYearMax.value || yearMaxInput.value;
    updateFilterLabel();
    updateRuntimeLabel();
    updateCriticLabel();
    updateYearLabel();
    await fetchAndLoadMovies(statusHandler);
    const adder = swipeCurrentPerson;
    const manual = swipeSelectedMovies.filter(m => (m.source || 'manual') === 'manual');
    const existing = new Set(manual.map(m => m.title));
    let autoList = (movies || []).map(m => ({
      title: m.title,
      display: formatTitleWithYear(m),
      image: m.image || '',
      imageAbsolute: resolveMovieImage({ image: m.image || '' }),
      addedBy: adder,
      source: 'auto'
    })).filter(m => !existing.has(m.title));
    if (isFinite(swMaxMovies)) {
      autoList = shuffleArray(autoList).slice(0, swMaxMovies);
    }
    swipeSelectedMovies = shuffleArray(manual.concat(autoList));
    swipeLikes = {};
    swipeMatches = new Set();
    resetSwipeProgressAll();
    applySwipeProgress(swipeCurrentPerson);
    renderSwipeSelectedMovies();
    persistSwipeState();
  } catch (err) {
    console.error(err);
    statusHandler(t.statusFetchError + err.message);
  }
}

function renderPersonButtons() {
  if (!personButtons) return;
  personButtons.innerHTML = '';
  persons.forEach((p, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'person-btn' + (p === currentPerson ? ' active' : '');
    btn.dataset.person = p;
    btn.textContent = formatPersonLabel(p);
    btn.addEventListener('click', () => {
      currentPerson = p;
      renderPersonButtons();
      updateCurrentPersonLabel();
      updateComparisonCountText();
      if (activeSection === 'ranker') setAccentForPerson(currentPerson);
    });
    personButtons.appendChild(btn);
  });
}

function updateCurrentPersonLabel() {
  if (currentPersonLabel) currentPersonLabel.textContent = formatPersonLabel(currentPerson);
}

function formatPersonLabel(personId) {
  const idx = persons.indexOf(personId);
  if (idx >= 0) return `${getT().personPrefix} ${idx + 1}`;
  return personId;
}

function formatSwipePersonLabel(personId) {
  const idx = swipePersons.indexOf(personId);
  if (idx >= 0) return `${getT().personPrefix} ${idx + 1}`;
  return personId;
}

function setAccentForPerson(personId) {
  const body = document.body;
  if (!body) return;
  ACCENT_CLASSES.forEach(cls => body.classList.remove(cls));
  const idx = persons.indexOf(personId);
  const cls = ACCENT_CLASSES[idx] || ACCENT_CLASSES[0];
  body.classList.add(cls);
}

function setAccentForSwiper() {
  const body = document.body;
  if (!body) return;
  ACCENT_CLASSES.forEach(cls => body.classList.remove(cls));
  const idx = swipePersons.indexOf(swipeCurrentPerson);
  const cls = ACCENT_CLASSES[idx] || ACCENT_CLASSES[0];
  body.classList.add(cls);
}

function updateMovieCountLabel() {
  if (movieCountLabel) movieCountLabel.textContent = movies.length.toString();
  const info = document.getElementById("voteHeaderInfo");
  if (info) {
    const movieLabel = getT().moviesLabel;
    const label = '<span id="movieCountLabel">' + movies.length + '</span> ' + movieLabel;
    info.innerHTML = label;
  }
}

function getNumber(el, fallback) {
  if (!el) return fallback;
  const v = parseFloat(el.value);
  return isNaN(v) ? fallback : v;
}

function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

function randomNormal() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function extractYearFromText(text) {
  if (!text) return null;
  const match = /\((\d{4})\)\s*$/.exec(text);
  if (match) {
    const yr = parseInt(match[1], 10);
    if (!isNaN(yr)) return yr;
  }
  return null;
}

function formatTitleWithYear(movie) {
  if (!movie) return '';
  const base = movie.display || movie.title || '';
  const year = movie.year || extractYearFromText(base);
  return year ? `${base.replace(/\s*\(\d{4}\)\s*$/, '')} (${year})` : base;
}

function getSwipeMovieByTitle(title) {
  if (!title) return null;
  return swipeSelectedMovies.find(m => m.title === title) || { title, display: title, image: '' };
}

function titlesToMovieOrder(titles) {
  return (titles || []).map(t => getSwipeMovieByTitle(t)).filter(Boolean);
}

function randomOrderTitles() {
  return shuffleArray(swipeSelectedMovies.map(m => m.title));
}

function serializeSwipeMovies() {
  return swipeSelectedMovies.map(m => {
    const imgAbs = resolveMovieImage(m);
    return { ...m, imageAbsolute: imgAbs, image: m.image || '', source: m.source || 'manual' };
  });
}

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg ?? '';
}

function touchSetup() {
  if (!pairContainer) return;
  let startX = null;
  pairContainer.addEventListener('touchstart', (e) => { startX = e.changedTouches[0].screenX; });
  pairContainer.addEventListener('touchend', (e) => {
    if (startX === null) return;
    const dx = e.changedTouches[0].screenX - startX;
    const threshold = 50;
    if (Math.abs(dx) > threshold) {
      if (dx > 0) vote(1);
      else vote(0);
    }
    startX = null;
  });
}

function setupHeaderButtons() {
  // Theme toggle
  const body = document.body;
  const stored = localStorage.getItem('theme-mode');
  if (stored === 'light') body.classList.add('theme-light');
  toggleThemeBtn?.classList.toggle('active', body.classList.contains('theme-light'));
  toggleThemeBtn?.addEventListener('click', () => {
    const enableLight = !body.classList.contains('theme-light');
    if (enableLight) body.classList.add('theme-light');
    else body.classList.remove('theme-light');
    localStorage.setItem('theme-mode', enableLight ? 'light' : 'dark');
    toggleThemeBtn.classList.toggle('active', enableLight);
  });
}

function resolveMovieImage(movie) {
  if (!movie) return '';
  const candidate = movie.imageAbsolute || movie.image || '';
  if (/^https?:|^data:/.test(candidate)) return candidate;
  if (!candidate) return '';
  return `${API_BASE}/images/${candidate}`;
}

async function onApplyPersons() {
  const requested = Math.max(1, parseInt(numPersonsSelect.value || '1', 10));
  personCount = requested;
  persons = Array.from({ length: personCount }, (_, i) => `person${i + 1}`);
  if (!movies.length) {
    comparisonCount = persons.reduce((acc, p) => ({ ...acc, [p]: 0 }), {});
    currentPerson = persons[0];
    renderPersonButtons();
    updateCurrentPersonLabel();
    setAccentForPerson(currentPerson);
    pairCoverage = { coveredPairs: 0, totalPairs: 0, ratio: 0 };
    pairCoveragePerPerson = persons.reduce((acc, p) => ({ ...acc, [p]: { coveredPairs: 0, totalPairs: 0, ratio: 0 } }), {});
    updateProgress();
    updatePersonProgress();
    setStatus(getT().statusPersonsChanged);
    return;
  }
  try {
    applyPersonsBtn.disabled = true;
    const resp = await fetch(`${API_BASE}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personCount: requested })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);
    applyState(data.state);
    setStatus(getT().statusPersonsApplied);
  } catch (err) {
    console.error(err);
    setStatus(getT().statusPersonsApplyError + err.message);
  } finally {
    applyPersonsBtn.disabled = false;
  }
}

async function downloadTop10Image() {
  const ranking = computeRanking().slice(0, 10);
  if (!ranking.length) return;
  const cols = 5;
  const rows = 2;
  const posterW = 240;
  const posterH = 360;
  const padding = 20;
  const textH = 40;
  const canvas = document.createElement('canvas');
  canvas.width = cols * (posterW + padding) + padding;
  canvas.height = rows * (posterH + textH + padding) + padding;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0e0e10';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '18px "Atkinson Hyperlegible", sans-serif';
  ctx.fillStyle = '#f4f4f5';
  ctx.textAlign = 'center';

  const loadImage = (src) => new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });

  for (let i = 0; i < ranking.length; i++) {
    const item = ranking[i];
    const movie = movieByTitle[item.title] || { image: '', display: item.title, title: item.title };
    const display = movie.display || movie.title;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = padding + col * (posterW + padding);
    const y = padding + row * (posterH + textH + padding);
    const img = await loadImage(resolveMovieImage(movie));
    if (img) ctx.drawImage(img, x, y, posterW, posterH);
    ctx.fillText(`${i + 1}. ${display}`, x + posterW / 2, y + posterH + 24);
  }
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'top10.jpg';
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/jpeg', 0.92);
}

function downloadRankingCsv() {
  const ranking = computeRanking();
  if (!ranking.length) return;
  const t = getT();
  const headers = [
    t.rankLabel || 'Rank',
    t.titleLabel || 'Title',
    t.ratingLabel || 'Rating',
    t.gamesLabel || 'Games',
    t.winsLabel || 'Wins'
  ];
  const rows = ranking.map(r => [
    r.rank,
    `"${(r.title || '').replace(/"/g, '""')}"`,
    r.rating.toFixed(0),
    r.games,
    r.wins
  ]);
  const csv = [headers.join(',')].concat(rows.map(r => r.join(','))).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ranking.csv';
  a.click();
  URL.revokeObjectURL(url);
}

