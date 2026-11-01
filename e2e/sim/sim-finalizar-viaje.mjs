#!/usr/bin/env node
/**
 * Simulador del front: recorre contra un backend desplegado un viaje de PyME de
 * punta a punta, simulando la ubicación del chofer, y verifica el contrato
 * (CONTRATO-FINALIZAR.md):
 *   - Paso 3: confirmar la última parada ya NO finaliza; lo finaliza "salir" de
 *     la última (POST /api/choferes/viajes/:id/salir).
 *   - Pedido del front 20-10-2026: motivo y descripcion obligatorios, sin
 *     condiciones (las de un cliente viejo se ignoran), motivo en las lecturas
 *     de la PyME y del chofer.
 *   - Tarea 5: la PyME no puede finalizar antes de la hora prevista (409), el
 *     chofer no puede iniciar un segundo viaje en curso (409) y viaje:finalizado
 *     trae cerrado_por CHOFER.
 *
 * No necesita token ni front: crea sus propias cuentas (una PyME y un chofer)
 * con emails `sim+...@fleter.test`, saca el token de Firebase por REST y hace
 * todo con fetch + socket.io. Lo que crea queda en la base (es caja negra: no
 * puede borrar usuarios); se cuenta y se borra con
 * `node scripts/restos.js --solo sim [--borrar]` desde la raíz del repo. Los
 * viajes que queden vivos si algo falla se cancelan al final.
 *
 * Uso:
 *   node e2e/sim/sim-finalizar-viaje.mjs                                  # staging
 *   FLETER_API=http://localhost:3000 node e2e/sim/sim-finalizar-viaje.mjs # local
 *
 * La Web API key de Firebase: FIREBASE_WEB_API_KEY (o FIREBASE_API_KEY) del
 * entorno, de e2e/sim/.env, o del .env de la raíz del repo.
 *
 * Tarda ~1-2 minutos: el viaje tiene que crearse con 60 min de anticipación y
 * la ventana de inicio abre 60 min antes, así que se espera a que abra.
 */

import { readFileSync } from "node:fs";
import { io } from "socket.io-client";

const BASE = process.env.FLETER_API ?? "https://nombre-proyecto-back-staging.up.railway.app";
const FIREBASE_KEY =
  process.env.FIREBASE_WEB_API_KEY ??
  process.env.FIREBASE_API_KEY ??
  leerEnv(".env", ["FIREBASE_WEB_API_KEY", "FIREBASE_API_KEY"]) ??
  leerEnv("../../.env", ["FIREBASE_WEB_API_KEY"]);

if (!FIREBASE_KEY) {
  console.error("Falta FIREBASE_WEB_API_KEY (en el entorno, en e2e/sim/.env o en el .env de la raíz del repo).");
  process.exit(1);
}

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

let fallos = 0;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lee la primera de `claves` que tenga valor en un .env relativo a este script. */
function leerEnv(relativo, claves) {
  try {
    const lineas = readFileSync(new URL(relativo, import.meta.url), "utf8").split(/\r?\n/);
    for (const clave of claves) {
      const valor = lineas
        .find((l) => l.startsWith(`${clave}=`))
        ?.slice(clave.length + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (valor) return valor;
    }
  } catch {
    /* no existe */
  }
  return undefined;
}

function check(titulo, condicion, detalle = "") {
  if (condicion) console.log(`  ${ok("OK  ")} ${titulo}`);
  else {
    console.log(`  ${bad("FALLA")} ${titulo} ${detalle ? dim(detalle) : ""}`);
    fallos++;
  }
}

async function api(token, metodo, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: metodo,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  console.log(dim(`    ${metodo} ${path} → ${res.status} ${JSON.stringify(data)?.slice(0, 160)}`));
  return { status: res.status, data };
}

/** Falla y corta: sin esto el resto del recorrido no tiene sentido. */
function exigir(r, status, que) {
  if (r.status !== status) {
    throw new Error(`No se pudo ${que}: esperaba ${status}, vino ${r.status} ${JSON.stringify(r.data)}`);
  }
  return r.data;
}

// ---- datos de prueba ----

const sufijo = `${Date.now()}`.slice(-8);
const azar = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");

/** CUIT con dígito verificador válido (el backend lo valida). */
function cuitValido() {
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  for (;;) {
    const base = `30${azar(8)}`;
    const resto = base.split("").reduce((s, d, i) => s + Number(d) * pesos[i], 0) % 11;
    const dv = resto === 0 ? 0 : 11 - resto;
    if (dv !== 10) return `${base}${dv}`;
  }
}

// Plaza de Mayo → Obelisco → Recoleta
const PARADAS = [
  { lat: -34.6083, lng: -58.3712, direccion: "Plaza de Mayo, CABA" },
  { lat: -34.6037, lng: -58.3816, direccion: "Obelisco, CABA" },
  { lat: -34.5875, lng: -58.3974, direccion: "Recoleta, CABA" },
];

const MOTIVO = `Simulación del front ${sufijo}`;
const DESCRIPCION = "Simulación de finalizar viaje: tocar timbre, portón azul";

/** ~20 m al norte: dentro del radio (200 m en staging y production, 50 m de default). */
const cerca = (p) => ({ lat: p.lat + 0.00018, lng: p.lng });
/** ~1,1 km al norte: fuera del radio. */
const lejos = (p) => ({ lat: p.lat + 0.01, lng: p.lng });

async function crearCuenta(tipo) {
  const email = `sim+${tipo}-${sufijo}@fleter.test`;
  const contrasena = `Sim-${sufijo}`;
  const body = {
    nombre: tipo === "pyme" ? "Pyme" : "Chofer",
    apellido: `Sim ${sufijo}`,
    dni: azar(8),
    email,
    contrasena,
  };
  const ruta = tipo === "pyme" ? "/api/auth/registro-cliente" : "/api/auth/registro-conductor";
  // La licencia se sigue mandando: mientras LICENCIA_OPCIONAL no esté prendida
  // en staging y production es obligatoria (y un conductor sin licencia rompe
  // al Prisma viejo de production, la base es compartida).
  if (tipo === "chofer") {
    body.nro_licencia = `LIC${sufijo}`;
    body.licencia_vencimiento = "2030-12-31T00:00:00.000Z";
  }
  exigir(await api(null, "POST", ruta, body), 201, `registrar ${tipo}`);

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: contrasena, returnSecureToken: true }),
    },
  );
  const data = await res.json();
  if (!data.idToken) throw new Error(`No se pudo loguear ${email} en Firebase: ${JSON.stringify(data)}`);
  console.log(dim(`    ${tipo}: ${email} / ${contrasena}`));
  return data.idToken;
}

function conectar(token, nombre, eventos) {
  return new Promise((resolve) => {
    const socket = io(BASE, { auth: { token: `Bearer ${token}` }, transports: ["websocket"] });
    socket.onAny((evento, data) => eventos.push({ evento, data }));
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", (e) => {
      console.log(bad(`  socket ${nombre}: ${e.message}`));
      resolve(socket);
    });
  });
}

/** Espera hasta `ms` a que llegue un evento que cumpla `pred`. */
async function esperarEvento(eventos, pred, ms = 5000) {
  for (let t = 0; t < ms && !eventos.some(pred); t += 200) await esperar(200);
  return eventos.find(pred);
}

/** Simula el GPS del chofer: N pings en línea recta de `a` a `b`. */
async function manejar(socket, idViaje, a, b, pasos = 6) {
  for (let i = 1; i <= pasos; i++) {
    const t = i / pasos;
    socket.emit("conductor:ubicacion", {
      id_viaje: idViaje,
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + (b.lng - a.lng) * t,
      timestamp: Date.now(),
    });
    await esperar(700);
  }
}

// Lo necesario para cancelar al final lo que quede vivo.
const estado = { tPyme: null, idOrg: null, viajes: [], sockets: [] };
const FINALES = ["FINALIZADO", "CANCELADO", "RECHAZADO", "VENCIDO"];

async function cancelarVivos() {
  for (const id of estado.viajes) {
    const r = await api(estado.tPyme, "GET", `/api/organizaciones/${estado.idOrg}/viajes/${id}`).catch(() => null);
    if (r?.status === 200 && !FINALES.includes(r.data?.estado)) {
      await api(estado.tPyme, "POST", `/api/organizaciones/${estado.idOrg}/viajes/${id}/cancelar`, { motivo: "sim: limpieza" }).catch(() => null);
    }
  }
}

async function recorrido() {
  console.log(`Base: ${BASE}`);
  const salud = await fetch(`${BASE}/health`).then((r) => r.json());
  console.log(`Salud: ${salud.status} ${dim(JSON.stringify(salud.capacidades))}`);

  // ---- 1. Armado: PyME, chofer vinculado, vehículo ----
  console.log(bold("\n1. Armado"));
  const tPyme = await crearCuenta("pyme");
  const tChofer = await crearCuenta("chofer");
  estado.tPyme = tPyme;

  const org = exigir(
    await api(tPyme, "POST", "/api/organizaciones", { nombre: `PyME Sim ${sufijo}`, cuit: cuitValido() }),
    201,
    "crear la PyME",
  );
  estado.idOrg = org.id_organizacion;
  const inv = exigir(
    await api(tPyme, "POST", `/api/organizaciones/${org.id_organizacion}/invitaciones`, { tipo: "CHOFER" }),
    201,
    "generar el código de chofer",
  );
  exigir(await api(tChofer, "POST", "/api/invitaciones/canjear", { codigo: inv.codigo }), 200, "canjear el código");

  // Vehículo SIN condiciones: el ciclo de la PyME no las usa.
  const vehiculo = exigir(
    await api(tChofer, "POST", "/api/conductores/mis-vehiculos", {
      patente: `SM${sufijo.slice(-5)}`,
      marca: "Fiat",
      modelo: "Fiorino",
      anio: 2022,
      color: "Blanco",
      tipo_vehiculo: "Utilitario",
    }),
    201,
    "registrar el vehículo",
  );

  const choferes = exigir(await api(tPyme, "GET", `/api/organizaciones/${org.id_organizacion}/choferes`), 200, "listar choferes");
  const idConductor = choferes[0].id_conductor;

  // Sockets antes de crear los viajes: el chofer tiene que recibir viaje:asignado.
  const eventosPyme = [];
  const eventosChofer = [];
  const sPyme = await conectar(tPyme, "PyME", eventosPyme);
  const sChofer = await conectar(tChofer, "chofer", eventosChofer);
  estado.sockets.push(sPyme, sChofer);

  // ---- 2. Crear: motivo y descripción obligatorios, sin condiciones ----
  console.log(bold("\n2. Crear el viaje"));
  // 60 min de anticipación mínima + 30 s; la ventana abre 60 min antes → abre en ~30 s.
  const fecha = new Date(Date.now() + 60 * 60_000 + 30_000).toISOString();
  const rutaViajes = `/api/organizaciones/${org.id_organizacion}/viajes`;
  const cuerpo = (extra = {}) => ({
    id_conductor: idConductor,
    fecha_programada: fecha,
    paradas: PARADAS,
    motivo: MOTIVO,
    descripcion: DESCRIPCION,
    ...extra,
  });
  const sin = (clave) => Object.fromEntries(Object.entries(cuerpo()).filter(([k]) => k !== clave));

  // Estos 400 los corta la validación, antes de Google: no crean nada.
  let r = await api(tPyme, "POST", rutaViajes, sin("motivo"));
  check('crear sin motivo → 400 "motivo es requerido"', r.status === 400 && r.data?.error === "motivo es requerido");
  r = await api(tPyme, "POST", rutaViajes, cuerpo({ motivo: "x".repeat(121) }));
  check("crear con motivo de 121 caracteres → 400", r.status === 400 && /120/.test(r.data?.error));
  r = await api(tPyme, "POST", rutaViajes, cuerpo({ descripcion: "   " }));
  check('crear con descripción vacía → 400 "descripcion no puede estar vacia"', r.status === 400 && r.data?.error === "descripcion no puede estar vacia");

  const viaje = exigir(await api(tPyme, "POST", rutaViajes, cuerpo()), 201, "crear el viaje");
  const id = viaje.id_viaje;
  estado.viajes.push(id);
  const [p1, p2, p3] = viaje.paradas.sort((a, b) => a.orden - b.orden);
  console.log(`  viaje ${bold(id)} con paradas ${p1.id_parada}, ${p2.id_parada}, ${p3.id_parada}`);
  check("la respuesta trae motivo y descripción, y no condiciones_requeridas", viaje.motivo === MOTIVO && viaje.descripcion === DESCRIPCION && !("condiciones_requeridas" in viaje));

  // Un cliente viejo todavía manda condiciones: se ignoran sin error. Este
  // segundo viaje sirve después para el 409 de "otro viaje en curso".
  const viaje2 = exigir(
    await api(tPyme, "POST", rutaViajes, cuerpo({ condiciones_requeridas: ["REFRIGERADO", "PELIGROSO"] })),
    201,
    "crear el segundo viaje (con condiciones de un cliente viejo)",
  );
  const id2 = viaje2.id_viaje;
  estado.viajes.push(id2);
  check("condiciones_requeridas en el body → 201 y no vuelven", !("condiciones_requeridas" in viaje2));

  const asignado = await esperarEvento(eventosChofer, (e) => e.evento === "viaje:asignado" && e.data?.id_viaje === id);
  check("viaje:asignado al chofer trae el motivo", asignado?.data?.motivo === MOTIVO, JSON.stringify(asignado?.data ?? null)?.slice(0, 160));

  r = await api(tPyme, "GET", `${rutaViajes}/${id}`);
  check("detalle de la PyME → motivo y descripción", r.data?.motivo === MOTIVO && r.data?.descripcion === DESCRIPCION);
  r = await api(tChofer, "GET", `/api/choferes/viajes/${id}`);
  check("detalle del chofer → motivo y descripción, sin condiciones", r.data?.motivo === MOTIVO && r.data?.descripcion === DESCRIPCION && !("condiciones_requeridas" in (r.data ?? {})));
  r = await api(tChofer, "GET", "/api/choferes/viajes?grupo=asignados");
  check("lista del chofer → motivo", Array.isArray(r.data) && r.data.find((v) => v.id_viaje === id)?.motivo === MOTIVO);

  exigir(await api(tChofer, "POST", `/api/choferes/viajes/${id}/confirmar`, { id_vehiculo: vehiculo.id_vehiculo }), 200, "confirmar el viaje");
  r = await api(tChofer, "POST", `/api/choferes/viajes/${id2}/confirmar`, { id_vehiculo: vehiculo.id_vehiculo });
  check("confirmar el viaje con condiciones viejas con un vehículo sin condiciones → 200", r.status === 200);

  // ---- 3. Iniciar, con ubicación simulada ----
  console.log(bold("\n3. Iniciar en el origen"));
  r = await api(tChofer, "POST", `/api/choferes/viajes/${id}/iniciar`, lejos(PARADAS[0]));
  check("iniciar a 1 km del origen → 400 con la distancia", r.status === 400 && /m del origen/.test(r.data?.error));

  sChofer.emit("conductor:ubicacion", { id_viaje: id, ...PARADAS[0], timestamp: Date.now() });
  // El error llega por socket; staging a veces tarda más de un segundo.
  const rechazado = await esperarEvento(eventosChofer, (e) => e.evento === "error" && /no fue iniciado/.test(e.data?.error));
  check('ping GPS antes de iniciar → error "El viaje no fue iniciado"', Boolean(rechazado));

  for (let intento = 0; intento < 18; intento++) {
    r = await api(tChofer, "POST", `/api/choferes/viajes/${id}/iniciar`, cerca(PARADAS[0]));
    if (r.status !== 400 || !/a partir de/.test(r.data?.error)) break;
    console.log(dim("    la ventana todavía no abrió, espero 10 s…"));
    await esperar(10_000);
  }
  check("iniciar a ~20 m del origen → 200 CARGANDO", r.status === 200 && r.data?.estado === "CARGANDO", JSON.stringify(r.data));
  if (r.status !== 200) throw new Error("no se pudo iniciar el viaje");

  // Tarea 5: un solo viaje en curso por chofer (se chequea antes que la ventana).
  r = await api(tChofer, "POST", `/api/choferes/viajes/${id2}/iniciar`, cerca(PARADAS[0]));
  check('iniciar un segundo viaje con otro en curso → 409 "Ya tenes un viaje en curso"', r.status === 409 && /viaje en curso/.test(r.data?.error), JSON.stringify(r.data));
  r = await api(tPyme, "POST", `${rutaViajes}/${id2}/cancelar`, { motivo: "sim: segundo viaje" });
  check("la PyME cancela el segundo viaje → 200", r.status === 200);

  // ---- 4. Ciclo por parada ----
  console.log(bold("\n4. Parada 1 → parada 2"));
  r = await api(tChofer, "POST", `/api/viajes/${id}/confirmar-parada`, { id_parada: p2.id_parada, ...PARADAS[1] });
  check('confirmar la 2 sin salir de la 1 → 400 "toca Salir"', r.status === 400 && /Salir/.test(r.data?.error));

  r = await api(tChofer, "POST", `/api/choferes/viajes/${id}/salir`);
  check("salir de la 1 → EN_RUTA, viaje_finalizado false", r.status === 200 && r.data?.estado === "EN_RUTA" && r.data?.viaje_finalizado === false);

  r = await api(tChofer, "POST", `/api/choferes/viajes/${id}/salir`);
  check('salir en EN_RUTA → 400 "No estas en ninguna parada"', r.status === 400 && /ninguna parada/.test(r.data?.error));

  await manejar(sChofer, id, PARADAS[0], PARADAS[1]);

  r = await api(tChofer, "POST", `/api/viajes/${id}/confirmar-parada`, { id_parada: p3.id_parada, ...PARADAS[2] });
  check('confirmar la 3 salteando la 2 → 400 "Primero tenes que confirmar la parada 2"', r.status === 400 && /parada 2/.test(r.data?.error));

  r = await api(tChofer, "POST", `/api/viajes/${id}/confirmar-parada`, { id_parada: p2.id_parada, ...lejos(PARADAS[1]) });
  check('confirmar la 2 a 1 km → 400 "Estas a Xm"', r.status === 400 && /Estas a/.test(r.data?.error));

  r = await api(tChofer, "POST", `/api/viajes/${id}/confirmar-parada`, { id_parada: p2.id_parada, ...cerca(PARADAS[1]) });
  check("confirmar la 2 a ~20 m → DESCARGANDO, viaje_finalizado false", r.status === 200 && r.data?.estado === "DESCARGANDO" && r.data?.viaje_finalizado === false);

  console.log(bold("\n5. Parada 2 → parada 3 (la última)"));
  r = await api(tChofer, "POST", `/api/choferes/viajes/${id}/salir`);
  check("salir de la 2 → EN_RUTA", r.status === 200 && r.data?.estado === "EN_RUTA");

  await manejar(sChofer, id, PARADAS[1], PARADAS[2]);

  r = await api(tChofer, "POST", `/api/viajes/${id}/confirmar-parada`, { id_parada: p3.id_parada, ...cerca(PARADAS[2]) });
  check(
    bold("confirmar la ÚLTIMA → DESCARGANDO y viaje_finalizado false (ya no finaliza)"),
    r.status === 200 && r.data?.estado === "DESCARGANDO" && r.data?.viaje_finalizado === false,
    JSON.stringify(r.data),
  );

  r = await api(tPyme, "GET", `${rutaViajes}/${id}`);
  check("la PyME lo ve en DESCARGANDO, no FINALIZADO", r.data?.estado === "DESCARGANDO", `estado=${r.data?.estado}`);
  check("el cierre manual todavía no está habilitado (hay hora prevista de fin)", r.data?.cierre?.cierre_manual_habilitado === false && Boolean(r.data?.cierre?.hora_prevista_fin), JSON.stringify(r.data?.cierre));

  // Tarea 5: la PyME no puede finalizar antes de la hora prevista de fin.
  r = await api(tPyme, "POST", `${rutaViajes}/${id}/finalizar`);
  check('la PyME intenta finalizar antes de la hora prevista → 409 "Todavia no se puede finalizar"', r.status === 409 && /Todavia no se puede finalizar/.test(r.data?.error), JSON.stringify(r.data));

  r = await api(tChofer, "PATCH", `/api/viajes/${id}/estado`, { estado: "EN_RUTA" });
  check("PATCH /api/viajes/:id/estado en viaje de PyME → 400", r.status === 400);

  // ---- 6. Finalizar ----
  console.log(bold("\n6. Salir de la última = finalizar"));
  r = await api(tChofer, "POST", `/api/choferes/viajes/${id}/salir`);
  const fin = r.data ?? {};
  check(bold("salir de la última → FINALIZADO, viaje_finalizado true"), r.status === 200 && fin.estado === "FINALIZADO" && fin.viaje_finalizado === true, JSON.stringify(fin));
  check("trae precio_real", typeof fin.precio_real === "number");
  check("trae remito_url", typeof fin.remito_url === "string" && fin.remito_url.length > 0);
  check("trae estimado y real", fin.estimado != null && fin.real != null);
  check("real.distancia_km sale del GPS simulado", typeof fin.real?.distancia_km === "number", `real=${JSON.stringify(fin.real)}`);

  r = await api(tChofer, "POST", `/api/choferes/viajes/${id}/salir`);
  check("salir otra vez → 400 o 409 (no finaliza dos veces)", r.status === 400 || r.status === 409);

  r = await api(tChofer, "POST", `/api/viajes/${id}/confirmar-parada`, { id_parada: p3.id_parada, ...cerca(PARADAS[2]) });
  check("confirmar la última de nuevo → 400", r.status === 400);

  r = await api(tPyme, "POST", `${rutaViajes}/${id}/finalizar`);
  check('la PyME intenta finalizar un viaje ya cerrado → 409 "cerrado por el chofer"', r.status === 409 && /cerrado por el chofer/.test(r.data?.error), JSON.stringify(r.data));

  const antes = eventosChofer.length;
  sChofer.emit("conductor:ubicacion", { id_viaje: id, ...PARADAS[2], timestamp: Date.now() });
  await esperar(2000);
  check("ping GPS con el viaje finalizado → se ignora sin error", !eventosChofer.slice(antes).some((e) => e.evento === "error"));

  r = await api(tPyme, "GET", `${rutaViajes}/${id}`);
  const det = r.data ?? {};
  check("detalle de la PyME → FINALIZADO, cerrado por el CHOFER, completo", det.estado === "FINALIZADO" && det.cierre?.cerrado_por === "CHOFER" && det.cierre?.incompleto === false, JSON.stringify(det.cierre));
  const paradas = det.paradas ?? [];
  check(
    "las 3 paradas tienen llegada_real y salida_real",
    paradas.length === 3 && paradas.every((p) => p.llegada_real && p.salida_real),
    JSON.stringify(paradas.map((p) => ({ orden: p.orden, llegada: p.llegada_real, salida: p.salida_real }))),
  );

  r = await api(tPyme, "GET", `${rutaViajes}/${id}/remito`);
  check("remito disponible para la PyME", r.status === 200);

  // ---- 7. Sockets ----
  console.log(bold("\n7. Eventos"));
  const nombres = eventosPyme.map((e) => e.evento);
  console.log(dim(`    PyME: ${[...new Set(nombres)].map((n) => `${n}×${nombres.filter((x) => x === n).length}`).join("  ")}`));
  const finalizados = eventosPyme.filter((e) => e.evento === "viaje:finalizado" && e.data?.id_viaje === id);
  check("viaje:finalizado llegó a la PyME exactamente una vez", finalizados.length === 1, `llegó ${finalizados.length}`);
  const f = finalizados[0]?.data ?? {};
  check("viaje:finalizado trae estimado, real y paradas", f.estimado && f.real && f.paradas);
  check(
    "viaje:finalizado trae cerrado_por CHOFER, incompleto false, paradas_no_visitadas [] y fecha_corte_precio",
    f.cerrado_por === "CHOFER" && f.incompleto === false && Array.isArray(f.paradas_no_visitadas) && f.paradas_no_visitadas.length === 0 && Boolean(f.fecha_corte_precio),
    JSON.stringify({ cerrado_por: f.cerrado_por, incompleto: f.incompleto, paradas_no_visitadas: f.paradas_no_visitadas, fecha_corte_precio: f.fecha_corte_precio }),
  );
  const alChofer = await esperarEvento(eventosChofer, (e) => e.evento === "viaje:finalizado" && e.data?.id_viaje === id);
  check("viaje:finalizado también le llega al chofer, con cerrado_por CHOFER", alChofer?.data?.cerrado_por === "CHOFER");

  const estados = eventosPyme
    .filter((e) => e.evento === "viaje:estado_cambiado" && e.data?.id_viaje === id)
    .map((e) => `${e.data?.estado_anterior}→${e.data?.estado_nuevo}`);
  console.log(dim(`    estado_cambiado: ${estados.join("  ")}`));
  const SECUENCIA = ["CONFIRMADO→CARGANDO", "CARGANDO→EN_RUTA", "EN_RUTA→DESCARGANDO", "DESCARGANDO→EN_RUTA", "EN_RUTA→DESCARGANDO"];
  check(
    "viaje:estado_cambiado: la secuencia del contrato (salir de la última NO lo emite, solo viaje:finalizado)",
    JSON.stringify(estados) === JSON.stringify(SECUENCIA),
    estados.join(" "),
  );
  check(
    "viaje:estado_cambiado trae estado_anterior, estado_nuevo e id_parada",
    eventosPyme.filter((e) => e.evento === "viaje:estado_cambiado" && e.data?.id_viaje === id).every((e) => e.data.estado_anterior && e.data.estado_nuevo && e.data.id_parada),
  );
  check("hubo mapa:actualizar (el GPS simulado llegó a la PyME)", nombres.includes("mapa:actualizar"));

  console.log(`\nViajes ${id} (finalizado) y ${id2} (cancelado), PyME ${org.id_organizacion}.`);
}

let codigo = 1;
try {
  await recorrido();
  codigo = fallos === 0 ? 0 : 1;
  console.log(fallos === 0 ? ok("Todo OK.") : bad(`${fallos} chequeo(s) fallaron.`));
} catch (e) {
  console.error(bad("\nCortado:"), e.message);
  if (fallos > 0) console.log(bad(`${fallos} chequeo(s) fallaron antes del corte.`));
} finally {
  // La base de staging es la de production: no puede quedar un viaje vivo.
  await cancelarVivos().catch((e) => console.error(bad("No se pudieron cancelar los viajes vivos:"), e.message));
  estado.sockets.forEach((s) => s.close());
}
process.exit(codigo);
