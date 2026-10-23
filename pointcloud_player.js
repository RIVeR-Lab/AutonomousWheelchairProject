/* LiDAR point cloud player for the paper page.
 *
 * Reads the selected experiment's filtered ROS 2 bag (<folder>/lidar_bag/lidar_bag_0_filtered.db3)
 * straight in the browser with sql.js, decodes the Livox scans and the odometry, and replays them
 * with the wheelchair model. No server is needed, so it works on GitHub Pages.
 *
 * The page's experiment script announces the selected run with an 'experiment-change' event on
 * window ({ id, name, sources }); this player follows it.
 */
(function () {
  'use strict';

  const LIBS = {
    three: ['https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'],
    sql: [
      'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/sql-wasm.js',
      'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js',
    ],
  };
  const LIDAR_TOPIC = '/livox/lidar';
  const ODOM_TOPIC = '/vehicle/odometry';
  const MAP_CAP = 400000;          // points in the accumulated map
  const SCAN_CAP = 20000;          // points kept per scan for display
  const MAX_WINDOW_SCANS = 1500;
  const VIEW_KEY = 'pcPlayer.view';
  const BG = 0x0b1020;

  /* ------------------------------------------------------------ elements */
  const $ = (id) => document.getElementById(id);
  const section = $('pcSection');
  if (!section) return;
  const stageEl = $('pcStage');
  const wrapEl = $('pcCanvasWrap');
  const overlay = $('pcOverlay');
  const overlayMsg = $('pcMsg');
  const overlayBar = $('pcBar');
  const overlayBarFill = $('pcBarFill');
  const expSel = $('pcExp');
  const statusEl = $('pcStatus');
  const playBtn = $('pcPlay');
  const scrubEl = $('pcScrub');
  const timeEl = $('pcTime');
  const speedEl = $('pcSpeed');
  const resetBtn = $('pcReset');
  const previewEl = $('pcPreview');

  /* A still image of each experiment, shown while its bag downloads and decodes.
     It lives next to the bag as preview.jpg, preview.png or preview.webp, tried in that order. */
  const PREVIEW_NAMES = ['preview.jpg', 'preview.png', 'preview.webp'];
  function previewUrlsFor(exp) {
    const u = exp && exp.sources && exp.sources[0];
    return u ? PREVIEW_NAMES.map((name) => u.replace(/[^/]*$/, name)) : [];
  }
  function showPreview(exp) {
    hidePreview();
    const urls = previewUrlsFor(exp);
    let i = 0;
    const tryNext = () => {
      if (i >= urls.length || currentId !== exp.id) { hidePreview(); return; }
      previewEl.src = urls[i++];
    };
    previewEl.onload = () => {
      if (currentId === exp.id && !data) {
        previewEl.hidden = false;
        overlay.classList.add('on-preview');
      }
    };
    previewEl.onerror = tryNext;
    tryNext();
  }
  function hidePreview() {
    previewEl.onload = previewEl.onerror = null;
    previewEl.hidden = true;
    overlay.classList.remove('on-preview');
  }

  function showOverlay(msg, fraction) {
    overlay.hidden = false;
    overlayMsg.textContent = msg;
    const hasBar = typeof fraction === 'number';
    overlayBar.hidden = !hasBar;
    if (hasBar) overlayBarFill.style.width = Math.round(Math.max(0, Math.min(1, fraction)) * 100) + '%';
  }
  function hideOverlay() { overlay.hidden = true; }
  function setStatus(cls, text) {
    statusEl.hidden = !text;
    statusEl.className = 'status ' + cls;
    statusEl.textContent = text || '';
  }
  const mb = (n) => (n / (1024 * 1024)).toFixed(1) + ' MB';

  /* ------------------------------------------------------------ settings */
  function loadView() {
    try {
      const v = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
      return v && typeof v === 'object' ? v : {};
    } catch (e) { return {}; }
  }
  function saveView() {
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch (e) { /* unavailable */ }
  }
  function sanitize(v) {
    const hex = (c, d) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : d);
    const num = (x, lo, hi, d) => { x = Number(x); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
    const pick = (x, opts, d) => (opts.indexOf(x) >= 0 ? x : d);
    return {
      colorMode: pick(v.colorMode, ['height', 'intensity', 'time', 'solid'], 'intensity'),
      solidColor: hex(v.solidColor, '#3dd6c6'),
      pointSize: num(v.pointSize, 0.2, 6, 1.8),
      pointShape: pick(v.pointShape, ['square', 'circle', 'soft'], 'soft'),
      windowSec: num(v.windowSec, 0, 120, 0.5),
      fade: v.fade !== false,
      showMap: v.showMap !== false,
      showPath: v.showPath !== false,
      pathColor: hex(v.pathColor, '#ff0000'),
      pathWidth: num(v.pathWidth, 0.01, 0.5, 0.1),
      showChair: v.showChair !== false,
      chairColor: hex(v.chairColor, '#7fffd4'),
    };
  }
  let view = sanitize(loadView());

  /* ------------------------------------------------------------ library loading */
  function loadScript(urls) {
    return urls.reduce((p, url) => p.catch(() => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = () => resolve(url);
      s.onerror = () => { s.remove(); reject(new Error('Couldn’t load ' + url)); };
      document.head.appendChild(s);
    })), Promise.reject(new Error('start')));
  }

  let threeReady = null;
  let sqlReady = null;
  function ensureThree() {
    if (!threeReady) threeReady = window.THREE ? Promise.resolve() : loadScript(LIBS.three);
    return threeReady;
  }
  function ensureSql() {
    if (!sqlReady) {
      sqlReady = loadScript(LIBS.sql).then((url) => {
        const base = url.slice(0, url.lastIndexOf('/') + 1);
        return window.initSqlJs({ locateFile: (f) => base + f });
      });
    }
    return sqlReady;
  }

  /* ------------------------------------------------------------ download */
  async function fetchWithProgress(urls, onProgress, isStale) {
    for (const url of urls) {
      let r;
      try { r = await fetch(url); } catch (e) { continue; }
      if (!r.ok) continue;
      const total = Number(r.headers.get('content-length')) || 0;
      if (!r.body || !r.body.getReader) {
        const buf = new Uint8Array(await r.arrayBuffer());
        onProgress(buf.length, buf.length);
        return buf;
      }
      const reader = r.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (isStale()) { reader.cancel(); return null; }
        chunks.push(value);
        got += value.length;
        onProgress(got, total);
      }
      const out = new Uint8Array(got);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    }
    return null;
  }

  function checkSqlite(bytes) {
    const head = new TextDecoder().decode(bytes.subarray(0, 40));
    if (head.startsWith('SQLite format 3')) return;
    if (head.startsWith('version https://git-lfs')) {
      throw new Error('The bag on GitHub is a Git LFS pointer, not the file itself. Upload it without LFS (under 25 MB through the website, or with plain git).');
    }
    throw new Error('This file isn’t a ROS 2 SQLite bag.');
  }

  /* ------------------------------------------------------------ CDR decoding */
  const CDR_BASE = 4;
  const align = (off, a) => CDR_BASE + (((off - CDR_BASE) + a - 1) & ~(a - 1));

  // livox_ros_driver2/CustomMsg: returns the view, the first point's offset and the point count.
  function locatePoints(bytes) {
    if (bytes[1] !== 1) throw new Error('Only little-endian CDR is supported.');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = CDR_BASE + 8;                         // header.stamp
    off += 4 + dv.getUint32(off, true);             // header.frame_id
    off = align(off, 8) + 8;                        // timebase
    off = align(off + 8, 4);                        // point_num, lidar_id, rsvd[3]
    const cnt = dv.getUint32(off, true);
    return { dv, off: off + 4, cnt };
  }

  // nav_msgs/Odometry: position and orientation.
  function parseOdometry(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = CDR_BASE + 8;
    off += 4 + dv.getUint32(off, true);             // header.frame_id
    off = align(off, 4);
    off += 4 + dv.getUint32(off, true);             // child_frame_id
    off = align(off, 8);
    const f = (k) => dv.getFloat64(off + 8 * k, true);
    return [f(0), f(1), f(2), f(3), f(4), f(5), f(6)];
  }

  function quatMatrix(qx, qy, qz, qw) {
    const n = Math.hypot(qx, qy, qz, qw) || 1;
    qx /= n; qy /= n; qz /= n; qw /= n;
    return [
      1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
      2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
      2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy),
    ];
  }
  const yawOf = (qx, qy, qz, qw) => Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz));

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
  }

  /* Decodes the bag into display data. Positions are stored in three.js axes
     (x, up, -y), so ROS z (height) is the second component. */
  async function decodeBag(SQL, bytes, onProgress, isStale) {
    const db = new SQL.Database(bytes);
    try {
      const topics = (db.exec('SELECT id, name, type FROM topics')[0] || { values: [] }).values;
      const find = (name, type) => {
        const byName = topics.find((t) => t[1] === name);
        if (byName) return byName[0];
        const byType = topics.find((t) => String(t[2]).indexOf(type) >= 0);
        return byType ? byType[0] : null;
      };
      const lidarId = find(LIDAR_TOPIC, 'livox_ros_driver2/msg/CustomMsg');
      const odomId = find(ODOM_TOPIC, 'nav_msgs/msg/Odometry');
      if (lidarId == null) throw new Error('The bag has no Livox LiDAR topic.');

      // Times relative to the first scan, subtracted inside SQLite so nanosecond
      // timestamps keep full precision (they don't fit exactly in a JS number).
      const rows = (topicId) => {
        const stmt = db.prepare(
          'SELECT timestamp - (SELECT MIN(timestamp) FROM messages WHERE topic_id = $l), data ' +
          'FROM messages WHERE topic_id = $t ORDER BY timestamp, id');
        stmt.bind({ $l: lidarId, $t: topicId });
        return stmt;
      };

      const odomT = [], odomP = [];
      if (odomId != null) {
        const st = rows(odomId);
        while (st.step()) {
          const r = st.get();
          odomT.push(r[0] / 1e9);
          odomP.push(parseOdometry(r[1]));
        }
        st.free();
      }
      const poseAt = (t) => {
        if (!odomT.length) return null;
        let lo = 0, hi = odomT.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (odomT[mid] < t) lo = mid + 1; else hi = mid;
        }
        if (lo > 0 && t - odomT[lo - 1] < odomT[lo] - t) lo--;
        return odomP[lo];
      };

      const nScans = (db.exec('SELECT COUNT(*) FROM messages WHERE topic_id = ' + Number(lidarId))[0] || { values: [[0]] }).values[0][0];
      if (!nScans) throw new Error('The bag has no LiDAR scans.');

      const frames = [];
      let total = 0;
      const st = rows(lidarId);
      let i = 0;
      while (st.step()) {
        const r = st.get();
        const t = r[0] / 1e9;
        const { dv, off, cnt } = locatePoints(r[1]);
        const pose = poseAt(t);
        const R = pose ? quatMatrix(pose[3], pose[4], pose[5], pose[6]) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
        const tx = pose ? pose[0] : 0, ty = pose ? pose[1] : 0, tz = pose ? pose[2] : 0;
        const stride = cnt > SCAN_CAP ? cnt / SCAN_CAP : 1;
        const keep = Math.min(cnt, SCAN_CAP);
        const pos = new Float32Array(keep * 3);
        const inten = new Float32Array(keep);
        let k = 0;
        for (let j = 0; j < keep; j++) {
          const p = off + Math.floor(j * stride) * 20;
          const x = dv.getFloat32(p + 4, true), y = dv.getFloat32(p + 8, true), z = dv.getFloat32(p + 12, true);
          if (x === 0 && y === 0 && z === 0) continue;          // "no echo" returns
          const wx = R[0] * x + R[1] * y + R[2] * z + tx;
          const wy = R[3] * x + R[4] * y + R[5] * z + ty;
          const wz = R[6] * x + R[7] * y + R[8] * z + tz;
          pos[k * 3] = wx; pos[k * 3 + 1] = wz; pos[k * 3 + 2] = -wy;
          inten[k] = dv.getUint8(p + 16);
          k++;
        }
        frames.push({ t, pos: pos.subarray(0, k * 3), inten: inten.subarray(0, k), count: k });
        total += k;
        i++;
        if (i % 25 === 0) {
          onProgress(i / nScans);
          await new Promise((res) => setTimeout(res, 0));
          if (isStale()) { st.free(); return null; }
        }
      }
      st.free();

      const traj = odomT.map((t, n) => {
        const p = odomP[n];
        return { t, x: p[0], y: p[2], z: -p[1], yaw: yawOf(p[3], p[4], p[5], p[6]) };
      });
      const t0 = frames.length ? frames[0].t : 0;
      const duration = Math.max(frames.length ? frames[frames.length - 1].t : 0,
                                traj.length ? traj[traj.length - 1].t : 0) - Math.min(0, t0);
      return { frames, traj, duration, totalPoints: total, map: buildMap(frames) };
    } finally {
      db.close();
    }
  }

  /* Voxel-downsamples every scan into one accumulated map. */
  function buildMap(frames) {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const f of frames) {
      const p = f.pos;
      for (let i = 0; i < p.length; i += 3) {
        if (p[i] < minX) minX = p[i]; if (p[i] > maxX) maxX = p[i];
        if (p[i + 1] < minY) minY = p[i + 1]; if (p[i + 1] > maxY) maxY = p[i + 1];
        if (p[i + 2] < minZ) minZ = p[i + 2]; if (p[i + 2] > maxZ) maxZ = p[i + 2];
      }
    }
    if (!Number.isFinite(minX)) return { pos: new Float32Array(0), inten: new Float32Array(0), count: 0, bounds: null };
    let voxel = 0.05;
    for (;;) {
      const nx = Math.floor((maxX - minX) / voxel) + 1;
      const ny = Math.floor((maxY - minY) / voxel) + 1;
      const seen = new Set();
      const pos = [], inten = [];
      let over = false;
      for (const f of frames) {
        const p = f.pos;
        for (let i = 0, j = 0; i < p.length; i += 3, j++) {
          const key = Math.floor((p[i] - minX) / voxel) +
            nx * (Math.floor((p[i + 1] - minY) / voxel) + ny * Math.floor((p[i + 2] - minZ) / voxel));
          if (seen.has(key)) continue;
          seen.add(key);
          pos.push(p[i], p[i + 1], p[i + 2]);
          inten.push(f.inten[j]);
          if (seen.size > MAP_CAP) { over = true; break; }
        }
        if (over) break;
      }
      if (!over) {
        return {
          pos: new Float32Array(pos), inten: new Float32Array(inten), count: inten.length,
          bounds: { minX, maxX, minY, maxY, minZ, maxZ },
        };
      }
      voxel *= 1.5;
    }
  }

  /* ------------------------------------------------------------ rendering helpers */
  function heatColor(t, out, o) {
    const x = Math.min(1, Math.max(0, t));
    out[o] = x < 0.5 ? 0.05 + 0.4 * (x / 0.5) : 0.45 + 0.55 * ((x - 0.5) / 0.5);
    out[o + 1] = x < 0.5 ? 0.55 + 0.4 * (x / 0.5) : 0.95 - 0.25 * ((x - 0.5) / 0.5);
    out[o + 2] = x < 0.5 ? 0.85 - 0.55 * (x / 0.5) : 0.3 - 0.25 * ((x - 0.5) / 0.5);
  }

  /* The wheelchair in one material, so its color can be set from the panel. */
  function buildWheelchair(THREE, mat) {
    const vehicle = new THREE.Group();
    const track = 0.52, wheelbase = 0.58, seatH = 0.42;
    const add = (geo, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); vehicle.add(m); return m; };

    add(new THREE.BoxGeometry(0.42, 0.08, 0.55), 0, 0.14, 0.02);                    // chassis
    add(new THREE.BoxGeometry(0.40, 0.06, 0.38), 0, seatH, 0.06);                   // seat
    add(new THREE.BoxGeometry(0.40, 0.42, 0.06), 0, seatH + 0.24, 0.22).rotation.x = -0.12;   // backrest
    for (const side of [-1, 1]) {
      add(new THREE.BoxGeometry(0.05, 0.04, 0.32), side * 0.22, seatH + 0.16, 0.02);           // armrest
      add(new THREE.CylinderGeometry(0.018, 0.018, 0.16, 10), side * 0.22, seatH + 0.08, 0.14);
      add(new THREE.CylinderGeometry(0.016, 0.016, 0.36, 10), side * 0.18, seatH - 0.06, 0.18);
    }
    add(new THREE.BoxGeometry(0.34, 0.03, 0.18), 0, 0.10, -0.38);                    // footrest
    add(new THREE.BoxGeometry(0.34, 0.04, 0.02), 0, 0.125, -0.46);

    function wheel(x, z, r, w) {
      const g = new THREE.Group();
      [[r, w, 20], [r * 0.55, w * 1.05, 16], [r * 0.18, w * 1.15, 12]].forEach(([rr, ww, seg]) => {
        const c = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr, ww, seg), mat);
        c.rotation.z = Math.PI / 2;
        g.add(c);
      });
      g.position.set(x, r, z);
      vehicle.add(g);
    }
    const rearR = 0.16, frontR = 0.09, rearZ = wheelbase * 0.42, frontZ = -wheelbase * 0.48;
    wheel(-track / 2, rearZ, rearR, 0.055);
    wheel(track / 2, rearZ, rearR, 0.055);
    wheel(-track / 2, frontZ, frontR, 0.045);
    wheel(track / 2, frontZ, frontR, 0.045);
    add(new THREE.CylinderGeometry(0.012, 0.012, track * 0.92, 8), 0, rearR, rearZ).rotation.z = Math.PI / 2;
    add(new THREE.ConeGeometry(0.04, 0.1, 10), 0, 0.16, -0.50).rotation.x = Math.PI / 2;   // points forward
    return vehicle;
  }

  /* Orbit (drag), pan (right-drag or Shift-drag) and zoom (wheel or pinch).
     The wheel only zooms after the view has been clicked, so scrolling the page
     past the player doesn't get captured. */
  function attachControls(THREE, camera, element) {
    const target = new THREE.Vector3();
    const home = { position: new THREE.Vector3(), target: new THREE.Vector3() };
    const sph = new THREE.Spherical();
    const off = new THREE.Vector3();
    const pointers = new Map();
    let mode = null, pinchStart = 0, pinchRadius = 0, engaged = false;

    function sync() { off.copy(camera.position).sub(target); sph.setFromVector3(off); }
    function apply() {
      sph.phi = Math.max(0.02, Math.min(Math.PI - 0.02, sph.phi));
      sph.radius = Math.max(0.2, Math.min(1500, sph.radius));
      off.setFromSpherical(sph);
      camera.position.copy(target).add(off);
      camera.lookAt(target);
      camera.updateMatrixWorld();
    }
    function pan(dx, dy) {
      const perPx = 2 * sph.radius * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / (element.clientHeight || 1);
      target.addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), -dx * perPx);
      target.addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1), dy * perPx);
    }
    const pinchDist = () => { const p = Array.from(pointers.values()); return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); };

    element.addEventListener('contextmenu', (e) => e.preventDefault());
    element.addEventListener('pointerdown', (e) => {
      engaged = true;
      element.classList.add('engaged');
      element.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) { mode = 'pinch'; pinchStart = pinchDist(); pinchRadius = sph.radius; }
      else if (pointers.size === 1) mode = (e.button === 2 || e.button === 1 || e.shiftKey) ? 'pan' : 'orbit';
    });
    element.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      prev.x = e.clientX; prev.y = e.clientY;
      if (mode === 'orbit') { sph.theta -= dx * 0.006; sph.phi -= dy * 0.006; }
      else if (mode === 'pan') pan(dx, dy);
      else if (mode === 'pinch' && pointers.size === 2) { const d = pinchDist(); if (d > 0) sph.radius = pinchRadius * (pinchStart / d); }
      apply();
    });
    const release = (e) => {
      pointers.delete(e.pointerId);
      if (!pointers.size) mode = null;
      else if (pointers.size === 1 && mode === 'pinch') mode = 'orbit';
    };
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
    element.addEventListener('pointerleave', () => { if (!pointers.size) { engaged = false; element.classList.remove('engaged'); } });
    element.addEventListener('wheel', (e) => {
      if (!engaged) return;
      e.preventDefault();
      sph.radius *= Math.exp(e.deltaY * 0.0012);
      apply();
    }, { passive: false });
    element.addEventListener('dblclick', reset);

    function reset() { camera.position.copy(home.position); target.copy(home.target); sync(); apply(); }
    function setHome(position, tgt) { home.position.copy(position); home.target.copy(tgt); reset(); }
    return { reset, setHome };
  }

  /* ------------------------------------------------------------ the engine */
  let engine = null;

  function createEngine(THREE) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(BG, 1);
    wrapEl.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(BG, 0.012);
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 2000);
    scene.add(new THREE.GridHelper(40, 40, 0x2a3a5a, 0x162033));
    scene.add(new THREE.AmbientLight(0x8899bb, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 0.7);
    key.position.set(5, 10, 3);
    scene.add(key);

    const mapGeo = new THREE.BufferGeometry();
    const mapMat = new THREE.PointsMaterial({ size: 0.045, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.85 });
    const mapPoints = new THREE.Points(mapGeo, mapMat);
    scene.add(mapPoints);

    const scanGeo = new THREE.BufferGeometry();
    const scanMat = new THREE.PointsMaterial({ size: 0.07, vertexColors: true, sizeAttenuation: true });
    const scanPoints = new THREE.Points(scanGeo, scanMat);
    scene.add(scanPoints);

    const pathMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false });
    const doneMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, depthTest: false, fog: false });
    const pathMesh = new THREE.Mesh(new THREE.BufferGeometry(), pathMat);
    const doneMesh = new THREE.Mesh(new THREE.BufferGeometry(), doneMat);
    doneMesh.renderOrder = 10;
    scene.add(pathMesh);
    scene.add(doneMesh);

    const chairMat = new THREE.MeshStandardMaterial({ color: view.chairColor, metalness: 0.1, roughness: 0.55 });
    const vehicle = buildWheelchair(THREE, chairMat);
    scene.add(vehicle);

    // Outline of the box that removes points from the static map.
    const boxHelper = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0xff66aa, transparent: true, opacity: 0.9 }));
    boxHelper.visible = false;
    scene.add(boxHelper);

    const controls = attachControls(THREE, camera, renderer.domElement);
    renderer.domElement.classList.add('pc-canvas');

    function resize() {
      const w = wrapEl.clientWidth, h = wrapEl.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    new ResizeObserver(resize).observe(wrapEl);
    resize();

    return { THREE, renderer, scene, camera, controls, mapGeo, mapMat, mapPoints, scanGeo, scanMat, scanPoints,
             pathMat, doneMat, pathMesh, doneMesh, vehicle, chairMat, boxHelper, sprites: {} };
  }

  /* ------------------------------------------------------------ player state */
  let data = null;            // decoded bag
  let tNow = 0;
  let playing = true;
  let speed = 1;
  let shownKey = '';
  let colorVersion = 0;
  const colorCache = new Map();
  let ranges = { zLo: 0, zHi: 1, iLo: 0, iHi: 1 };

  function colorsFor(pos, inten, mode, tNorm) {
    const n = inten.length;
    const out = new Float32Array(n * 3);
    if (mode === 'solid') {
      const c = new engine.THREE.Color(view.solidColor);
      for (let i = 0; i < n; i++) { out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b; }
      return out;
    }
    const zs = 1 / Math.max(1e-6, ranges.zHi - ranges.zLo);
    const is = 1 / Math.max(1e-6, ranges.iHi - ranges.iLo);
    for (let i = 0; i < n; i++) {
      const t = mode === 'intensity' ? (inten[i] - ranges.iLo) * is
        : mode === 'time' ? tNorm
        : (pos[i * 3 + 1] - ranges.zLo) * zs;
      heatColor(t, out, i * 3);
    }
    return out;
  }

  /* ---- exclusion box for the static map, in ROS axes (x forward, y left, z up) ---- */
  const BOX_KEYS = ['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax'];
  let exclude = null;          // { enabled, show, xmin … zmax } for the current experiment
  let excludeKey = null;

  // Default exclusion box for every experiment (map frame, meters).
  const DEFAULT_BOX = { enabled: true, show: false, xmin: -2.8, xmax: 4.9, ymin: -4, ymax: 3.7, zmin: -0.7, zmax: 3.5 };
  function defaultBox() { return Object.assign({}, DEFAULT_BOX); }

  function loadExclude(expId) {
    excludeKey = 'pcPlayer.exclude.' + expId;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(excludeKey) || 'null'); } catch (e) { saved = null; }
    const base = defaultBox();
    exclude = Object.assign(base, saved && typeof saved === 'object' ? saved : {});
    BOX_KEYS.forEach((k) => { if (!Number.isFinite(Number(exclude[k]))) exclude[k] = base[k]; exclude[k] = Number(exclude[k]); });
    exclude.enabled = !!exclude.enabled;
    exclude.show = !!exclude.show;
  }
  function saveExclude() {
    if (!excludeKey || !exclude) return;
    try { localStorage.setItem(excludeKey, JSON.stringify(exclude)); } catch (e) { /* unavailable */ }
  }

  function filteredMap() {
    const m = data.map;
    if (!exclude || !exclude.enabled) return { pos: m.pos, inten: m.inten, hidden: 0 };
    const e = exclude;
    const pos = new Float32Array(m.pos.length);
    const inten = new Float32Array(m.inten.length);
    let k = 0;
    for (let i = 0; i < m.count; i++) {
      const x = m.pos[i * 3], z = m.pos[i * 3 + 1], y = -m.pos[i * 3 + 2];
      if (x >= e.xmin && x <= e.xmax && y >= e.ymin && y <= e.ymax && z >= e.zmin && z <= e.zmax) continue;
      pos[k * 3] = m.pos[i * 3]; pos[k * 3 + 1] = m.pos[i * 3 + 1]; pos[k * 3 + 2] = m.pos[i * 3 + 2];
      inten[k] = m.inten[i];
      k++;
    }
    return { pos: pos.subarray(0, k * 3), inten: inten.subarray(0, k), hidden: m.count - k };
  }

  function refreshMapColors() {
    if (!data) return;
    const E = engine, THREE = E.THREE;
    const mode = view.colorMode === 'time' ? 'height' : view.colorMode;
    const fm = filteredMap();
    E.mapGeo.setAttribute('position', new THREE.BufferAttribute(fm.pos, 3));
    E.mapGeo.setAttribute('color', new THREE.BufferAttribute(colorsFor(fm.pos, fm.inten, mode, 0), 3));
    E.mapGeo.computeBoundingSphere();
    updateBoxHelper();
    $('pcBoxNote').textContent = exclude && exclude.enabled
      ? 'Hiding ' + fm.hidden.toLocaleString() + ' of ' + data.map.count.toLocaleString() + ' map points'
      : '';
  }

  function updateBoxHelper() {
    if (!engine) return;
    const h = engine.boxHelper;
    h.visible = !!data && !!exclude && exclude.show && view.showMap;
    if (!exclude) return;
    const e = exclude;
    h.position.set((e.xmin + e.xmax) / 2, (e.zmin + e.zmax) / 2, -(e.ymin + e.ymax) / 2);
    h.scale.set(Math.max(1e-3, e.xmax - e.xmin), Math.max(1e-3, e.zmax - e.zmin), Math.max(1e-3, e.ymax - e.ymin));
  }

  function writeBoxInputs() {
    $('pcBoxOn').checked = exclude.enabled;
    $('pcBoxShow').checked = exclude.show;
    BOX_KEYS.forEach((k) => {
      const el = $('pcBox_' + k);
      el.value = exclude[k].toFixed(2);
      el.classList.remove('invalid');
    });
  }

  function invalidateColors() {
    colorVersion++;
    colorCache.clear();
    shownKey = '';
  }

  function spriteTexture(kind) {
    const E = engine;
    if (E.sprites[kind]) return E.sprites[kind];
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    if (kind === 'circle') {
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(32, 32, 30, 0, Math.PI * 2);
      g.fill();
    } else {
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.45, 'rgba(255,255,255,0.75)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
    }
    E.sprites[kind] = new E.THREE.CanvasTexture(c);
    return E.sprites[kind];
  }

  function applyPointStyle() {
    if (!engine) return;
    [[engine.mapMat, 0.045, 0.85], [engine.scanMat, 0.07, 1]].forEach(([m, base, opacity]) => {
      m.size = base * view.pointSize;
      m.opacity = opacity;
      if (view.pointShape === 'soft') {
        m.map = spriteTexture('soft'); m.alphaTest = 0.02; m.transparent = true; m.depthWrite = false;
      } else {
        m.map = view.pointShape === 'circle' ? spriteTexture('circle') : null;
        m.alphaTest = view.pointShape === 'circle' ? 0.5 : 0;
        m.transparent = opacity < 1;
        m.depthWrite = true;
      }
      m.needsUpdate = true;
    });
    engine.mapPoints.visible = !!data && view.showMap;
    updateBoxHelper();
  }

  /* WebGL lines are one pixel wide, so the path is a ribbon: a flat strip plus an
     upright one, which keeps its thickness from any angle. */
  function ribbon(pts, width, lift) {
    const THREE = engine.THREE;
    const geo = new THREE.BufferGeometry();
    const n = pts.length;
    if (n < 2) { geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3)); geo.setDrawRange(0, 0); return geo; }
    const pos = new Float32Array(n * 12);
    const half = width / 2;
    let sx = 1, sz = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      const tx = b.x - a.x, tz = b.z - a.z, len = Math.hypot(tx, tz);
      if (len > 1e-6) { sx = -tz / len; sz = tx / len; }
      const p = pts[i], y = p.y + lift, o = i * 12;
      pos.set([p.x + sx * half, y, p.z + sz * half, p.x - sx * half, y, p.z - sz * half,
               p.x, y + half, p.z, p.x, y - half, p.z], o);
    }
    const idx = new Uint32Array((n - 1) * 12);
    for (let i = 0; i < n - 1; i++) {
      const a = i * 4, b = a + 4;
      idx.set([a, a + 1, b, a + 1, b + 1, b, a + 2, a + 3, b + 2, a + 3, b + 3, b + 2], i * 12);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  function rebuildPath() {
    if (!engine) return;
    const E = engine;
    E.pathMesh.geometry.dispose();
    E.doneMesh.geometry.dispose();
    const pts = data ? data.traj : [];
    E.pathMesh.geometry = ribbon(pts, view.pathWidth, 0);
    E.doneMesh.geometry = ribbon(pts, view.pathWidth, 0.06);
    E.doneMesh.geometry.setDrawRange(0, 0);
    applyPathStyle();
  }

  function applyPathStyle() {
    if (!engine) return;
    engine.pathMat.color.set(view.pathColor);
    engine.doneMat.color.set(view.pathColor);
    const on = !!data && view.showPath && data.traj.length > 1;
    engine.pathMesh.visible = on;
    engine.doneMesh.visible = on;
    engine.vehicle.visible = !!data && view.showChair && data.traj.length > 0;
    engine.chairMat.color.set(view.chairColor);
  }

  function trajIndexAt(t) {
    const tr = data.traj;
    let lo = 0, hi = tr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tr[mid].t <= t) lo = mid + 1; else hi = mid; }
    return lo;   // number of samples at or before t
  }

  function frameIndexAt(t) {
    const fr = data.frames;
    let lo = 0, hi = fr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (fr[mid].t <= t) lo = mid + 1; else hi = mid; }
    return Math.max(0, lo - 1);
  }

  function updateVehicle() {
    const tr = data.traj;
    if (!tr.length) return;
    const k = trajIndexAt(tNow);
    engine.doneMesh.geometry.setDrawRange(0, Math.max(0, k - 1) * 12);
    let x, y, z, yaw;
    if (k <= 0) ({ x, y, z, yaw } = tr[0]);
    else if (k >= tr.length) ({ x, y, z, yaw } = tr[tr.length - 1]);
    else {
      const a = tr[k - 1], b = tr[k];
      const u = (tNow - a.t) / Math.max(1e-6, b.t - a.t);
      x = a.x + (b.x - a.x) * u; y = a.y + (b.y - a.y) * u; z = a.z + (b.z - a.z) * u;
      let d = b.yaw - a.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      yaw = a.yaw + d * u;
    }
    // The model faces -z; turn it to the ROS heading (x forward, y left).
    engine.vehicle.position.set(x, y - 0.02, z);
    engine.vehicle.rotation.set(0, Math.atan2(-Math.cos(yaw), Math.sin(yaw)), 0);
  }

  function updateScans() {
    const fr = data.frames;
    const E = engine, THREE = E.THREE;
    const idx = frameIndexAt(tNow);
    const tCur = fr[idx].t;
    let start = idx;
    if (view.windowSec > 0) {
      while (start > 0 && idx - start < MAX_WINDOW_SCANS && fr[start - 1].t >= tCur - view.windowSec) start--;
    }
    const fading = view.fade && view.windowSec > 0;
    const keyNow = start + ':' + idx + ':' + colorVersion + ':' + (fading ? 1 : 0);
    if (keyNow === shownKey) return;
    shownKey = keyNow;

    for (const k of Array.from(colorCache.keys())) if (k < start || k > idx) colorCache.delete(k);
    let total = 0;
    for (let i = start; i <= idx; i++) total += fr[i].count;
    const pos = new Float32Array(Math.max(1, total) * 3);
    const col = new Float32Array(Math.max(1, total) * 3);
    let o = 0;
    for (let i = start; i <= idx; i++) {
      const f = fr[i];
      if (!f.count) continue;
      let c = colorCache.get(i);
      if (!c) {
        c = colorsFor(f.pos, f.inten, view.colorMode, data.duration > 0 ? f.t / data.duration : 0);
        colorCache.set(i, c);
      }
      pos.set(f.pos, o);
      const fade = fading ? 1 - 0.75 * Math.min(1, (tCur - f.t) / view.windowSec) : 1;
      if (fade >= 0.999) col.set(c, o);
      else for (let j = 0; j < c.length; j++) col[o + j] = c[j] * fade;
      o += f.pos.length;
    }
    E.scanGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    E.scanGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    E.scanGeo.setDrawRange(0, total);
    E.scanGeo.computeBoundingSphere();
  }

  function updateTransport() {
    const d = data ? data.duration : 0;
    timeEl.textContent = tNow.toFixed(1) + ' s / ' + d.toFixed(1) + ' s';
    if (!scrubEl.matches(':active')) scrubEl.value = d > 0 ? String(Math.round((tNow / d) * 1000)) : '0';
  }

  function setPlaying(on) {
    playing = on;
    playBtn.textContent = on ? 'Pause' : 'Play';
  }

  /* ------------------------------------------------------------ loading data into the scene */
  function fitCamera() {
    const E = engine, THREE = E.THREE;
    const b = data.map.bounds;
    let center, radius;
    if (b) {
      center = new THREE.Vector3((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
      radius = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 4) * 0.6;
    } else {
      center = new THREE.Vector3();
      radius = 6;
    }
    E.controls.setHome(new THREE.Vector3(center.x + radius, center.y + radius * 0.8, center.z + radius), center);
  }

  function computeRanges() {
    const sample = (arr, stride, step) => {
      const out = [];
      const n = Math.floor(arr.length / stride);
      const jump = Math.max(1, Math.floor(n / 50000));
      for (let i = 0; i < n; i += jump) out.push(arr[i * stride + step]);
      return out.sort((a, b) => a - b);
    };
    const zs = sample(data.map.pos, 3, 1);
    const is = sample(data.map.inten, 1, 0);
    ranges = { zLo: percentile(zs, 0.02), zHi: percentile(zs, 0.98), iLo: percentile(is, 0.02), iHi: percentile(is, 0.98) };
  }

  function useData(d, expId) {
    data = d;
    tNow = data.frames.length ? Math.max(0, data.frames[0].t) : 0;
    loadExclude(expId);
    writeBoxInputs();
    computeRanges();
    invalidateColors();
    refreshMapColors();
    applyPointStyle();
    rebuildPath();
    fitCamera();
    setPlaying(true);
    hidePreview();
    hideOverlay();
  }

  function clearData(message) {
    data = null;
    shownKey = '';
    if (engine) {
      engine.mapPoints.visible = false;
      engine.scanGeo.setDrawRange(0, 0);
      engine.pathMesh.visible = engine.doneMesh.visible = false;
      engine.vehicle.visible = false;
      engine.boxHelper.visible = false;
    }
    $('pcBoxNote').textContent = '';
    tNow = 0;
    updateTransport();
    showOverlay(message);
  }

  /* ------------------------------------------------------------ experiment selection */
  /* The selector lists only experiments whose bag is actually there. Each run's bag is
     checked with a HEAD request (no download) when the section first comes into view. */
  let allExps = window.__experimentList || [];
  let wantedId = window.__experiment ? window.__experiment.id : null;   // the page's selected run
  let available = null;        // runs with a bag, each with the one URL that answered
  let checking = null;
  let currentId = null;        // the run shown in the viewer
  let loadingId = null;        // the run being downloaded or decoded
  let activated = false;
  let loadToken = 0;
  const cache = new Map();     // experiment id -> decoded data (last few)

  function checkAvailability() {
    if (checking) return checking;
    const list = allExps;
    checking = Promise.all(list.map(async (exp) => {
      for (const url of exp.sources || []) {
        try {
          const r = await fetch(url, { method: 'HEAD' });
          if (r.ok) return Object.assign({}, exp, { sources: [url] });
        } catch (e) { /* try the next location */ }
      }
      return null;
    })).then((res) => {
      if (list === allExps) available = res.filter(Boolean);
      return available;
    });
    return checking;
  }

  function fillSelector() {
    if (!available) {
      expSel.innerHTML = '<option>Checking for LiDAR recordings…</option>';
      expSel.disabled = true;
      return;
    }
    if (!available.length) {
      expSel.innerHTML = '<option>No LiDAR recordings available</option>';
      expSel.disabled = true;
      return;
    }
    expSel.innerHTML = '';
    available.forEach((exp) => {
      const o = document.createElement('option');
      o.value = exp.id;
      o.textContent = exp.name;
      expSel.appendChild(o);
    });
    expSel.disabled = available.length < 2;
    if (currentId) expSel.value = currentId;
  }

  async function refresh() {
    fillSelector();
    if (!available) showOverlay('Checking which experiments have LiDAR recordings…');
    await checkAvailability();
    fillSelector();
    if (!available || !available.length) {
      clearData('None of the experiments has a LiDAR recording yet.');
      return;
    }
    // Follow the page's selected run when it has a recording; otherwise keep the one
    // already shown, or start with the first run that has one.
    const target = available.find((e) => e.id === wantedId)
      || available.find((e) => e.id === currentId)
      || available[0];
    show(target);
  }

  function show(exp) {
    // already showing it, or still loading it
    if (exp.id === currentId && (loadingId === exp.id || (data && cache.get(exp.id) === data))) {
      expSel.value = exp.id;
      return;
    }
    currentId = exp.id;
    expSel.value = exp.id;
    if (!cache.has(exp.id)) showPreview(exp);
    loadExperiment(exp);
  }

  async function loadExperiment(exp) {
    loadingId = exp ? exp.id : null;
    try { await loadExperimentInner(exp); } finally { if (loadingId === (exp && exp.id)) loadingId = null; }
  }

  async function loadExperimentInner(exp) {
    const token = ++loadToken;
    const stale = () => token !== loadToken;
    if (!exp) { clearData('Choose an experiment above.'); return; }
    if (!exp.sources || !exp.sources.length) { clearData('This experiment has no LiDAR recording.'); setStatus('wait', ''); return; }

    try {
      showOverlay('Loading the 3D viewer…');
      setStatus('wait', 'loading…');
      await ensureThree();
      if (stale()) return;
      if (!engine) { engine = createEngine(window.THREE); applyPointStyle(); requestAnimationFrame(tick); }

      if (cache.has(exp.id)) {
        useData(cache.get(exp.id), exp.id);
        setStatus('ok', cache.get(exp.id).label);
        return;
      }
      clearData('Downloading the LiDAR recording…');
      const sqlP = ensureSql();
      const bytes = await fetchWithProgress(exp.sources, (got, total) => {
        if (stale()) return;
        showOverlay('Downloading the LiDAR recording… ' + mb(got) + (total ? ' of ' + mb(total) : ''),
                    total ? got / total : undefined);
      }, stale);
      if (stale()) return;
      if (!bytes) { clearData('Couldn’t download the LiDAR recording for this experiment.'); setStatus('bad', 'error'); return; }
      checkSqlite(bytes);

      showOverlay('Preparing the decoder…');
      const SQL = await sqlP;
      if (stale()) return;
      const decoded = await decodeBag(SQL, bytes, (f) => {
        if (!stale()) showOverlay('Decoding scans… ' + Math.round(f * 100) + '%', f);
      }, stale);
      if (stale() || !decoded) return;
      if (!decoded.frames.length) throw new Error('The bag has no LiDAR scans.');
      const pts = decoded.totalPoints >= 1e6 ? (decoded.totalPoints / 1e6).toFixed(2) + 'M'
        : decoded.totalPoints.toLocaleString();
      decoded.label = decoded.frames.length.toLocaleString() + ' scans, ' + pts + ' points, ' + mb(bytes.length);
      cache.set(exp.id, decoded);
      while (cache.size > 3) cache.delete(cache.keys().next().value);
      useData(decoded, exp.id);
      setStatus('ok', decoded.label);
    } catch (err) {
      if (stale()) return;
      console.error(err);
      clearData('Couldn’t show this recording: ' + (err && err.message ? err.message : err));
      setStatus('bad', 'error');
    }
  }

  const sameList = (a, b) => a.length === b.length &&
    a.every((e, i) => e.id === b[i].id && JSON.stringify(e.sources) === JSON.stringify(b[i].sources));

  window.addEventListener('experiment-change', (e) => {
    const d = e.detail || {};
    wantedId = d.id;
    if (Array.isArray(d.all) && !sameList(d.all, allExps)) {
      allExps = d.all;                 // a different config was loaded: check again
      checking = null;
      available = null;
    }
    if (!activated) return;
    if (!available) { refresh(); return; }
    const exp = available.find((x) => x.id === d.id);
    if (exp) show(exp);                // runs without a recording leave the viewer as it is
  });

  expSel.addEventListener('change', () => {
    const exp = available && available.find((x) => x.id === expSel.value);
    if (!exp) return;
    show(exp);
    const main = $('projectSel');      // switch the rest of the page to the same run
    if (main && main.value !== exp.id && Array.from(main.options || []).some((o) => o.value === exp.id)) {
      main.value = exp.id;
      main.dispatchEvent(new Event('change'));
    }
  });

  function activate() {
    if (activated) return;
    activated = true;
    refresh();
  }

  let visible = false;
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) activate();
      }
    }, { rootMargin: '400px 0px' }).observe(section);
    new IntersectionObserver((entries) => {
      for (const en of entries) visible = en.isIntersecting;
    }).observe(stageEl);
  } else {
    visible = true;
    activate();
  }

  /* ------------------------------------------------------------ transport */
  playBtn.addEventListener('click', () => {
    if (!data) return;
    if (!playing && tNow >= data.duration - 1e-3) tNow = 0;
    setPlaying(!playing);
  });
  scrubEl.addEventListener('input', () => {
    if (!data) return;
    setPlaying(false);
    tNow = (Number(scrubEl.value) / 1000) * data.duration;
  });
  speedEl.addEventListener('change', () => { speed = Number(speedEl.value) || 1; });
  resetBtn.addEventListener('click', () => { if (engine) engine.controls.reset(); });

  let last = performance.now();
  function tick(now) {
    requestAnimationFrame(tick);
    const dt = Math.max(0, Math.min(0.25, (now - last) / 1000));
    last = now;
    if (!visible || !engine) return;
    if (data) {
      if (playing) {
        tNow += dt * speed;
        if (tNow > data.duration) tNow = 0;          // loop
      }
      updateScans();
      updateVehicle();
      updateTransport();
    }
    engine.renderer.render(engine.scene, engine.camera);
  }

  /* ------------------------------------------------------------ settings panel */
  function bind(id, event, apply) {
    const el = $(id);
    el.addEventListener(event, () => { apply(el); syncOutputs(); saveView(); });
    return el;
  }
  function syncOutputs() {
    $('pcSolidRow').hidden = view.colorMode !== 'solid';
    $('pcSizeOut').textContent = view.pointSize.toFixed(1) + '×';
    $('pcPathWidthOut').textContent = Math.round(view.pathWidth * 100) + ' cm';
  }
  function writeViewInputs() {
  $('pcColorMode').value = view.colorMode;
  $('pcSolid').value = view.solidColor;
  $('pcSize').value = String(view.pointSize);
  $('pcShape').value = view.pointShape;
  $('pcWindow').value = String(view.windowSec);
  $('pcFade').checked = view.fade;
  $('pcMap').checked = view.showMap;
  $('pcPath').checked = view.showPath;
  $('pcPathColor').value = view.pathColor;
  $('pcPathWidth').value = String(view.pathWidth);
  $('pcChair').checked = view.showChair;
  $('pcChairColor').value = view.chairColor;
  syncOutputs();
  }
  writeViewInputs();

  // Authoring tool, shown with ?tools in the page address: save the current view as preview.jpg.
  if (new URLSearchParams(location.search).has('tools')) $('pcTools').hidden = false;
  $('pcSavePreview').addEventListener('click', () => {
    if (!engine || !data) return;
    // Render and read back in the same task, while the frame is still in the canvas.
    engine.renderer.render(engine.scene, engine.camera);
    engine.renderer.domElement.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'preview.jpg';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/jpeg', 0.88);
  });

  $('pcDefaults').addEventListener('click', () => {
    view = sanitize({});
    try { localStorage.removeItem(VIEW_KEY); } catch (e) { /* unavailable */ }
    writeViewInputs();
    speed = 1;
    speedEl.value = '1';
    if (data && exclude) {
      exclude = defaultBox();
      saveExclude();
      writeBoxInputs();
    }
    invalidateColors();
    applyPointStyle();
    rebuildPath();
    refreshMapColors();
  });

  bind('pcColorMode', 'change', (el) => { view.colorMode = el.value; invalidateColors(); refreshMapColors(); });
  bind('pcSolid', 'input', (el) => { view.solidColor = el.value; invalidateColors(); refreshMapColors(); });
  bind('pcSize', 'input', (el) => { view.pointSize = Number(el.value) || 1; applyPointStyle(); });
  bind('pcShape', 'change', (el) => { view.pointShape = el.value; applyPointStyle(); });
  bind('pcWindow', 'input', (el) => {
    const v = Number(el.value);
    const ok = el.value !== '' && Number.isFinite(v) && v >= 0;
    el.classList.toggle('invalid', !ok);
    if (ok) { view.windowSec = Math.min(120, v); shownKey = ''; }
  });
  bind('pcFade', 'change', (el) => { view.fade = el.checked; shownKey = ''; });
  bind('pcMap', 'change', (el) => { view.showMap = el.checked; applyPointStyle(); });
  bind('pcPath', 'change', (el) => { view.showPath = el.checked; applyPathStyle(); });
  bind('pcPathColor', 'input', (el) => { view.pathColor = el.value; applyPathStyle(); });
  bind('pcPathWidth', 'input', (el) => { view.pathWidth = Number(el.value) || 0.05; rebuildPath(); });
  bind('pcChair', 'change', (el) => { view.showChair = el.checked; applyPathStyle(); });
  bind('pcChairColor', 'input', (el) => { view.chairColor = el.value; if (engine) engine.chairMat.color.set(el.value); });

  /* Exclusion box: edits apply as you type and are remembered per experiment. */
  function onBoxEdited() {
    if (!exclude) return;
    const next = {};
    let ok = true;
    BOX_KEYS.forEach((k) => {
      const el = $('pcBox_' + k);
      const v = Number(el.value);
      const good = el.value !== '' && Number.isFinite(v);
      el.classList.toggle('invalid', !good);
      if (!good) ok = false;
      next[k] = v;
    });
    ['x', 'y', 'z'].forEach((a) => {
      if (ok && next[a + 'min'] > next[a + 'max']) {
        $('pcBox_' + a + 'min').classList.add('invalid');
        $('pcBox_' + a + 'max').classList.add('invalid');
        ok = false;
      }
    });
    if (!ok) return;
    Object.assign(exclude, next);
    saveExclude();
    refreshMapColors();
  }
  BOX_KEYS.forEach((k) => $('pcBox_' + k).addEventListener('input', onBoxEdited));
  $('pcBoxOn').addEventListener('change', () => {
    if (!exclude) return;
    exclude.enabled = $('pcBoxOn').checked;
    saveExclude();
    refreshMapColors();
  });
  $('pcBoxShow').addEventListener('change', () => {
    if (!exclude) return;
    exclude.show = $('pcBoxShow').checked;
    saveExclude();
    updateBoxHelper();
  });
  $('pcBoxReset').addEventListener('click', () => {
    if (!data) return;
    const enabled = exclude ? exclude.enabled : false;
    exclude = Object.assign(defaultBox(), { enabled });
    saveExclude();
    writeBoxInputs();
    refreshMapColors();
  });

  // Exposed for testing the decoder outside the page.
  window.__pcPlayerInternals = { decodeBag, buildMap, locatePoints, parseOdometry };
})();
