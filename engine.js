// Loads engine.wasm and gives it a tiny in-memory WASI file system holding the player's own game files.
// Works in browsers and in Node (for tests). No game data ships with this file.

export class PinballEngine {
  constructor(files, hooks = {}) {
    // files: Map of UPPERCASE file name -> Uint8Array
    this.files = files;
    this.hooks = hooks;
    this.fds = new Map();
    this.nextFd = 4;
    this.mem = null;
  }

  async load(wasmSource) {
    const imports = { host: this.#hostImports(), wasi_snapshot_preview1: this.#wasiImports() };
    const { instance } = wasmSource instanceof WebAssembly.Module
      ? { instance: await WebAssembly.instantiate(wasmSource, imports) }
      : await WebAssembly.instantiate(wasmSource, imports);
    this.instance = instance;
    this.x = instance.exports;
    this.x._initialize();
    return this;
  }

  get u8() { return new Uint8Array(this.x.memory.buffer); }
  get dv() { return new DataView(this.x.memory.buffer); }

  str(ptr, len) { return new TextDecoder().decode(this.u8.subarray(ptr, ptr + len)); }
  cstr(ptr) { const u = this.u8; let e = ptr; while (u[e]) e++; return this.str(ptr, e - ptr); }

  fileFor(path) {
    const name = path.replace(/^.*[\\/]/, '').toUpperCase();
    return this.files.get(name);
  }

  #hostImports() {
    const h = this.hooks;
    return {
      now_ms: () => performance.now(),
      log: (p, l) => (h.log || console.log)(this.str(p, l)),
      load_sound: (p, l) => {
        const path = this.str(p, l);
        const data = this.fileFor(path);
        return data && h.loadSound ? h.loadSound(path, data) : -1;
      },
      play_sound: (id) => h.playSound && h.playSound(id),
      stop_sounds: () => h.stopSounds && h.stopSounds(),
      sound_volume: (v) => h.soundVolume && h.soundVolume(v / 128),
      load_music: (p, l) => {
        const path = this.str(p, l);
        const data = this.fileFor(path);
        return data && h.loadMusic ? h.loadMusic(path, data) : -1;
      },
      load_music_mem: (p, l) => h.loadMusic ? h.loadMusic('memory.mid', this.u8.slice(p, p + l)) : -1,
      play_music: (id) => h.playMusic && h.playMusic(id),
      stop_music: () => h.stopMusic && h.stopMusic(),
      music_volume: (v) => h.musicVolume && h.musicVolume(v / 128),
      event: (k, v) => h.event && h.event(k, v),
      text: (p, l, t) => h.text && h.text(this.str(p, l), t),
      get_high_score: () => (h.getHighScore ? h.getHighScore() : 0),
    };
  }

  #wasiImports() {
    const ENOENT = 44, EBADF = 8, SUCCESS = 0;
    return {
      fd_prestat_get: (fd, out) => {
        if (fd !== 3) return EBADF;
        this.dv.setUint8(out, 0);
        this.dv.setUint32(out + 4, 1, true);
        return SUCCESS;
      },
      fd_prestat_dir_name: (fd, p, l) => { if (fd !== 3) return EBADF; this.u8[p] = 47; return SUCCESS; },
      fd_fdstat_get: (fd, out) => {
        const dv = this.dv;
        dv.setUint8(out, fd <= 2 ? 2 : fd === 3 ? 3 : 4);
        dv.setUint16(out + 2, 0, true);
        dv.setBigUint64(out + 8, 0xffffffffn, true);
        dv.setBigUint64(out + 16, 0xffffffffn, true);
        return SUCCESS;
      },
      fd_fdstat_set_flags: () => SUCCESS,
      path_open: (dirfd, dirflags, p, l, oflags, rb, ri, fdflags, outFd) => {
        const path = this.str(p, l);
        const data = this.fileFor(path);
        if (!data || (oflags & 1)) return ENOENT; // read-only FS: refuse creates
        const fd = this.nextFd++;
        this.fds.set(fd, { data, pos: 0 });
        this.dv.setUint32(outFd, fd, true);
        return SUCCESS;
      },
      fd_read: (fd, iovs, n, outN) => {
        const f = this.fds.get(fd);
        if (!f) return EBADF;
        let total = 0;
        const dv = this.dv, u8 = this.u8;
        for (let i = 0; i < n; i++) {
          const buf = dv.getUint32(iovs + i * 8, true), len = dv.getUint32(iovs + i * 8 + 4, true);
          const chunk = f.data.subarray(f.pos, Math.min(f.pos + len, f.data.length));
          u8.set(chunk, buf);
          f.pos += chunk.length;
          total += chunk.length;
          if (chunk.length < len) break;
        }
        dv.setUint32(outN, total, true);
        return SUCCESS;
      },
      fd_seek: (fd, offset, whence, out) => {
        const f = this.fds.get(fd);
        if (!f) return EBADF;
        const off = Number(offset);
        f.pos = whence === 0 ? off : whence === 1 ? f.pos + off : f.data.length + off;
        this.dv.setBigUint64(out, BigInt(f.pos), true);
        return SUCCESS;
      },
      fd_close: (fd) => { this.fds.delete(fd); return SUCCESS; },
      fd_write: (fd, iovs, n, outN) => {
        let total = 0, s = '';
        const dv = this.dv;
        for (let i = 0; i < n; i++) {
          const buf = dv.getUint32(iovs + i * 8, true), len = dv.getUint32(iovs + i * 8 + 4, true);
          s += this.str(buf, len);
          total += len;
        }
        if (s.trim()) (this.hooks.log || console.log)(s.trimEnd());
        dv.setUint32(outN, total, true);
        return SUCCESS;
      },
      proc_exit: (code) => { throw new Error('engine exited ' + code); },
    };
  }

  // ---- convenience API
  init(music = true) { return this.x.scp_init(music ? 1 : 0); }
  frame(dtMs) { this.x.scp_frame(dtMs); }
  input(type, value, down) { this.x.scp_input(type, value, down ? 1 : 0); }

  info() {
    const f = new Float32Array(this.x.memory.buffer, this.x.scp_info(), 26);
    return {
      matrix: Array.from(f.subarray(0, 12)), d: f[12], cx: f[13], cy: f[14], zmin: f[15], zscaler: f[16],
      width: f[17], height: f[18], bgzWidth: f[19], bgzHeight: f[20], bgzStride: f[21],
      bgzOffsetX: f[22], bgzOffsetY: f[23], fullTilt: !!f[24], ballRadius: f[25],
    };
  }

  balls() {
    const f = new Float32Array(this.x.memory.buffer, this.x.scp_balls(), 64);
    const out = [];
    for (let i = 0; i < f[0]; i++) out.push({ x: f[1 + i * 4], y: f[2 + i * 4], z: f[3 + i * 4], visible: f[4 + i * 4] > 0 });
    return out;
  }

  // BGRA pixels of the composed table (same layout the 2D game shows)
  pixels(w, h) { return new Uint8Array(this.x.memory.buffer, this.x.scp_vscreen(), this.x.scp_vscreen_stride() * h * 4); }
  zscreen(h) { return new Uint16Array(this.x.memory.buffer, this.x.scp_zscreen(), this.x.scp_zscreen_stride() * h); }
  backgroundZ(info) {
    const p = this.x.scp_bgz();
    return p ? new Uint16Array(this.x.memory.buffer, p, info.bgzStride * info.bgzHeight) : null;
  }
}

export const Controls = { LeftFlipper: 9, RightFlipper: 10, Plunger: 0, NudgeLeft: 13, NudgeRight: 14, NudgeUp: 11 };
export const InputType = { Keyboard: 1, Mouse: 2, Controller: 3 };
