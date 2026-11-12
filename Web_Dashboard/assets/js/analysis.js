/*
 * "What the data tells us": the five questions, answered from the hourly
 * summary that the database works out (get_hourly_summary).
 */
(function (FlowState) {
    'use strict';

    const { lib, config, ui, charts } = FlowState;
    const $ = (id) => document.getElementById(id);

    const L = (value) => `${lib.formatLiters(value)} L`;
    const percent = (value) => `${Math.round(value)}%`;

    function answer(question, headline, detail, tone) {
        ui.setLive(`${question}Answer`, headline);
        ui.setText(`${question}Detail`, detail);
        $(question).dataset.tone = tone || 'neutral';
    }

    function renderLoss(loss) {
        if (loss.weekUsed <= 0) {
            answer('q1', 'No water measured yet',
                'Once water has flowed past both sensors, this shows how much went missing between the tank and the tap.');
            return;
        }
        const share = loss.sharePercent;
        const today = `Today: ${L(loss.todayLost)} lost of ${L(loss.todayUsed)} used.`;
        if (share < config.device.normalBelowPercent) {
            answer('q1', `No leak: ${L(loss.weekLost)} (${share.toFixed(1)}%) in 7 days`,
                `Up to ${config.device.normalBelowPercent}% is normal sensor error, so there is no sign of a leak. ${today}`, 'good');
            return;
        }
        const severe = share >= config.device.criticalFromPercent
            ? ` That is above ${config.device.criticalFromPercent}%, the level at which the ESP32 closes the valve.` : '';
        answer('q1', `Yes: ${L(loss.weekLost)} lost in 7 days`,
            `${share.toFixed(1)}% of the ${L(loss.weekUsed)} that left the tank never reached the tap.${severe} ${today}`,
            share >= config.device.criticalFromPercent ? 'critical' : 'warning');
    }

    function renderPeak(peak) {
        if (peak.peakHour === null) {
            answer('q2', 'Not enough data yet', 'The busiest hours appear once water has flowed.');
            return;
        }
        const basis = peak.basedOnToday
            ? 'so far today (an average needs a full day of readings)'
            : `on an average day (${peak.daysAveraged} day${peak.daysAveraged === 1 ? '' : 's'} of readings)`;
        const busiest = peak.busiestDay
            ? ` The busiest day this week was ${lib.shortDay(peak.busiestDay.dateKey)} with ${L(peak.busiestDay.used)}.` : '';
        answer('q2', `Most between ${lib.hourRange(peak.peakHour)}`, `${L(peak.peakLiters)} flows in that hour ${basis}.${busiest}`);
    }

    function renderUnusual(unusual, now, deviceStatus) {
        const flagged = /anomaly/i.test(deviceStatus || '') ? ' The ESP32 has flagged this hour as unusual too.' : '';
        if (unusual.state === 'learning') {
            answer('q3', 'Still learning what is normal',
                `A normal day needs ${config.device.baselineDays} days of readings. ${unusual.baselineDays} of ${config.device.baselineDays} so far. Used today: ${L(unusual.todaySoFar)}.${flagged}`);
            return;
        }
        const time = `${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`;
        const comparison = `By ${time} today ${L(unusual.todaySoFar)} has been used; on a normal day it is ${L(unusual.normalSoFar)} by this time.`;
        if (unusual.ratio === null) {
            answer('q3', unusual.state === 'high' ? 'Yes: more than normal' : 'No: close to normal', `${comparison}${flagged}`,
                unusual.state === 'high' ? 'warning' : 'good');
        } else if (unusual.state === 'high') {
            answer('q3', `Yes: ${percent((unusual.ratio - 1) * 100)} more than normal`, `${comparison}${flagged}`, 'warning');
        } else if (unusual.state === 'low') {
            answer('q3', `Yes, but lower: ${percent((1 - unusual.ratio) * 100)} less than normal`, comparison, 'neutral');
        } else {
            const change = (unusual.ratio - 1) * 100;
            answer('q3', 'No: close to normal', `${comparison} (${change >= 0 ? '+' : '−'}${percent(Math.abs(change))}).${flagged}`, 'good');
        }
    }

    function renderNight(night) {
        const last = night.lastNight;
        const nightHours = `${config.device.nightStartHour}–${config.device.nightEndHour} AM`;
        const record = `${night.nightsWithFlow} of the last ${night.nightsWithData} night${night.nightsWithData === 1 ? '' : 's'} with readings had flow.`;
        const when = last && last.inProgress ? 'tonight so far' : 'last night';
        if (!last || last.state === 'no-data') {
            answer('q4', `No readings from ${when}`, `The ESP32 was not sending between ${nightHours}. ${night.nightsWithData ? record : ''}`.trim());
        } else if (last.state === 'dry') {
            answer('q4', `No: nothing flowed ${when}`, `Between ${nightHours} sensor 1 saw no flow. ${record}`, 'good');
        } else {
            const minutes = Math.max(1, Math.round(last.minutes));
            const valve = last.state === 'critical' ? ' After 10 minutes the ESP32 closes the valve.' : '';
            answer('q4', `Yes: about ${minutes} min of flow ${when}`,
                `${L(last.used)} between ${nightHours}. Flow while everyone sleeps usually means a dripping tap, a running toilet or a hidden leak.${valve} ${record}`,
                last.state === 'flow' ? 'warning' : 'critical');
        }
        renderNightStrip(night.nights);
    }

    function renderNightStrip(nights) {
        const longest = Math.max(10, ...nights.map((entry) => entry.minutes));
        const cells = nights.map((entry) => {
            const cell = document.createElement('div');
            cell.className = 'night';
            cell.dataset.state = entry.state;
            const label = lib.shortDay(entry.dateKey).split(' ');
            const bar = document.createElement('span');
            bar.className = 'night-bar';
            bar.style.setProperty('--fill', entry.state === 'no-data' ? '0' : (entry.minutes / longest).toFixed(3));
            const value = document.createElement('span');
            value.className = 'night-value';
            value.textContent = entry.state === 'no-data' ? 'no data' : entry.state === 'dry' ? 'dry' : `${Math.max(1, Math.round(entry.minutes))} min`;
            const day = document.createElement('span');
            day.className = 'night-day';
            day.textContent = `${label[0]} ${label[1]}`;
            cell.title = `${lib.shortDay(entry.dateKey)}, ${config.device.nightStartHour}–${config.device.nightEndHour} AM: ${value.textContent}`;
            cell.append(bar, value, day);
            return cell;
        });
        $('nightStrip').replaceChildren(...cells);
    }

    function renderCost(cost, loss) {
        const tariff = config.getTariff();
        ui.setLive('costToday', lib.formatRupees(cost.todayCost));
        ui.setLive('costMonth', cost.basisDays ? lib.formatRupees(cost.monthCost) : '--');
        ui.setLive('costLeaks', cost.basisDays ? lib.formatRupees(cost.monthLeakCost) : '--');
        if (!cost.basisDays) {
            answer('q5', `${lib.formatRupees(cost.todayCost)} so far`, 'A monthly estimate appears once there is a day of readings.');
            return;
        }
        const basis = cost.basisDays === 1 ? 'one day' : `the last ${cost.basisDays} days`;
        answer('q5', `About ${lib.formatRupees(cost.monthCost)} a month`,
            `At ₹${tariff} per 1,000 L and ${L(cost.dailyUsed)} a day (from ${basis}). Leaks account for ${lib.formatRupees(cost.monthLeakCost)} of that. Today so far: ${lib.formatRupees(cost.todayCost)}${loss.todayLost > 0 ? `, of which leaks ${lib.formatRupees(cost.todayLeakCost)}` : ''}.`);
    }

    function readingsInLastDay(rows, nowMs) {
        return rows
            .filter((row) => (lib.toTime(row.hour_start) ?? 0) >= nowMs - 86400000)
            .reduce((total, row) => total + Math.max(0, lib.toNumber(row.readings)), 0);
    }

    /**
     * @param {object[]} rows get_hourly_summary rows
     * @param {{nowMs: number, deviceStatus: string}} context
     */
    function render(rows, context) {
        const nowMs = context.nowMs;
        const now = lib.zonedParts(nowMs, config.device.timeZone);
        const days = lib.groupByDay(rows, config.device.timeZone);
        const dayCount = config.settings.analysisDays;

        const loss = lib.answerLoss(days, now.dateKey, dayCount);
        const peak = lib.answerPeak(days, now.dateKey, dayCount);
        const unusual = lib.answerUnusual(days, now.dateKey, now, {
            minDays: config.device.baselineDays, ratio: config.device.unusualRatio, dayCount
        });
        const night = lib.answerNight(days, now.dateKey, now, {
            startHour: config.device.nightStartHour,
            endHour: config.device.nightEndHour,
            uploadIntervalSeconds: config.device.uploadIntervalMs / 1000,
            dayCount
        });
        const cost = lib.answerCost(loss, config.getTariff());

        renderLoss(loss);
        renderPeak(peak);
        renderUnusual(unusual, now, context.deviceStatus);
        renderNight(night);
        renderCost(cost, loss);

        const empty = 'No readings stored yet.';
        charts.renderLoss(loss, empty);
        charts.renderHours(peak, empty);
        charts.renderToday(unusual, empty);

        const stored = readingsInLastDay(rows, nowMs);
        ui.setText('exportRecordCount', stored.toLocaleString('en-IN'));
        ui.setLive('stageStore', `${stored.toLocaleString('en-IN')} readings in the last 24 h`);
        ui.setLive('stageAnalyze', unusual.state === 'learning'
            ? `5 questions · learning normal use (${unusual.baselineDays} of ${config.device.baselineDays} days)`
            : '5 questions answered below');
        ui.setText('analysisUpdated', `Updated ${new Date(nowMs).toLocaleTimeString('en-IN')}.`);
        return { loss, peak, unusual, night, cost };
    }

    function renderUnavailable(message) {
        ['q1', 'q2', 'q3', 'q4', 'q5'].forEach((question) => answer(question, message, ''));
        charts.renderLoss(null, message);
        charts.renderHours(null, message);
        charts.renderToday(null, message);
        $('nightStrip').replaceChildren();
        ui.setText('stageStore', '--');
        ui.setText('stageAnalyze', '--');
    }

    function initTariff(onChange) {
        const input = $('tariffInput');
        input.value = String(config.getTariff());
        input.addEventListener('change', () => {
            if (!config.setTariff(input.value)) {
                ui.toast('Enter a tariff between 0 and 10,000 rupees per 1,000 L.', 'warning');
                input.value = String(config.getTariff());
                return;
            }
            onChange();
        });
    }

    FlowState.analysis = { render, renderUnavailable, initTariff };
})(window.FlowState = window.FlowState || {});
