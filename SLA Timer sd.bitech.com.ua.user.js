// ==UserScript==
// @name         SLA Timer sd.bitech.com.ua
// @namespace    http://tampermonkey.net/
// @version      20260713
// @description  Таймер SLA для sd.bitech в нижньому лівому куті блоку історія. Вираховує час в блоці "історія", враховує критичність та всі призупинення. При кліці на таймер копіює час завершення SLA. За дві години до завершення таймера інтерфейс стає червоним. Деталі в гілці discord.
// @author       Ovolya
// @match        *://sd.bitech.com.ua/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=bitech.com.ua
// @updateURL    https://github.com/Ovolsan/SLA-Timer-sd.bitech.com.ua/raw/refs/heads/main/SLA%20Timer%20sd.bitech.com.ua.user.js
// @downloadURL  https://github.com/Ovolsan/SLA-Timer-sd.bitech.com.ua/raw/refs/heads/main/SLA%20Timer%20sd.bitech.com.ua.user.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Лимиты SLA по критичности (в часах)
    const SLA_LIMITS = {
        '1.ЗК-1': 4,
        '1.ЗК-2': 8,
        '2.ЗК-1': 8,
        '2.ЗК-2': 16,
        '3.ЗК-1': 16,
        '3.ЗК-2': 24
    };

    // Проверка, активна ли вкладка истории
    function isHistoryTabActive() {
        const historyPanel = document.querySelector('p-tabpanel[id*="tabpanel_requests_hstr"]');
        if (!historyPanel) return false;

        // Вкладка активна, если её размеры больше нуля (не скрыта через display: none)
        const rect = historyPanel.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    // Парсер дат формата DD.MM.YYYY HH:MM
    function parseDateTime(str) {
        if (!str) return null;
        let match = str.trim().match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
        if (match) {
            return new Date(match[3], match[2] - 1, match[1], match[4], match[5], 0);
        }
        return null;
    }

    // Форматирование даты в DD.MM.YYYY HH:MM
    function formatDateTime(date) {
        if (!date) return '';
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${day}.${month}.${year} ${hours}:${minutes}`;
    }

    // Чтение истории изменений напрямую из сетки интерфейса
    function parseHistoryData() {
        const historyPanel = document.querySelector('p-tabpanel[id*="tabpanel_requests_hstr"]');
        if (!historyPanel) return null;

        let creationTime = null;
        let events = [];

        // Ищем все строки (события) в таблице истории
        const rows = historyPanel.querySelectorAll('tbody.p-datatable-tbody > tr');

        rows.forEach(row => {
            let currentEventTime = null;

            // Время возникновения записи (извлекается из тега <small>)
            const timeEl = row.querySelector('small');
            if (timeEl) {
                let dateMatch = timeEl.textContent.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
                if (dateMatch) {
                    currentEventTime = parseDateTime(dateMatch[0]);
                }
            }

            // Находим все блоки-названия полей (класс col-4)
            const keyCols = row.querySelectorAll('.md\\:col-4');

            keyCols.forEach(keyCol => {
                // Значение поля всегда лежит в соседнем блоке
                const valCol = keyCol.nextElementSibling;
                if (!valCol || !valCol.classList.contains('md:col-8')) return;

                let keyText = keyCol.textContent.trim();
                let valText = valCol.textContent.trim();

                // Ищем время создания
                if (keyText === 'Дата й час створення') {
                    let match = valText.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
                    if (match) creationTime = parseDateTime(match[0]);
                }

                // Ищем смену критичности
                if (keyText === 'Критичність') {
                    let critMatch = valText.match(/(1|2|3)\.ЗК\-(1|2)/);
                    if (critMatch) {
                        events.push({
                            time: currentEventTime || creationTime,
                            type: 'criticality',
                            value: critMatch[0]
                        });
                    }
                }

                // Ищем приостановку
                if (keyText.includes('SLA призупинено до')) {
                    let pauseMatch = valText.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
                    if (pauseMatch && currentEventTime) {
                        events.push({
                            time: currentEventTime,
                            type: 'suspension',
                            suspendedTo: parseDateTime(pauseMatch[0])
                        });
                    }
                }
            });
        });

        if (!creationTime) return null;
        return { creationTime, events };
    }

    // Расчет SLA с учетом пауз
    function calculateSLA() {
        const history = parseHistoryData();
        if (!history) return null;

        const { creationTime, events } = history;
        const now = new Date();

        let activeCriticality = null;
        let suspensions = [];

        // Упорядочиваем по времени
        events.sort((a, b) => a.time - b.time);

        events.forEach(ev => {
            if (ev.type === 'criticality') {
                activeCriticality = ev.value;
            }
            if (ev.type === 'suspension' && ev.suspendedTo) {
                suspensions.push({ start: ev.time, end: ev.suspendedTo });
            }
        });

        if (!activeCriticality) {
            activeCriticality = '2.ЗК-2';
        }

        const limitHours = SLA_LIMITS[activeCriticality] || 8;
        const slaLimitMs = limitHours * 60 * 60 * 1000;

        let totalSuspensionMs = 0;

        // Разбор сложных цепей пауз
        if (suspensions.length > 0) {
            suspensions.sort((a, b) => a.start - b.start);
            let currentChain = { start: suspensions[0].start, end: suspensions[0].end };

            for (let i = 1; i < suspensions.length; i++) {
                let next = suspensions[i];
                if (next.start <= currentChain.end) {
                    if (next.end > currentChain.end) {
                        currentChain.end = next.end; // Продление
                    }
                } else {
                    totalSuspensionMs += (currentChain.end - currentChain.start); // Обрыв цепочки
                    currentChain = { start: next.start, end: next.end }; // Новая цепочка
                }
            }
            totalSuspensionMs += (currentChain.end - currentChain.start); // Завершение финальной цепи
        }

        const elapsedMs = now.getTime() - creationTime.getTime();
        const remainingMs = slaLimitMs - elapsedMs + totalSuspensionMs;

        // Точная дата дедлайна SLA
        const deadlineDate = new Date(creationTime.getTime() + slaLimitMs + totalSuspensionMs);

        return { remainingMs, deadlineDate };
    }

    // Отрисовка UI
    function getOrCreateTimerUI() {
        let timerDiv = document.getElementById('my-sla-timer');
        if (!timerDiv) {
            timerDiv = document.createElement('div');
            timerDiv.id = 'my-sla-timer';

            Object.assign(timerDiv.style, {
                position: 'fixed',
                bottom: '10px', // Левый нижний угол
                left: '10px',   // Левый нижний угол
                zIndex: 9999,
                cursor: 'pointer',
                fontWeight: 'bold',
                padding: '6px 12px',
                borderRadius: '6px',
                display: 'none', // Изначально скрыт, пока не подтвердится вкладка истории
                transition: 'background-color 0.15s ease',
                fontSize: '13px',
                userSelect: 'none',
                boxShadow: '0 2px 5px rgba(0,0,0,0.3)'
            });

            // Копирование ДАТЫ И ВРЕМЕНИ ДЕДЛАЙНА в буфер обмена по клику
            timerDiv.addEventListener('click', () => {
                const deadlineText = timerDiv.getAttribute('data-deadline');
                if (!deadlineText) return;

                navigator.clipboard.writeText(deadlineText).then(() => {
                    const originalBg = timerDiv.style.backgroundColor;
                    const originalBorder = timerDiv.style.borderColor;
                    const originalColor = timerDiv.style.color;

                    // Вспышка зеленым цветом при успешном копировании
                    timerDiv.style.backgroundColor = '#1e7e34';
                    timerDiv.style.borderColor = '#1e7e34';
                    timerDiv.style.color = '#ffffff';

                    setTimeout(() => {
                        timerDiv.style.backgroundColor = originalBg;
                        timerDiv.style.borderColor = originalBorder;
                        timerDiv.style.color = originalColor;
                    }, 300);
                }).catch(err => {
                    console.error('Не удалось скопировать текст: ', err);
                });
            });

            document.body.appendChild(timerDiv);
        }
        return timerDiv;
    }

    // Цикл таймера
    function updateTimer() {
        const timerDiv = getOrCreateTimerUI();

        // Если мы не на вкладке истории, полностью скрываем таймер
        if (!isHistoryTabActive()) {
            timerDiv.style.display = 'none';
            return;
        }

        // Показываем таймер, если вкладка активна
        timerDiv.style.display = 'inline-block';

        const slaData = calculateSLA();

        // Если цвет временно изменен (активна анимация копирования) — не прерываем её стилями обновления
        const isFlashing = timerDiv.style.backgroundColor === 'rgb(30, 126, 52)';

        if (slaData === null) {
            timerDiv.innerHTML = `Відкрийте історію`;
            timerDiv.removeAttribute('data-deadline');
            if (!isFlashing) {
                timerDiv.style.backgroundColor = '#555';
                timerDiv.style.color = '#fff';
                timerDiv.style.border = '1px solid #777';
            }
            return;
        }

        const { remainingMs, deadlineDate } = slaData;

        // Записываем форматированную дату дедлайна в data-атрибут для копирования
        timerDiv.setAttribute('data-deadline', formatDateTime(deadlineDate));

        const isOverdue = remainingMs < 0;
        const absDiff = Math.abs(remainingMs);

        const h = Math.floor(absDiff / (1000 * 60 * 60));
        const m = Math.floor((absDiff % (1000 * 60 * 60)) / (1000 * 60));

        const sign = isOverdue ? '-' : '';
        const timeString = `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

        timerDiv.innerHTML = timeString;

        if (!isFlashing) {
            // Меняет цвет за 2 часа (7200000 мс) до конца SLA
            const twoHoursMs = 2 * 60 * 60 * 1000;
            if (remainingMs <= twoHoursMs) {
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

    setInterval(updateTimer, 1000);

})();
