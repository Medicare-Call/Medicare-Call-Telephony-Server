import { register, collectDefaultMetrics, Gauge } from 'prom-client';

collectDefaultMetrics({ register });

// 가용한 전화번호 개수 메트릭
export const availableCallerNumbersGauge = new Gauge({
    name: 'telephony_available_caller_numbers_total',
    help: 'Number of available caller numbers',
});

register.registerMetric(availableCallerNumbersGauge);

export { register };