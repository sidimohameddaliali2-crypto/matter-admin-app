import jwt from 'jsonwebtoken';
import User from '../models/User.js';

// Shared by HTTP and Socket.IO. Never accept a built-in fallback signing key.
export const authenticateStaffToken = async (token) => {
  if (typeof token !== 'string' || !token || !process.env.JWT_SECRET) {
    throw new Error('Not authorized');
  }
  const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  if (!decoded || typeof decoded.id !== 'string' || decoded.partnerId || decoded.memberId) {
    throw new Error('Invalid token type');
  }
  const user = await User.findById(decoded.id).select('-password');
  if (!user || !user.isActive) throw new Error('Not authorized');
  return user;
};

export const protect = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({ message: 'Not authorized, no token' });
    }

    try {
      req.user = await authenticateStaffToken(token);
      
      if (!req.user) {
        return res.status(401).json({ message: 'User not found' });
      }
      
      if (!req.user.isActive) {
        return res.status(401).json({ message: 'User account is deactivated' });
      }
      
      next();
    } catch (error) {
      return res.status(401).json({ message: 'Not authorized, token failed' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};

export const authorize = (roles = []) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Not authorized' });
    }

    // Convert single role to array
    if (typeof roles === 'string') {
      roles = [roles];
    }

    // Allow access if no roles specified or user has one of the required roles
    if (roles.length === 0 || roles.includes(req.user.role)) {
      return next();
    }

    return res.status(403).json({ 
      success: false,
      message: `User role ${req.user.role} is not authorized to access this route` 
    });
  };
};

// Alias for common role checks
export const admin = authorize(['admin', 'super_admin']);
export const superAdmin = authorize(['super_admin']);
export const manager = authorize(['manager', 'admin', 'super_admin']);
export const dispatcher = authorize(['dispatcher', 'manager', 'admin', 'super_admin']);

export const checkPermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Not authorized' });
    }

    // Super admin has all permissions
    if (req.user.role === 'super_admin') {
      return next();
    }

    if (!req.user.permissions || !req.user.permissions[permission]) {
      return res.status(403).json({ 
        message: `Not authorized to access ${permission}` 
      });
    }

    next();
  };
};

// If you need an authenticate function, you can alias protect as authenticate
export const authenticate = protect;
