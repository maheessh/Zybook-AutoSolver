
/*
 * zyBooks Console Section Runner v6 (no Node.js or Playwright)
 * Participation only. Do not use where course rules prohibit automation.
 */
(async () => {
  'use strict';

  if (location.hostname !== 'learn.zybooks.com') {
    console.error('Run this on learn.zybooks.com');
    return;
  }
  window.zyRunner?.stop?.();
  window.zyPA?.stop?.();
  document.getElementById('zy-v6-panel')?.remove();
  document.getElementById('zy-v6-frame')?.remove();

  const match = location.pathname.match(/^\/zybook\/([^/]+)/);
  if (!match) { console.error('Open your zyBooks course first.'); return; }
  const course = match[1];
  const root = `${location.origin}/zybook/${course}`;
  const A = '.interactive-activity-container.participation';
  const T = '.draggable-object';
  const D = '.draggable-object-target.definition-drag-container';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const q = (node, css) => node?.querySelector(css) ?? null;
  const qa = (node, css) => Array.from(node?.querySelectorAll(css) || []);
  const clean = x => String(x || '').replace(/\s+/g, ' ').trim();
  const visible = node => !!(node?.isConnected && node.getClientRects().length);
  const hash = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(36); };
  const key = `zy-v6-wrong:${course}`;
  let wrong = {};
  try { wrong = JSON.parse(sessionStorage.getItem(key) || '{}') || {}; } catch {}
  const rejected = (id, value) => (wrong[id] || []).includes(String(value));
  function remember(id, value) {
    if (rejected(id, value)) return;
    (wrong[id] ??= []).push(String(value));
    try { sessionStorage.setItem(key, JSON.stringify(wrong)); } catch {}
  }

  const runner = {
    stopped: false, paused: false, busy: false,
    stats: { sections: 0, skippedSections: 0, complete: 0, skippedActivities: 0, actions: 0, reviews: 0 },
    results: [], current: null,
    stop() { runner.stopped = true; runner.paused = false; log('Stop requested.'); },
    pause() { runner.paused = true; log('Paused.'); },
    resume() { runner.paused = false; log('Resuming.'); },
    summary() { return { ...runner.stats, current: runner.current, results: runner.results }; },
    clearHistory() { wrong = {}; sessionStorage.removeItem(key); log('Remembered wrong attempts cleared.'); }
  };
  window.zyRunner = runner;
  async function proceed() {
    if (runner.stopped) throw Error('Stopped by user');
    while (runner.paused && !runner.stopped) await sleep(180);
    if (runner.stopped) throw Error('Stopped by user');
  }

  // UI and TOC picker
  const panel = document.createElement('aside');
  panel.id = 'zy-v6-panel';
  panel.style.cssText = 'position:fixed;z-index:2147483647;right:12px;top:12px;width:345px;max-width:calc(100vw - 25px);max-height:93vh;overflow:auto;color:#f5f7fa;background:#172638;padding:14px;border-radius:12px;box-shadow:0 8px 32px #0007;font:13px system-ui';
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
      <strong style="font-size:15px">zyBooks Console Runner v6</strong><button data-minimize title="Minimize panel">−</button>
    </div>
    <div data-content>
      <p style="margin:7px 0">Choose sections. Completed (100%) sections are skipped by default.</p>
      <div style="display:flex;gap:5px;flex-wrap:wrap">
        <button data-scan>Scan TOC</button><button data-all>Select unfinished</button><button data-none>Clear</button>
      </div>
      <div data-list style="border:1px solid #627080;padding:6px;margin-top:7px;max-height:210px;overflow:auto"></div>
      <input data-manual style="width:100%;box-sizing:border-box;margin-top:7px;padding:6px;color:#101820" placeholder="Or enter: 6.1, 6.6-6.10, 7.2" />
      <label style="display:block;margin-top:7px"><input data-skip type="checkbox" checked /> Skip sections labeled 100%</label>
      <label style="display:block;margin:6px 0"><input data-match type="checkbox" checked /> Try matching (synthetic drag; may fail)</label>
      <label style="display:block;margin:6px 0"><input data-spa type="checkbox" /> If iframe blocked, try TOC links (may reload page)</label>
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin:8px 0">
        <button data-run style="background:#a1edc6;color:#162719;font-weight:700">Run selected</button>
        <button data-current>Current section</button>
        <button data-pause>Pause</button><button data-stop>Stop</button>
      </div>
      <div data-status style="white-space:pre-wrap;border-top:1px solid #667489;padding-top:7px">Ready.</div>
      <div data-log style="margin-top:6px;max-height:160px;overflow:auto;color:#bbcada;font-size:11px"></div>
      <button data-close-frame style="margin-top:7px">Hide section viewer</button>
    </div>`;
  document.body.appendChild(panel);
  const $ = attr => panel.querySelector(`[data-${attr}]`);
  const list = $('list');
  const status = $('status');
  const logs = $('log');
  const log = (...args) => {
    const message = args.map(String).join(' ');
    console.log('[zyRunner]', message);
    const div = document.createElement('div'); div.textContent = message;
    logs.prepend(div);
    while (logs.children.length > 45) logs.lastElementChild.remove();
    status.textContent = `${message}\n${runner.stats.complete} verified complete · ${runner.stats.skippedActivities} activity skips · ${runner.stats.actions} actions · ${runner.stats.reviews} reviews`;
  };
  $('minimize').onclick = () => {
    const content = $('content');
    content.hidden = !content.hidden;
    $('minimize').textContent = content.hidden ? '+' : '−';
  };
  $('pause').onclick = () => {
    if (runner.paused) runner.resume(); else runner.pause();
    $('pause').textContent = runner.paused ? 'Resume' : 'Pause';
  };
  $('stop').onclick = () => runner.stop();
  let frame;
  $('close-frame').onclick = () => { if (frame) frame.style.display = frame.style.display === 'none' ? 'block' : 'none'; };

  function parseSection(url) {
    try {
      const u = new URL(url, location.href);
      const m = u.pathname.match(/^\/zybook\/([^/]+)\/chapter\/(\d+)\/section\/(\d+)\/?$/);
      if (!m || u.origin !== location.origin || m[1] !== course) return null;
      return { ch: +m[2], sec: +m[3], num: `${m[2]}.${m[3]}`, url: `${root}/chapter/${+m[2]}/section/${+m[3]}` };
    } catch { return null; }
  }
  function tocState(anchor) {
    // Find the smallest ancestor containing one section link and the percentage.
    let parent = anchor;
    for (let i = 0; i < 5 && parent && parent !== document.body; i++, parent = parent.parentElement) {
      const count = qa(parent, 'a[href]').filter(x => parseSection(x.href)).length;
      if (count === 1 && /(?:100\s*%|no points|not complete|\d+\s*%)/i.test(clean(parent.textContent))) {
        const text = clean(parent.textContent);
        return { done: /\b100\s*%/i.test(text), noPoints: /no points/i.test(text) };
      }
    }
    return { done: false, noPoints: false };
  }
  let entries = [];
  function scan() {
    const found = new Map();
    for (const anchor of qa(document, 'a[href]')) {
      if (panel.contains(anchor)) continue;
      const info = parseSection(anchor.href);
      if (!info) continue;
      const state = tocState(anchor);
      const name = clean(anchor.textContent).replace(/^\d+\.\d+\s*/, '').slice(0, 85);
      const item = { ...info, label: `${info.num} ${name || 'Section'}`, done: state.done, noPoints: state.noPoints };
      const old = found.get(info.num);
      if (!old || (!old.done && item.done)) found.set(info.num, item);
    }
    // Current section can be selected even when TOC links aren't visible.
    const here = parseSection(location.href);
    if (here && !found.has(here.num)) found.set(here.num, { ...here, label: `${here.num} (current)`, done: false, noPoints: false });
    entries = [...found.values()].sort((a, b) => a.ch - b.ch || a.sec - b.sec);
    list.replaceChildren();
    if (!entries.length) { list.textContent = 'No section links found. Expand the TOC or type section numbers below.'; return; }
    for (const chapter of [...new Set(entries.map(e => e.ch))]) {
      const group = document.createElement('div');
      group.style.cssText = 'border-bottom:1px solid #43546a;padding:3px 0';
      const heading = document.createElement('label');
      const check = document.createElement('input'); check.type = 'checkbox';
      heading.append(check, ` Chapter ${chapter}`); heading.style.fontWeight = 'bold';
      group.appendChild(heading);
      const children = [];
      for (const e of entries.filter(x => x.ch === chapter)) {
        const row = document.createElement('label'); row.style.cssText = 'display:block;margin:3px 0 3px 15px';
        const box = document.createElement('input'); box.type = 'checkbox'; box.dataset.section = e.num;
        box.checked = !e.done && !e.noPoints;
        children.push(box);
        const badge = e.done ? ' ✓ 100%' : (e.noPoints ? ' (no points)' : '');
        row.append(box, ' ', `${e.label}${badge}`); group.appendChild(row);
      }
      check.onchange = () => children.forEach(c => c.checked = check.checked);
      list.appendChild(group);
    }
    log(`Found ${entries.length} section links. The TOC may need expanding to show others.`);
  }
  $('scan').onclick = scan;
  $('all').onclick = () => qa(list, 'input[data-section]').forEach(b => {
    const e = entries.find(x => x.num === b.dataset.section);
    b.checked = !!e && !e.done && !e.noPoints;
  });
  $('none').onclick = () => qa(list, 'input[type=checkbox]').forEach(b => { b.checked = false; });
  scan();

  function selectedSections() {
    const chosen = new Map();
    for (const b of qa(list, 'input[data-section]:checked')) {
      const e = entries.find(x => x.num === b.dataset.section);
      if (e) chosen.set(e.num, e);
    }
    const manual = clean($('manual').value).split(/[,;\n]+/).map(x => x.trim()).filter(Boolean);
    for (const item of manual) {
      const m = item.match(/^(\d+)\.(\d+)(?:\s*-\s*(?:(\d+)\.)?(\d+))?$/);
      if (!m) throw Error(`Invalid section range: ${item}`);
      const ch = +m[1], from = +m[2], to = m[4] ? +m[4] : from;
      if (m[3] && +m[3] !== ch) throw Error('Ranges must stay within one chapter');
      if (ch < 1 || from < 1 || to < from || to - from > 35) throw Error(`Invalid section range: ${item}`);
      for (let s = from; s <= to; s++) {
        const num = `${ch}.${s}`;
        chosen.set(num, entries.find(x => x.num === num) || { ch, sec: s, num, label: num, url: `${root}/chapter/${ch}/section/${s}`, done: false, noPoints: false });
      }
    }
    const result = [...chosen.values()].sort((a, b) => a.ch - b.ch || a.sec - b.sec);
    if (!result.length || result.length > 80) throw Error('Select 1 to 80 sections.');
    return result;
  }

  // Completion and feedback. Only live page evidence may establish success.
  function success(node) {
    return !!q(node, '.zb-explanation.correct, .message.correct, [aria-label="Question completed"]') ||
      qa(node, '.message').some(e => visible(e) && /^correct[!.]?$/i.test(clean(e.textContent)));
  }
  function failure(node) {
    return !!q(node, '.zb-explanation.incorrect, .message.incorrect') ||
      qa(node, '.message, .zb-explanation').some(e => visible(e) && /^(incorrect|wrong|try again|not quite)\b/i.test(clean(e.textContent)));
  }
  const targets = act => qa(act, D);
  function populated(t) { return !!q(t, '.term-bucket.populated, .draggable-object'); }
  function rowFeedback(t) {
    const r = t.parentElement || t;
    const good = populated(t) && (!!q(r, '.correct, [aria-label="Question completed"]') || /\bcorrect[!.]?\b/i.test(clean(q(r, '.message')?.textContent)));
    const bad = !good && (!!q(r, '.incorrect') || /\b(?:incorrect|wrong|try again)\b/i.test(clean(q(r, '.message')?.textContent)));
    return { good, bad, occupied: populated(t), label: clean(q(t, '.draggable-object')?.textContent) };
  }
  function completed(act) {
    const checks = qa(act, '.zb-chevron');
    const marked = !!q(act, '[aria-label="Activity completed"]') || (checks.length > 0 && checks.every(e => e.classList.contains('filled')));
    if (!marked) return false;
    if (qa(act, '.multiple-choice-question, .short-answer-question').some(n => failure(n) && !success(n))) return false;
    if (targets(act).some(t => !rowFeedback(t).occupied || rowFeedback(t).bad)) return false;
    return true;
  }
  function review(what) { runner.stats.reviews++; log(`Review: ${what}`); }

  async function choices(act, prefix) {
    const questions = qa(act, '.multiple-choice-question');
    for (const [i, question] of questions.entries()) {
      await proceed();
      if (completed(act) || success(question)) continue;
      const options = qa(question, 'input[type="radio"]').filter(x => !x.disabled);
      if (!options.length) continue;
      const prompt = clean(q(question, '.question-text, .question-stem, .question-prompt')?.textContent);
      const signature = hash(JSON.stringify([prompt, options.map(x => clean(x.closest('label')?.textContent || x.parentElement?.textContent || x.value))]));
      const id = `${prefix}/choice/${i}/${signature}`;
      const selected = options.findIndex(x => x.checked);
      if (selected >= 0 && failure(question)) remember(id, selected);
      if (selected >= 0 && !failure(question)) { review(`${prefix} question ${i + 1}: existing selection unverified`); continue; }
      for (let j = 0; j < options.length; j++) {
        await proceed();
        if (rejected(id, j)) continue;
        options[j].click(); runner.stats.actions++;
        await sleep(480);
        if (success(question) || completed(act)) break;
        if (failure(question)) remember(id, j);
        else { review(`${prefix} question ${i + 1}: correctness feedback unavailable`); break; }
      }
    }
  }
  async function shortAnswers(act, prefix) {
    for (const [i, question] of qa(act, '.short-answer-question').entries()) {
      await proceed();
      if (completed(act) || success(question)) continue;
      const input = q(question, 'textarea, input[type="text"]');
      const submit = q(question, 'button.check-button');
      const show = q(question, 'button.show-answer-button');
      if (!input || !submit || submit.disabled) continue;
      let answer = q(question, '.forfeit-answer');
      for (let j = 0; !answer && j < 2 && show && !show.disabled; j++) {
        show.click(); runner.stats.actions++; await sleep(250);
        answer = q(question, '.forfeit-answer');
      }
      if (!answer || !clean(answer.textContent)) { review(`${prefix} short answer ${i + 1}: unavailable`); continue; }
      const view = input.ownerDocument.defaultView;
      const proto = input instanceof view.HTMLTextAreaElement ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, clean(answer.textContent));
      input.dispatchEvent(new view.Event('input', { bubbles: true }));
      input.dispatchEvent(new view.Event('change', { bubbles: true }));
      submit.click(); runner.stats.actions++;
      await sleep(500);
      if (!success(question) && !completed(act)) review(`${prefix} short answer ${i + 1}: not verified`);
    }
  }
  async function animations(act) {
    for (const control of qa(act, '.animation-controls')) {
      for (const speed of qa(control, '.speed-control input[type="checkbox"]')) {
        if (!speed.checked && !speed.disabled && visible(speed)) { speed.click(); runner.stats.actions++; }
      }
      for (let step = 0; step < 36 && !completed(act); step++) {
        await proceed();
        if (q(control, 'button[aria-label="Play again"]')) break;
        const pause = q(control, 'button[aria-label="Pause"]');
        if (pause && visible(pause)) { await sleep(480); continue; }
        const play = q(control, 'button[aria-label="Play"]') || q(control, 'button.start-button');
        if (!play || !visible(play) || play.disabled) break;
        play.click(); runner.stats.actions++; await sleep(500);
      }
    }
  }

  // Console-only synthetic drag. Check for an actual DOM move after each attempt.
  // Browser security prevents events dispatched here from being trusted mouse input.
  function syntheticDrag(source, destination, mode) {
    const view = source.ownerDocument.defaultView;
    const transfer = typeof view.DataTransfer === 'function' ? new view.DataTransfer() : {
      data: {}, setData(t, v) { this.data[t] = v; }, getData(t) { return this.data[t] || ''; }, clearData() { this.data = {}; }, effectAllowed: 'all', dropEffect: 'move', types: []
    };
    const fire = (el, type) => {
      let event;
      try { event = new view.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }); }
      catch {
        event = new view.CustomEvent(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: transfer });
      }
      el.dispatchEvent(event);
    };
    if (mode === 0) {
      fire(source, 'dragstart'); fire(destination, 'dragenter'); fire(destination, 'dragover');
      fire(destination, 'drop'); fire(source, 'dragend');
    } else {
      // A legacy zyBooks handler may expect the source's drop event first.
      fire(source, 'dragstart'); fire(source, 'drop'); fire(destination, 'drop'); fire(source, 'dragend');
    }
  }
  async function matching(act, prefix) {
    if (!$('match').checked || !targets(act).length || completed(act)) return;
    const tileNames = [...new Set(qa(act, T).map(t => clean(t.textContent)).filter(Boolean))];
    if (tileNames.length !== targets(act).length) { review(`${prefix}: ambiguous matching tiles`); return; }
    for (const tileName of tileNames) {
      await proceed();
      if (completed(act)) return;
      const tileIsCorrect = () => targets(act).some(t => rowFeedback(t).good && rowFeedback(t).label === tileName);
      if (tileIsCorrect()) continue;
      const id = `${prefix}/match/${hash(tileName)}`;
      let found = false;
      for (let i = 0; i < targets(act).length; i++) {
        await proceed();
        if (tileIsCorrect()) { found = true; break; }
        const target = targets(act)[i];
        const row = rowFeedback(target);
        if (row.good || rejected(id, i)) continue;
        // Can move a tile out of a wrong row, but not overwrite another tile.
        if (row.occupied) {
          if (row.label === tileName && row.bad) remember(id, i);
          continue;
        }
        const source = qa(act, T).find(t => {
          if (clean(t.textContent) !== tileName) return false;
          const old = t.closest(D);
          return !old || !rowFeedback(old).good;
        });
        if (!source) break;
        let moved = false;
        for (let mode = 0; mode < 2; mode++) {
          syntheticDrag(source, target, mode); runner.stats.actions++;
          await sleep(350);
          const result = rowFeedback(target);
          if (result.occupied && result.label === tileName) { moved = true; break; }
        }
        if (!moved) { review(`${prefix}: browser rejected synthetic dragging. Drag tiles manually.`); return; }
        const result = rowFeedback(target);
        if (result.good) { found = true; break; }
        if (result.bad) { remember(id, i); continue; }
        review(`${prefix}: tile moved but correctness could not be verified`);
        return;
      }
      if (!found && !tileIsCorrect()) { review(`${prefix}: no confirmed correct match for ${tileName}`); return; }
    }
  }

  async function processDocument(doc, section) {
    const acts = qa(doc, A);
    if (!acts.length) { log(`${section.num}: no participation activities found.`); return { complete: 0, total: 0 }; }
    let count = 0;
    for (const [i, act] of acts.entries()) {
      await proceed();
      const prefix = `${section.num}/activity${i + 1}`;
      if (completed(act)) { runner.stats.skippedActivities++; count++; continue; }
      log(`${section.num}: activity ${i + 1}/${acts.length}`);
      await choices(act, prefix);
      await shortAnswers(act, prefix);
      await animations(act);
      await matching(act, prefix);
      if (completed(act)) { count++; runner.stats.complete++; }
      else review(`${prefix}: incomplete or no recognizable completion marker`);
    }
    return { complete: count, total: acts.length };
  }

  // Same-origin iframe keeps the picker and queue alive when section URLs load.
  async function openInFrame(section) {
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'zy-v6-frame';
      frame.title = 'zyBooks selected section';
      frame.style.cssText = 'position:fixed;z-index:2147483646;left:10px;top:10px;width:calc(100vw - 390px);height:92vh;min-width:350px;background:white;border:2px solid #375a85;border-radius:8px';
      document.body.appendChild(frame);
    }
    frame.style.display = 'block';
    let loaded = false;
    const waiter = new Promise(resolve => {
      frame.onload = () => { loaded = true; resolve(true); };
      setTimeout(() => resolve(false), 11000);
    });
    frame.src = section.url;
    await waiter;
    if (!loaded) throw Error('Section viewer did not load');
    // Some servers disallow iframe embedding, even for the same origin.
    for (let retry = 0; retry < 24; retry++) {
      await proceed();
      let doc;
      try { doc = frame.contentDocument; } catch { throw Error('Section iframe inaccessible'); }
      if (!doc?.body || doc.location?.href === 'about:blank') { await sleep(250); continue; }
      if (q(doc, A)) return doc;
      if (retry === 23) {
        const text = clean(doc.body.innerText).slice(0, 180);
        if (/refused|blocked|not allowed|sign in|log in/i.test(text)) throw Error(`Iframe blocked or needs login: ${text}`);
        return doc;
      }
      await sleep(250);
    }
    throw Error('Unable to inspect section iframe');
  }

  // Optional fallback: click the site's real TOC link. This only preserves
  // Console state when its router keeps the document alive (SPA navigation).
  async function navigateWithTOC(section) {
    const anchor = qa(document, 'a[href]').find(a => parseSection(a.href)?.num === section.num && !panel.contains(a));
    if (!anchor) throw Error('No visible/loaded TOC link for SPA fallback');
    if (frame) frame.style.display = 'none';
    anchor.click();
    let ok = false;
    for (let i = 0; i < 36; i++) {
      await proceed();
      if (parseSection(location.href)?.num === section.num && q(document, A)) {
        ok = true;
        break;
      }
      await sleep(250);
    }
    if (!ok) throw Error('TOC navigation did not reveal the requested section');
    await sleep(450);
    return document;
  }

  async function runQueue(sections) {
    if (runner.busy) { log('Already running.'); return; }
    runner.busy = true;
    runner.stopped = false;
    runner.paused = false;
    runner.results = [];
    log(`Starting ${sections.length} selected section(s).`);
    try {
      for (const section of sections) {
        await proceed();
        runner.current = section.num;
        if ($('skip').checked && (section.done || section.noPoints)) {
          runner.stats.skippedSections++;
          runner.results.push({ section: section.num, result: 'Skipped (TOC 100% / no points)' });
          log(`${section.num}: skipped based on TOC status.`);
          continue;
        }
        let doc;
        try {
          // Running on the currently displayed section works without iframe.
          const here = parseSection(location.href);
          if (here?.num === section.num) {
            doc = document;
          } else {
            try {
              doc = await openInFrame(section);
            } catch (embedError) {
              if (!$('spa').checked) throw embedError;
              log(`${section.num}: iframe unavailable; trying TOC navigation (may reload).`);
              doc = await navigateWithTOC(section);
            }
          }
          const result = await processDocument(doc, section);
          runner.stats.sections++;
          runner.results.push({ section: section.num, ...result });
          log(`${section.num}: ${result.complete}/${result.total} verified complete.`);
        } catch (err) {
          if (runner.stopped) break;
          runner.results.push({ section: section.num, error: err.message });
          log(`${section.num}: ${err.message}. No reliable console-only cross-section fallback if embedding is blocked.`);
          // Avoid reporting an entire queue as completed after a framing failure.
          if (/iframe|viewer|inaccessible/i.test(err.message)) break;
        }
      }
    } finally {
      runner.busy = false;
      runner.current = null;
      console.table(runner.results);
      log('Run finished. See window.zyRunner.summary() for results.');
    }
  }

  $('run').onclick = () => {
    try { runQueue(selectedSections()); } catch (e) { log(e.message); }
  };
  $('current').onclick = () => {
    const here = parseSection(location.href);
    if (!here) { log('Open a specific chapter section before using Current section.'); return; }
    runQueue([{ ...here, done: false, noPoints: false, label: here.num }]);
  };
  log('Ready. Select sections and click Run selected.');
})();
