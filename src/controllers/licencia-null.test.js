// Licencia opcional (pedido del front 20-10-2026), Paso A: la base acepta NULL
// en conductores.nro_licencia / licencia_vencimiento. Mientras production tenga
// el Prisma viejo NO puede haber filas NULL en la DB compartida, asi que las
// lecturas se prueban aca, con prisma mockeado: un conductor sin licencia no
// rompe ninguna de las respuestas que lo traen, y la licencia sale como null.
// (La integracion real va en test-identidad CASO 15, detras de TEST_LICENCIA_NULL.)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  usuario: { count: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  conductor: { findUnique: vi.fn() },
  vinculoChofer: { findMany: vi.fn() },
  viaje: { findUnique: vi.fn() },
}));

vi.mock('../config/prisma.js', () => ({ default: prismaMock }));
vi.mock('../config/firebase.js', () => ({ default: {} }));
vi.mock('../config/redis.js', () => ({ default: { get: vi.fn(), del: vi.fn(), on: vi.fn() } }));
vi.mock('../sockets/index.js', () => ({ io: null }));
vi.mock('../services/ruta.service.js', () => ({
  obtenerRutaPlaneada: vi.fn(async () => null),
  guardarRutaPlaneada: vi.fn(),
  calcularYGuardarRuta: vi.fn(),
}));

const { listarUsuarios, obtenerUsuario } = await import('./admin.controller.js');
const { getMe, schemaConductor, licenciaOpcional } = await import('./auth.controller.js');
const { listarChoferes } = await import('../services/vinculo-chofer.service.js');
const { obtenerViaje } = await import('./viajes.controller.js');

// Un conductor como lo devuelve Prisma (nuevo) con la licencia sin cargar.
const CONDUCTOR_SIN_LICENCIA = {
  id_conductor: 7,
  id_usuario: 70,
  nro_licencia: null,
  licencia_vencimiento: null,
  calificacion_promedio: 0,
};
const USUARIO = { id_usuario: 70, nombre: 'Chofer', apellido: 'Sin Licencia', email: 'x@test.com', rol: 'CONDUCTOR' };

function respuesta() {
  const res = { statusCode: null, body: undefined };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = JSON.parse(JSON.stringify(b))), res);
  return res;
}

beforeEach(() => vi.clearAllMocks());

describe('lecturas con un conductor sin licencia', () => {
  it('GET /api/admin/usuarios -> 200 y licencia null', async () => {
    prismaMock.usuario.count.mockResolvedValue(1);
    prismaMock.usuario.findMany.mockResolvedValue([
      { ...USUARIO, cliente: null, conductor: CONDUCTOR_SIN_LICENCIA, empresas_gerente: [] },
    ]);
    const res = respuesta();
    await listarUsuarios({ query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.usuarios[0].conductor).toMatchObject({ nro_licencia: null, licencia_vencimiento: null });
  });

  it('GET /api/admin/usuarios/:id -> 200 y licencia null', async () => {
    prismaMock.usuario.findUnique.mockResolvedValue(USUARIO);
    prismaMock.conductor.findUnique.mockResolvedValue({
      ...CONDUCTOR_SIN_LICENCIA,
      vehiculos_propios: [],
      conductor_vehiculos: [],
      viajes: [],
    });
    const res = respuesta();
    await obtenerUsuario({ params: { id: '70' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.conductor).toMatchObject({ nro_licencia: null, licencia_vencimiento: null, vehiculos: [], viajes: [] });
  });

  it('GET /api/auth/me de un CONDUCTOR -> 200 (no lee la licencia)', async () => {
    prismaMock.conductor.findUnique.mockResolvedValue({ id_conductor: 7 });
    prismaMock.vinculoChofer.findMany.mockResolvedValue([]);
    const res = respuesta();
    await getMe({ usuario: USUARIO }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.organizaciones).toEqual([]);
  });

  it('GET /api/organizaciones/:id/choferes -> el chofer sin licencia se lista igual', async () => {
    prismaMock.vinculoChofer.findMany.mockResolvedValue([
      {
        fecha_alta: new Date('2026-10-01T00:00:00Z'),
        metodo_cobro: 'CALCULO_PLATAFORMA',
        conductor: {
          id_conductor: 7,
          usuario: { id_usuario: 70, nombre: 'Chofer', apellido: 'Sin Licencia', telefono: null },
          vehiculos_propios: [],
        },
      },
    ]);
    const choferes = await listarChoferes(1);
    expect(choferes).toHaveLength(1);
    expect(choferes[0]).toMatchObject({ id_conductor: 7, vehiculos: [] });
  });

  it('GET /api/viajes/:id (chofer de un viaje interno) -> 200, licencia null y sin condiciones_req', async () => {
    prismaMock.viaje.findUnique.mockResolvedValue({
      id_viaje: 10,
      id_organizacion: 1,
      estado: 'ASIGNADO',
      fecha_programada: new Date(Date.now() + 3_600_000),
      fecha_inicio: null,
      fecha_llegada_origen: null,
      duracion_estimada_horas: 1,
      motivo: 'Reparto',
      descripcion: 'Porton azul',
      paradas: [
        { id_parada: 1, orden: 1, id_lugar: null, llegada_real: null, salida_real: null },
        { id_parada: 2, orden: 2, id_lugar: null, llegada_real: null, salida_real: null },
      ],
      condiciones_req: [{ condicion: 'FRAGIL' }],
      cliente: { id_usuario: 99, usuario: {} },
      conductor: { ...CONDUCTOR_SIN_LICENCIA, usuario: USUARIO },
      vehiculo: null,
      empresa: null,
      calificacion: null,
      historial_estados: [],
    });
    const res = respuesta();
    await obtenerViaje({ params: { id: '10' }, usuario: USUARIO }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.conductor).toMatchObject({ nro_licencia: null, licencia_vencimiento: null });
    expect(res.body).not.toHaveProperty('condiciones_req');
    expect(res.body.motivo).toBe('Reparto');
  });
});

describe('registro del conductor segun LICENCIA_OPCIONAL', () => {
  const ORIGINAL = process.env.LICENCIA_OPCIONAL;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.LICENCIA_OPCIONAL;
    else process.env.LICENCIA_OPCIONAL = ORIGINAL;
  });

  const base = { nombre: 'A', apellido: 'B', dni: '12345678', email: 'a@test.com', contrasena: '123456' };
  const LIC = { nro_licencia: 'LIC1', licencia_vencimiento: '2030-01-01T00:00:00.000Z' };

  it('solo "true" o "1" prenden; default false', () => {
    expect(licenciaOpcional({})).toBe(false);
    expect(licenciaOpcional({ LICENCIA_OPCIONAL: 'false' })).toBe(false);
    expect(licenciaOpcional({ LICENCIA_OPCIONAL: 'si' })).toBe(false);
    expect(licenciaOpcional({ LICENCIA_OPCIONAL: 'true' })).toBe(true);
    expect(licenciaOpcional({ LICENCIA_OPCIONAL: '1' })).toBe(true);
  });

  it('apagada: la licencia sigue siendo obligatoria (las dos)', () => {
    delete process.env.LICENCIA_OPCIONAL;
    expect(schemaConductor().safeParse(base).success).toBe(false);
    expect(schemaConductor().safeParse({ ...base, nro_licencia: 'LIC1' }).success).toBe(false);
    expect(schemaConductor().safeParse({ ...base, ...LIC }).success).toBe(true);
  });

  it('prendida: sin licencia, o con una sola, pasa; si llega se valida como siempre', () => {
    process.env.LICENCIA_OPCIONAL = 'true';
    expect(schemaConductor().safeParse(base).success).toBe(true);
    expect(schemaConductor().safeParse({ ...base, nro_licencia: 'LIC1' }).success).toBe(true);
    expect(schemaConductor().safeParse({ ...base, ...LIC }).success).toBe(true);
    expect(schemaConductor().safeParse({ ...base, licencia_vencimiento: 'mañana' }).success).toBe(false);
    expect(schemaConductor().safeParse({ ...base, nro_licencia: '' }).success).toBe(false);
  });
});
