// Web Audio back end: the game's WAV effects, plus its MIDI theme played on a small built-in synth
// (or an MP3/OGG of the theme if the player's files include one).

export class GameAudio {
  constructor(files) {
    this.files = files;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.connect(this.master);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.5;
    this.musicGain.connect(this.master);
    this.sounds = [];
    this.playing = new Set();
    this.music = [];
    this.musicNode = null;
    this.synth = null;
    this.onSound = null;
  }

  resume() { if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); }

  // Engine asks for sounds synchronously, so decode in the background and play once ready.
  loadSound(path, data) {
    const id = this.sounds.length;
    const slot = { name: path.replace(/^.*[\\/]/, '').toUpperCase(), buffer: null };
    this.sounds.push(slot);
    this.ctx.decodeAudioData(data.slice().buffer).then((b) => (slot.buffer = b)).catch(() => {});
    return id;
  }

  playSound(id) {
    const slot = this.sounds[id];
    if (!slot || !slot.buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = slot.buffer;
    src.connect(this.sfxGain);
    src.onended = () => this.playing.delete(src);
    this.playing.add(src);
    src.start();
    if (this.onSound) this.onSound(slot.name);
  }

  stopSounds() { for (const s of this.playing) { try { s.stop(); } catch {} } this.playing.clear(); }
  soundVolume(v) { this.sfxGain.gain.value = v; }
  musicVolume(v) { this.musicGain.gain.value = v * 0.5; }

  loadMusic(path, data) {
    const id = this.music.length;
    const base = path.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').toUpperCase();
    const recorded = this.files.get(base + '.MP3') || this.files.get(base + '.OGG');
    const entry = { midi: null, buffer: null };
    if (recorded) {
      this.ctx.decodeAudioData(recorded.slice().buffer).then((b) => (entry.buffer = b)).catch(() => {
        entry.midi = parseMidi(data);
      });
    } else {
      try { entry.midi = parseMidi(data); } catch (e) { console.warn('MIDI parse failed', e); return -1; }
    }
    this.music.push(entry);
    return id;
  }

  playMusic(id) {
    this.stopMusic();
    const entry = this.music[id];
    if (!entry) return;
    this.currentMusic = id;
    const start = () => {
      if (this.currentMusic !== id) return;
      if (entry.buffer) {
        const src = this.ctx.createBufferSource();
        src.buffer = entry.buffer;
        src.loop = true;
        src.connect(this.musicGain);
        src.start();
        this.musicNode = src;
      } else if (entry.midi) {
        this.synth = new MidiPlayer(this.ctx, this.musicGain, entry.midi);
        this.synth.play();
      } else {
        setTimeout(start, 200); // still decoding
      }
    };
    start();
  }

  stopMusic() {
    this.currentMusic = -1;
    if (this.musicNode) { try { this.musicNode.stop(); } catch {} this.musicNode = null; }
    if (this.synth) { this.synth.stop(); this.synth = null; }
  }
}

// ---------------------------------------------------------------- MIDI
function parseMidi(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 0;
  const str = (n) => String.fromCharCode(...u8.subarray(p, p + n));
  if (str(4) !== 'MThd') throw new Error('not MIDI');
  const division = dv.getUint16(12);
  const ntracks = dv.getUint16(10);
  p = 8 + dv.getUint32(4);
  const events = [];
  for (let t = 0; t < ntracks && p < u8.length; t++) {
    if (str(4) !== 'MTrk') break;
    const len = dv.getUint32(p + 4);
    let q = p + 8;
    const end = q + len;
    let tick = 0, running = 0;
    const vlq = () => { let v = 0, b; do { b = u8[q++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
    while (q < end) {
      tick += vlq();
      let status = u8[q];
      if (status < 0x80) status = running; else q++;
      if (status === 0xff) {
        const type = u8[q++];
        const l = vlq();
        if (type === 0x51) events.push({ tick, type: 'tempo', value: (u8[q] << 16) | (u8[q + 1] << 8) | u8[q + 2] });
        q += l;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) { q += vlq(); continue; }
      running = status;
      const kind = status & 0xf0, ch = status & 0x0f;
      const a = u8[q++];
      const b = kind === 0xc0 || kind === 0xd0 ? 0 : u8[q++];
      if (kind === 0x90 && b > 0) events.push({ tick, type: 'on', ch, note: a, vel: b });
      else if (kind === 0x80 || (kind === 0x90 && b === 0)) events.push({ tick, type: 'off', ch, note: a });
      else if (kind === 0xc0) events.push({ tick, type: 'program', ch, value: a });
      else if (kind === 0xb0 && a === 7) events.push({ tick, type: 'volume', ch, value: b });
    }
    p = end;
  }
  events.sort((x, y) => x.tick - y.tick || (x.type === 'off' ? -1 : 1));
  // Convert ticks to seconds
  let tempo = 500000, lastTick = 0, time = 0;
  for (const e of events) {
    time += ((e.tick - lastTick) * tempo) / division / 1e6;
    lastTick = e.tick;
    e.time = time;
    if (e.type === 'tempo') tempo = e.value;
  }
  return { events, duration: time + 0.5 };
}

// A deliberately simple General MIDI-ish synth: program families map to a few oscillator voices.
class MidiPlayer {
  constructor(ctx, out, song) {
    this.ctx = ctx;
    this.out = out;
    this.song = song;
    this.timer = null;
    this.active = new Map();
    this.program = new Array(16).fill(0);
    this.volume = new Array(16).fill(100);
    this.noise = null;
  }

  play() {
    this.loopStart = this.ctx.currentTime + 0.1;
    this.index = 0;
    this.timer = setInterval(() => this.pump(), 50);
    this.pump();
  }

  stop() {
    clearInterval(this.timer);
    for (const v of this.active.values()) for (const n of v) this.release(n, this.ctx.currentTime);
    this.active.clear();
  }

  pump() {
    const ev = this.song.events;
    const horizon = this.ctx.currentTime + 0.25;
    while (true) {
      if (this.index >= ev.length) {
        this.loopStart += this.song.duration;
        this.index = 0;
        for (const v of this.active.values()) for (const n of v) this.release(n, this.loopStart);
        this.active.clear();
      }
      const e = ev[this.index];
      const t = this.loopStart + e.time;
      if (t > horizon) break;
      this.handle(e, Math.max(t, this.ctx.currentTime));
      this.index++;
    }
  }

  handle(e, t) {
    const key = e.ch * 128 + e.note;
    if (e.type === 'program') this.program[e.ch] = e.value;
    else if (e.type === 'volume') this.volume[e.ch] = e.value;
    else if (e.type === 'on') {
      const n = e.ch === 9 ? this.drum(e.note, e.vel, t) : this.voice(e.ch, e.note, e.vel, t);
      if (!n) return;
      if (!this.active.has(key)) this.active.set(key, []);
      this.active.get(key).push(n);
    } else if (e.type === 'off') {
      const list = this.active.get(key);
      if (list && list.length) this.release(list.shift(), t);
    }
  }

  voice(ch, note, vel, t) {
    const prog = this.program[ch];
    const family = prog >> 3; // GM families of 8
    const freq = 440 * Math.pow(2, (note - 69) / 12);
    const types = ['triangle', 'square', 'sine', 'sawtooth', 'triangle', 'sawtooth', 'sawtooth', 'square',
      'sawtooth', 'square', 'sawtooth', 'sawtooth', 'triangle', 'square', 'sine', 'sine'];
    const osc = this.ctx.createOscillator();
    osc.type = types[family] || 'triangle';
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    const level = (vel / 127) * (this.volume[ch] / 127) * (family === 4 ? 0.22 : 0.08);
    const sustain = family === 0 || family === 1 || family === 2 ? 0.4 : 0.8;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.008);
    g.gain.setTargetAtTime(level * sustain, t + 0.01, 0.15);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = Math.min(9000, freq * 6 + 800);
    osc.connect(filter).connect(g).connect(this.out);
    osc.start(t);
    return { osc, g, level };
  }

  drum(note, vel, t) {
    const ctx = this.ctx;
    if (!this.noise) {
      const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noise = b;
    }
    const level = (vel / 127) * 0.3;
    const g = ctx.createGain();
    g.connect(this.out);
    if (note === 35 || note === 36) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
      g.gain.setValueAtTime(level * 1.6, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      o.connect(g);
      o.start(t);
      o.stop(t + 0.3);
    } else {
      const s = ctx.createBufferSource();
      s.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      const hat = note === 42 || note === 44 || note === 46 || note >= 49;
      f.type = hat ? 'highpass' : 'bandpass';
      f.frequency.value = hat ? 7000 : 1800;
      const len = note === 46 || note === 49 || note === 57 ? 0.35 : hat ? 0.05 : 0.15;
      g.gain.setValueAtTime(level, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + len);
      s.connect(f).connect(g);
      s.start(t);
      s.stop(t + len + 0.05);
    }
    return null;
  }

  release(n, t) {
    if (!n) return;
    n.g.gain.cancelScheduledValues(t);
    n.g.gain.setTargetAtTime(0, t, 0.06);
    n.osc.stop(t + 0.4);
  }
}
