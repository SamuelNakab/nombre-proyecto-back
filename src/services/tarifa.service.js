const DEFAULT_TARIFA_BASE_HORA_CABA = 3500;
const DEFAULT_TARIFA_PICO_HORA_CABA = 5000;
const DEFAULT_TARIFA_BASE_KM_PROVINCIA = 150;
const DEFAULT_TARIFA_PICO_KM_PROVINCIA = 200;

export function esHoraPico(fecha) {
  const hora = fecha.getHours();
  return (hora >= 7 && hora <= 10) || (hora >= 17 && hora <= 20);
}

export function obtenerTarifas(zona, fecha) {
  const es_hora_pico = esHoraPico(fecha);

  const tarifaBaseHora =
    parseFloat(process.env.TARIFA_BASE_HORA_CABA) || DEFAULT_TARIFA_BASE_HORA_CABA;
  const tarifaPicoHora =
    parseFloat(process.env.TARIFA_PICO_HORA_CABA) || DEFAULT_TARIFA_PICO_HORA_CABA;
  const tarifaBaseKm =
    parseFloat(process.env.TARIFA_BASE_KM_PROVINCIA) || DEFAULT_TARIFA_BASE_KM_PROVINCIA;
  const tarifaPicoKm =
    parseFloat(process.env.TARIFA_PICO_KM_PROVINCIA) || DEFAULT_TARIFA_PICO_KM_PROVINCIA;

  const tarifa_hora_valor = es_hora_pico ? tarifaPicoHora : tarifaBaseHora;
  const tarifa_km_valor = es_hora_pico ? tarifaPicoKm : tarifaBaseKm;

  return {
    tarifa_hora: zona === 'PROVINCIA' ? null : tarifa_hora_valor,
    tarifa_km: zona === 'CABA' ? null : tarifa_km_valor,
    es_hora_pico,
  };
}
