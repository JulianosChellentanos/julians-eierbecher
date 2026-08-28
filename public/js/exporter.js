// OVJU — binärer STL-Export (Millimeter, little-endian)
import * as THREE from 'three';

/**
 * Exportiert eine Liste von THREE.Mesh als binäres STL.
 * Wendet die World-Matrix jedes Meshes an. Rückgabe: ArrayBuffer.
 */
export function exportSTL(meshes) {
  const tris = [];
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const cb = new THREE.Vector3(), ab = new THREE.Vector3();

  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i += 3) {
      vA.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      vB.fromBufferAttribute(pos, i + 1).applyMatrix4(mesh.matrixWorld);
      vC.fromBufferAttribute(pos, i + 2).applyMatrix4(mesh.matrixWorld);
      cb.subVectors(vC, vB);
      ab.subVectors(vA, vB);
      cb.cross(ab).normalize();
      tris.push([cb.x, cb.y, cb.z, vA.x, vA.y, vA.z, vB.x, vB.y, vB.z, vC.x, vC.y, vC.z]);
    }
    if (geo !== mesh.geometry) geo.dispose();
  }

  const buffer = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buffer);
  const header = 'OVJU Eierbecher — https://ovju.de — units: mm';
  for (let i = 0; i < Math.min(80, header.length); i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    for (let k = 0; k < 12; k++) { dv.setFloat32(o, t[k], true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return buffer;
}

/** ArrayBuffer → Download im Browser */
export function downloadSTL(buffer, filename) {
  const blob = new Blob([buffer], { type: 'model/stl' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** ArrayBuffer → base64 (chunked, stack-sicher) */
export function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
