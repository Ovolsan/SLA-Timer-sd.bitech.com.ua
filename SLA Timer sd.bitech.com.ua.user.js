// ==UserScript==
// @name         SLA Timer sd.bitech.com.ua
// @namespace    http://tampermonkey.net/
// @version      20260612
// @description  Не повноцінний таймер SLA для sd.bitech. Бере час "Час відправки оповіщення:", враховує умову критичності. Якщо є призупинення, то бере його за основу таймера. Деталі в гілці discord.
// @author       Ovolya
// @match        *://sd.bitech.com.ua/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=bitech.com.ua
// @updateURL    https://github.com/Ovolsan/SLA-Timer-sd.bitech.com.ua/raw/refs/heads/main/SLA%20Timer%20sd.bitech.com.ua.user.js
// @downloadURL  https://github.com/Ovolsan/SLA-Timer-sd.bitech.com.ua/raw/refs/heads/main/SLA%20Timer%20sd.bitech.com.ua.user.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const RULES = {
        '1.ЗК-1': { hours: 4, hasExclusion: false },
        '1.ЗК-2': { hours: 8, hasExclusion: false },
        '2.ЗК-1': { hours: 8, hasExclusion: true, exStart: 0, exEnd: 5 },
        '2.ЗК-2': { hours: 16, hasExclusion: true, exStart: 0, exEnd: 5 },
        '3.ЗК-1': { hours: 16, hasExclusion: true, exStart: 20, exEnd: 8 },
        '3.ЗК-2': { hours: 24, hasExclusion: true, exStart: 20, exEnd: 8 }
    };

    function parseDateString(dateStr) {
        if (!dateStr) return null;
        let match = dateStr.match(/(\d{2})[\.\/](\d{2})[\.\/](\d{4})(?:\s+(\d{2}):(\d{2}))?/);
        if (match) {
            return new Date(match[3], match[2] - 1, match[1], match[4] || 0, match[5] || 0, 0);
        }
        let d = new Date(dateStr);
        return isNaN(d.getTime()) ? null : d;
    }

    function parseSourceDate(dateStr) {
        if (!dateStr) return null;
        dateStr = dateStr.trim();

        if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
            let d = new Date(dateStr.replace(' ', 'T'));
            return isNaN(d.getTime()) ? null : d;
        }

        let cleanStr = dateStr.replace(/^[A-Za-z]+,\s*/, '');
        let d = new Date(cleanStr);
        return isNaN(d.getTime()) ? null : d;
    }

    function isInsideExclusion(d, start, end) {
        let h = d.getHours();
        if (start < end) {
            return h >= start && h < end;
        } else {
            return h >= start || h < end;
        }
    }

    function jumpToEndOfExclusion(d, start, end) {
        let h = d.getHours();
        if (start < end) {
            d.setHours(end, 0, 0, 0);
        } else {
            if (h >= start) {
                d.setDate(d.getDate() + 1);
            }
            d.setHours(end, 0, 0, 0);
        }
    }

    function calculateSLAFromDate(startDate, criticality) {
        let rule = RULES[criticality];
        if (!rule) return null;

        let date = new Date(startDate.getTime());
        let msToAdd = rule.hours * 60 * 60 * 1000;

        if (!rule.hasExclusion) {
            return new Date(date.getTime() + msToAdd);
        }

        while (msToAdd > 0) {
            if (isInsideExclusion(date, rule.exStart, rule.exEnd)) {
                jumpToEndOfExclusion(date, rule.exStart, rule.exEnd);
                continue;
            }

            let nextExclusionStart = new Date(date);
            nextExclusionStart.setHours(rule.exStart, 0, 0, 0);

            if (nextExclusionStart <= date) {
                nextExclusionStart.setDate(nextExclusionStart.getDate() + 1);
            }

            let timeToNextExclusion = nextExclusionStart.getTime() - date.getTime();

            if (msToAdd <= timeToNextExclusion) {
                date.setTime(date.getTime() + msToAdd);
                msToAdd = 0;
            } else {
                date.setTime(nextExclusionStart.getTime());
                msToAdd -= timeToNextExclusion;
            }
        }
        return date;
    }

    // ПОЛНОСТЬЮ ОБНОВЛЕННАЯ ФУНКЦИЯ ПОИСКА
    function getTargetTime() {
        const manualInput = document.getElementById('slaDateTimePicker');
        if (manualInput && manualInput.value) {
            let manualDate = parseDateString(manualInput.value);
            if (manualDate) return manualDate;
        }

        let htmlContent = "";
        const iframe = document.querySelector('iframe.app-iframe');

        if (iframe) {
            htmlContent = iframe.getAttribute('srcdoc') || "";
        }

        // Если iframe пуст, берем код из основного документа
        if (!htmlContent) {
            htmlContent = document.body.innerHTML;
        }

        // Превращаем HTML-верстку в чистый текст, сохраняя переносы строк
        let textLines = htmlContent
            .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/td>|<\/tr>/gi, '\n') // Заменяем теги разрыва на \n
            .replace(/<[^>]+>/g, '') // Удаляем все остальные HTML-теги (например <b>, <body>)
            .split('\n')             // Разбиваем текст на массив строк
            .map(line => line.trim()) // Убираем пробелы по краям
            .filter(line => line.length > 0); // Выбрасываем пустые строки

        let dateText = null;
        let criticalityText = null;

        // Проходимся по каждой текстовой строке
        textLines.forEach(line => {
            if (line.includes('Час відправки оповіщення:')) {
                // Отрезаем заголовок и удаляем звездочки (если они есть), чтобы осталась только дата
                dateText = line.split('Час відправки оповіщення:')[1].replace(/\*/g, '').trim();
            }
            if (line.includes('Пріоритет:')) {
                // Ищем критичность в скобках для второго типа заявок
                let match = line.match(/\(([^)]+)\)/);
                if (match) criticalityText = match[1];
            }
        });

        // Если в тексте не было слова "Пріоритет:", берем критичность из радиокнопок (для первой заявки)
        if (!criticalityText) {
            const checkedRadio = document.querySelector('app-radio-button-group[key="criticality"] p-radiobutton[data-p-checked="true"]');
            if (checkedRadio) {
                const label = checkedRadio.closest('label');
                const span = label ? label.querySelector('.radio-button-label-text') : null;
                if (span) criticalityText = span.textContent.trim();
            }
        }

        if (!dateText || !criticalityText) return null;

        const startTime = parseSourceDate(dateText);
        if (!startTime) return null;

        return calculateSLAFromDate(startTime, criticalityText);
    }

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
