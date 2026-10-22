// ==UserScript==
// @name         SLA Timer sd.bitech.com.ua
// @namespace    http://tampermonkey.net/
// @version      20261023
// @description  Таймер SLA для sd.bitech. Відображається на сторінці заявок коло статусу, в самій заявці в лівому меню та у списку заявок. Повністю прибирає стовпець "Таймер задачі". Вираховує час в блоці "історія", враховує критичність та всі призупинення. Клік на таймер у заявці копіює час завершення SLA, а у списку відкриває меню копіювання та налаштування розташування. За дві години до завершення таймера інтерфейс таймера стає червоним. Деталі в гілці discord.
// @author       Ovolya
// @match        *://sd.bitech.com.ua/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=bitech.com.ua
// @updateURL    https://github.com/Ovolsan/SLA-Timer-sd.bitech.com.ua/raw/refs/heads/main/SLA%20Timer%20sd.bitech.com.ua.user.js
// @downloadURL  https://github.com/Ovolsan/SLA-Timer-sd.bitech.com.ua/raw/refs/heads/main/SLA%20Timer%20sd.bitech.com.ua.user.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // --- КОНСТАНТИ ---
    const SLA_LIMITS = {
        '1.ЗК-1': 4, '1.ЗК-2': 8,
        '2.ЗК-1': 8, '2.ЗК-2': 16,
        '3.ЗК-1': 16, '3.ЗК-2': 24
    };
    const CLEANUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;


    // --- БАЗОВІ ФУНКЦІЇ ---
    function getTicketId() {
        const urlMatch = window.location.pathname.match(/\/admin\/requests\/(\d+)/);
        if (urlMatch) return urlMatch[1];
        const breadcrumb = document.querySelector('.p-breadcrumb-list');
        if (!breadcrumb) return null;
        const link = breadcrumb.querySelector('a[href*="/admin/requests/"]');
        if (!link) return null;
        const match = link.href.match(/\/admin\/requests\/(\d+)/);
        return match ? match[1] : null;
    }

    function isTicketPage() { return !!getTicketId(); }

    function parseDateTime(str) {
        if (!str) return null;
        let match = str.trim().match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
        if (match) return new Date(match[3], match[2] - 1, match[1], match[4], match[5], 0);
        return null;
    }

    function formatDateTime(date) {
        if (!date) return '';
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${day}.${month}.${year} ${hours}:${minutes}`;
    }

    // --- ОЧИЩЕННЯ СТАРИХ SLA-ЗАПИСІВ ---
    function cleanupOldSlaData() {
        try {
            const now = Date.now();
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith('slaData_')) {
                    try {
                        const data = JSON.parse(localStorage.getItem(key));
                        if (data && data.deadline && data.deadline < now) keysToRemove.push(key);
                    } catch (e) { keysToRemove.push(key); }
                }
            }
            keysToRemove.forEach(key => localStorage.removeItem(key));
            if (keysToRemove.length > 0) console.log(`[SLA Timer] Видалено ${keysToRemove.length} прострочених SLA-записів.`);
        } catch (e) { console.warn('[SLA Timer] Помилка очищення localStorage:', e); }
    }

    cleanupOldSlaData();
    setInterval(cleanupOldSlaData, CLEANUP_INTERVAL_MS);

    // --- ПАРСИНГ ІСТОРІЇ ТА РОЗРАХУНОК SLA ---
    function parseHistoryData() {
        const historyPanel = document.querySelector('app-requests_hstr-list') ||
                             document.querySelector('p-tabpanel[id*="tabpanel_requests_hstr"]');
        if (!historyPanel) return null;

        let creationTime = null;
        let latestCriticality = null;
        let events = [];
        const rows = historyPanel.querySelectorAll('tbody.p-datatable-tbody > tr');

        rows.forEach(row => {
            let currentEventTime = null;
            const timeEl = row.querySelector('small');
            if (timeEl) {
                let dateMatch = timeEl.textContent.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
                if (dateMatch) currentEventTime = parseDateTime(dateMatch[0]);
            }

            const keyCols = row.querySelectorAll('.md\\:col-4');
            keyCols.forEach(keyCol => {
                const valCol = keyCol.nextElementSibling;
                if (!valCol || !valCol.classList.contains('md:col-8')) return;

                let keyText = keyCol.textContent.trim();
                let valText = valCol.textContent.trim();

                if (keyText === 'Дата й час створення' || keyText === 'Дата и время создания') {
                    let match = valText.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
                    if (match) creationTime = parseDateTime(match[0]);
                }

                if (keyText === 'Критичність' || keyText === 'Критичность') {
                    let critMatch = valText.match(/(1|2|3)\.ЗК\-(1|2)/);
                    if (critMatch && !latestCriticality) {
                        latestCriticality = critMatch[0];
                    }
                }

                if (keyText.includes('SLA призупинено до') || keyText.includes('SLA приостановлено до')) {
                    let pauseMatch = valText.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
                    if (pauseMatch && currentEventTime) {
                        events.push({ time: currentEventTime, type: 'suspension', suspendedTo: parseDateTime(pauseMatch[0]) });
                    }
                }
            });
        });

        if (!creationTime) return null;
        return { creationTime, events, latestCriticality };
    }

    function calculateSLA() {
        const history = parseHistoryData();
        if (!history) return null;

        const { creationTime, events, latestCriticality } = history;
        if (!latestCriticality) return { noSLA: true };

        let suspensions = [];
        events.sort((a, b) => a.time - b.time);
        events.forEach(ev => {
            if (ev.type === 'suspension' && ev.suspendedTo) suspensions.push({ start: ev.time, end: ev.suspendedTo });
        });

        const limitHours = SLA_LIMITS[latestCriticality] || 8;
        const slaLimitMs = limitHours * 60 * 60 * 1000;
        let totalSuspensionMs = 0;

        if (suspensions.length > 0) {
            suspensions.sort((a, b) => a.start - b.start);
            let currentChain = { start: suspensions[0].start, end: suspensions[0].end };

            for (let i = 1; i < suspensions.length; i++) {
                let next = suspensions[i];
                if (next.start <= currentChain.end) {
                    if (next.end > currentChain.end) currentChain.end = next.end;
                } else {
                    totalSuspensionMs += (currentChain.end - currentChain.start);
                    currentChain = { start: next.start, end: next.end };
                }
            }
            totalSuspensionMs += (currentChain.end - currentChain.start);
        }

        const deadlineDate = new Date(creationTime.getTime() + slaLimitMs + totalSuspensionMs);
        return { remainingMs: deadlineDate - Date.now(), deadlineDate };
    }

    function saveSlaData(ticketId) {
        const slaData = calculateSLA();
        if (!slaData) return false;
        const storageKey = `slaData_${ticketId}`;
        if (slaData.noSLA) {
            localStorage.removeItem(storageKey);
        } else {
            localStorage.setItem(storageKey, JSON.stringify({ deadline: slaData.deadlineDate.getTime() }));
        }
        return true;
    }

    // --- UI ТАЙМЕРА В ЗАЯВЦІ ---
    let autoSaveInterval = null;
    let returnToTicketTab = null;
    const PENDING_REFRESH_KEY = 'slaPendingRefresh';

    function getOrCreateTimerUI() {
        let container = document.getElementById('my-sla-container');
        if (container) return container;

        container = document.createElement('div');
        container.id = 'my-sla-container';
        Object.assign(container.style, {
            display: 'inline-flex', position: 'relative', alignItems: 'center', zIndex: 99
        });

        const timerDiv = document.createElement('div');
        timerDiv.id = 'my-sla-timer';
        Object.assign(timerDiv.style, {
            fontWeight: 'bold', borderRadius: '0px',
            transition: 'background-color 0.15s ease', fontSize: '13px', userSelect: 'none',
            boxShadow: '0 2px 5px rgba(0,0,0,0.2)', textAlign: 'center', height: '26px', width: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
            border: 'none', position: 'relative', overflow: 'hidden', cursor: 'pointer'
        });

        const textSpan = document.createElement('span');
        textSpan.id = 'my-sla-timer-text';
        textSpan.style.position = 'relative';
        textSpan.style.zIndex = '2';
        timerDiv.appendChild(textSpan);

        // Слой с кнопками (появляется при наведении, если есть сохранённые данные)
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'sla-timer-actions';
        Object.assign(actionsDiv.style, {
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            display: 'flex', justifyContent: 'space-around', alignItems: 'center',
            opacity: '0', transition: 'opacity 0.2s ease',
            pointerEvents: 'none', zIndex: '3', background: 'rgba(0,0,0,0.5)'
        });

        const refreshBtn = document.createElement('button');
        refreshBtn.innerHTML = '⟳';
        refreshBtn.title = 'Оновити SLA';
        const copyBtn = document.createElement('button');
        copyBtn.innerHTML = '⧉';
        copyBtn.title = 'Копіювати дедлайн';
        [refreshBtn, copyBtn].forEach(btn => {
            Object.assign(btn.style, {
                background: 'transparent', border: 'none', color: '#fff', fontSize: '18px',
                cursor: 'pointer', padding: '0', lineHeight: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', width: '50%', height: '100%'
            });
        });

        actionsDiv.appendChild(refreshBtn);
        actionsDiv.appendChild(copyBtn);
        timerDiv.appendChild(actionsDiv);

        // Показываем кнопки при наведении
        timerDiv.addEventListener('mouseenter', () => {
            const id = getTicketId();
            if ((id && localStorage.getItem(`slaData_${id}`)) || timerDiv.hasAttribute('data-deadline')) {
                actionsDiv.style.opacity = '1';
                actionsDiv.style.pointerEvents = 'auto';
            }
        });
        timerDiv.addEventListener('mouseleave', () => {
            actionsDiv.style.opacity = '0';
            actionsDiv.style.pointerEvents = 'none';
        });

        refreshBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = getTicketId();
            if (!id) return;
            if (saveSlaData(id)) {
                refreshBtn.style.color = '#1e7e34';
                setTimeout(() => { refreshBtn.style.color = '#fff'; }, 300);
                updateMainTimer();
                updateListTimers();
            } else {
                navigateToHistoryAndSave();
            }
        });

        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const deadlineText = timerDiv.getAttribute('data-deadline');
            if (deadlineText) {
                navigator.clipboard.writeText(deadlineText).then(() => {
                    copyBtn.style.color = '#1e7e34';
                    setTimeout(() => { copyBtn.style.color = '#fff'; }, 300);
                }).catch(err => console.error('Помилка копіювання: ', err));
            }
        });

        timerDiv.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            const id = getTicketId();
            if (!id) return;
            const hasData = localStorage.getItem(`slaData_${id}`);
            if (!hasData && !timerDiv.hasAttribute('data-deadline')) {
                navigateToHistoryAndSave();
            } else {
                const deadline = timerDiv.getAttribute('data-deadline');
                if (deadline) navigator.clipboard.writeText(deadline).catch(() => {});
            }
        });

        container.appendChild(timerDiv);
        return container;
    }

    // --- ПЕРЕХІД В ІСТОРІЮ З АВТОЗБЕРЕЖЕННЯМ І ПОВЕРНЕННЯМ ---
    function waitForHistoryAndReturn() {
        const pending = JSON.parse(sessionStorage.getItem(PENDING_REFRESH_KEY) || 'null');
        if (!pending) return;
        if (autoSaveInterval) clearInterval(autoSaveInterval);

        autoSaveInterval = setInterval(() => {
            // Не повертаємо користувача, якщо він уже відкрив іншу заявку.
            if (getTicketId() !== pending.ticketId || Date.now() - pending.startedAt > 15000) {
                clearInterval(autoSaveInterval);
                autoSaveInterval = null;
                sessionStorage.removeItem(PENDING_REFRESH_KEY);
                returnToTicketTab = null;
                return;
            }
            if (!saveSlaData(pending.ticketId)) return;

            clearInterval(autoSaveInterval);
            autoSaveInterval = null;
            sessionStorage.removeItem(PENDING_REFRESH_KEY);
            updateMainTimer();
            updateListTimers();
            console.log('[SLA Timer] SLA оновлено, повертаємося до заявки');

            // Деякі вкладки перемикаються без зміни URL.
            const previousTab = returnToTicketTab;
            returnToTicketTab = null;
            if (previousTab?.isConnected) {
                previousTab.click();
                return;
            }
            if (location.href === pending.returnUrl &&
                new URL(pending.returnUrl).searchParams.get('tab') === 'requests_hstr') return;
            const returnTab = Array.from(document.querySelectorAll('a[href]'))
                .find(link => link.href === pending.returnUrl);
            if (returnTab) {
                returnTab.click();
            } else {
                location.href = pending.returnUrl;
            }
        }, 500);
    }

    function navigateToHistoryAndSave() {
        const ticketId = getTicketId();
        if (!ticketId || autoSaveInterval) return;
        // sessionStorage зберігає адресу повернення також при повному переході через URL.
        sessionStorage.setItem(PENDING_REFRESH_KEY, JSON.stringify({
            ticketId, returnUrl: location.href, startedAt: Date.now()
        }));
        returnToTicketTab = document.querySelector(
            '.dpl-aside-tab[aria-current="true"], .dpl-aside-tab.dpl-aside-link-active, ' +
            '.p-tabview-selected .p-tabview-nav-link, .p-highlight .p-tabview-nav-link, ' +
            '.p-tabview-nav-link[aria-selected="true"], a[role="tab"][aria-selected="true"], .nav-link.active'
        );
        console.log('[SLA Timer] Перехід на вкладку Історія...');
        let tab = document.querySelector('.dpl-aside-tab[aria-label="Історія"], a[href*="tab=requests_hstr"]');
        if (!tab) {
            const candidates = document.querySelectorAll('.dpl-aside-tab, .p-tabview-nav-link, .nav-link, a[role="tab"], li[role="presentation"] a');
            for (let t of candidates) {
                if (t.textContent.trim() === 'Історія' || t.textContent.trim() === 'История') {
                    tab = t;
                    break;
                }
            }
        }
        waitForHistoryAndReturn();
        if (tab) {
            tab.click();
        } else {
            console.warn('[SLA Timer] Вкладку не знайдено, переходимо через URL');
            const url = new URL(location);
            url.searchParams.set('tab', 'requests_hstr');
            location.href = url;
        }
    }

    // --- ОБНОВЛЕНИЕ ТАЙМЕРА НА СТРАНИЦЕ ЗАЯВКИ ---
    function updateMainTimer() {
        const ticketId = getTicketId();
        const container = getOrCreateTimerUI();
        if (!ticketId) {
            container.style.display = 'none';
            return;
        }

        const aside = document.querySelector('aside.dpl-aside');
        const group = aside?.querySelector('.dpl-aside-tab[aria-label="Заявка"]')
            ?.closest('.dpl-aside-group');
        if (group && group.firstElementChild !== container) {
            container.style.margin = '0';
            container.style.flexDirection = 'column';
            container.style.gap = '0';
            container.style.width = '100%';
            container.style.padding = '0';
            container.style.boxSizing = 'border-box';
            container.style.flex = '0 0 auto';
            const timerDiv = container.querySelector('#my-sla-timer');
            if (timerDiv) { timerDiv.style.width = '100%'; timerDiv.style.padding = '0'; }
            group.prepend(container);
        }
        container.style.display = 'flex';

        const timerDiv = container.querySelector('#my-sla-timer');
        const textSpan = container.querySelector('#my-sla-timer-text');
        const refreshBtn = container.querySelector('.sla-btn-refresh');
        const copyBtn = container.querySelector('.sla-btn-copy');
        if (!timerDiv || !textSpan) return;

        let slaData = null;
        const storageKey = `slaData_${ticketId}`;

        if (document.querySelector('app-requests_hstr-list, p-tabpanel[id*="tabpanel_requests_hstr"]')) {
            const fresh = calculateSLA();
            if (fresh) {
                slaData = fresh;
                saveSlaData(ticketId);
            }
        }

        if (!slaData) {
            const saved = localStorage.getItem(storageKey);
            if (saved) {
                try {
                    const { deadline } = JSON.parse(saved);
                    slaData = { remainingMs: deadline - Date.now(), deadlineDate: new Date(deadline) };
                } catch (e) {}
            }
        }

        const isFlashing = timerDiv.style.backgroundColor === 'rgb(30, 126, 52)';

        if (!slaData) {
            textSpan.innerHTML = '<span style="font-size: 20px; line-height: 1;">⟳</span>';
            timerDiv.title = 'Оновити таймер';
            timerDiv.style.cursor = 'pointer';
            timerDiv.removeAttribute('data-deadline');
            if (!isFlashing) {
                timerDiv.style.backgroundColor = '#5c2323';
                timerDiv.style.color = '#cfd3da';
                timerDiv.style.border = 'none';
            }
            return;
        }

        if (slaData.noSLA) {
            textSpan.textContent = 'Немає SLA';
            textSpan.style.fontSize = '13px';
            timerDiv.title = '';
            timerDiv.style.cursor = 'default';
            timerDiv.removeAttribute('data-deadline');
            if (copyBtn) copyBtn.style.display = 'none';
            if (refreshBtn) refreshBtn.style.display = 'flex';
            if (!isFlashing) {
                timerDiv.style.backgroundColor = '#26282f';
                timerDiv.style.color = '#cfd3da';
                timerDiv.style.border = 'none';
            }
            return;
        }

        const { remainingMs, deadlineDate } = slaData;
        timerDiv.setAttribute('data-deadline', formatDateTime(deadlineDate));
        timerDiv.style.cursor = 'pointer';
        if (refreshBtn) refreshBtn.style.display = 'flex';
        if (copyBtn) copyBtn.style.display = 'flex';

        const isOverdue = remainingMs < 0;
        const absDiff = Math.abs(remainingMs);
        const h = Math.floor(absDiff / (1000 * 60 * 60));
        const m = Math.floor((absDiff % (1000 * 60 * 60)) / (1000 * 60));

        textSpan.textContent = `${isOverdue ? '-' : ''}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        textSpan.style.fontSize = '13px';

        if (!isFlashing) {
            if (remainingMs <= 2 * 60 * 60 * 1000) {
                timerDiv.style.backgroundColor = '#4a0000'; timerDiv.style.color = '#cfd3da'; timerDiv.style.borderColor = '#ff4d4d';
            } else {
                timerDiv.style.backgroundColor = '#064a2c'; timerDiv.style.color = '#cfd3da'; timerDiv.style.borderColor = '#064a2c';
            }
        }
    }

    // --- СПИСОК ЗАЯВОК: ПРИХОВУВАННЯ КОЛОНОК І ВІДНОВЛЕННЯ СІТКИ ---
    function hideStockTimerColumns() {
    document.querySelectorAll('.request-column').forEach(col => {
        const prop = col.querySelector('.property-name');

        if (prop?.textContent.trim() !== 'Таймер задачі')
            return;

        if (col.dataset.hidden)
            return;

        col.dataset.hidden = "1";

        col.querySelectorAll(':scope > *:not(.request-column-resizer)').forEach(el => {
            Object.assign(el.style, {
                visibility: 'hidden',
                pointerEvents: 'none'
            });
        });

        col.style.position = 'relative';
    });
    }
    const style = document.createElement('style');
    style.textContent = `
.request-column {
    white-space: nowrap;
}
`;
    document.head.append(style);

    new MutationObserver(() => {
        if (document.querySelector('.p-panel-header, [id$="-titlebar"]')) {
            hideStockTimerColumns();
        }
    }).observe(document.body, {
        childList: true,
        subtree: true
    });


    // --- МЕНЮ ТА РОЗТАШУВАННЯ ТАЙМЕРІВ У СПИСКУ ---
    const LIST_LAYOUT_KEY = 'slaListTimerLayout';
    const LIST_LAYOUT_FIELDS = {
        x: { label: 'По горизонталі', min: -400, max: 400, value: 0, unit: 'пкс' },
        y: { label: 'По вертикалі', min: -120, max: 120, value: 0, unit: 'пкс' },
        width: { label: 'Ширина', min: 40, max: 180, value: 56, unit: 'пкс' },
        height: { label: 'Висота', min: 16, max: 64, value: 22, unit: 'пкс' },
        fontSize: { label: 'Розмір тексту', min: 8, max: 24, value: 12, unit: 'пкс' }
    };
    function readListTimerLayout() {
        let saved;
        try { saved = JSON.parse(localStorage.getItem(LIST_LAYOUT_KEY)); } catch (e) {}
        return Object.fromEntries(Object.entries(LIST_LAYOUT_FIELDS).map(([key, field]) => {
            const value = saved?.[key];
            return [key, Number.isFinite(value)
                ? Math.max(field.min, Math.min(field.max, Math.round(value))) : field.value];
        }));
    }
    let listTimerLayout = readListTimerLayout();
    let listTimerPopup = null;

    function applyListTimerLayout(timer) {
        const { x, y, width, height, fontSize } = listTimerLayout;
        // Абсолютне позиціювання виключає таймер з розрахунку висоти рядка.
        Object.assign(timer.style, {
            position: 'absolute', right: '96%', bottom: '-3px', zIndex: '10',
            transform: `translate(${x}px, ${y}px)`, width: `${width}px`, height: `${height}px`,
            boxSizing: 'border-box', padding: '2px 5px', margin: '0',
            fontSize: `${fontSize}px`, fontWeight: 'bold', lineHeight: '1',
            borderWidth: '1px', borderStyle: 'solid', borderRadius: '0', display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center', whiteSpace: 'nowrap',
            overflow: 'hidden', cursor: 'pointer', userSelect: 'none'
        });
    }

    function openListTimerMenu(timer) {
        listTimerPopup?.close(false);
        const controller = new AbortController();
        const { signal } = controller;
        const host = document.createElement('div');
        host.id = 'sla-list-timer-popup';
        host.lang = 'uk';
        // Shadow DOM захищає меню від глобальних стилів div/button/span у Stylus.
        host.style.cssText = 'position:fixed;inset:0;width:0;height:0;z-index:2147483000;';
        host.style.setProperty('background', 'transparent', 'important');
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `
            <style>
                :host { font:13px sans-serif; color:#c8c3bc; }
                *, *::before, *::after { box-sizing:border-box; }
                .panel { position:fixed; width:224px; max-width:calc(100vw - 16px);
                    max-height:calc(100dvh - 16px); overflow:auto; padding:4px; margin:0;
                    background:#272a2c; color:#c8c3bc; border:1px solid #3e4446; border-radius:0; }
                .panel.editor { width:304px; padding:10px; }
                button { font:inherit; color:inherit; background:transparent; border:0;
                    border-radius:0; margin:0; padding:7px 8px; cursor:pointer; }
                button:hover { background:#35393b; }
                button:focus-visible, input:focus-visible { outline:2px solid #86b9ff; outline-offset:-2px; }
                .action { display:flex; align-items:center; gap:9px; width:100%; text-align:left; }
                svg { flex:none; width:17px; height:17px; fill:none; stroke:currentColor;
                    stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
                header, .caption, footer { display:flex; align-items:center; justify-content:space-between; gap:8px; }
                h2 { font:700 13px sans-serif; margin:0; }
                .close { padding:3px; display:flex; }
                .note, .status { color:#9d9588; font-size:12px; line-height:1.4; margin:6px 0; }
                .status:empty { display:none; }
                .status[data-error] { color:#ffb7be; }
                label { display:block; margin:14px 0; }
                output { color:#b8c0ca; font-variant-numeric:tabular-nums; }
                input[type=range] { display:block; width:100%; height:18px; margin:5px 0 0;
                    padding:0; accent-color:#86b9ff; cursor:pointer; }
                footer { border-top:1px solid #3e4446; padding-top:8px; }
                .primary { background:#1e3a60; color:#e8e6e3; }
                .primary:hover { background:#284b79; }
            </style>
            <section class="panel" role="menu" aria-label="SLA">
                <button class="action" type="button" role="menuitem" data-action="copy">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="13"/><path d="M16 8V3H3v13h5"/></svg>
                    Копіювати SLA
                </button>
                <button class="action" type="button" role="menuitem" data-action="edit">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16M8 4v6m8 4v6"/></svg>
                    Редагувати розташування
                </button>
                <p class="status" role="status" aria-live="polite"></p>
            </section>`;
        const panel = root.querySelector('.panel');
        const anchor = timer.getBoundingClientRect();
        let copyTimeout;
        function close(restoreFocus = true) {
            clearTimeout(copyTimeout);
            controller.abort();
            host.remove();
            timer.setAttribute('aria-expanded', 'false');
            if (restoreFocus && timer.isConnected) timer.focus({ preventScroll: true });
            if (listTimerPopup?.host === host) listTimerPopup = null;
        }
        function positionPanel() {
            const rect = panel.getBoundingClientRect();
            panel.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8))}px`;
            const top = anchor.bottom + 6;
            panel.style.top = `${Math.max(8, Math.min(top, window.innerHeight - rect.height - 8))}px`;
        }
        function showStatus(text, error = false) {
            const status = panel.querySelector('.status');
            status.textContent = text;
            status.toggleAttribute('data-error', error);
            positionPanel();
        }
        function saveLayout() {
            document.querySelectorAll('.list-sla-timer').forEach(item => {
                if (item.style.display !== 'none') applyListTimerLayout(item);
            });
            try {
                localStorage.setItem(LIST_LAYOUT_KEY, JSON.stringify(listTimerLayout));
                showStatus('Зміни збережено');
            } catch (e) { showStatus('Не вдалося зберегти налаштування в браузері', true); }
        }
        function openEditor() {
            clearTimeout(copyTimeout);
            panel.classList.add('editor');
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-label', 'Розташування таймерів SLA');
            panel.innerHTML = `
                <header><h2>Розташування таймерів SLA</h2>
                    <button class="close" type="button" aria-label="Закрити">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
                    </button>
                </header>
                <p class="note">Для всіх таймерів списку. Зміни видно одразу, вони зберігаються автоматично.</p>
                ${Object.entries(LIST_LAYOUT_FIELDS).map(([key, field]) => `
                    <label for="sla-layout-${key}">
                        <span class="caption"><span>${field.label}</span><output for="sla-layout-${key}">${listTimerLayout[key]} ${field.unit}</output></span>
                        <input id="sla-layout-${key}" type="range" data-key="${key}" min="${field.min}" max="${field.max}" step="1" value="${listTimerLayout[key]}">
                    </label>`).join('')}
                <p class="note">Розмір таймера не змінює висоту рядка.</p>
                <p class="status" role="status" aria-live="polite"></p>
                <footer><button type="button" data-action="reset">Скинути</button>
                    <button class="primary" type="button" data-action="done">Готово</button></footer>`;
            panel.querySelector('.close').addEventListener('click', () => close(), { signal });
            panel.querySelector('[data-action=done]').addEventListener('click', () => close(), { signal });
            panel.querySelectorAll('input').forEach(input => {
                input.addEventListener('input', () => {
                    listTimerLayout[input.dataset.key] = Number(input.value);
                    input.labels[0].querySelector('output').textContent = `${input.value} пкс`;
                    saveLayout();
                }, { signal });
            });
            panel.querySelector('[data-action=reset]').addEventListener('click', () => {
                for (const [key, field] of Object.entries(LIST_LAYOUT_FIELDS)) {
                    listTimerLayout[key] = field.value;
                    const input = panel.querySelector(`[data-key=${key}]`);
                    input.value = field.value;
                    input.labels[0].querySelector('output').textContent = `${field.value} ${field.unit}`;
                }
                saveLayout();
            }, { signal });
            positionPanel();
            panel.querySelector('input').focus();
        }
        panel.querySelector('[data-action=copy]').addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(timer.dataset.deadline);
                if (signal.aborted) return;
                showStatus('SLA скопійовано');
                copyTimeout = setTimeout(() => close(), 800);
            } catch (e) {
                if (!signal.aborted) showStatus('Не вдалося скопіювати SLA. Спробуйте ще раз.', true);
            }
        }, { signal });
        panel.querySelector('[data-action=edit]').addEventListener('click', openEditor, { signal });
        document.addEventListener('pointerdown', event => {
            if (!event.composedPath().includes(host)) close(false);
        }, { capture: true, signal });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        }, { capture: true, signal });
        panel.addEventListener('keydown', event => {
            if (panel.getAttribute('role') !== 'menu') return;
            const items = Array.from(panel.querySelectorAll('[role=menuitem]'));
            const index = items.indexOf(root.activeElement);
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                items[next].focus();
            }
        }, { signal });
        document.addEventListener('focusin', event => {
            if (!event.composedPath().includes(host) && event.target !== timer) close(false);
        }, { signal });
        window.addEventListener('resize', () => close(false), { signal });
        window.addEventListener('scroll', event => {
            if (!event.composedPath().includes(host)) close(false);
        }, { capture: true, signal });
        document.body.append(host);
        listTimerPopup = { host, timer, close };
        timer.setAttribute('aria-expanded', 'true');
        positionPanel();
        panel.querySelector('button').focus({ preventScroll: true });
    }

    function updateListTimers() {
        if (listTimerPopup && !listTimerPopup.timer.isConnected) listTimerPopup.close(false);
        const panels = document.querySelectorAll('.p-panel-header, [id$="-titlebar"]');
        panels.forEach(panel => {
            let ticketId = panel.dataset.ticketId;
            if (!ticketId) {
                const link = panel.querySelector('a[href*="/admin/requests/"]');
                if (link) { const m = link.href.match(/\/admin\/requests\/(\d+)/); if (m) ticketId = m[1]; }
                if (!ticketId) {
                    const propName = panel.querySelector('.property-name') || panel;
                    const idMatch = propName.textContent.match(/Заявка\s*#?(\d+)/i);
                    if (idMatch) ticketId = idMatch[1];
                }
                if (ticketId) panel.dataset.ticketId = ticketId;
            }
            if (!ticketId) return;

            let statusCol = panel.querySelector('div:nth-child(2) > div > div:nth-child(2)');
            if (!statusCol) {
                const grid = panel.querySelector('.grid.align-items-start.flex-1');
                if (grid) statusCol = Array.from(grid.children).find(c => c.textContent.includes('Статус'));
            }
            if (!statusCol) statusCol = panel;

            let timerSpan = panel.querySelector('.list-sla-timer');
            if (!timerSpan) {
                statusCol.style.position = 'relative'; statusCol.style.overflow = 'visible';
                timerSpan = document.createElement('span');
                timerSpan.className = 'list-sla-timer';
                timerSpan.dataset.ticketId = ticketId;
                timerSpan.setAttribute('role', 'button');
                timerSpan.tabIndex = 0;
                timerSpan.setAttribute('aria-haspopup', 'menu');
                timerSpan.setAttribute('aria-expanded', 'false');
                timerSpan.title = 'Меню SLA';
                const openMenu = event => {
                    event.preventDefault();
                    event.stopPropagation();
                    openListTimerMenu(timerSpan);
                };
                timerSpan.addEventListener('click', openMenu);
                timerSpan.addEventListener('contextmenu', openMenu);
                timerSpan.addEventListener('keydown', event => {
                    if (['Enter', ' ', 'ContextMenu'].includes(event.key) || (event.shiftKey && event.key === 'F10')) openMenu(event);
                });
                statusCol.appendChild(timerSpan);
            }

            const saved = localStorage.getItem(`slaData_${ticketId}`);
            if (!saved) { timerSpan.style.display = 'none'; return; }
            applyListTimerLayout(timerSpan);
            try {
                const { deadline } = JSON.parse(saved);
                timerSpan.dataset.deadline = formatDateTime(new Date(deadline));
                timerSpan.setAttribute('aria-label', `SLA заявки ${ticketId}: ${timerSpan.dataset.deadline}. Відкрити меню`);
                const remainingMs = deadline - Date.now();
                const isOverdue = remainingMs < 0;
                const absDiff = Math.abs(remainingMs);
                const h = Math.floor(absDiff / (1000 * 60 * 60));
                const m = Math.floor((absDiff % (1000 * 60 * 60)) / (1000 * 60));
                timerSpan.textContent = `${isOverdue ? '-' : ''}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

                if (remainingMs <= 2 * 60 * 60 * 1000) {
                    timerSpan.style.backgroundColor = '#4a0000'; timerSpan.style.color = '#cfd3da'; timerSpan.style.borderColor = '#ff4d4d';
                } else {
                    timerSpan.style.backgroundColor = '#064a2c'; timerSpan.style.color = '#cfd3da'; timerSpan.style.borderColor = '#064a2c';
                }
            } catch (e) {
                console.error(`Помилка оновлення таймера списку для заявки ${ticketId}:`, e);
            }
        });
    }

    // --- ГЛАВНЫЙ ЦИКЛ (1 секунда) ---
    setInterval(() => {
        if (isTicketPage()) updateMainTimer();
        updateListTimers();
    }, 1000);

    // Продовжуємо оновлення після переходу в історію з перезавантаженням сторінки.
    waitForHistoryAndReturn();

    // Первый запуск
    if (isTicketPage()) updateMainTimer();
    updateListTimers();
    window.addEventListener('load', () => { hideStockTimerColumns(); if (isTicketPage()) updateMainTimer(); updateListTimers(); });
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        hideStockTimerColumns();
    }
})();
