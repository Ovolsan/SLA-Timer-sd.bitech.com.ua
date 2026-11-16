// ==UserScript==
// @name         SLA Timer sd.bitech.com.ua
// @namespace    http://tampermonkey.net/
// @version      20261116
// @description  Таймер SLA для sd.bitech. Бере таймер SLA напряму з API сайту — те саме значення, що й стандартна колонка «Таймер задачі», тому коректно враховує критичність, усі призупинення, їх дострокове зняття та зв'язані заявки. Відображається у списку заявок коло статусу для всіх заявок і в самій заявці над лівим меню, оновлюється щохвилини. Показує фактичний час до дедлайну. Клік на таймер у заявці копіює час завершення SLA, а у списку відкриває меню копіювання та налаштування розташування. За дві години до завершення таймер стає червоним. Деталі в гілці discord.
// @author       Ovolya
// @match        *://sd.bitech.com.ua/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=bitech.com.ua
// @updateURL    https://github.com/Ovolsan/SLA-Timer-sd.bitech.com.ua/raw/refs/heads/main/SLA%20Timer%20sd.bitech.com.ua.user.js
// @downloadURL  https://github.com/Ovolsan/SLA-Timer-sd.bitech.com.ua/raw/refs/heads/main/SLA%20Timer%20sd.bitech.com.ua.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // --- КОНСТАНТИ ---
    const API_PATH = '/app';
    const LIST_PATH = '/admin/requests';
    const REFRESH_INTERVAL_MS = 60 * 1000;
    const DANGER_THRESHOLD_MS = 2 * 60 * 60 * 1000;
    const TOKEN_EXPIRY_MARGIN_MS = 15 * 1000;
    const STATUS_CLOSED = 5; // «Закрита»
    const TEXT_COLOR = '#cfd3da';
    const MAIN_TIMER_FONT_SIZE = '15px';
    const TONES = {
        ok: { background: '#064a2c', border: '#064a2c' },
        danger: { background: '#4a0000', border: '#ff4d4d' },
        muted: { background: '#26282f', border: '#3e4446' },
        missing: { background: '#5c2323', border: '#5c2323' }
    };


    // --- БАЗОВІ ФУНКЦІЇ ---
    function getTicketId() {
        const urlMatch = window.location.pathname.match(/\/admin\/requests\/(\d+)/);
        if (urlMatch) return urlMatch[1];
        const link = document.querySelector('.p-breadcrumb-list a[href*="/admin/requests/"]');
        const match = link?.href.match(/\/admin\/requests\/(\d+)/);
        return match ? match[1] : null;
    }

    function pad2(value) { return String(value).padStart(2, '0'); }

    function formatDateTime(ms) {
        if (!Number.isFinite(ms)) return '';
        const date = new Date(ms);
        return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    function formatClock(ms) {
        const date = new Date(ms);
        return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    function formatDuration(ms) {
        const abs = Math.abs(ms);
        const hours = Math.floor(abs / (60 * 60 * 1000));
        const minutes = Math.floor((abs % (60 * 60 * 1000)) / (60 * 1000));
        return `${ms < 0 ? '-' : ''}${pad2(hours)}:${pad2(minutes)}`;
    }

    function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
    function setTitle(el, title) { if (el.title !== title) el.title = title; }
    function setStyle(el, prop, value) { if (el.style[prop] !== value) el.style[prop] = value; }
    function setData(el, key, value) {
        if (value) { if (el.dataset[key] !== value) el.dataset[key] = value; } else if (key in el.dataset) delete el.dataset[key];
    }
    function setTone(el, tone, withBorder) {
        if (el.dataset.slaTone === tone) return;
        el.dataset.slaTone = tone;
        el.style.backgroundColor = TONES[tone].background;
        el.style.color = TEXT_COLOR;
        if (withBorder) el.style.borderColor = TONES[tone].border;
    }


    // --- ДАНІ SLA З API САЙТУ ---
    // Сайт сам рахує таймер SLA (поле sla_timer кожної заявки): критичність, призупинення
    // (статус «Відстрочено» — до зміни статусу або до автоматичного відновлення) та зв'язані
    // заявки. Скрипт не рахує SLA сам, а лише показує ці дані.
    const slaStore = new Map();
    let authorization = null; // токен доступу самого сайту: лише в пам'яті сторінки, нікуди не зберігається
    let authorizationExpiresAt = 0;
    let lastListRequest = null;
    let lastRefreshAttemptAt = 0;
    let refreshPromise = null;
    let lastRefreshError = '';

    function rememberTicket(item, receivedAt) {
        if (!item || typeof item !== 'object' || !Number.isFinite(item.id) ||
            !Object.prototype.hasOwnProperty.call(item, 'sla_timer')) return false;
        const timer = item.sla_timer;
        slaStore.set(String(item.id), {
            receivedAt,
            timer: timer && Number.isFinite(timer.remaining) ? {
                remainingMs: timer.remaining * 1000,
                deadlineMs: Number.isFinite(timer.deadline) ? timer.deadline * 1000 : null
            } : null,
            statusId: item.status?.id ?? null
        });
        return true;
    }

    // Повертає кількість заявок із даними SLA у відповіді API.
    function rememberApiResponse(response) {
        let json = response;
        if (typeof response === 'string') {
            if (!response.includes('"sla_timer"')) return 0;
            try { json = JSON.parse(response); } catch (e) { return 0; }
        }
        const data = json?.data;
        const receivedAt = Date.now();
        return (Array.isArray(data) ? data : [data])
            .reduce((count, item) => count + (rememberTicket(item, receivedAt) ? 1 : 0), 0);
    }

    function handleApiExchange(requestBody, response, path) {
        if (!rememberApiResponse(response) || path !== LIST_PATH || typeof requestBody !== 'string') return;
        // Запам'ятовуємо запит списку, щоб щохвилини повторювати саме його (ті самі фільтри й сторінка).
        try {
            const request = JSON.parse(requestBody);
            if (request?.module === 'requests' && request.action === 'readMany') {
                lastListRequest = { body: requestBody, receivedAt: Date.now() };
            }
        } catch (e) {}
    }

    function isApiUrl(url) {
        try {
            const parsed = new URL(url, location.href);
            return parsed.origin === location.origin && parsed.pathname === API_PATH;
        } catch (e) { return false; }
    }

    function rememberAuthorization(value) {
        if (typeof value !== 'string' || !/^Bearer\s+\S/i.test(value)) return;
        authorization = value;
        authorizationExpiresAt = 0;
        try {
            const payload = value.replace(/^Bearer\s+/i, '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const exp = JSON.parse(atob(payload)).exp;
            if (Number.isFinite(exp)) authorizationExpiresAt = exp * 1000;
        } catch (e) {}
    }

    // Скрипт запускається до завантаження сайту й читає відповіді, які сайт і так отримує.
    function installApiCapture() {
        const proto = XMLHttpRequest.prototype;
        const nativeOpen = proto.open;
        const nativeSend = proto.send;
        const nativeSetRequestHeader = proto.setRequestHeader;
        const apiRequests = new WeakSet();

        proto.open = function (method, url) {
            if (isApiUrl(url)) apiRequests.add(this); else apiRequests.delete(this);
            return nativeOpen.apply(this, arguments);
        };
        proto.setRequestHeader = function (name, value) {
            if (apiRequests.has(this) && String(name).toLowerCase() === 'authorization') rememberAuthorization(value);
            return nativeSetRequestHeader.apply(this, arguments);
        };
        proto.send = function (body) {
            if (apiRequests.has(this)) {
                const path = location.pathname;
                this.addEventListener('load', () => {
                    if (this.status !== 200) return;
                    try {
                        const type = this.responseType;
                        const response = type === '' || type === 'text' ? this.responseText : type === 'json' ? this.response : null;
                        handleApiExchange(body, response, path);
                    } catch (e) { console.warn('[SLA Timer] Не вдалося прочитати відповідь сайту:', e); }
                });
            }
            return nativeSend.apply(this, arguments);
        };

        const nativeFetch = window.fetch;
        window.fetch = function (input, init) {
            const promise = nativeFetch.apply(window, arguments);
            try {
                const isRequest = input instanceof Request;
                if (isApiUrl(isRequest ? input.url : String(input))) {
                    rememberAuthorization(new Headers(init?.headers ?? (isRequest ? input.headers : undefined)).get('authorization'));
                    const body = typeof init?.body === 'string' ? init.body : null;
                    const path = location.pathname;
                    promise.then(response => response.ok ? response.clone().text() : null)
                        .then(text => { if (text) handleApiExchange(body, text, path); })
                        .catch(() => {});
                }
            } catch (e) {}
            return promise;
        };
        return nativeFetch;
    }

    const nativeFetch = installApiCapture();

    function canCallApi() {
        return Boolean(authorization) &&
            (!authorizationExpiresAt || authorizationExpiresAt - Date.now() > TOKEN_EXPIRY_MARGIN_MS);
    }

    // Лише читання: ті самі запити, що робить сайт, без жодних змін у заявках.
    async function callApi(body) {
        const headers = {
            'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', Authorization: authorization
        };
        const xsrf = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]*)/);
        if (xsrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf[1]);
        const path = location.pathname;
        const response = await nativeFetch.call(window, API_PATH, { method: 'POST', credentials: 'same-origin', headers, body });
        if (response.status === 401) authorization = null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        handleApiExchange(body, await response.text(), path);
    }

    function refreshSlaData(force = false) {
        if (refreshPromise) return refreshPromise;
        const ticketId = getTicketId();
        let body = null;
        let dataAt = 0;
        if (ticketId) {
            body = JSON.stringify({ module: 'requests', action: 'readOne', data: { id: Number(ticketId) } });
            dataAt = slaStore.get(ticketId)?.receivedAt ?? 0;
        } else if (location.pathname === LIST_PATH && lastListRequest) {
            ({ body, receivedAt: dataAt } = lastListRequest);
        }
        if (!body) return Promise.resolve(false);
        const now = Date.now();
        if (!force && (document.visibilityState === 'hidden' || now - dataAt < REFRESH_INTERVAL_MS ||
            now - lastRefreshAttemptAt < REFRESH_INTERVAL_MS)) return Promise.resolve(false);
        if (!canCallApi()) {
            if (force) lastRefreshError = 'Не вдалося оновити: сайт ще не видав доступ. Виконайте будь-яку дію на сайті або оновіть сторінку.';
            return Promise.resolve(false);
        }
        lastRefreshAttemptAt = now;
        refreshPromise = callApi(body)
            .then(() => { lastRefreshError = ''; return true; }, error => {
                console.warn('[SLA Timer] Не вдалося оновити дані SLA:', error);
                if (force) lastRefreshError = 'Не вдалося оновити дані SLA. Спробуйте ще раз або оновіть сторінку.';
                return false;
            })
            .finally(() => { refreshPromise = null; });
        return refreshPromise;
    }


    // --- СТАН ТАЙМЕРА ---
    // Показуємо фактичний час до дедлайну SLA. Під час призупинення дедлайн сайту —
    // це кінець призупинення плюс залишок, тож таймер іде далі, як і раніше.
    function getSlaView(ticketId, now) {
        const entry = slaStore.get(String(ticketId));
        if (!entry) return { kind: 'missing' };
        const { timer } = entry;
        if (!timer) return { kind: entry.statusId === STATUS_CLOSED ? 'closed' : 'none', entry };
        const deadlineMs = timer.deadlineMs ?? entry.receivedAt + timer.remainingMs;
        return { kind: 'timer', entry, deadlineMs, remainingMs: deadlineMs - now };
    }

    function describeSla(view) {
        const lines = [];
        if (view.kind === 'timer') {
            lines.push(view.remainingMs < 0
                ? `SLA прострочено на ${formatDuration(-view.remainingMs)}`
                : `До завершення SLA: ${formatDuration(view.remainingMs)}`);
            lines.push(`Дедлайн SLA: ${formatDateTime(view.deadlineMs)}`);
        } else if (view.kind === 'closed') {
            lines.push('Заявку закрито, таймер SLA не ведеться');
        } else if (view.kind === 'none') {
            lines.push('Для цієї заявки таймер SLA не ведеться');
        } else {
            lines.push('Дані SLA ще не отримано від сайту');
        }
        if (view.entry) lines.push(`Дані сайту від ${formatClock(view.entry.receivedAt)}`);
        if (lastRefreshError) lines.push(lastRefreshError);
        return lines.join('\n');
    }

    function getTimerLook(view) {
        const title = describeSla(view);
        switch (view.kind) {
            case 'timer':
                return {
                    text: formatDuration(view.remainingMs),
                    tone: view.remainingMs <= DANGER_THRESHOLD_MS ? 'danger' : 'ok',
                    deadline: formatDateTime(view.deadlineMs), title
                };
            case 'closed': return { text: 'Закрита', tone: 'muted', deadline: '', title };
            case 'none': return { text: 'Немає SLA', tone: 'muted', deadline: '', title };
            default: return { text: '⟳', tone: 'missing', deadline: '', title };
        }
    }


    // --- UI ТАЙМЕРА В ЗАЯВЦІ ---
    let mainTimer = null;

    function createActionButton(symbol, title, className) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = symbol;
        button.title = title;
        Object.assign(button.style, {
            background: 'transparent', border: 'none', color: '#fff', fontSize: '18px',
            cursor: 'pointer', padding: '0', lineHeight: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%'
        });
        return button;
    }

    function flashButton(button, ok) {
        button.style.color = ok ? '#1e7e34' : '#ff4d4d';
        setTimeout(() => { button.style.color = '#fff'; }, ok ? 300 : 1200);
    }

    function refreshNow() {
        refreshSlaData(true).then(tick);
    }

    function createMainTimer() {
        const container = document.createElement('div');
        container.id = 'my-sla-container';
        Object.assign(container.style, {
            display: 'flex', flexDirection: 'column', position: 'relative', alignItems: 'center', zIndex: 99,
            margin: '0', gap: '0', width: '100%', padding: '0', boxSizing: 'border-box', flex: '0 0 auto'
        });

        const timerDiv = document.createElement('div');
        timerDiv.id = 'my-sla-timer';
        Object.assign(timerDiv.style, {
            fontWeight: 'bold', borderRadius: '0px',
            transition: 'background-color 0.15s ease', fontSize: MAIN_TIMER_FONT_SIZE, userSelect: 'none',
            boxShadow: '0 2px 5px rgba(0,0,0,0.2)', textAlign: 'center', height: '26px', width: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
            border: 'none', position: 'relative', overflow: 'hidden', cursor: 'pointer', padding: '0 1px'
        });

        const textSpan = document.createElement('span');
        textSpan.id = 'my-sla-timer-text';
        Object.assign(textSpan.style, { position: 'relative', zIndex: '2', lineHeight: '1', whiteSpace: 'nowrap' });
        timerDiv.appendChild(textSpan);

        // Шар із кнопкою копіювання з'являється при наведенні, коли є дедлайн.
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'sla-timer-actions';
        Object.assign(actionsDiv.style, {
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            display: 'flex', justifyContent: 'space-around', alignItems: 'center',
            opacity: '0', transition: 'opacity 0.2s ease',
            pointerEvents: 'none', zIndex: '3', background: 'rgba(0,0,0,0.5)'
        });
        const copyBtn = createActionButton('⧉', 'Копіювати дедлайн', 'sla-btn-copy');
        actionsDiv.append(copyBtn);
        timerDiv.appendChild(actionsDiv);
        container.appendChild(timerDiv);

        const showActions = visible => {
            actionsDiv.style.opacity = visible ? '1' : '0';
            actionsDiv.style.pointerEvents = visible ? 'auto' : 'none';
        };
        timerDiv.addEventListener('mouseenter', () => showActions(Boolean(timerDiv.dataset.deadline)));
        timerDiv.addEventListener('mouseleave', () => showActions(false));

        copyBtn.addEventListener('click', event => {
            event.stopPropagation();
            const deadline = timerDiv.dataset.deadline;
            if (!deadline) return;
            navigator.clipboard.writeText(deadline).then(() => flashButton(copyBtn, true), error => {
                flashButton(copyBtn, false);
                console.error('[SLA Timer] Помилка копіювання:', error);
            });
        });
        timerDiv.addEventListener('click', event => {
            if (event.target.closest('button')) return;
            const deadline = timerDiv.dataset.deadline;
            if (deadline) navigator.clipboard.writeText(deadline).catch(() => {});
            else refreshNow();
        });

        return { container, timerDiv, textSpan, showActions };
    }

    function updateMainTimer(now) {
        const ticketId = getTicketId();
        if (!ticketId) {
            if (mainTimer) setStyle(mainTimer.container, 'display', 'none');
            return;
        }
        mainTimer ??= createMainTimer();
        const { container, timerDiv, textSpan, showActions } = mainTimer;

        const group = document.querySelector('aside.dpl-aside .dpl-aside-tab[aria-label="Заявка"]')
            ?.closest('.dpl-aside-group');
        if (group && group.firstElementChild !== container) group.prepend(container);
        setStyle(container, 'display', 'flex');

        const look = getTimerLook(getSlaView(ticketId, now));
        setText(textSpan, look.text);
        setStyle(textSpan, 'fontSize', look.tone === 'missing' ? '20px' : MAIN_TIMER_FONT_SIZE);
        setTone(timerDiv, look.tone, false);
        setTitle(timerDiv, `${look.title}\n${look.deadline ? 'Клік — копіювати дедлайн' : 'Клік — оновити дані'}`);
        setData(timerDiv, 'deadline', look.deadline);
        if (!look.deadline) showActions(false);
    }


    // --- СПИСОК ЗАЯВОК: ПРИХОВУВАННЯ СТАНДАРТНОЇ КОЛОНКИ «ТАЙМЕР ЗАДАЧІ» ---
    function hideStockTimerColumns() {
        document.querySelectorAll('.request-column').forEach(col => {
            if (col.dataset.hidden) return;
            if (col.querySelector('.property-name')?.textContent.trim() !== 'Таймер задачі') return;
            col.dataset.hidden = '1';
            col.querySelectorAll(':scope > *:not(.request-column-resizer)').forEach(el => {
                Object.assign(el.style, { visibility: 'hidden', pointerEvents: 'none' });
            });
            col.style.position = 'relative';
        });
    }


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
            borderWidth: '1px', borderStyle: 'solid', borderRadius: '0',
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
            document.querySelectorAll('.list-sla-timer').forEach(applyListTimerLayout);
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
                    input.labels[0].querySelector('output').textContent = `${input.value} ${LIST_LAYOUT_FIELDS[input.dataset.key].unit}`;
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


    // --- ТАЙМЕРИ У СПИСКУ ЗАЯВОК ---
    // Номер заявки читаємо щоразу: сайт може перевикористати рядок для іншої заявки.
    function getPanelTicketId(panel) {
        const href = panel.querySelector('a[href*="/admin/requests/"]')?.getAttribute('href');
        const fromLink = href?.match(/\/admin\/requests\/(\d+)/);
        if (fromLink) return fromLink[1];
        const fromText = (panel.querySelector('.property-name') || panel).textContent.match(/Заявка\s*#?(\d+)/i);
        return fromText ? fromText[1] : null;
    }

    function findStatusColumn(panel) {
        return Array.from(panel.querySelectorAll('.request-column'))
                .find(col => col.querySelector('.property-name')?.textContent.trim() === 'Статус')
            || panel.querySelector('div:nth-child(2) > div > div:nth-child(2)')
            || Array.from(panel.querySelector('.grid.align-items-start.flex-1')?.children ?? [])
                .find(col => col.textContent.includes('Статус'))
            || panel;
    }

    function createListTimer(panel) {
        const statusCol = findStatusColumn(panel);
        statusCol.style.position = 'relative';
        statusCol.style.overflow = 'visible';
        const timer = document.createElement('span');
        timer.className = 'list-sla-timer';
        timer.setAttribute('role', 'button');
        timer.tabIndex = 0;
        timer.setAttribute('aria-haspopup', 'menu');
        timer.setAttribute('aria-expanded', 'false');
        timer.style.display = 'none';
        applyListTimerLayout(timer);
        const openMenu = event => {
            event.preventDefault();
            event.stopPropagation();
            openListTimerMenu(timer);
        };
        timer.addEventListener('click', openMenu);
        timer.addEventListener('contextmenu', openMenu);
        timer.addEventListener('keydown', event => {
            if (['Enter', ' ', 'ContextMenu'].includes(event.key) || (event.shiftKey && event.key === 'F10')) openMenu(event);
        });
        statusCol.appendChild(timer);
        return timer;
    }

    function updateListTimers(now) {
        if (listTimerPopup && !listTimerPopup.timer.isConnected) listTimerPopup.close(false);
        document.querySelectorAll('.p-panel-header, [id$="-titlebar"]').forEach(panel => {
            const ticketId = getPanelTicketId(panel);
            let timer = panel.querySelector('.list-sla-timer');
            if (!ticketId) {
                if (timer) setStyle(timer, 'display', 'none');
                return;
            }
            timer ??= createListTimer(panel);
            setData(timer, 'ticketId', ticketId);

            const view = getSlaView(ticketId, now);
            if (view.kind !== 'timer') {
                setStyle(timer, 'display', 'none');
                setData(timer, 'deadline', '');
                return;
            }
            const look = getTimerLook(view);
            setText(timer, look.text);
            setTone(timer, look.tone, true);
            setData(timer, 'deadline', look.deadline);
            setTitle(timer, `${look.title}\nКлік — меню SLA`);
            const label = `SLA заявки ${ticketId}: ${look.text}${look.deadline ? `, дедлайн ${look.deadline}` : ''}. Відкрити меню`;
            if (timer.getAttribute('aria-label') !== label) timer.setAttribute('aria-label', label);
            setStyle(timer, 'display', 'inline-flex');
        });
    }


    // --- ГОЛОВНИЙ ЦИКЛ ---
    let lastTickError = '';
    function tick() {
        try {
            const now = Date.now();
            updateMainTimer(now);
            updateListTimers(now);
            refreshSlaData();
        } catch (e) {
            if (String(e) !== lastTickError) console.error('[SLA Timer]', e);
            lastTickError = String(e);
        }
    }

    // Записи старих версій (SLA, розраховані з історії) більше не потрібні.
    function removeLegacyStorage() {
        try {
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key?.startsWith('slaData_')) keys.push(key);
            }
            keys.forEach(key => localStorage.removeItem(key));
            sessionStorage.removeItem('slaPendingRefresh');
        } catch (e) {}
    }

    function init() {
        removeLegacyStorage();
        const style = document.createElement('style');
        style.textContent = '.request-column { white-space: nowrap; }';
        document.head.append(style);

        hideStockTimerColumns();
        let hideScheduled = false;
        new MutationObserver(() => {
            if (hideScheduled) return;
            hideScheduled = true;
            requestAnimationFrame(() => { hideScheduled = false; hideStockTimerColumns(); });
        }).observe(document.body, { childList: true, subtree: true });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') tick();
        });
        tick();
        setInterval(tick, 1000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
