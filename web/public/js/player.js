const ICONS = {
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>`,
  play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>`,
  replay: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>`,
  fwd: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 5l9 7-9 7V5zM2 5l9 7-9 7V5z"/></svg>`,
  vol: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 9v6h4l5 5V4L9 9H5zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>`,
  mute: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12l4-4-1.5-1.5-4 4-4-4L9.5 8l4 4-4 4 1.5 1.5 4-4 4 4 1.5-1.5-4-4zM5 9v6h4l5 5V4L9 9H5z"/></svg>`,
  cc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 12h2m6 0h2M7 15h4m4 0h2"/></svg>`,
  gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.6.9 1 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
  full: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>`,
};

function fmt(t) {
  if (!Number.isFinite(t) || t < 0) return "0:00";
  const s = Math.floor(t % 60);
  const m = Math.floor((t / 60) % 60);
  const h = Math.floor(t / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export class ZXPlayer {
  constructor(root) {
    this.root = root;
    this.hls = null;
    this.hideTimer = null;
    this.onClose = null;
    this.meta = null;
    this.root.innerHTML = `
      <div class="player-stage">
        <video playsinline></video>
        <div class="spinner"><span></span></div>
        <div class="player-ui">
          <div class="player-top">
            <button class="icon-btn" data-act="close" title="Cerrar">${ICONS.back}</button>
            <div>
              <div class="player-title">ZX Player</div>
              <div class="player-sub">Media3 · ExoPlayer</div>
            </div>
            <div class="grow"></div>
            <span class="engine-chip" data-engine>directo</span>
          </div>
          <div class="player-center">
            <button class="icon-btn" data-act="rew" title="-10s">${ICONS.replay}</button>
            <button class="play-fab" data-act="toggle">${ICONS.play}</button>
            <button class="icon-btn" data-act="ff" title="+10s">${ICONS.fwd}</button>
          </div>
          <div class="player-bottom">
            <div class="scrub">
              <span data-cur>0:00</span>
              <div class="bar" data-bar>
                <div class="bar-track"></div>
                <div class="bar-buf"></div>
                <div class="bar-play"></div>
                <div class="bar-knob"></div>
              </div>
              <span data-dur>0:00</span>
            </div>
            <div class="controls">
              <button class="icon-btn" data-act="toggle">${ICONS.pause}</button>
              <button class="icon-btn" data-act="mute">${ICONS.vol}</button>
              <div class="grow"></div>
              <button class="icon-btn" data-act="cc" title="Subtítulos">${ICONS.cc}</button>
              <button class="icon-btn" data-act="gear" title="Ajustes">${ICONS.gear}</button>
              <button class="icon-btn" data-act="full" title="Pantalla completa">${ICONS.full}</button>
            </div>
          </div>
          <div class="sheet" data-sheet></div>
        </div>
      </div>
    `;
    this.video = this.root.querySelector("video");
    this.ui = this.root.querySelector(".player-ui");
    this.spinner = this.root.querySelector(".spinner");
    this.sheet = this.root.querySelector("[data-sheet]");
    this.bind();
  }

  bind() {
    this.root.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act) this.action(act);
      else this.bump();
    });
    this.root.addEventListener("mousemove", () => this.bump());
    this.video.addEventListener("play", () => this.sync());
    this.video.addEventListener("pause", () => this.sync());
    this.video.addEventListener("timeupdate", () => this.progress());
    this.video.addEventListener("progress", () => this.progress());
    this.video.addEventListener("waiting", () => this.spinner.classList.add("on"));
    this.video.addEventListener("playing", () => this.spinner.classList.remove("on"));
    this.video.addEventListener("canplay", () => this.spinner.classList.remove("on"));
    this.video.addEventListener("ended", () => this.sync());
    this.root.querySelector("[data-bar]").addEventListener("click", (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      if (this.video.duration) this.video.currentTime = p * this.video.duration;
    });
    window.addEventListener("keydown", (e) => {
      if (!this.root.classList.contains("on")) return;
      if (["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
      if (e.key === "Escape") this.close();
      if (e.key === " ") {
        e.preventDefault();
        this.action("toggle");
      }
      if (e.key === "ArrowRight") this.video.currentTime += 10;
      if (e.key === "ArrowLeft") this.video.currentTime -= 10;
      if (e.key === "f") this.action("full");
      if (e.key === "m") this.action("mute");
    });
  }

  bump() {
    this.root.classList.add("show-ui");
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (!this.video.paused) this.root.classList.remove("show-ui");
    }, 2800);
  }

  action(name) {
    if (name === "close") return this.close();
    if (name === "toggle") {
      if (this.video.paused) this.video.play().catch(() => {});
      else this.video.pause();
    }
    if (name === "rew") this.video.currentTime = Math.max(0, this.video.currentTime - 10);
    if (name === "ff") this.video.currentTime += 10;
    if (name === "mute") this.video.muted = !this.video.muted;
    if (name === "full") {
      if (!document.fullscreenElement) this.root.requestFullscreen?.();
      else document.exitFullscreen?.();
    }
    if (name === "gear") this.toggleSheet("speed");
    if (name === "cc") this.toggleSheet("cc");
    this.sync();
  }

  toggleSheet(kind) {
    if (this.sheet.classList.contains("on") && this.sheet.dataset.kind === kind) {
      this.sheet.classList.remove("on");
      return;
    }
    this.sheet.dataset.kind = kind;
    if (kind === "speed") {
      const rates = [0.5, 0.75, 1, 1.25, 1.5, 2];
      this.sheet.innerHTML =
        `<h4>Velocidad</h4>` +
        rates
          .map(
            (r) =>
              `<button data-rate="${r}" class="${this.video.playbackRate === r ? "on" : ""}">${r === 1 ? "Normal" : r + "×"}</button>`
          )
          .join("");
      this.sheet.querySelectorAll("[data-rate]").forEach((b) =>
        b.addEventListener("click", () => {
          this.video.playbackRate = Number(b.dataset.rate);
          this.sheet.classList.remove("on");
        })
      );
    } else {
      const tracks = [...this.video.textTracks];
      this.sheet.innerHTML =
        `<h4>Subtítulos</h4><button data-off>Desactivados</button>` +
        tracks
          .map((t, i) => `<button data-cc="${i}">${t.label || t.language || "Pista " + (i + 1)}</button>`)
          .join("");
      this.sheet.querySelector("[data-off]")?.addEventListener("click", () => {
        tracks.forEach((t) => (t.mode = "disabled"));
        this.sheet.classList.remove("on");
      });
      this.sheet.querySelectorAll("[data-cc]").forEach((b) =>
        b.addEventListener("click", () => {
          tracks.forEach((t, i) => (t.mode = i === Number(b.dataset.cc) ? "showing" : "disabled"));
          this.sheet.classList.remove("on");
        })
      );
    }
    this.sheet.classList.add("on");
  }

  sync() {
    const playing = !this.video.paused;
    this.root.querySelectorAll("[data-act='toggle']").forEach((b) => {
      b.innerHTML = playing ? ICONS.pause : ICONS.play;
    });
    this.root.querySelector("[data-act='mute']").innerHTML = this.video.muted ? ICONS.mute : ICONS.vol;
    this.progress();
  }

  progress() {
    const d = this.video.duration || 0;
    const c = this.video.currentTime || 0;
    const p = d ? (c / d) * 100 : 0;
    let buf = 0;
    try {
      if (this.video.buffered.length) buf = (this.video.buffered.end(this.video.buffered.length - 1) / d) * 100;
    } catch {
      buf = 0;
    }
    this.root.querySelector(".bar-play").style.width = p + "%";
    this.root.querySelector(".bar-buf").style.width = buf + "%";
    this.root.querySelector(".bar-knob").style.left = p + "%";
    this.root.querySelector("[data-cur]").textContent = fmt(c);
    this.root.querySelector("[data-dur]").textContent = fmt(d);
  }

  destroyHls() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.video.removeAttribute("src");
    this.video.load();
  }

  async open({ playUrl, kind, engine, title, subtitle, poster, headers, subtitles }) {
    this.destroyHls();
    this.root.classList.add("on", "show-ui");
    this.spinner.classList.add("on");
    this.root.querySelector(".player-title").textContent = title || "ZX Player";
    this.root.querySelector(".player-sub").textContent = [subtitle, "Media3 · ExoPlayer"].filter(Boolean).join(" · ");
    this.root.querySelector("[data-engine]").textContent = engine || "directo";
    if (poster) this.video.poster = poster;

    if (kind === "youtube" || kind === "external") {
      window.open(playUrl, "_blank", "noopener");
      this.close();
      return;
    }

    if (kind === "hls" && window.Hls && window.Hls.isSupported()) {
      this.hls = new window.Hls({
        enableWorker: true,
        xhrSetup: headers
          ? (xhr) => {
              for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
            }
          : undefined,
      });
      this.hls.loadSource(playUrl);
      this.hls.attachMedia(this.video);
      this.hls.on(window.Hls.Events.MANIFEST_PARSED, () => this.video.play().catch(() => {}));
      this.hls.on(window.Hls.Events.ERROR, (_, data) => {
        if (data?.fatal) this.spinner.classList.remove("on");
      });
    } else {
      this.video.src = playUrl;
      this.video.play().catch(() => {});
    }

    (this.video.querySelectorAll("track") || []).forEach((t) => t.remove());
    for (const s of subtitles || []) {
      const track = document.createElement("track");
      track.kind = "subtitles";
      track.label = s.lang || s.id || "sub";
      track.srclang = s.lang || "und";
      track.src = s.url;
      this.video.appendChild(track);
    }
    this.bump();
  }

  close() {
    this.video.pause();
    this.destroyHls();
    this.root.classList.remove("on");
    if (document.fullscreenElement) document.exitFullscreen?.();
    this.onClose?.();
  }
}
