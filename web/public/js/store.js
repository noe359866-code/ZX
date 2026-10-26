const KEY = "zx.v1";

export const CINEMETA_URL = "https://v3-cinemeta.strem.io/manifest.json";

export const CINEMETA = {
  transportUrl: CINEMETA_URL,
  enabled: true,
  official: true,
  locked: true,
  manifest: {
    id: "com.linvo.cinemeta",
    version: "3.0.14",
    name: "Cinemeta",
    description: "Catálogos oficiales de películas y series (incluido en ZX)",
    logo: "https://www.stremio.com/website/stremio-logo-small.png",
    resources: ["catalog", "meta", "addon_catalog"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [
      { type: "movie", id: "top", name: "Populares", extra: [{ name: "search" }, { name: "skip" }, { name: "genre" }] },
      { type: "series", id: "top", name: "Series populares", extra: [{ name: "search" }, { name: "skip" }, { name: "genre" }] },
      { type: "movie", id: "imdbRating", name: "Destacadas", extra: [{ name: "skip" }, { name: "genre" }] },
      { type: "series", id: "imdbRating", name: "Series destacadas", extra: [{ name: "skip" }, { name: "genre" }] },
    ],
  },
};

function isCinemeta(addon) {
  const url = String(addon?.transportUrl || "").replace(/\/+$/, "");
  return url === CINEMETA_URL.replace(/\/+$/, "") || addon?.manifest?.id === "com.linvo.cinemeta";
}

export function ensureCinemeta(list) {
  const addons = Array.isArray(list) ? [...list] : [];
  const i = addons.findIndex(isCinemeta);
  if (i < 0) {
    addons.unshift(structuredClone(CINEMETA));
  } else {
    const prev = addons[i];
    addons.splice(i, 1);
    addons.unshift({
      ...CINEMETA,
      ...prev,
      transportUrl: CINEMETA_URL,
      enabled: true,
      official: true,
      locked: true,
      manifest: prev.manifest?.catalogs?.length ? prev.manifest : CINEMETA.manifest,
    });
  }
  return addons;
}

export const AVATARS = [
  { id: "aurora", bg: "linear-gradient(145deg,#ff5d73,#c44bff)" },
  { id: "ocean", bg: "linear-gradient(145deg,#00a8e1,#074b78)" },
  { id: "lime", bg: "linear-gradient(145deg,#7dffb3,#0b8f5a)" },
  { id: "gold", bg: "linear-gradient(145deg,#ffd36b,#e67e22)" },
  { id: "rose", bg: "linear-gradient(145deg,#ff7eb3,#c9184a)" },
  { id: "violet", bg: "linear-gradient(145deg,#c44bff,#3b0764)" },
  { id: "slate", bg: "linear-gradient(145deg,#9aa5b1,#1b2430)" },
  { id: "kids", bg: "linear-gradient(145deg,#ffe066,#00a8e1)" },
];

export const MAX_PROFILES = 5;

function uid() {
  return "p_" + Math.random().toString(36).slice(2, 10);
}

export function makeProfile(partial = {}) {
  return {
    id: uid(),
    name: "Perfil",
    avatar: AVATARS[0].id,
    kids: false,
    library: [],
    continueWatching: [],
    ...partial,
  };
}

const DEFAULTS = {
  addons: [structuredClone(CINEMETA)],
  settings: {
    webtorRest: "https://api.webtor.io/v1",
    webtorKey: "",
    webtorSaveLibrary: false,
    mediaflowUrl: "http://127.0.0.1:8888",
    mediaflowPassword: "",
    mediaflowEnabled: true,
    torrserverUrl: "http://127.0.0.1:8090",
    torrserverUser: "",
    torrserverPass: "",
    torrentEngine: "auto",
    preferProxyHls: true,
  },
  profiles: [makeProfile({ name: "Principal", avatar: "ocean" })],
  activeProfileId: null,
  lastSearch: "",
};

function migrateProfiles(data) {
  if (Array.isArray(data.profiles) && data.profiles.length) {
    return {
      profiles: data.profiles.map((p) => makeProfile({ ...p, id: p.id || uid() })),
      activeProfileId: data.activeProfileId || null,
    };
  }
  const p = makeProfile({
    name: "Principal",
    avatar: "ocean",
    library: data.library || [],
    continueWatching: data.continueWatching || [],
  });
  return { profiles: [p], activeProfileId: null };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const data = JSON.parse(raw);
    const migrated = migrateProfiles(data);
    return {
      ...structuredClone(DEFAULTS),
      ...data,
      settings: { ...DEFAULTS.settings, ...(data.settings || {}) },
      addons: ensureCinemeta(Array.isArray(data.addons) ? data.addons : []),
      profiles: migrated.profiles,
      activeProfileId: migrated.activeProfileId,
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function save(state) {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      addons: state.addons,
      settings: state.settings,
      profiles: state.profiles,
      activeProfileId: state.activeProfileId,
      lastSearch: state.lastSearch,
    })
  );
}

export const store = {
  state: load(),
  persist() {
    this.state.addons = ensureCinemeta(this.state.addons);
    save(this.state);
  },
  settings() {
    return this.state.settings;
  },
  setSettings(patch) {
    Object.assign(this.state.settings, patch);
    this.persist();
  },
  addons() {
    return this.state.addons;
  },
  upsertAddon(addon) {
    const url = addon.transportUrl.replace(/\/+$/, "");
    const i = this.state.addons.findIndex((a) => a.transportUrl.replace(/\/+$/, "") === url);
    if (i >= 0) this.state.addons[i] = { ...this.state.addons[i], ...addon, transportUrl: url };
    else this.state.addons.push({ ...addon, transportUrl: url, enabled: true });
    this.persist();
  },
  removeAddon(url) {
    this.state.addons = this.state.addons.filter((a) => a.transportUrl !== url && !a.locked && !isCinemeta(a));
    this.state.addons = ensureCinemeta(this.state.addons);
    this.persist();
  },
  toggleAddon(url, enabled) {
    const a = this.state.addons.find((x) => x.transportUrl === url);
    if (a && !a.locked && !isCinemeta(a)) a.enabled = enabled;
    this.persist();
  },
  profiles() {
    return this.state.profiles;
  },
  profile() {
    return this.state.profiles.find((p) => p.id === this.state.activeProfileId) || this.state.profiles[0] || null;
  },
  selectProfile(id) {
    const p = this.state.profiles.find((x) => x.id === id);
    if (!p) return null;
    this.state.activeProfileId = id;
    this.persist();
    return p;
  },
  addProfile({ name, avatar, kids }) {
    if (this.state.profiles.length >= MAX_PROFILES) throw new Error("Máximo " + MAX_PROFILES + " perfiles");
    const used = new Set(this.state.profiles.map((p) => p.avatar));
    const nextAvatar = AVATARS.find((a) => !used.has(a.id))?.id || AVATARS[0].id;
    const p = makeProfile({
      name: (name || "Perfil").trim().slice(0, 18) || "Perfil",
      avatar: avatar || nextAvatar,
      kids: !!kids,
    });
    this.state.profiles.push(p);
    this.persist();
    return p;
  },
  updateProfile(id, patch) {
    const p = this.state.profiles.find((x) => x.id === id);
    if (!p) return;
    if (patch.name != null) p.name = String(patch.name).trim().slice(0, 18) || p.name;
    if (patch.avatar) p.avatar = patch.avatar;
    if (patch.kids != null) p.kids = !!patch.kids;
    this.persist();
  },
  removeProfile(id) {
    if (this.state.profiles.length <= 1) throw new Error("Deja al menos un perfil");
    this.state.profiles = this.state.profiles.filter((p) => p.id !== id);
    if (this.state.activeProfileId === id) this.state.activeProfileId = this.state.profiles[0].id;
    this.persist();
  },
  inLibrary(id) {
    return (this.profile()?.library || []).some((x) => x.id === id);
  },
  toggleLibrary(meta) {
    const p = this.profile();
    if (!p) return;
    if (this.inLibrary(meta.id)) {
      p.library = p.library.filter((x) => x.id !== meta.id);
    } else {
      p.library.unshift({
        id: meta.id,
        type: meta.type,
        name: meta.name,
        poster: meta.poster,
        background: meta.background,
        imdbRating: meta.imdbRating,
        year: yearOf(meta),
      });
    }
    this.persist();
  },
  pushContinue(item) {
    const p = this.profile();
    if (!p) return;
    p.continueWatching = [item, ...p.continueWatching.filter((x) => x.videoId !== item.videoId)].slice(0, 24);
    this.persist();
  },
};

export function avatarStyle(id) {
  return (AVATARS.find((a) => a.id === id) || AVATARS[0]).bg;
}

export function yearOf(meta) {
  if (!meta) return "";
  if (meta.year) return String(meta.year);
  if (meta.releaseInfo) return String(meta.releaseInfo).slice(0, 4);
  if (meta.released) return String(meta.released).slice(0, 4);
  return "";
}

export function addonBase(transportUrl) {
  return String(transportUrl || "")
    .replace(/\/manifest\.json$/i, "")
    .replace(/\/+$/, "");
}
