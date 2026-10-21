const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { createHash } = require('node:crypto');

const COURSE = 'SOUTHEASTERNCMPS2940KoutsougerasFall2026';
const ROOT = `https://learn.zybooks.com/zybook/${COURSE}`;

const PROFILE = path.join(__dirname, '.zybooks-v5-profile');
const HISTORY = path.join(__dirname, '.zybooks-v5-history.json');

const ACTIVITY = '.interactive-activity-container.participation';
const TILE = '.draggable-object';
const TARGET = '.draggable-object-target.definition-drag-container';

const wait = ms => new Promise(r => setTimeout(r, ms));
const norm = text => String(text || '').replace(/\s+/g, ' ').trim();
const keyHash = text =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

let wrong = {};

try {
  wrong = JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
} catch {}

const saveWrong = (key, index) => {
  wrong[key] ||= [];

  if (!wrong[key].includes(index)) {
    wrong[key].push(index);
    fs.writeFileSync(HISTORY, JSON.stringify(wrong, null, 2));
  }
};

const wasWrong = (key, index) =>
  (wrong[key] || []).includes(index);

const ctl = {
  stop: false,
  actions: 0,
  skipped: 0,
  results: []
};

// ---------- Section navigation ----------

function validSection(url) {
  try {
    const u = new URL(url);

    return (
      u.origin === 'https://learn.zybooks.com' &&
      u.pathname.startsWith(`/zybook/${COURSE}/chapter/`) &&
      /^\/zybook\/[^/]+\/chapter\/\d+\/section\/\d+$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}

// ---------- Completion detection ----------

async function status(activity) {
  return activity.evaluate(root => {
    const norm = t =>
      String(t || '').replace(/\s+/g, ' ').trim();

    const feedback = node => {
      const correct = Boolean(node.querySelector(
        '.zb-explanation.correct, .message.correct, ' +
        '[aria-label="Question completed"]'
      ));

      const incorrect = Boolean(node.querySelector(
        '.zb-explanation.incorrect, .message.incorrect'
      )) || [...node.querySelectorAll(
        '.message,.zb-explanation'
      )].some(x =>
        /^(incorrect|wrong|try again|not quite)\b/i
          .test(norm(x.textContent))
      );

      return {
        correct,
        incorrect: incorrect && !correct
      };
    };

    const targets = [...root.querySelectorAll(
      '.draggable-object-target.definition-drag-container'
    )];

    const rows = targets.map(t => {
      const wrapper = t.parentElement || t;
      const tile = t.querySelector('.draggable-object');

      const good = Boolean(wrapper.querySelector(
        '.correct, [aria-label="Question completed"]'
      ));

      const bad = Boolean(
        wrapper.querySelector('.incorrect')
      );

      return {
        label: norm(tile?.textContent),
        occupied: Boolean(
          tile || t.querySelector('.term-bucket.populated')
        ),
        good,
        bad: bad && !good
      };
    });

    const questions = [...root.querySelectorAll(
      '.multiple-choice-question, .short-answer-question'
    )].map(feedback);

    const chevrons = [...root.querySelectorAll('.zb-chevron')];

    const marked = Boolean(
      root.querySelector('[aria-label="Activity completed"]')
    ) || (
      chevrons.length > 0 &&
      chevrons.every(el => el.classList.contains('filled'))
    );

    // A completed activity is never repeated unless live
    // feedback explicitly contradicts the completion marker.
    const complete =
      marked &&
      rows.every(r => !r.bad) &&
      questions.every(q => !q.incorrect);

    return {
      complete,
      marked,
      rows,
      questions
    };
  });
}

// ---------- Multiple choice / True-False ----------

async function tryChoices(activity, chapterSection, i) {
  const questions = activity.locator(
    '.multiple-choice-question'
  );

  for (
    let q = 0;
    q < await questions.count() && !ctl.stop;
    q++
  ) {
    if ((await status(activity)).complete) return;

    const question = questions.nth(q);

    const meta = await question.evaluate(el => ({
      correct: !!el.querySelector(
        '.zb-explanation.correct, .message.correct, ' +
        '[aria-label="Question completed"]'
      ),
      incorrect: !!el.querySelector(
        '.zb-explanation.incorrect, .message.incorrect'
      ),
      checked: [...el.querySelectorAll(
        'input[type="radio"]'
      )].findIndex(x => x.checked),
      fingerprint:
        el.querySelector(
          '.question-text,.question-stem,.question-prompt'
        )?.textContent?.trim() ||
        [...el.querySelectorAll('input[type="radio"]')]
          .map(x => x.parentElement?.textContent).join('|'),
      count: el.querySelectorAll('input[type="radio"]').length
    }));

    if (meta.correct || !meta.count) continue;

    const k =
      `${chapterSection}|a${i}|mc${q}|` +
      keyHash(meta.fingerprint);

    if (meta.checked >= 0) {
      if (meta.incorrect) {
        saveWrong(k, meta.checked);
      } else {
        console.log(
          'MC question has an unverified selection; review.'
        );
        continue;
      }
    }

    for (
      let opt = 0;
      opt < meta.count && !ctl.stop;
      opt++
    ) {
      if (wasWrong(k, opt)) continue;

      await question.locator(
        'input[type="radio"]'
      ).nth(opt).evaluate(el => el.click());

      ctl.actions++;
      await wait(520);

      const current = (await status(activity)).questions[q];

      if (
        current?.correct ||
        (await status(activity)).complete
      ) {
        break;
      }

      if (current?.incorrect) {
        saveWrong(k, opt);
      } else {
        console.log(
          'MC feedback not recognized; stopping retries here.'
        );
        break;
      }
    }
  }
}

// ---------- Short answers ----------

async function tryShortAnswers(activity) {
  const questions = activity.locator(
    '.short-answer-question'
  );

  for (
    let i = 0;
    i < await questions.count() && !ctl.stop;
    i++
  ) {
    if ((await status(activity)).complete) return;

    const q = questions.nth(i);

    const already = await q.evaluate(el =>
      !!el.querySelector(
        '.zb-explanation.correct,.message.correct,' +
        '[aria-label="Question completed"]'
      )
    );

    if (already) continue;

    const input = q.locator(
      'textarea,input[type="text"]'
    ).first();

    const check = q.locator(
      'button.check-button'
    ).first();

    if (
      !(await input.count()) ||
      !(await check.count())
    ) {
      continue;
    }

    let text = await q.locator(
      '.forfeit-answer'
    ).first().textContent().catch(() => null);

    if (!text) {
      const reveal = q.locator(
        'button.show-answer-button'
      ).first();

      if (await reveal.count()) {
        for (let t = 0; t < 2 && !text; t++) {
          await reveal.evaluate(el => el.click());
          ctl.actions++;
          await wait(350);

          text = await q.locator(
            '.forfeit-answer'
          ).first().textContent().catch(() => null);
        }
      }
    }

    if (!text || !norm(text)) {
      console.log('Short answer unavailable; review.');
      continue;
    }

    await input.fill(norm(text));
    await check.evaluate(el => el.click());

    ctl.actions++;
    await wait(500);
  }
}

// ---------- Animations ----------

async function tryAnimations(activity) {
  const controls = activity.locator(
    '.animation-controls'
  );

  for (
    let c = 0;
    c < await controls.count() && !ctl.stop;
    c++
  ) {
    const control = controls.nth(c);

    for (let step = 0; step < 35 && !ctl.stop; step++) {
      if ((await status(activity)).complete) break;

      const state = await control.evaluate(el => {
        const visible = e =>
          e && e.getClientRects().length > 0;

        const speed = [...el.querySelectorAll(
          '.speed-control input[type="checkbox"]'
        )].find(x =>
          visible(x) && !x.checked && !x.disabled
        );

        const start = [...el.querySelectorAll(
          'button.start-button'
        )].find(x =>
          visible(x) && !x.disabled
        );

        const pause = [...el.querySelectorAll(
          'button[aria-label="Pause"]'
        )].some(visible);

        const play = [...el.querySelectorAll(
          'button[aria-label="Play"]'
        )].find(x =>
          visible(x) && !x.disabled
        );

        const replay = [...el.querySelectorAll(
          'button[aria-label="Play again"]'
        )].some(visible);

        speed?.click();

        if (replay) return 'done';
        if (pause) return 'playing';

        if (start) {
          start.click();
          return 'clicked';
        }

        if (play) {
          play.click();
          return 'clicked';
        }

        return 'idle';
      });

      if (state === 'clicked') ctl.actions++;

      if (
        state === 'idle' ||
        state === 'done'
      ) {
        break;
      }

      await wait(
        state === 'playing' ? 750 : 450
      );
    }
  }
}

// ---------- Real mouse dragging ----------

async function drag(page, src, dst) {
  await src.scrollIntoViewIfNeeded();
  await dst.scrollIntoViewIfNeeded();

  const a = await src.boundingBox();
  const b = await dst.boundingBox();

  if (!a || !b) {
    throw Error('Draggable tile or target is hidden.');
  }

  await page.mouse.move(
    a.x + a.width / 2,
    a.y + a.height / 2
  );

  await page.mouse.down();
  await wait(120);

  await page.mouse.move(
    b.x + b.width / 2,
    b.y + b.height / 2,
    { steps: 24 }
  );

  await wait(150);
  await page.mouse.up();
  await wait(550);

  ctl.actions++;
}

async function sourceFor(activity, label) {
  const index = await activity.locator(TILE).evaluateAll(
    (nodes, label) => nodes.findIndex(el => {
      const text = el.textContent
        .replace(/\s+/g, ' ').trim();

      const target = el.closest(
        '.definition-drag-container'
      );

      return (
        text === label &&
        !target?.parentElement?.querySelector('.correct')
      );
    }),
    label
  );

  return index < 0
    ? null
    : activity.locator(TILE).nth(index);
}

async function place(page, activity, label, index) {
  const src = await sourceFor(activity, label);

  if (!src) {
    throw Error(`Could not find blue tile: ${label}`);
  }

  const dst = activity.locator(TARGET).nth(index);

  await drag(page, src, dst);

  let row = (await status(activity)).rows[index];

  if (!row?.occupied) {
    const retrySource = await sourceFor(
      activity,
      label
    );

    if (retrySource) {
      try {
        await retrySource.dragTo(dst, {
          timeout: 5000,
          force: true
        });
      } catch {}

      await wait(500);
      row = (await status(activity)).rows[index];
    }
  }

  if (!row?.occupied) {
    throw Error(
      'Drag was not registered by zyBooks.'
    );
  }

  if (row.label && row.label !== label) {
    throw Error(
      'A different tile landed in the box.'
    );
  }

  return row;
}

// ---------- Matching feedback ----------

async function checkMatching(activity) {
  const buttons = activity.locator('button').filter({
    hasText: /^(check|submit|check answer)$/i
  });

  for (let i = 0; i < await buttons.count(); i++) {
    const b = buttons.nth(i);

    const relevant = await b.evaluate(el =>
      !el.closest(
        '.short-answer-question, .multiple-choice-question'
      ) &&
      !el.disabled &&
      el.getClientRects().length > 0
    );

    if (relevant) {
      await b.click();
      ctl.actions++;
      await wait(550);
      return;
    }
  }
}

// ---------- Drag-and-drop matching ----------

async function tryMatching(
  page,
  activity,
  section,
  activityNumber
) {
  if (!(await activity.locator(TARGET).count())) {
    return;
  }

  let st = await status(activity);

  if (st.complete) return;

  const labels = await activity.locator(TILE).evaluateAll(
    nodes => nodes.map(n =>
      n.textContent.replace(/\s+/g, ' ').trim()
    ).filter(Boolean)
  );

  const n = st.rows.length;

  if (
    labels.length !== n ||
    new Set(labels).size !== labels.length
  ) {
    console.warn(
      'Matching: ambiguous/missing tile labels; review.'
    );
    return;
  }

  const solved = new Map();

  st.rows.forEach((r, i) => {
    if (r.good && r.label) {
      solved.set(r.label, i);
    }
  });

  // Move a tile out of an incorrect box and into an
  // available box. Leave confirmed correct tiles alone.

  for (const label of labels) {
    if (ctl.stop || solved.has(label)) {
      continue;
    }

    const historyKey =
      `${section}|a${activityNumber}|match|` +
      keyHash(label);

    let matched = false;

    for (
      let index = 0;
      index < n && !ctl.stop;
      index++
    ) {
      st = await status(activity);

      if (st.complete) return;

      const row = st.rows[index];

      // Never displace a verified correct match.
      if (row.good) continue;

      if (row.occupied) {
        if (
          row.label === label &&
          row.bad
        ) {
          saveWrong(historyKey, index);
        }

        continue;
      }

      if (wasWrong(historyKey, index)) {
        continue;
      }

      const after = await place(
        page,
        activity,
        label,
        index
      );

      if (after.good) {
        solved.set(label, index);
        matched = true;
        break;
      }

      if (after.bad) {
        saveWrong(historyKey, index);
        continue;
      }

      // If feedback is not immediately available,
      // don't assume that the match is wrong.
    }

    if (!matched) {
      await checkMatching(activity);

      st = await status(activity);

      if (st.complete) return;

      st.rows.forEach((r, idx) => {
        if (r.good && r.label) {
          solved.set(r.label, idx);
        }

        if (r.bad && r.label) {
          saveWrong(
            `${section}|a${activityNumber}|match|` +
              keyHash(r.label),
            idx
          );
        }
      });

      if (!solved.has(label)) {
        console.warn(
          `Matching: no verified correct placement ` +
          `for "${label}". Review.`
        );
        return;
      }
    }
  }

  if (!(await status(activity)).complete) {
    console.warn(
      'Matching tiles handled; completion not confirmed.'
    );
  }
}

// ---------- Process one section ----------

async function runSection(
  page,
  entry,
  sequence,
  total
) {
  const url = entry.url;

  console.log(
    `\n[${sequence}/${total}] ${entry.label || url}`
  );

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });

  await wait(900);
  await attachProgressPanel(page);

  const activities = page.locator(ACTIVITY);

  try {
    await activities.first().waitFor({
      timeout: 12000
    });
  } catch {
    return {
      url,
      completed: 0,
      total: 0,
      note: 'No participation activities detected'
    };
  }

  const count = await activities.count();

  for (
    let i = 0;
    i < count && !ctl.stop;
    i++
  ) {
    const activity = activities.nth(i);

    // Live completion check before any interaction.
    if ((await status(activity)).complete) {
      ctl.skipped++;
      continue;
    }

    try {
      await tryChoices(activity, url, i);
      await tryShortAnswers(activity);
      await tryAnimations(activity);
      await tryMatching(page, activity, url, i);
    } catch (error) {
      console.warn(
        `Activity ${i + 1} needs review: ${error.message}`
      );
    }

    const done = (await status(activity)).complete;

    console.log(
      `Activity ${i + 1}/${count}: ` +
      (done ? 'complete' : 'not verified')
    );

    await updateProgressPanel(
      page,
      `${sequence}/${total} sections · ` +
      `activity ${i + 1}/${count} · ` +
      `${ctl.actions} actions`
    );
  }

  let completed = 0;

  for (let i = 0; i < count; i++) {
    if ((await status(activities.nth(i))).complete) {
      completed++;
    }
  }

  return {
    url,
    completed,
    total: count,
    note: ctl.stop ? 'Stopped' : 'Checked'
  };
}

// ---------- Progress overlay ----------

async function attachProgressPanel(page) {
  await page.evaluate(() => {
    document.getElementById(
      'zy-v5-progress'
    )?.remove();

    const box = document.createElement('aside');

    box.id = 'zy-v5-progress';

    box.style.cssText =
      'position:fixed;right:16px;bottom:16px;' +
      'z-index:2147483647;background:#192638;' +
      'color:white;border-radius:10px;padding:14px;' +
      'box-shadow:0 4px 20px #0005;' +
      'font:13px system-ui;max-width:310px';

    box.innerHTML =
      '<b>zyBooks Section Runner</b>' +
      '<div id="zy-v5-status" ' +
      'style="margin:8px 0">Working…</div>';

    const button = document.createElement('button');

    button.textContent = 'Stop after current action';

    button.onclick = () => window.zyStopRunner();

    box.appendChild(button);
    document.body.appendChild(box);
  });
}

async function updateProgressPanel(page, text) {
  try {
    await page.evaluate(text => {
      const el = document.getElementById(
        'zy-v5-status'
      );

      if (el) el.textContent = text;
    }, text);
  } catch {}
}

// ---------- Chapter/section picker ----------

async function showPicker(page) {
  return new Promise(async (resolve, reject) => {
    try {
      await page.exposeFunction(
        'zyStartRunner',
        selection => resolve(selection)
      );

      await page.evaluate(({ course, root }) => {
        document.getElementById(
          'zy-v5-picker'
        )?.remove();

        const panel = document.createElement('aside');

        panel.id = 'zy-v5-picker';

        panel.style.cssText =
          'position:fixed;right:15px;top:65px;' +
          'z-index:2147483647;width:360px;' +
          'max-width:calc(100vw - 30px);' +
          'max-height:80vh;overflow:auto;' +
          'background:#15253a;color:white;' +
          'border:1px solid #49617b;padding:16px;' +
          'border-radius:12px;' +
          'box-shadow:0 6px 30px #0008;' +
          'font:13px system-ui';

        const heading = document.createElement('h3');

        heading.textContent =
          'zyBooks Section Runner v5';

        heading.style.margin = '0 0 8px';
        panel.appendChild(heading);

        const help = document.createElement('p');

        help.textContent =
          'Choose chapters or sections, then Start. ' +
          'Only participation activities will be processed.';

        panel.appendChild(help);

        const controls = document.createElement('div');
        const list = document.createElement('div');

        list.style.cssText =
          'max-height:38vh;overflow:auto;' +
          'border:1px solid #42566c;padding:8px';

        const input = document.createElement('input');

        input.placeholder =
          'Optional: 6.1, 6.3, 7.1-7.4';

        input.style.cssText =
          'width:100%;margin:10px 0;' +
          'padding:7px;box-sizing:border-box';

        const info = document.createElement('div');

        info.style.cssText =
          'margin:6px 0;color:#c9d4e6';

        const mkButton = (caption, fn) => {
          const b = document.createElement('button');

          b.textContent = caption;

          b.style.cssText =
            'margin:3px;padding:6px;cursor:pointer';

          b.addEventListener('click', fn);
          controls.appendChild(b);
        };

        let entries = [];

        function scan() {
          const found = new Map();

          for (
            const anchor of document.querySelectorAll(
              'a[href]'
            )
          ) {
            let url;

            try {
              url = new URL(anchor.href);
            } catch {
              continue;
            }

            const m = url.pathname.match(
              /\/chapter\/(\d+)\/section\/(\d+)\/?$/
            );

            if (
              !m ||
              url.origin !== 'https://learn.zybooks.com' ||
              !url.pathname.startsWith(
                `/zybook/${course}/`
              )
            ) {
              continue;
            }

            const ch = Number(m[1]);
            const sec = Number(m[2]);

            found.set(`${ch}.${sec}`, {
              ch,
              sec,
              url: `${root}/chapter/${ch}/section/${sec}`,
              label:
                `${ch}.${sec} — ` +
                (anchor.textContent.trim() || 'Section')
            });
          }

          entries = [...found.values()].sort(
            (a, b) =>
              a.ch - b.ch ||
              a.sec - b.sec
          );

          list.replaceChildren();

          const groups = new Map();

          for (const entry of entries) {
            if (!groups.has(entry.ch)) {
              groups.set(entry.ch, []);
            }

            groups.get(entry.ch).push(entry);
          }

          for (const [chapter, members] of groups) {
            const section = document.createElement('div');

            section.style.cssText =
              'margin:6px 0;' +
              'border-bottom:1px solid #40516a';

            const chLabel = document.createElement('label');
            const chBox = document.createElement('input');

            chBox.type = 'checkbox';

            chLabel.append(
              chBox,
              ` Chapter ${chapter} (${members.length} sections)`
            );

            chLabel.style.fontWeight = 'bold';
            section.appendChild(chLabel);

            const checks = [];

            for (const entry of members) {
              const label = document.createElement('label');

              label.style.cssText =
                'display:block;margin:4px 0 4px 14px';

              const checkbox = document.createElement('input');

              checkbox.type = 'checkbox';
              checkbox.className = 'zy-v5-choice';
              checkbox.dataset.url = entry.url;
              checkbox.dataset.label = entry.label;

              label.append(
                checkbox,
                ` ${entry.label}`
              );

              section.appendChild(label);
              checks.push(checkbox);
            }

            chBox.addEventListener(
              'change',
              () => checks.forEach(
                c => c.checked = chBox.checked
              )
            );

            list.appendChild(section);
          }

          info.textContent =
            `Detected ${entries.length} linked sections. ` +
            'Expand TOC chapters and press Rescan ' +
            'if some are missing.';
        }

        mkButton('Select all', () =>
          panel.querySelectorAll(
            '.zy-v5-choice'
          ).forEach(x => x.checked = true)
        );

        mkButton('Clear', () =>
          panel.querySelectorAll(
            '.zy-v5-choice'
          ).forEach(x => x.checked = false)
        );

        mkButton('Rescan TOC', scan);

        const start = document.createElement('button');

        start.textContent = 'Start selected sections';

        start.style.cssText =
          'background:#69d7a8;color:#10251e;' +
          'font-weight:bold;padding:9px 12px;' +
          'cursor:pointer;border:0;border-radius:6px';

        start.addEventListener('click', async () => {
          const out = new Map();

          for (
            const box of panel.querySelectorAll(
              '.zy-v5-choice:checked'
            )
          ) {
            out.set(box.dataset.url, {
              url: box.dataset.url,
              label: box.dataset.label
            });
          }

          const manual = input.value
            .split(/[,;\n]+/)
            .map(s => s.trim())
            .filter(Boolean);

          for (const term of manual) {
            const m = term.match(
              /^(\d+)\.(\d+)(?:\s*-\s*(\d+))?$/
            );

            if (!m) {
              info.textContent =
                `Invalid manual section: ${term}`;
              return;
            }

            const ch = +m[1];
            const from = +m[2];
            const to = +(m[3] || m[2]);

            if (
              ch < 1 ||
              from < 1 ||
              to < from ||
              to - from > 30
            ) {
              info.textContent =
                `Invalid section range: ${term}`;
              return;
            }

            for (let s = from; s <= to; s++) {
              const url =
                `${root}/chapter/${ch}/section/${s}`;

              out.set(url, {
                url,
                label: `${ch}.${s} (manual)`
              });
            }
          }

          if (!out.size || out.size > 80) {
            info.textContent =
              'Choose 1–80 sections.';
            return;
          }

          start.disabled = true;
          info.textContent = 'Starting...';

          try {
            await window.zyStartRunner(
              [...out.values()]
            );
          } catch (error) {
            info.textContent = error.message;
            start.disabled = false;
          }
        });

        panel.append(
          controls,
          list,
          input,
          info,
          start
        );

        document.body.appendChild(panel);
        scan();
      }, {
        course: COURSE,
        root: ROOT
      });
    } catch (error) {
      reject(error);
    }
  });
}

// ---------- Main ----------

async function main() {
  const browser = await chromium.launchPersistentContext(
    PROFILE,
    {
      headless: false,
      viewport: {
        width: 1400,
        height: 960
      }
    }
  );

  const page =
    browser.pages()[0] ||
    await browser.newPage();

  const rl = readline.createInterface({
    input: stdin,
    output: stdout
  });

  await page.exposeFunction(
    'zyStopRunner',
    () => {
      ctl.stop = true;
    }
  );

  try {
    await page.goto(ROOT, {
      waitUntil: 'domcontentloaded'
    });

    console.log(
      'Sign in to zyBooks if prompted. ' +
      'Navigate to the course TOC.'
    );

    await rl.question(
      'When the table of contents is visible, ' +
      'press ENTER here...'
    );

    const selected = await showPicker(page);

    const unique = [...new Map(
      selected
        .filter(x => validSection(x.url))
        .map(x => [x.url, x])
    ).values()];

    if (!unique.length) {
      throw Error('No valid sections selected.');
    }

    console.log(
      `Selected ${unique.length} sections.`
    );

    for (
      let i = 0;
      i < unique.length && !ctl.stop;
      i++
    ) {
      try {
        ctl.results.push(
          await runSection(
            page,
            unique[i],
            i + 1,
            unique.length
          )
        );
      } catch (error) {
        ctl.results.push({
          url: unique[i].url,
          note: error.message
        });

        console.warn(
          `Section failed: ${error.message}`
        );
      }
    }

    console.table(ctl.results);

    console.log(
      `Actions: ${ctl.actions}, ` +
      `verified activity skips: ${ctl.skipped}`
    );

    console.log(
      `Saved feedback-confirmed wrong answers in ${HISTORY}`
    );

    await updateProgressPanel(
      page,
      'Finished. See Terminal summary.'
    );

    await rl.question(
      'Press ENTER to close the browser...'
    );
  } finally {
    rl.close();
    await browser.close();
  }
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
