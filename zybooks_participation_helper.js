
(async () => {
  'use strict';

  if (location.hostname !== 'learn.zybooks.com') {
    console.warn('Open learn.zybooks.com before running the helper.');
    return;
  }

  window.zyPA?.stop?.();
  document.getElementById('zy-pa-helper')?.remove();

  const OPT = {
    clickDelayMs: 550,
    loopDelayMs: 1100,
    maxRuntimeMs: 5 * 60 * 1000,
    maxDropsPerActivity: 90,
    stalledMs: 25000
  };
  const route = location.pathname + location.search;
  const storageKey = 'zyPA-v3-failures:' + route;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clean = value => (value || '').replace(/\s+/g, ' ').trim();
  const all = (root, selector) => Array.from(root.querySelectorAll(selector));

  function loadFailures() {
    try {
      const obj = JSON.parse(sessionStorage.getItem(storageKey) || '{}');
      return {
        choices: obj.choices && typeof obj.choices === 'object' ? obj.choices : {},
        matching: obj.matching && typeof obj.matching === 'object' ? obj.matching : {}
      };
    } catch (_) {
      return { choices: {}, matching: {} };
    }
  }
  const failures = loadFailures();
  function saveFailures() {
    try { sessionStorage.setItem(storageKey, JSON.stringify(failures)); }
    catch (_) { /* Browsers may disable storage. */ }
  }
  function failedBefore(category, key, value) {
    return Array.isArray(failures[category][key]) &&
      failures[category][key].includes(value);
  }
  function rememberFailure(category, key, value) {
    const list = failures[category][key] ??= [];
    if (!list.includes(value)) {
      list.push(value);
      saveFailures();
    }
  }

  const state = {
    running: true,
    startedAt: Date.now(),
    lastActionAt: Date.now(),
    actions: 0,
    drops: 0,
    skippedActivities: new Set(),
    skippedQuestions: new WeakSet(),
    skippedQuestionCount: 0,
    skippedTargets: new WeakSet(),
    skippedTargetCount: 0,
    animationStarted: new WeakSet(),
    shortSubmitted: new WeakSet(),
    dragTriedThisRun: new Set(),
    manualNeeded: new Set()
  };

  const panel = document.createElement('section');
  panel.id = 'zy-pa-helper';
  Object.assign(panel.style, {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
    background: '#192839', color: 'white', padding: '14px 16px',
    borderRadius: '10px', boxShadow: '0 4px 22px #0005',
    width: '290px', maxWidth: 'calc(100vw - 32px)',
    font: '13px system-ui', lineHeight: '1.45'
  });
  panel.innerHTML = `
    <strong>zyBooks participation helper v3</strong>
    <div data-status style="white-space:pre-line;margin:9px 0">Checking completion…</div>
    <button type="button" data-stop style="cursor:pointer;padding:5px 12px">Stop</button>
  `;
  document.body.appendChild(panel);
  const statusElement = panel.querySelector('[data-status]');
  const stopButton = panel.querySelector('[data-stop]');
  function status(message) { statusElement.textContent = message; }
  function stop(message = 'Stopped.') {
    state.running = false;
    status(message);
    stopButton.disabled = true;
  }
  function action() {
    state.actions++;
    state.lastActionAt = Date.now();
  }
  function summary() {
    const activities = getActivities();
    return {
      running: state.running,
      activities: activities.length,
      confirmedComplete: activities.filter(activityComplete).length,
      verifiedActivitySkips: state.skippedActivities.size,
      verifiedQuestionSkips: state.skippedQuestionCount,
      verifiedMatchingRowSkips: state.skippedTargetCount,
      clicksAndDrops: state.actions,
      matchingDrops: state.drops,
      reviewActivities: [...state.manualNeeded]
    };
  }
  window.zyPA = {
    stop,
    summary,
    clearHistory() {
      failures.choices = {};
      failures.matching = {};
      try { sessionStorage.removeItem(storageKey); } catch (_) {}
      console.info('Saved incorrect attempts cleared; rerun the script if needed.');
    }
  };
  stopButton.addEventListener('click', () => stop());

  const getActivities = () => all(document,
    '.interactive-activity-container.participation'
  );
  const getTargets = activity => all(activity,
    '.draggable-object-target.definition-drag-container'
  );
  const getTiles = activity => all(activity, '.draggable-object');

  function activityComplete(activity) {
    const explicitDone = Boolean(activity.querySelector('[aria-label="Activity completed"]'));
    const chevrons = all(activity, '.zb-chevron');
    const markedDone = explicitDone || (chevrons.length > 0 &&
      chevrons.every(chevron => chevron.classList.contains('filled')));
    if (!markedDone) return false;

    // Do not blindly trust the completion badge if live content contradicts it.
    const questions = all(activity, '.multiple-choice-question, .short-answer-question');
    if (questions.some(q => feedbackIncorrect(q) && !feedbackCorrect(q))) return false;
    const targets = getTargets(activity);
    if (targets.some(t => !targetPopulated(t) ||
      (targetIncorrect(t) && !targetCorrect(t)))) return false;
    return true;
  }

  function feedbackCorrect(scope) {
    if (scope.querySelector('[aria-label="Question completed"]')) return true;
    if (all(scope, '.zb-explanation.correct, .message.correct')
      .some(node => node.getClientRects().length > 0)) return true;
    return all(scope, '.message').some(node =>
      node.getClientRects().length > 0 && /^correct[!.]?$/i.test(clean(node.textContent))
    );
  }
  function feedbackIncorrect(scope) {
    if (scope.querySelector('.zb-explanation.incorrect, .message.incorrect')) return true;
    return all(scope, '.message, .zb-explanation').some(node =>
      /^(incorrect|try again|not quite|wrong)\b/i.test(clean(node.textContent))
    );
  }
  function noteCorrectQuestion(question) {
    if (!state.skippedQuestions.has(question)) {
      state.skippedQuestions.add(question);
      state.skippedQuestionCount++;
    }
  }
  function noteCorrectTarget(target) {
    if (!state.skippedTargets.has(target)) {
      state.skippedTargets.add(target);
      state.skippedTargetCount++;
    }
  }
  function markReview(id, reason) {
    state.manualNeeded.add(id);
    console.debug('[zyPA]', id, reason);
  }

  function hash(str) {
    // Stable compact fingerprint for question text and options.
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  async function doMultipleChoice(activity, activityNo) {
    const questions = all(activity, '.multiple-choice-question');
    for (const [qi, question] of questions.entries()) {
      if (!state.running || activityComplete(activity)) return;
      if (feedbackCorrect(question)) {
        noteCorrectQuestion(question);
        continue; // Verified correct, no duplicate clicking.
      }
      const inputs = all(question, 'input[type="radio"]').filter(input => !input.disabled);
      if (!inputs.length) continue;

      // Use only stable option/prompt text, excluding changing feedback.
      const prompt = clean(question.querySelector(
        '.question-text, .question-stem, .question-prompt'
      )?.textContent);
      const options = inputs.map(input => clean(
        input.closest('label')?.textContent || input.parentElement?.textContent || input.value
      ));
      const signature = hash(JSON.stringify([prompt, options]));
      const key = `${activityNo}:${qi}:${signature}`;
      const selected = inputs.findIndex(input => input.checked);
      // Capture existing wrong answers, including answers chosen in a prior run.
      if (selected !== -1 && feedbackIncorrect(question)) {
        rememberFailure('choices', key, selected);
      } else if (selected !== -1 && !feedbackIncorrect(question)) {
        // Selected but no success/failure feedback: don't blindly overwrite it.
        markReview(activityNo, 'Selected answer has no recognizable feedback.');
        continue;
      }
      const nextIndex = inputs.findIndex((_, index) =>
        !failedBefore('choices', key, index)
      );
      if (nextIndex === -1) {
        markReview(activityNo, 'All recognized answer choices were tried.');
        continue;
      }
      const choice = inputs[nextIndex];
      choice.click();
      action();
      await sleep(OPT.clickDelayMs);

      if (feedbackCorrect(question)) {
        noteCorrectQuestion(question);
      } else if (feedbackIncorrect(question)) {
        rememberFailure('choices', key, nextIndex);
      } else {
        markReview(activityNo, 'Answer feedback was not detected after click.');
      }
    }
  }

  function nativeSetValue(input, value) {
    const proto = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function doShortAnswer(activity, activityNo) {
    const questions = all(activity, '.short-answer-question');
    for (const question of questions) {
      if (!state.running || activityComplete(activity)) return;
      if (feedbackCorrect(question)) {
        noteCorrectQuestion(question);
        continue;
      }
      if (state.shortSubmitted.has(question)) continue;
      const input = question.querySelector('textarea, input[type="text"]');
      const check = question.querySelector('button.check-button');
      const show = question.querySelector('button.show-answer-button');
      if (!input || !check) continue;

      let revealed = question.querySelector('.forfeit-answer');
      if (!revealed && show && !show.disabled) {
        show.click(); action();
        await sleep(250);
        revealed = question.querySelector('.forfeit-answer');
        if (!revealed && !show.disabled) {
          show.click(); action();
          await sleep(250);
          revealed = question.querySelector('.forfeit-answer');
        }
      }
      if (!revealed) {
        markReview(activityNo, 'No revealed short answer is available.');
        continue;
      }
      const answer = clean(revealed.textContent);
      if (!answer) continue;
      // If this already has the correct text but is not marked correct,
      // submit only once per run and wait for explicit feedback.
      nativeSetValue(input, answer);
      state.shortSubmitted.add(question);
      await sleep(150);
      if (!check.disabled) {
        check.click(); action();
        await sleep(OPT.clickDelayMs);
      }
      if (feedbackCorrect(question)) noteCorrectQuestion(question);
      else markReview(activityNo, 'Short answer not verified correct yet.');
    }
  }

  function isVisible(element) {
    return Boolean(element?.isConnected && element.getClientRects().length);
  }
  function doAnimation(activity) {
    if (activityComplete(activity)) return;
    const controls = all(activity, '.animation-controls');
    if (!controls.length) return;
    for (const control of controls) {
      if (control.querySelector('[aria-label="Play again"]')) continue;
      for (const speed of all(control, '.speed-control input[type="checkbox"]')) {
        if (isVisible(speed) && !speed.checked && !speed.disabled) {
          speed.click(); action();
        }
      }
      const play = control.querySelector('button[aria-label="Play"]');
      const pause = control.querySelector('button[aria-label="Pause"]');
      if (pause && isVisible(pause)) continue; // Already running.
      if (play && isVisible(play) && !play.disabled) {
        play.click(); action();
        continue;
      }
      const start = control.querySelector('button.start-button');
      if (start && isVisible(start) && !start.disabled &&
          !state.animationStarted.has(start)) {
        state.animationStarted.add(start);
        start.click(); action();
      }
    }
  }

  function rowOf(target) { return target.parentElement || target; }
  function targetPopulated(target) {
    return Boolean(target.querySelector('.term-bucket.populated, .draggable-object'));
  }
  function targetCorrect(target) {
    if (!targetPopulated(target)) return false;
    const row = rowOf(target);
    return target.classList.contains('correct') ||
      Boolean(target.querySelector('.correct')) ||
      Boolean(row.querySelector('.correct, [aria-label="Question completed"]')) ||
      all(row, '.message').some(node => /^correct[!.]?$/i.test(clean(node.textContent)));
  }
  function targetIncorrect(target) {
    const row = rowOf(target);
    return Boolean(row.querySelector('.incorrect')) ||
      all(row, '.message').some(node => /^(incorrect|try again|wrong)\b/i.test(clean(node.textContent)));
  }

  function simulateDrag(source, target) {
    if (!source?.isConnected || !target?.isConnected) return false;
    const transfer = typeof DataTransfer === 'function'
      ? new DataTransfer() : null;
    const box = target.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    function emit(element, name) {
      let event;
      try {
        event = new DragEvent(name, {
          bubbles: true, cancelable: true, dataTransfer: transfer,
          clientX: x, clientY: y
        });
      } catch (_) {
        event = new CustomEvent(name, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: transfer });
      }
      element.dispatchEvent(event);
    }
    emit(source, 'dragstart');
    emit(target, 'dragenter');
    emit(target, 'dragover');
    emit(target, 'drop');
    emit(source, 'dragend');
    return true;
  }

  async function doMatching(activity, activityNo) {
    const targets = getTargets(activity);
    if (!targets.length || activityComplete(activity)) return;
    for (const target of targets) {
      if (targetCorrect(target)) noteCorrectTarget(target);
    }

    // Include unresolved tiles left in *wrong* boxes from earlier runs.
    // Only tiles in a verified-correct target are excluded.
    const unresolvedTiles = getTiles(activity).filter(tile => {
      const target = tile.closest('.draggable-object-target.definition-drag-container');
      return !target || !targetCorrect(target);
    }).sort((a, b) => {
      const inWrongBox = tile => Number(Boolean(tile.closest(
        '.draggable-object-target.definition-drag-container'
      )));
      return inWrongBox(b) - inWrongBox(a);
    });
    if (!unresolvedTiles.length) return;
    const names = unresolvedTiles.map(tile => clean(tile.textContent)).filter(Boolean);
    let dropsThisActivity = 0;

    for (const tileName of names) {
      if (!state.running || activityComplete(activity)) return;
      const findSource = () => getTiles(activity).find(tile => {
        const box = tile.closest('.draggable-object-target.definition-drag-container');
        return clean(tile.textContent) === tileName && (!box || !targetCorrect(box));
      });
      let foundCorrect = false;
      for (let i = 0; i < targets.length; i++) {
        if (!state.running || activityComplete(activity)) return;
        if (dropsThisActivity >= OPT.maxDropsPerActivity) break;
        const target = getTargets(activity)[i];
        const source = findSource();
        if (!source || !target) break;
        if (targetCorrect(target)) { noteCorrectTarget(target); continue; }
        if (targetPopulated(target)) continue; // Don't overwrite an occupied row.
        const current = source.closest('.draggable-object-target.definition-drag-container');
        if (current === target) continue;
        const matchKey = `${activityNo}:${hash(tileName)}:${targets.length}`;
        const attemptId = String(i);
        const combo = `${matchKey}:${attemptId}`;
        if (failedBefore('matching', matchKey, attemptId) ||
            state.dragTriedThisRun.has(combo)) continue;

        state.dragTriedThisRun.add(combo);
        const previouslyLocated = source.isConnected;
        if (!simulateDrag(source, target)) continue;
        action();
        state.drops++;
        dropsThisActivity++;
        await sleep(OPT.clickDelayMs);
        const updated = getTargets(activity)[i] || target;
        if (targetCorrect(updated)) {
          noteCorrectTarget(updated);
          foundCorrect = true;
          break;
        }
        if (targetIncorrect(updated)) {
          rememberFailure('matching', matchKey, attemptId);
        }
        const reacted = targetPopulated(updated) || !source.isConnected ||
          (previouslyLocated && Boolean(updated.querySelector('.term-bucket.populated')));
        if (!reacted) {
          markReview(activityNo, 'The page did not respond to synthetic drag events.');
          return;
        }
      }
      if (!foundCorrect && findSource()) {
        markReview(activityNo, 'A matching tile was not verified correct.');
        // Do not keep moving other tiles when one remains unresolved.
        return;
      }
    }
  }

  try {
    while (state.running && Date.now() - state.startedAt < OPT.maxRuntimeMs) {
      if (location.pathname + location.search !== route) {
        stop('Page changed. Rerun on the new section.');
        break;
      }
      const activities = getActivities();
      if (!activities.length) {
        status('Waiting for participation activities to load…');
        await sleep(OPT.loopDelayMs);
        continue;
      }

      for (const [i, activity] of activities.entries()) {
        if (!state.running) break;
        const n = i + 1;
        if (activityComplete(activity)) {
          state.skippedActivities.add(n);
          state.manualNeeded.delete(n);
          continue;
        }
        await doMultipleChoice(activity, n);
        await doShortAnswer(activity, n);
        doAnimation(activity);
        await doMatching(activity, n);
        if (activityComplete(activity)) state.manualNeeded.delete(n);
      }

      const done = activities.filter(activityComplete).length;
      const report =
        `${done}/${activities.length} activities verified complete\n` +
        `Skipped: ${state.skippedActivities.size} activities, ` +
        `${state.skippedQuestionCount} questions, ` +
        `${state.skippedTargetCount} matching rows\n` +
        `${state.actions} actions (${state.drops} drags)\n` +
        (state.manualNeeded.size
          ? `Needs review: activity ${[...state.manualNeeded].join(', ')}`
          : 'Scanning only unfinished activities…');
      status(report);
      if (done === activities.length) {
        stop('All participation activities are verified complete.');
        break;
      }
      const playing = activities.some(activity =>
        all(activity, 'button[aria-label="Pause"]').some(isVisible)
      );
      if (!playing && Date.now() - state.lastActionAt > OPT.stalledMs) {
        stop(report + '\nNo progress for 25 seconds; stopped safely.');
        break;
      }
      await sleep(OPT.loopDelayMs);
    }
    if (state.running) stop('5-minute safety limit reached; rerun to resume.');
  } catch (err) {
    console.error('zyPA error:', err);
    stop(`Stopped on error: ${err.message}. Check Console.`);
  }
})();
