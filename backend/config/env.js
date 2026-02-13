const requiredEnvVars = [
  'DB_HOST',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'JWT_SECRET'
];

const validateEnv = () => {
  const missing = requiredEnvVars.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
    throw new Error(
      `Faltan variables de entorno requeridas: ${missing.join(', ')}\n` +
      `Por favor, copia .env.example a ${envFile} y completa los valores.`
    );
  }
};

export { validateEnv };

