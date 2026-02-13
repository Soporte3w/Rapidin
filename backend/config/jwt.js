import jwt from 'jsonwebtoken';

export const generateToken = (userId, identifier, role) => {
  // Si es conductor (role = 'driver'), identifier es el phone
  // Si es admin, identifier es el email
  const payload = role === 'driver'
    ? { phone: identifier, role }
    : { userId, email: identifier, role };

  return jwt.sign(
    payload,
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

export const verifyToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET);
};







