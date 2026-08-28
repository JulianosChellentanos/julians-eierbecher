// OVJU — prozedurale Szenen & Deko-Props (kein externes Bildmaterial nötig)
import * as THREE from 'three';

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Einfaches deterministisches Rauschen (kein Math.random → stabile Optik)
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Holz-Tischplatte: Dielen mit Maserung */
export function woodTexture() {
  return canvasTexture(1024, 1024, (ctx, w, h) => {
    const rand = rng(42);
    const plankW = 176;
    for (let px = 0; px < w; px += plankW) {
      const light = 0.88 + rand() * 0.2;
      ctx.fillStyle = `rgb(${Math.round(172 * light)}, ${Math.round(132 * light)}, ${Math.round(96 * light)})`;
      ctx.fillRect(px, 0, plankW, h);
      // Maserung
      for (let i = 0; i < 26; i++) {
        ctx.strokeStyle = `rgba(84, 58, 38, ${0.04 + rand() * 0.07})`;
        ctx.lineWidth = 1 + rand() * 2;
        ctx.beginPath();
        const x0 = px + rand() * plankW;
        ctx.moveTo(x0, 0);
        for (let y = 0; y <= h; y += 64) {
          ctx.lineTo(x0 + Math.sin(y * 0.01 + i) * 6 + (rand() - 0.5) * 8, y);
        }
        ctx.stroke();
      }
      // Astloch gelegentlich
      if (rand() < 0.5) {
        const kx = px + 30 + rand() * (plankW - 60), ky = rand() * h;
        const g = ctx.createRadialGradient(kx, ky, 2, kx, ky, 14);
        g.addColorStop(0, 'rgba(70,46,28,0.55)');
        g.addColorStop(1, 'rgba(70,46,28,0)');
        ctx.fillStyle = g;
        ctx.fillRect(kx - 16, ky - 16, 32, 32);
      }
      // Fuge
      ctx.fillStyle = 'rgba(60, 40, 24, 0.5)';
      ctx.fillRect(px + plankW - 2, 0, 2, h);
    }
  });
}

/** Wand mit weichem Lichtverlauf + feinem Rauschen */
export function wallTexture(top, bottom) {
  return canvasTexture(512, 512, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const rand = rng(7);
    for (let i = 0; i < 1600; i++) {
      ctx.fillStyle = `rgba(255,255,255,${rand() * 0.035})`;
      ctx.fillRect(rand() * w, rand() * h, 1.6, 1.6);
    }
  });
}

/** Weißes Frühstücksei (sitzt im Eierbecher) */
export function makeEgg() {
  const geo = new THREE.SphereGeometry(1, 40, 28);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: 0xf7f2e8, roughness: 0.45,
  }));
  mesh.scale.set(21, 27, 21);
  mesh.castShadow = true;
  return mesh;
}

/** Trockengräser für die Vasen-Vorschau */
export function makeGrass(openingRadius, topY) {
  const group = new THREE.Group();
  const colors = [0xc9b189, 0xa8a37b, 0xb89b6a, 0x8f9b74];
  const rand = rng(1234);
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand();
    const r0 = openingRadius * 0.45 * rand();
    const lean = 14 + rand() * 30;
    const hgt = 55 + rand() * 75;
    const sway = (rand() - 0.5) * 24;
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(Math.cos(a) * r0, topY - 18, Math.sin(a) * r0),
      new THREE.Vector3(Math.cos(a) * (r0 + lean * 0.4), topY + hgt * 0.5, Math.sin(a) * (r0 + lean * 0.4) + sway * 0.4),
      new THREE.Vector3(Math.cos(a) * (r0 + lean), topY + hgt, Math.sin(a) * (r0 + lean) + sway),
    ]);
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 14, 0.7, 5),
      new THREE.MeshStandardMaterial({ color: colors[i % colors.length], roughness: 0.8 })
    );
    tube.castShadow = true;
    group.add(tube);
    // kleine Samen-Spitze
    const tip = new THREE.Mesh(
      new THREE.ConeGeometry(1.7, 9, 6),
      new THREE.MeshStandardMaterial({ color: colors[(i + 1) % colors.length], roughness: 0.9 })
    );
    const end = curve.getPoint(1);
    tip.position.copy(end);
    tip.position.y += 4;
    tip.castShadow = true;
    group.add(tip);
  }
  return group;
}
