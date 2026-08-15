// Reactor panel — the second card widget. "What if this were a panel in a nuclear power station."
//
// This is NOT a skin. Skins here are pure CSS over the rack card's one DOM; this panel has its own
// markup, its own instruments and its own honesty branches, so it lives in its own module the way
// guiTOP carries GpuCardBars alongside GpuCardCorvette. renderer.js picks a widget family from the
// skin control and rebuilds the rack when the family changes (never when only the paint changes).
//
// ONE LAYOUT, TWO IDIOMS, chosen at build time:
//   'room'    — P1 control room: painted steel, ivory faces, incandescent lamps, split-flap counter.
//   'console' — P2 reactor console: the same panel in glass and xenon, lit arcs, nixie tubes.
// Everything else about them is identical, which is the point: an idiom is a finish, not a
// different set of facts.
//
// THE RULE THAT MAKES THE DENSITY HONEST: a control room is dense because it has many real signals,
// not because it has many shapes. Every lamp, meter and counter below is driven by something the
// collectors actually report — an unlit annunciator is a real "not true", the recorder plots
// measured rate only, and the workflow bulb bank only exists when the relay reported an item total,
// so even the number of sockets is a measurement. Nothing here is invented to fill the panel; the
// ornament is bezels, screws and silkscreen, never a number.
//
// The honesty rules carry over unchanged from job-card.js: no step data prints N/A and never a
// fabricated 0, no rate parks the needles at their stops under NO RATE, and an unknown identity
// field hides its row rather than showing a permanent "--".
(function () {
  const SVG = 'http://www.w3.org/2000/svg';

  const svgTag = (tag, attrs) => {
    const el = document.createElementNS(SVG, tag);
    for (const k in attrs || {}) el.setAttribute(k, attrs[k]);
    return el;
  };
  const div = (cls, text) => {
    const el = document.createElement('div');
    el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };
  const span = (cls, text) => {
    const el = document.createElement('span');
    el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };

  // Same compact forms the rack card uses — "3m35s", not "3m 35s". These sit in narrow counter
  // windows where a space costs the tail of the value to an ellipsis.
  function fmtSeconds(s) {
    if (s == null || !Number.isFinite(s)) return '--';
    if (s < 60) return `${s.toFixed(1)}s`;
    let m = Math.floor(s / 60);
    let rem = Math.round(s % 60);
    // 239.6s rounds to "3m60s" without this — a clock that reads 60 seconds past the minute.
    if (rem === 60) {
      m += 1;
      rem = 0;
    }
    if (m < 60) return `${m}m${rem}s`;
    return `${Math.floor(m / 60)}h${m % 60}m`;
  }

  // The figure between the two dials. Same 1.0 cutover the rack card's RATE legend uses, so the
  // panel and the card can never disagree about which unit a rate is being read in.
  const fmtRateValue = (v) => (v == null || !Number.isFinite(v) || v <= 0 ? '--' : v >= 1 ? v.toFixed(2) : (1 / v).toFixed(2));
  const rateUnit = (v) => (v == null || !Number.isFinite(v) || v <= 0 ? '' : v >= 1 ? 'it/s' : 's/it');

  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  // ── Twin rate dials ────────────────────────────────────────────────────────────────────────
  // The rack card's single face, split in two and mirrored: each movement owns one half of the same
  // log scale, the pivots sit at the outer edges and both arcs close toward the middle around the
  // readout (Bryan picked this facing on 2026-08-13 over the back-to-back one).
  //
  // NO NUMBERS ON THE ARCS, deliberately: a fuel gauge has none either — ticks, two end words, and
  // you read the tank from where the needle sits. The exact figure lives in the tell-tale column
  // between the dials, which is where a modern cluster puts it. The long ticks mark the same values
  // the printed face labels, so the graduation is unchanged; only the printing is gone.
  //
  // Both movements read UP for more. That replaces the rack card's "further right is faster": on a
  // mirrored pair, right means opposite things on the two dials, and up does not.
  const OUT_DEG = 135; // slow stop, measured from vertical
  const IN_DEG = 45;   // fast stop
  const SPAN_DEG = OUT_DEG - IN_DEG;

  /**
   * Split the current face into two halves.
   *
   * The marks come from lcd.js's hand-written tables at whatever range the Dials setting is on, so
   * the panel graduates exactly like the card it replaces. Sampling splits at 1:1 — the same
   * crossover the rest of the app flips its printed unit at. Training has no fast half at all
   * (nothing Bryan trains runs above 1 it/s), so it splits coarse/fine at the geometric middle of
   * its range instead: the left dial covers the long tail, the right expands the band every real
   * run actually sits in.
   */
  function twinSpec(kind) {
    const face = window.Widgets.faceSpec(kind);
    const min = 10 ** face.minLog; // it/s at the slow stop
    const max = 10 ** face.maxLog;
    // Where the pair is cut is a property of the FACE, not of the host kind: any single-unit face
    // (training, video) ends at 1 it/s, so splitting it at 1:1 would leave the right-hand movement
    // with no scale at all. Those split coarse/fine at the geometric middle instead — the left dial
    // covers the long tail, the right expands the band real runs sit in.
    const single = !!face.units.single;
    const split = single ? 10 ** ((face.minLog + face.maxLog) / 2) : 1;
    const splitWord = single ? `${Math.round(1 / split)}s` : '1:1';
    const marks = face.marks.map((m) => ({ v: m.v, major: !!m.label || !!m.centre }));
    const half = (lo, hi) => ({
      min: lo,
      max: hi,
      // A half keeps the marks inside its own band, plus its two end stops — a movement whose scale
      // stops short of its own needle stop looks like a broken instrument.
      marks: dedupeMarks([
        { v: lo, major: true },
        ...marks.filter((m) => m.v > lo * 1.0001 && m.v < hi * 0.9999),
        { v: hi, major: true },
      ]),
    });
    return {
      left: { ...half(min, split), endSlow: 'SLOW', endFast: splitWord },
      right: { ...half(split, max), endSlow: splitWord, endFast: 'FAST' },
    };
  }

  function dedupeMarks(list) {
    const out = [];
    for (const m of list) {
      const dup = out.find((o) => Math.abs(Math.log10(o.v) - Math.log10(m.v)) < 0.01);
      if (dup) dup.major = dup.major || m.major;
      else out.push({ ...m });
    }
    return out;
  }

  function createTwinDial(faceName) {
    let kind = faceName;
    const svg = svgTag('svg', { viewBox: '0 0 240 120', class: 'p-svg' });
    // overflow hidden, unlike the other instruments: the pivots sit on the face edge, and two red
    // hubs sitting out in the open were the giveaway that this was two little meters rather than
    // one cluster with two movements.
    svg.style.overflow = 'hidden';
    // ONE face behind both movements, not two — a cluster is a single panel with two pointers
    // printed on it, and two abutting rectangles read as two instruments that happen to touch.
    svg.appendChild(svgTag('rect', { x: 2, y: 2, width: 236, height: 116, rx: 18, class: 't-face' }));

    const readVal = svgTag('text', { x: 120, y: 57, class: 't-read' });
    const readUnit = svgTag('text', { x: 120, y: 71, class: 't-read-unit' });
    const noRate = svgTag('text', { x: 120, y: 89, class: 'm-nosig' });
    noRate.textContent = 'NO RATE';

    const halves = [];
    for (const side of ['left', 'right']) {
      const mirror = side === 'right';
      const px = mirror ? 216 : 24;
      const py = 60;
      const R = 52;
      const sign = mirror ? -1 : 1; // which way this movement sweeps away from its pivot
      const g = svgTag('g', { class: `t-half t-half--${side}` });
      const grads = svgTag('g', { class: 't-grads' });
      const angleAt = (t) => sign * (OUT_DEG - clamp01(t) * SPAN_DEG);
      const at = (a, r) => [px + r * Math.sin((a * Math.PI) / 180), py - r * Math.cos((a * Math.PI) / 180)];

      // The lit bar (console idiom) is the OUTERMOST ring — outside the needle, outside the
      // graduations — so the quadrant reads as the rim of a round gauge rather than as a second
      // scale drawn in among the ticks.
      const RA = R + 18;
      const arcTrack = svgTag('path', { class: 't-arc-track', pathLength: 1, 'stroke-dasharray': '1 1' });
      const arc = svgTag('path', { class: 't-arc', pathLength: 1, 'stroke-dasharray': '0 1' });
      const needle = svgTag('line', { x1: px, y1: py, x2: px, y2: py - (R + 2), class: 't-needle' });
      // A small dark boss, not a red button: with the pivot out on the face, a fat coloured hub is
      // the biggest thing on the instrument and it carries no reading at all.
      const hub = svgTag('circle', { cx: px, cy: py, r: 3.4, class: 't-hub' });
      const capSlow = svgTag('text', { class: 't-cap t-cap--end' });
      const capFast = svgTag('text', { class: 't-cap t-cap--end' });

      const [ax0, ay0] = at(angleAt(0), RA);
      const [ax1, ay1] = at(angleAt(1), RA);
      const arcD = `M ${ax0.toFixed(2)} ${ay0.toFixed(2)} A ${RA} ${RA} 0 0 ${mirror ? 1 : 0} ${ax1.toFixed(2)} ${ay1.toFixed(2)}`;
      arcTrack.setAttribute('d', arcD);
      arc.setAttribute('d', arcD);

      g.append(grads, arcTrack, arc, needle, hub, capSlow, capFast);
      svg.appendChild(g);

      const half = {
        g, grads, arc, needle, capSlow, capFast, mirror, sign, px, py, R, at, angleAt,
        spec: null,
        pos(v) {
          const s = this.spec;
          return clamp01((Math.log10(v) - Math.log10(s.min)) / (Math.log10(s.max) - Math.log10(s.min)));
        },
      };
      half.pointer = window.Widgets.createNeedle((deg) => {
        half.needle.setAttribute('transform', `rotate(${deg.toFixed(2)} ${half.px} ${half.py})`);
        // The lit arc grows from this movement's own stop up to its needle.
        const t = clamp01(Math.abs(deg - sign * OUT_DEG) / SPAN_DEG);
        half.arc.setAttribute('stroke-dasharray', `${t.toFixed(4)} 1`);
        // A round cap on a zero-length dash still paints a lit dot, and a dot at the stop would
        // read as a measurement — the same trap the rack card's halo arc hit.
        half.arc.style.visibility = t > 0.004 ? '' : 'hidden';
      }, sign * OUT_DEG);
      halves.push(half);
    }

    svg.append(readVal, readUnit, noRate);

    let lastRate = null;

    function drawFace() {
      const spec = twinSpec(kind);
      for (const half of halves) {
        const s = spec[half.mirror ? 'right' : 'left'];
        half.spec = s;
        half.grads.replaceChildren();
        for (const m of s.marks) {
          const a = half.angleAt(half.pos(m.v));
          const [x1, y1] = half.at(a, half.R);
          const [x2, y2] = half.at(a, half.R + (m.major ? 9 : 5));
          half.grads.appendChild(svgTag('line', { x1, y1, x2, y2, class: `m-tick${m.major ? ' m-tick--maj' : ''}` }));
        }
        // The two end words, parked just inside each stop and rotated a few degrees into the sweep
        // so they never land on the graduation marking the same stop — printed exactly on it, the
        // tick draws straight through the word. Facing inward, the space outside the rim belongs to
        // the readout, so the words tuck inside the arc; never in the 9px band between ticks and
        // rim, where a word collides with both.
        const rLab = half.R - 17;
        const [sx, sy] = half.at(half.angleAt(0) + half.sign * -7, rLab);
        const [fx, fy] = half.at(half.angleAt(1) + half.sign * 7, rLab);
        half.capSlow.setAttribute('x', sx);
        half.capSlow.setAttribute('y', sy + 3);
        half.capSlow.textContent = s.endSlow;
        half.capFast.setAttribute('x', fx);
        half.capFast.setAttribute('y', fy + 3);
        half.capFast.textContent = s.endFast;
        // No unit word on the face: the figure between the dials prints the unit of whichever half
        // is live, so a unit here would be a second, sometimes-wrong claim.
      }
    }

    drawFace();

    return {
      svg,
      /** @returns {boolean} whether the instrument is reading anything. */
      set(v) {
        lastRate = v;
        const live = v != null && Number.isFinite(v) && v > 0;
        for (const half of halves) {
          const s = half.spec;
          // A movement claims the reading only when the value falls in ITS half of the scale; the
          // other drops to its stop and goes dim, exactly as the rack face dims the unit word it is
          // not reading. Two lit dials would be two claims about one rate.
          const mine = live && (half.mirror ? v >= s.min : v <= s.max);
          half.pointer.setAngle(mine ? half.angleAt(half.pos(v)) : half.sign * OUT_DEG);
          half.g.classList.toggle('t-half--live', !!mine);
          half.g.classList.toggle('t-half--rest', !mine);
        }
        readVal.textContent = live ? fmtRateValue(v) : '--';
        readUnit.textContent = live ? rateUnit(v) : '';
        return live;
      },
      /** Reprint both halves after a Dials range change, then re-point at the same reading. */
      refreshFace() {
        drawFace();
        this.set(lastRate);
      },
      /** Same instrument, different scale — the running job turned out to be video. No-op if same. */
      setFace(name) {
        if (name === kind) return;
        kind = name;
        this.refreshFace();
      },
      destroy() {
        for (const half of halves) half.pointer.destroy();
      },
    };
  }

  // ── Small panel movement (cycle progress) ──────────────────────────────────────────────────
  // Linear 0..100%, one pointer. The reading is a ratio, not a rate, so it has no log scale and no
  // unit word — the ticks and the two end numbers are the whole face.
  const PCT_SWEEP = 100;
  const PCT_MARKS = [[0, '0'], [0.25, ''], [0.5, '50'], [0.75, ''], [1, '100']];

  function createPctMeter() {
    const svg = svgTag('svg', { viewBox: '0 0 120 62', class: 'p-svg' });
    // Clipped, unlike the instruments whose whole movement is on the face: the pivot sits BELOW the
    // face so only the top of the swing shows, and without the clip the hub hangs out under the
    // bottom edge and paints a red blob over the legend (seen at 520px, 2026-08-14). Every
    // graduation and label is inside the box, so nothing readable is lost.
    svg.style.overflow = 'hidden';
    const cx = 60;
    const cy = 64;
    const R = 40;
    const rad = (a) => ((a - 90) * Math.PI) / 180;
    const at = (a, r) => [cx + r * Math.cos(rad(a)), cy + r * Math.sin(rad(a))];

    svg.appendChild(svgTag('rect', { x: 1, y: 1, width: 118, height: 60, rx: 3, class: 'm-face' }));
    for (const [v, label] of PCT_MARKS) {
      const a = -PCT_SWEEP / 2 + v * PCT_SWEEP;
      const [x1, y1] = at(a, R);
      const [x2, y2] = at(a, R + (label ? 7 : 4));
      svg.appendChild(svgTag('line', { x1, y1, x2, y2, class: `m-tick${label ? ' m-tick--maj' : ''}` }));
      if (label) {
        const [lx, ly] = at(a, R + 14);
        const t = svgTag('text', { x: lx, y: ly + 2.5, class: 'm-lab' });
        t.textContent = label;
        svg.appendChild(t);
      }
    }

    const [ax0, ay0] = at(-PCT_SWEEP / 2, R - 5);
    const [ax1, ay1] = at(PCT_SWEEP / 2, R - 5);
    const arcD = `M ${ax0.toFixed(2)} ${ay0.toFixed(2)} A ${R - 5} ${R - 5} 0 0 1 ${ax1.toFixed(2)} ${ay1.toFixed(2)}`;
    svg.appendChild(svgTag('path', { d: arcD, class: 'm-arc-track', pathLength: 1, 'stroke-dasharray': '1 1' }));
    const arc = svgTag('path', { d: arcD, class: 'm-arc', pathLength: 1, 'stroke-dasharray': '0 1' });
    const needle = svgTag('line', { x1: cx, y1: cy, x2: cx, y2: cy - (R + 2), class: 'm-needle' });
    const hub = svgTag('circle', { cx, cy, r: 5, class: 'm-hub' });
    const noSig = svgTag('text', { x: 60, y: 40, class: 'm-nosig' });
    noSig.textContent = 'NO SIGNAL';
    svg.append(arc, needle, hub, noSig);

    const pointer = window.Widgets.createNeedle((deg) => {
      needle.setAttribute('transform', `rotate(${deg.toFixed(2)} ${cx} ${cy})`);
      const t = clamp01((deg + PCT_SWEEP / 2) / PCT_SWEEP);
      arc.setAttribute('stroke-dasharray', `${t.toFixed(4)} 1`);
      arc.style.visibility = t > 0.004 ? '' : 'hidden';
    }, -PCT_SWEEP / 2);

    return {
      svg,
      set(v) {
        const live = v != null && Number.isFinite(v) && v >= 0;
        pointer.setAngle(live ? -PCT_SWEEP / 2 + clamp01(v) * PCT_SWEEP : -PCT_SWEEP / 2);
        return live;
      },
      destroy() {
        pointer.destroy();
      },
    };
  }

  // ── Step counter mechanisms ────────────────────────────────────────────────────────────────
  // Split-flap in the control room, nixie in the console (Bryan's pick). Same interface, so the
  // panel neither knows nor cares which one it is holding: setValue(n) / setNA().
  //
  // Fixed width, with LEADING ZEROS — a mechanical counter has a wheel in every position and is
  // always showing something; blank leaves and dead tubes read as a broken display. The width grows
  // if a job needs more digits than the kind's default (a 150-step sampler exists), because
  // truncating a real number to fit the mechanism would be a lie. It never shrinks back mid-job:
  // wheels do not vanish.
  function createFlapCounter() {
    const rack = div('p-rack');
    const cells = [];
    const grow = (width) => {
      while (cells.length < width) {
        const card = div('fl');
        const top = div('fl-half fl-half--top');
        const bot = div('fl-half fl-half--bot');
        const topT = div('fl-txt', '0');
        const botT = div('fl-txt', '0');
        top.appendChild(topT);
        bot.appendChild(botT);
        card.append(top, bot);
        rack.insertBefore(card, rack.firstChild); // new wheels appear on the left, as on real gear
        cells.unshift({ card, topT, botT, cur: '0' });
      }
    };
    return {
      rack,
      set(text, width) {
        grow(Math.max(width, String(text).length));
        const s = String(text).padStart(cells.length, '0');
        cells.forEach((c, i) => {
          const ch = s[i];
          if (ch === c.cur) return;
          const old = c.cur;
          c.cur = ch;
          // The bottom leaf keeps the OLD digit until the falling leaf hides it — swapping it early
          // is what makes a fake flip look fake.
          c.topT.textContent = ch;
          const down = div('fl-leaf fl-leaf--down');
          const dInner = div('fl-half fl-half--top');
          dInner.appendChild(div('fl-txt', old));
          down.appendChild(dInner);
          const up = div('fl-leaf fl-leaf--up');
          const uInner = div('fl-half fl-half--bot');
          uInner.appendChild(div('fl-txt', ch));
          up.appendChild(uInner);
          c.card.append(down, up);
          setTimeout(() => {
            c.botT.textContent = ch;
            down.remove();
          }, 150);
          setTimeout(() => up.remove(), 330);
        });
      },
    };
  }

  function createNixieCounter() {
    const rack = div('p-rack');
    const tubes = [];
    const grow = (width) => {
      while (tubes.length < width) {
        const tube = div('nx');
        const digits = [];
        for (let d = 0; d < 10; d++) {
          const el = div('nx-d', String(d));
          // Cathodes sit at different depths in a real tube — without the offsets the unlit stack
          // reads as ten copies of one glyph instead of wire numerals behind one another. That
          // ghosting is the reason a nixie cannot be faked with a font.
          el.style.transform = `scale(${(0.94 + d * 0.006).toFixed(3)}) translateX(${((d % 3) - 1) * 0.6}px)`;
          tube.appendChild(el);
          digits.push(el);
        }
        rack.insertBefore(tube, rack.firstChild);
        tubes.unshift({ digits, on: -1 });
      }
    };
    return {
      rack,
      set(text, width) {
        grow(Math.max(width, String(text).length));
        const s = String(text).padStart(tubes.length, '0');
        tubes.forEach((t, i) => {
          const d = Number(s[i]);
          if (d === t.on) return;
          t.digits.forEach((el, k) => {
            const on = k === d;
            el.classList.toggle('nx-d--on', on);
            if (on) {
              el.classList.remove('nx-d--strike');
              void el.offsetWidth; // restart the strike animation
              el.classList.add('nx-d--strike');
            }
          });
          t.on = d;
        });
      },
    };
  }

  function createStepCounter(idiom, width) {
    const win = div('p-stepwin');
    const mech = idiom === 'console' ? createNixieCounter() : createFlapCounter();
    const na = div('p-stepna', 'N/A');
    win.append(mech.rack, na);
    // Build the wheels up front, before any reading arrives. The N/A overlay is positioned over the
    // window, and an empty mechanism gives the window no height at all — an idle host showed an
    // empty box where the words should be (found on the first render, 2026-08-14). The mechanism is
    // hidden behind visibility, which still reserves its space, so the window is always counter-high.
    mech.set(0, width);
    win.classList.add('p-stepwin--na');
    return {
      win,
      setValue(n) {
        win.classList.remove('p-stepwin--na');
        mech.set(n, width);
      },
      // No step data blanks the mechanism and prints the words. Zeros are for positions a real
      // number does not reach, never for "we do not know" — the same rule the rack card's numerals
      // follow, and the normal case for a foreign job on a host without the relay node.
      setNA() {
        win.classList.add('p-stepwin--na');
      },
    };
  }

  // ── Digital counter window ─────────────────────────────────────────────────────────────────
  function createCounter(label) {
    const wrap = div('p-count-wrap');
    const box = div('p-count');
    const val = span('p-count-val', '--');
    box.appendChild(val);
    wrap.append(box, span('p-cap', label));
    return {
      wrap,
      relabel(text) {
        wrap.querySelector('.p-cap').textContent = text;
      },
      /** A live reading: lit in the job colour when there is something to read, dim when not. */
      set(text, live) {
        wrap.hidden = false;
        val.textContent = text;
        val.classList.toggle('p-count-val--dim', !live);
        val.classList.remove('p-count-val--static');
      },
      /**
       * A fact about the host rather than a reading: plate ink, no glow, and the whole window is
       * removed when there is no value — unlike a reading, which has a dim state because "nothing
       * right now" is itself the answer. A version either exists or was never knowable.
       */
      setStatic(text) {
        wrap.hidden = text == null;
        val.textContent = text ?? '--';
        val.title = text ?? '';
        val.classList.add('p-count-val--static');
        val.classList.remove('p-count-val--dim');
      },
    };
  }

  function setTell(slot, text, live) {
    slot.v.textContent = text;
    slot.v.classList.toggle('p-tell-val--dim', !live);
  }

  // ── Rate recorder ──────────────────────────────────────────────────────────────────────────
  // 60 seconds of measured rate on a moving chart: time runs left to right, the pen is NOW, and
  // height is the same log scale the dials are graduated with — so higher on the chart is faster,
  // exactly as further round the dial is faster. A gap in the trace is a gap in the measurement —
  // the pen lifts rather than interpolating across a stall.
  //
  // IT HAS TO SAY WHAT IT IS. Unlabelled, a nearly flat trace on a filled chart reads as a level
  // gauge rather than a rate over time ("I don't know how to interpret it" — Bryan, 2026-08-14), so
  // the two ends of the scale are printed down the left edge in the same units the dial prints, the
  // window is marked at both ends of the time axis, and a dashed line marks the 1:1 crossover when
  // the face has one. Those four labels are the whole difference between a shape and a reading.
  const RECORDER_SAMPLES = 120; // 60s at the collector's 500ms snapshot tick

  // The face's own end values, said out loud: "20 s/it" at the slow end, "20 it/s" at the fast one.
  // Trailing zeros are trimmed — these are scale ends, not readings, and "20.00 it/s" in a corner
  // label reads as a measurement of something.
  function scaleWord(itPerSec, single) {
    // 1 it/s is the crossover on a two-unit face, so it is named as one: "1:1". On a single-unit
    // face it is not a crossover at all, it is simply the fast end of a scale printed in s/it —
    // labelling it 1:1 there invites the reading that the chart flips units halfway up, which it
    // does not.
    if (!single && Math.abs(Math.log10(itPerSec)) < 0.01) return '1:1';
    const v = itPerSec >= 1 ? itPerSec : 1 / itPerSec;
    return `${Number(v.toFixed(2))} ${single ? 's/it' : rateUnit(itPerSec)}`;
  }

  function createRecorder(faceName) {
    let kind = faceName;
    const box = div('p-chart');
    // preserveAspectRatio="none" stretches the drawing to the panel width, which is right for a
    // trace and wrong for text — so every label here is HTML positioned over the chart, never an
    // SVG <text> that would come out smeared.
    const plot = div('p-chart-plot');
    const svg = svgTag('svg', { viewBox: '0 0 300 38', preserveAspectRatio: 'none', class: 'p-svg' });
    for (let i = 1; i < 6; i++) svg.appendChild(svgTag('line', { x1: i * 50, y1: 2, x2: i * 50, y2: 36, class: 'c-grid' }));
    for (let i = 1; i < 3; i++) svg.appendChild(svgTag('line', { x1: 0, y1: i * 12, x2: 300, y2: i * 12, class: 'c-grid' }));
    const mid = svgTag('line', { x1: 0, x2: 300, y1: 0, y2: 0, class: 'c-mid' });
    const fill = svgTag('path', { d: '', class: 'c-fill' });
    const line = svgTag('path', { d: '', class: 'c-line' });
    const pen = svgTag('circle', { r: 2.4, cx: -9, cy: -9, class: 'c-pen' });
    svg.append(mid, fill, line, pen);
    const labFast = div('c-lab c-lab--fast');
    const labSlow = div('c-lab c-lab--slow');
    plot.append(svg, labFast, labSlow);
    // The time axis is stated in the caption rather than labelled inside the plot: the pen lives at
    // the right edge, so a "now" tag there sits on top of the trace exactly when the trace is
    // interesting. Direction is the whole point of the caption — read left to right, the right edge
    // is this second.
    box.append(plot, span('p-cap', 'Rate recorder · 60 s ago → now'));

    let face = window.Widgets.faceSpec(kind);
    const hist = [];
    const pos = (v) => clamp01((Math.log10(v) - face.minLog) / (face.maxLog - face.minLog));

    function drawScale() {
      const single = !!face.units.single;
      labFast.textContent = scaleWord(10 ** face.maxLog, single);
      labSlow.textContent = scaleWord(10 ** face.minLog, single);
      // The 1:1 crossover, where the printed unit flips — the one horizontal line on this chart that
      // means something. A face that does not span it (training) simply does not draw it.
      const spans = face.minLog < 0 && face.maxLog > 0;
      mid.style.display = spans ? '' : 'none';
      if (spans) {
        const y = 36 - pos(1) * 32;
        mid.setAttribute('y1', y);
        mid.setAttribute('y2', y);
      }
    }

    function redraw() {
      const pts = hist
        .map((x, i) => (x == null ? null : { x: 300 - (hist.length - 1 - i) * 2.5, y: 36 - pos(x) * 32 }))
        .filter(Boolean);
      if (pts.length > 1) {
        const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
        line.setAttribute('d', d);
        fill.setAttribute('d', `${d} L ${pts[pts.length - 1].x.toFixed(1)} 38 L ${pts[0].x.toFixed(1)} 38 Z`);
        const last = pts[pts.length - 1];
        pen.setAttribute('cx', last.x);
        pen.setAttribute('cy', last.y);
        pen.style.visibility = hist[hist.length - 1] == null ? 'hidden' : '';
      } else {
        line.setAttribute('d', '');
        fill.setAttribute('d', '');
        pen.style.visibility = 'hidden';
      }
    }

    drawScale();

    return {
      box,
      push(v) {
        hist.push(v != null && Number.isFinite(v) && v > 0 ? v : null);
        while (hist.length > RECORDER_SAMPLES) hist.shift();
        redraw();
      },
      /** A Dials range change rescales the chart in place — the samples are unchanged. */
      refreshFace() {
        face = window.Widgets.faceSpec(kind);
        drawScale();
        redraw();
      },
      /**
       * Follow the dial onto a different face. The samples are kept: they are measured rates in
       * it/s, and the chart only ever decided how to DRAW them — replotting the same 60 seconds on
       * the new scale is the honest thing, and throwing the history away would blank the one
       * instrument that shows what the rate was doing before the switch.
       */
      setFace(name) {
        if (name === kind) return;
        kind = name;
        this.refreshFace();
      },
    };
  }

  // ── LED bulb banks ─────────────────────────────────────────────────────────────────────────
  // Real bulbs in real sockets, and they replace the rack card's progress bar outright — the bar was
  // the same fact in a weaker language. One bank per progress that actually exists: steps within the
  // current node, and (for a batch) one bulb per image across the whole workflow.
  function createLedBank(label) {
    const row = div('p-led-row');
    const cap = div('p-led-cap', label);
    const bulbs = div('p-bulbs');
    const txt = span('p-led-txt', '');
    row.append(cap, bulbs, txt);
    const state = { count: 0, on: -1 };
    return {
      row,
      txt,
      relabel(text) {
        cap.textContent = text;
      },
      resize(count) {
        if (state.count === count) return;
        bulbs.replaceChildren();
        for (let i = 0; i < count; i++) bulbs.appendChild(div('p-bulb'));
        state.count = count;
        state.on = -1;
      },
      light(k, live) {
        [...bulbs.children].forEach((b, i) => {
          const on = i < k;
          // Strike only the bulbs that just came on — a whole bank flashing on every repaint would
          // be an animation of nothing.
          if (on && i >= state.on && state.on >= 0) {
            b.classList.remove('p-bulb--strike');
            void b.offsetWidth;
            b.classList.add('p-bulb--strike');
            // The strike has to come off again or it keeps overriding the steady state — in the
            // control room that steady state is the mains flicker, which would never run.
            b.addEventListener('animationend', () => b.classList.remove('p-bulb--strike'), { once: true });
          }
          b.classList.toggle('p-bulb--on', on);
        });
        state.on = k;
        row.classList.toggle('p-led-row--live', !!live);
      },
    };
  }

  // ── Annunciator bank ───────────────────────────────────────────────────────────────────────
  // Eight tiles, every one a real collector condition. `relay` is the only snapshot field the rack
  // card ignores; here it gets a lamp, and it follows the collector's own rule — false is claimed
  // only after a job has run 10s with no relay traffic, so an idle host never accuses anyone.
  const ANNUNCIATORS = [
    { key: 'run', text: 'Reactor Run', tone: 'run' },
    { key: 'queue', text: 'Queued', tone: 'wait' },
    { key: 'batch', text: 'Batch Run', tone: 'run' },
    { key: 'nosteps', text: 'No Step Data', tone: 'wait' },
    { key: 'relay', text: 'Relay Absent', tone: 'wait' },
    { key: 'done', text: 'Cycle Done', tone: 'ok' },
    { key: 'fault', text: 'Fault', tone: 'err' },
    { key: 'offline', text: 'Offline', tone: 'err' },
  ];

  // What a panel of each kind reads. Same split as the rack card's KINDS: a trainer differs only in
  // which face its dials carry and which three facts identify the job.
  // The four windows under the step counter. A ComfyUI host prints WHAT IT IS BUILT FROM — the four
  // numbers that answer "why is this box behaving differently from that one" (Bryan asked for these
  // on 2026-08-14). They are host facts, not readings, so they are set in plate ink rather than the
  // job colour, and a window whose value nobody can know is removed rather than dashed: the driver
  // needs the relay node's `/watcher/host_info`, and COMFYUI/PYTORCH/CUDA need a reachable host.
  // The live job figures those windows used to hold moved to the tell-tale line under the banks.
  //
  // A trainer has no such endpoint, so an ai-toolkit panel keeps its live counters there. Same
  // column, different contents — the panel structure does not fork.
  // ORDER IS THE LAYOUT: two per row, so this reads down the column as
  //   ComfyUI | Driver
  //   PyTorch | CUDA
  // — the app and the driver on the top line, the two things the app is built against under them
  // (Bryan's arrangement, 2026-08-14). The accelerator window RELABELS ITSELF from what the host
  // reports: CUDA on an NVIDIA box, ROCm on an AMD one.
  const COMFY_WINDOWS = [
    { key: 'comfyui', label: 'ComfyUI' },
    { key: 'driver', label: 'Driver' },
    { key: 'pytorch', label: 'PyTorch' },
    { key: 'accel', label: 'CUDA' },
  ];
  const TRAIN_WINDOWS = [
    { key: 'eta', label: 'ETA' },
    { key: 'elapsed', label: 'Elapsed' },
    { key: 'loss', label: 'Loss' },
    { key: 'queue', label: 'Queue' },
  ];

  const KIND_SPECS = {
    comfyui: {
      face: 'sampling',
      rateLegend: 'Sampling Rate',
      stepBank: 'Step Progress',
      identLabels: ['Model', 'Size', 'Batch'],
      windows: COMFY_WINDOWS,
      tellTale: true, // ETA / Elapsed / Batch ETA / Queue, in one line under the banks
      unit: 'UNIT G-1',
      digits: 2, // a sampler node rarely passes two digits; the mechanism grows if one does
    },
    aitoolkit: {
      face: 'training',
      rateLegend: 'Training Rate',
      stepBank: 'Run Progress',
      identLabels: ['Base Model', 'Resolution', 'Rank'],
      windows: TRAIN_WINDOWS,
      tellTale: false,
      unit: 'UNIT T-1',
      digits: 4,
    },
  };

  /**
   * @param {string} hostName
   * @param {'comfyui'|'aitoolkit'} [kind]
   * @param {'room'|'console'} [idiom]
   */
  function createReactorPanel(hostName, kind, idiom) {
    const kindKey = KIND_SPECS[kind] ? kind : 'comfyui';
    const spec = KIND_SPECS[kindKey];
    const skin = idiom === 'console' ? 'console' : 'room';
    const train = kindKey === 'aitoolkit';

    const pan = div(`pan pan--${skin}`);
    pan.dataset.host = hostName;
    pan.dataset.kind = kindKey;
    pan.dataset.face = spec.face;
    pan.dataset.idiom = skin;
    pan.dataset.widget = 'reactor';
    for (const corner of ['tl', 'tr', 'bl', 'br']) pan.appendChild(div(`p-screw p-screw--${corner}`));

    // ── Header: unit designation ──
    const head = div('p-head');
    const jewel = div('p-jewel');
    const unit = span('p-unit', spec.unit);
    const name = span('p-name', hostName);
    const mode = span('p-mode');
    const stat = span('p-hstat');
    head.append(jewel, unit, name, mode, stat);

    const ann = div('p-ann');
    const tiles = {};
    for (const a of ANNUNCIATORS) {
      const tile = div('p-tile', a.text);
      tile.style.setProperty('--tone', `var(--p-${a.tone})`);
      ann.appendChild(tile);
      tiles[a.key] = { el: tile, on: false };
    }

    // ── Instrument row ──
    // THREE COLUMNS, and the third is a stack rather than a third instrument. A step counter is a
    // small mechanism in a well as tall as a dial, so on its own it left a third of the panel empty
    // ("why does STEPS LEFT have soooo much dead space" — Bryan, 2026-08-14). The four digital
    // counters used to sit in their own full-width row underneath; moved into that column they fill
    // the space the counter does not need AND delete a row from the panel.
    const row = div('p-row');
    const rateBox = div('p-inst p-inst--rate');
    const dial = createTwinDial(spec.face);
    rateBox.append(dial.svg, span('p-cap', spec.rateLegend));

    const progBox = div('p-inst p-inst--prog');
    const pct = createPctMeter();
    progBox.append(pct.svg, span('p-cap', 'Cycle Progress'));

    const stepsBox = div('p-inst p-inst--steps');
    const steps = createStepCounter(skin, spec.digits);
    stepsBox.append(steps.win, span('p-cap', 'Steps Left'));

    const counts = div('p-counts');
    const windows = {};
    for (const w of spec.windows) {
      const win = createCounter(w.label);
      windows[w.key] = win;
      counts.append(win.wrap);
    }

    const stack = div('p-stack');
    stack.append(stepsBox, counts);
    row.append(rateBox, progBox, stack);

    const recorder = createRecorder(spec.face);

    const leds = div('p-leds');
    const ledStep = createLedBank(spec.stepBank);
    const ledFlow = createLedBank('Workflow');
    leds.append(ledStep.row, ledFlow.row);

    // ── Tell-tale line ──
    // The live job figures, in one strip instead of four windows. They were not dropped when the
    // windows became build info: ETA is the single most-asked question of a watcher, and a panel
    // that shows a driver version but not "when is it done" would be a worse instrument.
    const tell = spec.tellTale ? div('p-tell') : null;
    const tells = {};
    if (tell) {
      for (const [key, label] of [['elapsed', 'Elapsed'], ['eta', 'ETA'], ['jobeta', 'Batch ETA'], ['queue', 'Queue']]) {
        const item = div('p-tell-item');
        const l = span('p-tell-lab', label);
        const v = span('p-tell-val', '--');
        item.append(l, v);
        tell.appendChild(item);
        tells[key] = { item, v };
      }
    }

    // ── Identity plate ──
    const plate = div('p-plate');
    const plateRow = (label) => {
      const r = div('p-plate-row');
      const l = span('p-plate-lab', label);
      const v = span('p-plate-val', '--');
      r.append(l, v);
      plate.appendChild(r);
      return { r, l, v };
    };
    const pModel = plateRow(spec.identLabels[0]);
    const pSize = plateRow(spec.identLabels[1]);
    const pCount = plateRow(spec.identLabels[2]);
    const pProcess = plateRow('Process');

    pan.append(head, ann, row, recorder.box, leds, ...(tell ? [tell] : []), plate);

    pan._reactor = {
      spec, train, tiles, jewel, mode, stat, dial, pct, steps, recorder,
      rateBox, progBox, stepsBox, windows, tells,
      leds: { step: ledStep, flow: ledFlow },
      plate: { model: pModel, size: pSize, count: pCount, process: pProcess },
    };
    return pan;
  }

  function updateReactorPanel(pan, hostName, snapshot) {
    const p = pan._reactor;
    pan.querySelector('.p-name').textContent = hostName;

    const status = snapshot?.status ?? 'offline';
    const online = status === 'online';
    const job = snapshot?.currentJob ?? null;
    const running = !!job && !job.finished;
    const queue = snapshot?.queueRemaining ?? null;

    // Print the scale this job belongs on before reading anything off the instruments. Same rule the
    // rack card follows (job-card.js faceFor): a trainer never moves, a ComfyUI host follows what it
    // is currently making, and unknown media keeps the face already on the panel rather than
    // flipping back to stills in the gap between two video jobs.
    if (pan.dataset.kind !== 'aitoolkit') {
      const media = job?.media ?? null;
      const face = media === 'video' ? 'video' : media === 'image' ? 'sampling' : pan.dataset.face;
      if (face && face !== pan.dataset.face) {
        pan.dataset.face = face;
        p.dial.setFace(face);
        p.recorder.setFace(face);
      }
    }

    pan.dataset.status = status;
    p.stat.textContent = status;
    pan.classList.toggle('pan--run', running);
    pan.classList.toggle('pan--ok', job?.finished === 'success');
    pan.classList.toggle('pan--err', job?.finished === 'error' || !online);
    // A panel collapses to header + annunciators only when the unit is NOT THERE — offline,
    // unreachable, still connecting. An online host keeps every instrument even with nothing
    // running (Bryan, 2026-08-13): a reachable instance is the thing being waited on, so its panel
    // should already read as instruments at rest rather than as a lid.
    pan.classList.toggle('pan--blank', !job && !online);

    // The host's own account of itself, verbatim, never invented from status — a training run
    // spends minutes on "Loading dataset" before its first step, and without this the panel reads
    // "running, no numbers" throughout, which is indistinguishable from a stall.
    p.mode.textContent = running
      ? job.phase ?? 'RUN'
      : job?.finished
        ? job.stateText ?? (job.finished === 'success' ? 'DONE' : 'FAULT')
        : online ? 'STANDBY' : '';

    const hasSteps = !!job && Number.isFinite(job.maxSteps) && job.maxSteps > 0;
    const done = hasSteps ? Math.min(job.maxSteps, job.step ?? 0) : null;
    const ratio = hasSteps ? done / job.maxSteps : null;
    // Only a running job has a rate. A finished one is holding its last numbers, and a needle left
    // pointing at the rate of work that stopped is a measurement of nothing.
    const rate = running && Number.isFinite(job.stepsPerSec) && job.stepsPerSec > 0 ? job.stepsPerSec : null;
    const passTotal = running ? job.passTotal ?? null : null;

    // ── Annunciators ──
    const lit = {
      run: running,
      queue: !!queue,
      batch: running && (job.passTotal ?? 0) > 1,
      nosteps: running && !hasSteps,
      relay: snapshot?.relay === false,
      done: job?.finished === 'success',
      fault: job?.finished === 'error',
      offline: !online,
    };
    for (const a of ANNUNCIATORS) {
      const tile = p.tiles[a.key];
      const on = !!lit[a.key];
      // A tile that has just come true flashes three times and then holds, the way a real one does.
      if (on && !tile.on) {
        tile.el.classList.remove('p-tile--new');
        void tile.el.offsetWidth;
        tile.el.classList.add('p-tile--new');
      }
      tile.on = on;
      tile.el.classList.toggle('p-tile--on', on);
    }

    // ── Instruments ──
    const rateLive = p.dial.set(rate);
    p.rateBox.classList.toggle('p-inst--live', rateLive);
    p.rateBox.classList.toggle('p-inst--nosig', !rateLive);

    // A finished-successful cycle reads 100%, which is a real fact about it; a failed one holds
    // wherever it stopped.
    const pctValue = job?.finished === 'success' ? 1 : hasSteps ? ratio : null;
    const pctLive = p.pct.set(pctValue);
    p.progBox.classList.toggle('p-inst--live', pctValue != null);
    p.progBox.classList.toggle('p-inst--nosig', !pctLive);

    if (job?.finished === 'success') p.steps.setValue(0);
    else if (hasSteps) p.steps.setValue(job.maxSteps - done);
    else p.steps.setNA();
    p.stepsBox.classList.toggle('p-inst--live', hasSteps || job?.finished === 'success');

    p.recorder.push(rate);

    // ── Windows under the step counter ──
    const jobEta = running && Number.isFinite(job.jobEtaSec) ? job.jobEtaSec : null;
    if (p.train) {
      p.windows.eta.set(running && job.etaSec != null ? fmtSeconds(job.etaSec) : '--', running && job?.etaSec != null);
      p.windows.elapsed.set(job?.elapsedSec != null ? fmtSeconds(job.elapsedSec) : '--', job?.elapsedSec != null);
      // Loss stays "--" until the run has written its first sample; 0.0000 would be a lie.
      p.windows.loss.set(job?.loss != null ? job.loss.toFixed(4) : '--', job?.loss != null);
      p.windows.queue.set(queue != null ? String(queue) : '--', !!queue);
    } else {
      // What the host is built from. These are facts about the box, not readings off the job, so
      // they are set static (plate ink, no glow) and a window with nothing behind it is REMOVED —
      // an offline host has no versions to report, and a host whose relay predates
      // /watcher/host_info can never supply a driver. A dash in a window that will never fill is the
      // placeholder this project keeps refusing to print.
      const v = snapshot?.versions ?? null;
      for (const key of ['comfyui', 'driver', 'pytorch']) {
        const value = typeof v?.[key] === 'string' && v[key] ? v[key] : null;
        p.windows[key].setStatic(value);
      }
      // The GPU stack names itself. Three states, and each is honest about what is known:
      //   stack + version  -> label is the stack, value is the version   (CUDA / 13.0)
      //   stack, no version -> label says BACKEND, value is the stack     (Backend / ROCm)
      //   neither           -> the window goes away
      // A CPU-only or source build genuinely has no version to print, and a made-up one on an AMD
      // box is exactly the wrong label on a right number.
      const stack = typeof v?.accel === 'string' && v.accel ? v.accel : null;
      const stackVersion = typeof v?.accelVersion === 'string' && v.accelVersion ? v.accelVersion : null;
      p.windows.accel.relabel(stack && stackVersion ? stack : 'Backend');
      p.windows.accel.setStatic(stack ? stackVersion ?? stack : null);
    }

    // ── Tell-tale line (generation panels) ──
    if (p.spec.tellTale) {
      setTell(p.tells.elapsed, job?.elapsedSec != null ? fmtSeconds(job.elapsedSec) : '--', job?.elapsedSec != null);
      setTell(p.tells.eta, running && job.etaSec != null ? fmtSeconds(job.etaSec) : '--', running && job?.etaSec != null);
      // Batch ETA is hidden entirely on a job that is not a batch — the same rule the rack card
      // follows, and the reason is the same: one dead entry beside three live ones reads as broken.
      p.tells.jobeta.item.hidden = jobEta == null;
      setTell(p.tells.jobeta, jobEta != null ? fmtSeconds(jobEta) : '--', jobEta != null);
      setTell(p.tells.queue, queue != null ? String(queue) : '--', !!queue);
    }

    // ── LED banks ──
    // Step bank: 20 bulbs across the current node's progress. No step numbers means no lit bulbs at
    // all — a dark bank is the honest reading, exactly as N/A is on the counter.
    p.leds.step.resize(20);
    p.leds.step.light(hasSteps ? Math.round(ratio * 20) : 0, hasSteps);
    p.leds.step.txt.textContent = hasSteps
      ? `${done}/${job.maxSteps} · ${Math.round(ratio * 100)}%`
      : running ? 'no step data' : '--';

    // Workflow bank: one bulb per image, lit as each lands. The sockets only exist when the relay
    // reported a total, so the bank's own size is a measured number — never a guessed "/ 1".
    const batching = passTotal != null && passTotal > 1;
    p.leds.flow.row.classList.toggle('p-led-row--off', !batching);
    if (batching) {
      const sockets = Math.min(passTotal, 40);
      p.leds.flow.resize(sockets);
      const pass = job.pass ?? 0;
      p.leds.flow.light(Math.round((pass / passTotal) * sockets), true);
      p.leds.flow.txt.textContent = `${pass} / ${passTotal}`;
    }

    // ── Identity plate ──
    // Metadata only, never prompt text. An unrecognised graph hides the row rather than guessing or
    // parking a permanent "--".
    setPlate(p.plate.model, job?.model ?? null);
    setPlate(p.plate.size, job?.size ?? null);
    if (p.train) {
      setPlate(p.plate.count, job?.rank != null ? String(job.rank) : null);
    } else if (job?.frames != null) {
      // One slot that relabels itself: frames for a video latent, batch size for an image one. No
      // job has both, so two rows would leave a dead label on every panel.
      p.plate.count.l.textContent = 'Frames';
      setPlate(p.plate.count, String(job.frames));
    } else {
      p.plate.count.l.textContent = 'Batch Size';
      setPlate(p.plate.count, job?.batch != null ? String(job.batch) : null);
    }
    setPlate(p.plate.process, !job
      ? (online ? 'Idle' : snapshot?.lastError ? 'Unreachable' : '--')
      : job.finished
        ? job.stateText ?? (job.finished === 'success' ? 'Finished' : 'Failed')
        : job.nodeName ?? job.node ?? 'Running');
  }

  function setPlate(row, value) {
    const show = value != null && value !== '';
    row.r.classList.toggle('p-plate-row--off', !show);
    row.v.textContent = show ? value : '--';
    row.v.title = show ? value : '';
  }

  /** Panels register three pointers with the shared loop; a dropped panel must give them back. */
  function destroyReactorPanel(pan) {
    pan._reactor?.dial?.destroy();
    pan._reactor?.pct?.destroy();
  }

  /** Reprint the dials after a Dials range change. Keeps the panel, keeps the reading. */
  function refreshReactorFace(pan) {
    pan._reactor?.dial?.refreshFace();
    pan._reactor?.recorder?.refreshFace();
  }

  window.Widgets = window.Widgets || {};
  window.Widgets.createReactorPanel = createReactorPanel;
  window.Widgets.updateReactorPanel = updateReactorPanel;
  window.Widgets.destroyReactorPanel = destroyReactorPanel;
  window.Widgets.refreshReactorFace = refreshReactorFace;
})();
