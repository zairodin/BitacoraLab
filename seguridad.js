'use strict';

/*
 * Seguridad de la bitácora
 * ------------------------
 * - Los datos se cifran con AES-256-GCM antes de guardarse en el dispositivo.
 * - La llave de datos es aleatoria y se guarda "envuelta" (cifrada) dos veces:
 *     · con una llave derivada de la contraseña (PBKDF2-SHA256, 600 000 iteraciones)
 *     · con una llave derivada del código de recuperación
 * - Nada se envía a ningún servidor.
 */
const Boveda = (() => {
  const CLAVE = 'bitacoraAgua.boveda.v1';
  const CLAVE_ANTIGUA = 'bitacoraAgua.v1';        // datos sin cifrar de la primera versión
  const ITER_PASS = 600000;
  const ITER_REC = 100000;
  const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I para evitar confusiones
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const aB64 = buf => {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const deB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const azar = n => crypto.getRandomValues(new Uint8Array(n));
  const normCodigo = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  let dek = null;                 // llave de datos (solo en memoria mientras está desbloqueada)
  let boveda = leer();

  function leer() {
    try { return JSON.parse(localStorage.getItem(CLAVE)); } catch (e) { return null; }
  }
  function escribir() {
    localStorage.setItem(CLAVE, JSON.stringify(boveda));
  }

  async function derivar(secreto, sal, iter) {
    const base = await crypto.subtle.importKey('raw', enc.encode(secreto), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: iter },
      base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']);
  }
  async function envolver(secreto, iter) {
    const sal = azar(16), iv = azar(12);
    const kek = await derivar(secreto, sal, iter);
    const ct = await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv });
    return { sal: aB64(sal), iter, iv: aB64(iv), ct: aB64(ct) };
  }
  async function desenvolver(secreto, w) {
    const kek = await derivar(secreto, deB64(w.sal), w.iter);
    return crypto.subtle.unwrapKey('raw', deB64(w.ct), kek, { name: 'AES-GCM', iv: deB64(w.iv) },
      { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  }
  async function cifrarCon(llave, texto) {
    const iv = azar(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, llave, enc.encode(texto));
    return { iv: aB64(iv), ct: aB64(ct) };
  }
  async function descifrarCon(llave, d) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: deB64(d.iv) }, llave, deB64(d.ct));
    return dec.decode(pt);
  }
  function generarCodigo() {
    const bytes = azar(20);           // 20 caracteres de 32 símbolos = 100 bits
    const c = Array.from(bytes, b => ALFABETO[b % 32]).join('');
    return c.match(/.{4}/g).join('-');
  }
  async function verificar(password) {
    try { await desenvolver(password, boveda.pass); return true; } catch (e) { return false; }
  }

  return {
    disponible: () => !!(window.isSecureContext && window.crypto?.subtle),
    existe: () => !!(boveda && boveda.pass && boveda.rec),
    abierta: () => !!dek,

    /** Crea la bóveda. Devuelve el código de recuperación (se muestra una sola vez). */
    async crear(password) {
      let inicial = null;
      try { inicial = JSON.parse(localStorage.getItem(CLAVE_ANTIGUA)); } catch (e) { /* sin datos previos */ }
      dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      const codigo = generarCodigo();
      boveda = { v: 1, pass: await envolver(password, ITER_PASS), rec: await envolver(normCodigo(codigo), ITER_REC), datos: null };
      if (inicial && typeof inicial.registros === 'object') boveda.datos = await cifrarCon(dek, JSON.stringify(inicial));
      escribir();
      localStorage.removeItem(CLAVE_ANTIGUA);
      return codigo;
    },

    async abrir(password) {
      try { dek = await desenvolver(password, boveda.pass); return true; } catch (e) { dek = null; return false; }
    },

    async recuperar(codigo, nueva) {
      try { dek = await desenvolver(normCodigo(codigo), boveda.rec); } catch (e) { dek = null; return false; }
      boveda.pass = await envolver(nueva, ITER_PASS);
      escribir();
      return true;
    },

    async cambiar(actual, nueva) {
      if (!dek || !(await verificar(actual))) return false;
      boveda.pass = await envolver(nueva, ITER_PASS);
      escribir();
      return true;
    },

    /** Genera un código de recuperación nuevo; el anterior deja de funcionar. */
    async nuevoCodigo(actual) {
      if (!dek || !(await verificar(actual))) return null;
      const codigo = generarCodigo();
      boveda.rec = await envolver(normCodigo(codigo), ITER_REC);
      escribir();
      return codigo;
    },

    async leer() {
      if (!dek) throw new Error('Bóveda bloqueada');
      return boveda.datos ? JSON.parse(await descifrarCon(dek, boveda.datos)) : null;
    },

    async guardar(texto) {
      if (!dek) throw new Error('Bóveda bloqueada');
      boveda.datos = await cifrarCon(dek, texto);
      escribir();
    },

    /** Respaldo cifrado con una contraseña propia (puede ser la misma de la app). */
    async cifrarRespaldo(obj, password) {
      const sal = azar(16);
      const llave = await derivar(password, sal, ITER_PASS);
      const { iv, ct } = await cifrarCon(llave, JSON.stringify(obj));
      return { app: 'bitacora-agua', version: 2, cifrado: true, exportado: new Date().toISOString(),
               kdf: { sal: aB64(sal), iter: ITER_PASS }, iv, ct };
    },

    async descifrarRespaldo(data, password) {
      try {
        const llave = await derivar(password, deB64(data.kdf.sal), data.kdf.iter);
        return JSON.parse(await descifrarCon(llave, data));
      } catch (e) { return null; }
    },
  };
})();


/*
 * Pantalla de bloqueo: crear contraseña, desbloquear y recuperar acceso.
 * Llama a alAbrir(datos) cuando la bóveda queda abierta.
 */
const Candado = (() => {
  const $l = s => document.querySelector(s);
  const MIN = 8;
  const INTENTOS = 'bitacoraAgua.intentos';
  let alAbrir = null;

  function panel(id) {
    document.querySelectorAll('#lock .lk').forEach(p => p.classList.toggle('hidden', p.id !== id));
    const primero = document.querySelector(`#${id} input`);
    if (primero) setTimeout(() => primero.focus(), 50);
  }
  function error(id, msg) {
    const e = $l(id);
    e.textContent = msg || '';
    e.classList.toggle('hidden', !msg);
  }
  function ocupado(form, si, texto) {
    const b = form.querySelector('button[type=submit]');
    b.disabled = si;
    if (texto) b.dataset.t = b.dataset.t || b.textContent;
    b.textContent = si ? texto : (b.dataset.t || b.textContent);
  }
  function validarNueva(p1, p2) {
    if (p1.length < MIN) return `La contraseña debe tener al menos ${MIN} caracteres.`;
    if (p1 !== p2) return 'Las contraseñas no coinciden.';
    return '';
  }
  async function abrir() {
    const datos = await Boveda.leer();
    localStorage.removeItem(INTENTOS);
    document.body.classList.remove('locked');
    $l('#lock').classList.add('hidden');
    document.querySelectorAll('#lock input').forEach(i => { i.value = ''; });
    alAbrir(datos);
  }
  function mostrarCodigo(codigo, despues) {
    $l('#lkCodigoTxt').textContent = codigo;
    $l('#lkCodigoOk').checked = false;
    $l('#lkCodigoBtn').disabled = true;
    $l('#lkCodigoBtn').onclick = despues;
    panel('lkCodigo');
  }
  function espera() {
    const n = Number(localStorage.getItem(INTENTOS) || 0);
    return n >= 5 ? 30 : 0;                     // tras 5 intentos fallidos: 30 s entre intentos
  }

  function iniciar(callback) {
    alAbrir = callback;
    document.body.classList.add('locked');
    $l('#lock').classList.remove('hidden');

    if (!Boveda.disponible()) { panel('lkNoDisp'); return; }

    $l('#lkCodigoOk').addEventListener('change', e => { $l('#lkCodigoBtn').disabled = !e.target.checked; });

    $l('#lkSetup').addEventListener('submit', async e => {
      e.preventDefault();
      const msg = validarNueva($l('#lkP1').value, $l('#lkP2').value);
      error('#lkSetupErr', msg);
      if (msg) return;
      ocupado(e.target, true, 'Creando…');
      try {
        const codigo = await Boveda.crear($l('#lkP1').value);
        mostrarCodigo(codigo, abrir);
      } catch (err) {
        error('#lkSetupErr', 'No se pudo crear la contraseña: ' + err.message);
      } finally { ocupado(e.target, false); }
    });

    $l('#lkUnlock').addEventListener('submit', async e => {
      e.preventDefault();
      const seg = espera();
      if (seg) {
        const desde = Number(localStorage.getItem(INTENTOS + '.t') || 0);
        const faltan = Math.ceil(seg - (Date.now() - desde) / 1000);
        if (faltan > 0) { error('#lkUnlockErr', `Demasiados intentos. Espera ${faltan} s.`); return; }
      }
      ocupado(e.target, true, 'Verificando…');
      const ok = await Boveda.abrir($l('#lkPass').value);
      ocupado(e.target, false);
      if (ok) { await abrir(); return; }
      localStorage.setItem(INTENTOS, String(Number(localStorage.getItem(INTENTOS) || 0) + 1));
      localStorage.setItem(INTENTOS + '.t', String(Date.now()));
      $l('#lkPass').value = '';
      error('#lkUnlockErr', 'Contraseña incorrecta.');
      $l('#lkPass').focus();
    });

    $l('#lkOlvide').addEventListener('click', () => { error('#lkRecErr', ''); panel('lkRecover'); });
    $l('#lkVolver').addEventListener('click', () => { error('#lkUnlockErr', ''); panel('lkUnlock'); });

    $l('#lkRecover').addEventListener('submit', async e => {
      e.preventDefault();
      const msg = validarNueva($l('#lkN1').value, $l('#lkN2').value);
      error('#lkRecErr', msg);
      if (msg) return;
      ocupado(e.target, true, 'Verificando…');
      const ok = await Boveda.recuperar($l('#lkCod').value, $l('#lkN1').value);
      ocupado(e.target, false);
      if (!ok) { error('#lkRecErr', 'El código de recuperación no es correcto.'); return; }
      await abrir();
    });

    panel(Boveda.existe() ? 'lkUnlock' : 'lkSetup');
  }

  return { iniciar, mostrarCodigo, validarNueva, MIN };
})();
