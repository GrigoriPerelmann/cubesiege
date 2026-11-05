// The Balance Lab page (balance.html): shows the numbers from balance.js.
import { paperReport, findIssues, fieldCell, fieldJobs, perkJobs, FIELD_WEAPONS, FIELD_LOADOUTS } from './balance.js';
import { WEAPONS, PERKS } from './sim.js';

const $ = id => document.getElementById(id);
const wname = id => WEAPONS.find(w => w.id === id).name;
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };

// single-hue heat: stronger cell = more amber. Numbers keep the normal text colour.
const heat = f => `rgba(var(--heat), ${(0.06 + 0.5 * Math.max(0, Math.min(1, f))).toFixed(3)})`;

// tooltip for anything with data-tip
const tip = $('tip');
document.addEventListener('mousemove', e => {
  const t = e.target.closest && e.target.closest('[data-tip]');
  if (!t) { tip.style.display = 'none'; return; }
  tip.textContent = t.dataset.tip;
  tip.style.display = 'block';
  tip.style.left = `${Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${Math.min(e.clientY + 14, innerHeight - tip.offsetHeight - 8)}px`;
});

function showPaper() {
  const r = paperReport();
  $('score').textContent = r.score.toFixed(0);
  const parts = [
    [r.scenarioScore.toFixed(0), 'Power curve and ladder, across all situations (70% of the score)'],
    [`${Math.round(r.perkFair * 100)}%`, 'Perks help every weapon evenly (10%)'],
    [`${Math.round((1 - r.lottery) * 100)}%`, 'Stock guns that beat a fully upgraded pistol (10%)'],
    [`${Math.round((1 - r.wild) * 100)}%`, 'Upgrades in the target range (10%)'],
  ];
  $('parts').replaceChildren(...parts.map(([v, t]) => { const d = el('div', 'part'); d.append(el('b', '', v), el('span', '', t)); return d; }));
  const issues = findIssues(r);
  $('issues').replaceChildren(...(issues.length ? issues.map(i => {
    const li = el('li');
    li.append(el('span', i.level, i.level === 'fail' ? '✖ Problem: ' : '▲ Watch: '), document.createTextNode(i.text));
    return li;
  }) : [(() => { const li = el('li'); li.append(el('span', 'ok', '✔ '), document.createTextNode('No issues found.')); return li; })()]));

  // WPI table: heat is per row so each situation reads as its own ladder
  const t = $('wpi');
  t.replaceChildren();
  const head = el('tr');
  head.append(el('th', '', 'Situation'), ...r.scenarios[0].rows.map(c => el('th', '', wname(c.id))), el('th', '', 'Score'));
  t.append(head);
  for (const s of r.scenarios) {
    const tr = el('tr');
    tr.append(el('td', 'row', s.name));
    const lo = Math.log(Math.min(...s.rows.map(c => c.wpi))), hi = Math.log(Math.max(...s.rows.map(c => c.wpi)));
    for (const c of s.rows) {
      const td = el('td', 'cell', Math.round(c.wpi).toLocaleString());
      td.style.background = heat((Math.log(c.wpi) - lo) / (hi - lo || 1));
      td.dataset.tip = `${wname(c.id)}, ${s.name}: single ${Math.round(c.single)} DPS, crowd ${Math.round(c.horde)} DPS, sustained ${Math.round(c.sustained)} DPS, ammo lasts ${Math.round(c.up * 100)}% of the fight`;
      tr.append(td);
    }
    tr.append(el('td', 'num', s.score.toFixed(0)));
    t.append(tr);
  }

  // upgrades
  const max = 2.2, pct = v => `${((v - 1) / (max - 1)) * 100}%`;
  const ups = $('ups');
  ups.replaceChildren();
  for (const u of r.upgrades) {
    if (u.gain === null) continue;
    const track = el('div', 'track');
    const band = el('div', 'band');
    band.style.left = pct(1.25);
    band.style.width = `${(0.5 / (max - 1)) * 100}%`;
    const fill = el('div', 'fill');
    fill.style.width = pct(Math.min(max, Math.max(1, u.gain)));
    track.append(band, fill);
    track.dataset.tip = `${u.name} (${wname(u.w)}): ${u.desc}`;
    ups.append(el('div', 'row', u.name), track, el('div', 'num', `x${u.gain.toFixed(2)}`));
  }
}

// ---- field test: one run at a time, yielding to the browser in between
function runner(jobs, runs, onCell) {
  const bar = $('prog'), text = $('progText');
  const total = jobs.length;
  bar.max = total;
  bar.value = 0;
  for (const b of [$('fieldBtn'), $('perkBtn')]) b.disabled = true;
  return new Promise(res => {
    let i = 0;
    const next = () => {
      if (i >= total) {
        text.textContent = 'Done.';
        for (const b of [$('fieldBtn'), $('perkBtn')]) b.disabled = false;
        res();
        return;
      }
      onCell(jobs[i], fieldCell(jobs[i].cfg, runs));
      i++;
      bar.value = i;
      text.textContent = `${i} / ${total}`;
      setTimeout(next, 0);
    };
    setTimeout(next, 30);
  });
}

function fieldTable() {
  const t = $('field');
  t.replaceChildren();
  const head = el('tr');
  head.append(el('th', '', 'Loadout'), ...FIELD_WEAPONS.map(id => el('th', '', wname(id))));
  t.append(head);
  const cells = {};
  for (const l of FIELD_LOADOUTS) {
    const tr = el('tr');
    tr.append(el('td', 'row', l.name));
    for (const id of FIELD_WEAPONS) {
      const td = el('td', 'cell', '·');
      cells[`${l.id}:${id}`] = td;
      tr.append(td);
    }
    t.append(tr);
  }
  return cells;
}

$('fieldBtn').onclick = () => {
  const cells = fieldTable(), seen = [];
  runner(fieldJobs(), +$('runs').value, (job, c) => {
    const td = cells[`${job.loadout}:${job.weapon}`];
    td.textContent = c.wave.toFixed(1);
    td.dataset.tip = `${wname(job.weapon)}: average wave ${c.wave.toFixed(1)}, median ${c.median}, ${Math.round(c.dry * 100)}% of shots on the pistol after running dry`;
    td.dataset.v = c.wave;
    seen.push(td);
    const vs = seen.map(x => +x.dataset.v), lo = Math.min(...vs), hi = Math.max(...vs);
    for (const x of seen) x.style.background = heat((+x.dataset.v - lo) / (hi - lo || 1));
  });
};

$('perkBtn').onclick = () => {
  const t = $('perks');
  t.replaceChildren();
  const head = el('tr');
  head.append(el('th', '', 'Perk at max rank (Assault Rifle)'), el('th', '', 'Average wave'), el('th', '', 'Gain'));
  t.append(head);
  let base = null;
  runner(perkJobs(), +$('runs').value, (job, c) => {
    if (base === null) base = c.wave;
    const tr = el('tr');
    const pk = PERKS.find(p => p.id === job.perk);
    const gain = c.wave - base;
    tr.append(el('td', 'row', pk ? `${pk.name} x${pk.max}` : 'No perk'), el('td', 'num', c.wave.toFixed(1)), el('td', 'num', pk ? `${gain >= 0 ? '+' : ''}${gain.toFixed(1)}` : '–'));
    t.append(tr);
  });
};

fieldTable();
showPaper();
