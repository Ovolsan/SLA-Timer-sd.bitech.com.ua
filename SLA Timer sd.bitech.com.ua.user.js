// ==UserScript==
// @name         SLA Timer sd.bitech.com.ua
// @namespace    http://tampermonkey.net/
// @version      20260718
// @description  Таймер SLA для sd.bitech. Відображається на сторінці заявок коло статусу, в самій заявці на всіх блоках. Кнопка оновлення з'являється тільки в історії та розташована над таймером. Вираховує час в блоці "історія", враховує критичність та всі призупинення. При кліку на таймер копіює час завершення SLA. За дві години до завершення таймера інтерфейс таймера стає червоним. Деталі в гілці discord.
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
        '1.ЗК-1': 4,
        '1.ЗК-2': 8,
        '2.ЗК-1': 8,
        '2.ЗК-2': 16,
        '3.ЗК-1': 16,
        '3.ЗК-2': 24
    };

    // --- БАЗОВІ ФУНКЦІЇ ---
    function getTicketId() {
        const breadcrumb = document.querySelector('.p-breadcrumb-list');
        if (!breadcrumb) return null;
        const link = breadcrumb.querySelector('a[href*="/admin/requests/"]');
        if (!link) return null;
        const match = link.href.match(/\/admin\/requests\/(\d+)/);
        return match ? match[1] : null;
    }

    function isTicketPage() {
        return !!getTicketId();
    }

    function isHistoryTabActive() {
        const historyPanel = document.querySelector('p-tabpanel[id*="tabpanel_requests_hstr"]');
        if (!historyPanel) return false;
        const rect = historyPanel.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function parseDateTime(str) {
        if (!str) return null;
        let match = str.trim().match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
        if (match) {
            return new Date(match[3], match[2] - 1, match[1], match[4], match[5], 0);
        }
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

    // --- ЛОГІКА СТОРІНКИ ЗАЯВКИ (ПІДРАХУНОК ТА ПАРСИНГ) ---
    function parseHistoryData() {
        const historyPanel = document.querySelector('p-tabpanel[id*="tabpanel_requests_hstr"]');
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

                if (keyText === 'Дата й час створення') {
                    let match = valText.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
                    if (match) creationTime = parseDateTime(match[0]);
                }

                if (keyText === 'Критичність') {
                    let critMatch = valText.match(/(1|2|3)\.ЗК\-(1|2)/);
                    if (critMatch && !latestCriticality) {
                        // Беремо перше співпадіння (найновіше в історії)
                        latestCriticality = critMatch[0];
                    }
                }

                if (keyText.includes('SLA призупинено до')) {
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

        // Якщо критичності немає взагалі - повертаємо спеціальний об'єкт
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

        const now = new Date();
        const elapsedMs = now.getTime() - creationTime.getTime();
        const remainingMs = slaLimitMs - elapsedMs + totalSuspensionMs;
        const deadlineDate = new Date(creationTime.getTime() + slaLimitMs + totalSuspensionMs);

        return { remainingMs, deadlineDate };
    }

    // --- ІНТЕРФЕЙС НА СТОРІНЦІ ЗАЯВКИ ---
    function getOrCreateTimerUI() {
        let container = document.getElementById('my-sla-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'my-sla-container';
            Object.assign(container.style, {
                position: 'fixed', bottom: '10px', left: '10px', zIndex: 9999,
                display: 'none', flexDirection: 'column', gap: '6px', alignItems: 'center'
            });

            const saveBtn = document.createElement('button');
            saveBtn.id = 'my-sla-save-btn';
            saveBtn.title = 'Оновити та зберегти';
            saveBtn.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M23 4v6h-6"></path>
                    <path d="M1 20v-6h6"></path>
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                </svg>
            `;
            Object.assign(saveBtn.style, {
                padding: '0', width: '32px', height: '32px', borderRadius: '6px',
                cursor: 'pointer', background: '#26282f', border: '1px solid #555',
                boxShadow: '0 2px 5px rgba(0,0,0,0.2)', transition: 'background-color 0.15s ease', outline: 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'center'
            });

            saveBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const ticketId = getTicketId();
                if (!ticketId) return;

                if (!isHistoryTabActive()) return;

                const slaData = calculateSLA();
                if (slaData) {
                    const storageKey = `slaData_${ticketId}`;

                    if (slaData.noSLA) {
                        localStorage.removeItem(storageKey);
                    } else {
                        localStorage.setItem(storageKey, JSON.stringify({ deadline: slaData.deadlineDate.getTime() }));
                    }

                    const originalBg = saveBtn.style.backgroundColor;
                    saveBtn.style.backgroundColor = '#1e7e34';
                    setTimeout(() => { saveBtn.style.backgroundColor = originalBg; }, 300);

                    updateTimer();
                    updateListTimers();
                }
            });

            const timerDiv = document.createElement('div');
            timerDiv.id = 'my-sla-timer';
            Object.assign(timerDiv.style, {
                cursor: 'pointer', fontWeight: 'bold', padding: '7px 12px', borderRadius: '6px',
                transition: 'background-color 0.15s ease', fontSize: '13px', userSelect: 'none',
                boxShadow: '0 2px 5px rgba(0,0,0,0.3)', textAlign: 'center', height: '32px',
                display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box'
            });

            timerDiv.addEventListener('click', () => {
                const deadlineText = timerDiv.getAttribute('data-deadline');
                if (!deadlineText) return;
                navigator.clipboard.writeText(deadlineText).then(() => {
                    const originalBg = timerDiv.style.backgroundColor;
                    const originalBorder = timerDiv.style.borderColor;
                    const originalColor = timerDiv.style.color;

                    timerDiv.style.backgroundColor = '#1e7e34';
                    timerDiv.style.borderColor = '#1e7e34';
                    timerDiv.style.color = '#ffffff';

                    setTimeout(() => {
                        timerDiv.style.backgroundColor = originalBg;
                        timerDiv.style.borderColor = originalBorder;
                        timerDiv.style.color = originalColor;
                    }, 300);
                }).catch(err => console.error('Помилка копіювання: ', err));
            });

            container.appendChild(saveBtn);
            container.appendChild(timerDiv);
            document.body.appendChild(container);
        }
        return container;
    }

    function updateTimer() {
        const container = getOrCreateTimerUI();
        const timerDiv = document.getElementById('my-sla-timer');
        const saveBtn = document.getElementById('my-sla-save-btn');

        const ticketId = getTicketId();
        if (!ticketId) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';

        if (saveBtn) {
            saveBtn.style.display = isHistoryTabActive() ? 'flex' : 'none';
        }

        let slaData = null;
        const storageKey = `slaData_${ticketId}`;

        if (isHistoryTabActive()) {
            const freshData = calculateSLA();
            if (freshData) slaData = freshData;
        }

        if (!slaData) {
            const savedData = localStorage.getItem(storageKey);
            if (savedData) {
                try {
                    const { deadline } = JSON.parse(savedData);
                    const remainingMs = deadline - new Date().getTime();
                    slaData = { remainingMs, deadlineDate: new Date(deadline) };
                } catch (e) {
                    console.error('Помилка читання з кешу', e);
                }
            }
        }

        const isFlashing = timerDiv.style.backgroundColor === 'rgb(30, 126, 52)';

        if (!slaData) {
            timerDiv.innerHTML = `Відкрийте історію`;
            timerDiv.removeAttribute('data-deadline');
            if (!isFlashing) {
                timerDiv.style.backgroundColor = '#555';
                timerDiv.style.color = '#fff';
                timerDiv.style.border = '1px solid #777';
            }
            return;
        }

        if (slaData.noSLA) {
            timerDiv.innerHTML = `Немає SLA`;
            timerDiv.removeAttribute('data-deadline');
            if (!isFlashing) {
                timerDiv.style.backgroundColor = '#555';
                timerDiv.style.color = '#fff';
                timerDiv.style.border = '1px solid #777';
            }
            return;
        }

        const { remainingMs, deadlineDate } = slaData;
        timerDiv.setAttribute('data-deadline', formatDateTime(deadlineDate));

        const isOverdue = remainingMs < 0;
        const absDiff = Math.abs(remainingMs);
        const h = Math.floor(absDiff / (1000 * 60 * 60));
        const m = Math.floor((absDiff % (1000 * 60 * 60)) / (1000 * 60));

        timerDiv.innerHTML = `${isOverdue ? '-' : ''}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

        if (!isFlashing) {
            if (remainingMs <= 2 * 60 * 60 * 1000) {
                timerDiv.style.backgroundColor = '#4a0000';
                timerDiv.style.color = '#ffcccc';
                timerDiv.style.border = '1px solid #ff4d4d';
            } else {
                timerDiv.style.backgroundColor = '#26282f';
                timerDiv.style.color = '#ccffcc';
                timerDiv.style.border = '1px solid #33cc33';
            }
        }
    }

    // --- ЛОГІКА СТОРІНКИ СПИСКУ ЗАЯВОК ---
    function injectListTimers() {
        document.querySelectorAll('.p-panel-header').forEach(panel => {
            if (panel.dataset.slaInjected) return;

            const grid = panel.querySelector('.grid.align-items-start.flex-1');
            if (!grid) return;

            let currentTicketId = null;
            const propName = panel.querySelector('.property-name');

            if (propName) {
                const idMatch = propName.textContent.trim().match(/Заявка #(\d+)/);
                if (idMatch) {
                    currentTicketId = idMatch[1];
                }
            }

            const statusCol = Array.from(grid.children).find(c => c.textContent.includes('Статус'));

            if (statusCol && currentTicketId) {
                statusCol.style.position = 'relative';
                statusCol.style.overflow = 'visible';

                const timerSpan = document.createElement('span');
                timerSpan.className = 'list-sla-timer';
                timerSpan.dataset.ticketId = currentTicketId;

                Object.assign(timerSpan.style, {
                    display: 'none',
                    position: 'absolute',
                    right: '93%',
                    bottom: '5px',
                    marginRight: '4px',
                    zIndex: '10',
                    padding: '2px 5px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    whiteSpace: 'nowrap',
                    border: '1px solid #555'
                });

                statusCol.appendChild(timerSpan);
            }

            panel.dataset.slaInjected = 'true';
        });
    }

    function updateListTimers() {
        document.querySelectorAll('.list-sla-timer').forEach(timerEl => {
            const ticketId = timerEl.dataset.ticketId;
            const storageKey = `slaData_${ticketId}`;
            const savedData = localStorage.getItem(storageKey);

            if (!savedData) {
                timerEl.style.display = 'none';
                return;
            }

            try {
                const { deadline } = JSON.parse(savedData);
                const now = new Date().getTime();
                const remainingMs = deadline - now;
                const isOverdue = remainingMs < 0;
                const absDiff = Math.abs(remainingMs);

                const h = Math.floor(absDiff / (1000 * 60 * 60));
                const m = Math.floor((absDiff % (1000 * 60 * 60)) / (1000 * 60));

                timerEl.textContent = `${isOverdue ? '-' : ''}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                timerEl.style.display = 'inline-block';

                if (remainingMs <= 2 * 60 * 60 * 1000) {
                    timerEl.style.backgroundColor = '#4a0000';
                    timerEl.style.color = '#ffcccc';
                    timerEl.style.borderColor = '#ff4d4d';
                } else {
                    timerEl.style.backgroundColor = '#26282f';
                    timerEl.style.color = '#ccffcc';
                    timerEl.style.borderColor = '#33cc33';
                }
            } catch (e) {
                console.error(`Помилка читання SLA для заявки ${ticketId}`, e);
            }
        });
    }

    // --- СИСТЕМА ОНОВЛЕННЯ ---
    const observer = new MutationObserver(() => {
        if (document.querySelector('.p-panel-header:not([data-sla-injected="true"])')) {
            injectListTimers();
            updateListTimers();
        }

        if (isTicketPage()) {
            const container = document.getElementById('my-sla-container');
            const historyActive = isHistoryTabActive();

            if (container) {
                if (container.dataset.historyActive !== String(historyActive)) {
                    container.dataset.historyActive = String(historyActive);
                    updateTimer();
                }
            } else {
                updateTimer();
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setInterval(() => {
        updateTimer();
        updateListTimers();
    }, 60000);

    injectListTimers();
    updateListTimers();
    updateTimer();

})();
