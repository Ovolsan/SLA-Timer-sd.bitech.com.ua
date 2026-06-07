// ==UserScript==
// @name         SLA Timer sd.bitech.com.ua
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Таймер SLA з урахуванням Часу відправки оповіщення
// @author       Ovolya
// @match        *://sd.bitech.com.ua/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=bitech.com.ua
// @updateURL    https://github.com/Ovolsan/SLA-Timer-sd.bitech.com.ua/raw/refs/heads/main/SLA%20Timer%20sd.bitech.com.ua.user.js
// @downloadURL  https://github.com/Ovolsan/SLA-Timer-sd.bitech.com.ua/raw/refs/heads/main/SLA%20Timer%20sd.bitech.com.ua.user.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Универсальный парсер даты из инпута (поддерживает формат ДД.ММ.ГГГГ ЧЧ:ММ)
    function parseDateString(dateStr) {
        if (!dateStr) return null;
        let match = dateStr.match(/(\d{2})[\.\/](\d{2})[\.\/](\d{4})(?:\s+(\d{2}):(\d{2}))?/);
        if (match) {
            return new Date(match[3], match[2] - 1, match[1], match[4] || 0, match[5] || 0, 0);
        }
        let d = new Date(dateStr);
        return isNaN(d.getTime()) ? null : d;
    }

    // Логика расчета SLA
    function calculateSLA(startDateStr, criticality) {
        let startDate = new Date(startDateStr.replace(' ', 'T'));
        if (isNaN(startDate.getTime())) return null;

        let hoursToAdd = 0;
        let excludeNight = false;

        if (criticality === '1.ЗК-1') {
            hoursToAdd = 4;
            excludeNight = false;
        } else if (criticality === '2.ЗК-2') {
            hoursToAdd = 16;
            excludeNight = true;
        } else {
            return null;
        }

        let date = new Date(startDate.getTime());
        let msToAdd = hoursToAdd * 60 * 60 * 1000;

        if (!excludeNight) {
            return new Date(date.getTime() + msToAdd);
        }

        while (msToAdd > 0) {
            let h = date.getHours();
            if (h >= 0 && h < 5) {
                date.setHours(5, 0, 0, 0);
            } else {
                let nextMidnight = new Date(date);
                nextMidnight.setHours(24, 0, 0, 0);
                let timeToMidnight = nextMidnight.getTime() - date.getTime();

                if (msToAdd <= timeToMidnight) {
                    date.setTime(date.getTime() + msToAdd);
                    msToAdd = 0;
                } else {
                    date.setTime(nextMidnight.getTime());
                    msToAdd -= timeToMidnight;
                }
            }
        }
        return date;
    }

    // Функция для определения целевого времени
    function getTargetTime() {
        const manualInput = document.getElementById('slaDateTimePicker');
        if (manualInput && manualInput.value) {
            let manualDate = parseDateString(manualInput.value);
            if (manualDate) return manualDate;
        }

        const iframe = document.querySelector('iframe.app-iframe');
        if (!iframe) return null;

        const srcdoc = iframe.getAttribute('srcdoc');
        if (!srcdoc) return null;

        // Измененная строка поиска: теперь ищет "Час відправки оповіщення:"
        const timeMatch = srcdoc.match(/\*Час відправки оповіщення:\*\s*(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})/);
        if (!timeMatch) return null;
        const startTimeStr = timeMatch[1];

        const checkedRadio = document.querySelector('app-radio-button-group[key="criticality"] p-radiobutton[data-p-checked="true"]');
        if (!checkedRadio) return null;

        const label = checkedRadio.closest('label');
        if (!label) return null;

        const span = label.querySelector('.radio-button-label-text');
        const criticality = span ? span.textContent.trim() : null;

        return calculateSLA(startTimeStr, criticality);
    }

    // Создание UI таймера в DOM
    function getOrCreateTimerUI() {
        let timerDiv = document.getElementById('my-sla-timer');
        if (!timerDiv) {
            timerDiv = document.createElement('div');
            timerDiv.id = 'my-sla-timer';

            Object.assign(timerDiv.style, {
                position: 'fixed',
                top: '45px',
                right: '10px',
                zIndex: 9999,
                cursor: 'pointer',
                fontWeight: 'bold',
                padding: '6px 12px',
                borderRadius: '6px',
                display: 'inline-block',
                transition: '0.3s',
                fontSize: '13px',
                userSelect: 'none',
                boxShadow: '0 2px 5px rgba(0,0,0,0.3)'
            });

            timerDiv.title = 'Натисніть, щоб скопіювати цільовий час';

            // При клике копируем дату
            timerDiv.addEventListener('click', () => {
                const targetTime = getTargetTime();
                if (targetTime) {
                    const d = String(targetTime.getDate()).padStart(2, '0');
                    const m = String(targetTime.getMonth() + 1).padStart(2, '0');
                    const y = targetTime.getFullYear();
                    const h = String(targetTime.getHours()).padStart(2, '0');
                    const min = String(targetTime.getMinutes()).padStart(2, '0');

                    const formattedDate = `${d}.${m}.${y} ${h}:${min}`;

                    navigator.clipboard.writeText(formattedDate).then(() => {
                        const originalText = timerDiv.innerHTML;
                        timerDiv.innerHTML = "Скопійовано!";
                        setTimeout(() => { timerDiv.innerHTML = originalText; }, 1000);
                    });
                }
            });

            document.body.appendChild(timerDiv);
        }
        return timerDiv;
    }

    // Обновление значений таймера
    function updateTimer() {
        const targetDate = getTargetTime();

        if (!targetDate) {
            const existingTimer = document.getElementById('my-sla-timer');
            if (existingTimer) existingTimer.style.display = 'none';
            return;
        }

        const timerDiv = getOrCreateTimerUI();
        timerDiv.style.display = 'inline-block';

        const now = new Date();
        const diffMs = targetDate.getTime() - now.getTime();

        const isOverdue = diffMs < 0;
        const absDiff = Math.abs(diffMs);

        const h = Math.floor(absDiff / (1000 * 60 * 60));
        const m = Math.floor((absDiff % (1000 * 60 * 60)) / (1000 * 60));

        const sign = isOverdue ? '-' : '';
        const timeString = `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

        timerDiv.innerHTML = `SLA: ${timeString}`;

        if (isOverdue) {
            timerDiv.style.backgroundColor = '#4a0000';
            timerDiv.style.color = '#ffcccc';
            timerDiv.style.border = '1px solid #ff4d4d';
        } else {
            timerDiv.style.backgroundColor = '#26282f';
            timerDiv.style.color = '#ccffcc';
            timerDiv.style.border = '1px solid #33cc33';
        }
    }

    setInterval(updateTimer, 1000);

})();
