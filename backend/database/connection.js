import pool, { query } from '../config/database.js';

// Compatibilidad para rutas antiguas que todavía llaman pool.query(). La
// consulta pasa por el helper instrumentado, mientras connect()/end() y las
// propiedades del Pool siguen delegándose al objeto original.
const instrumentedPool = new Proxy(pool, {
  get(target, property, receiver) {
    if (property === 'query') return query;
    const value = Reflect.get(target, property, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

export { query };
export default instrumentedPool;






