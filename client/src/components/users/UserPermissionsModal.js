import React, { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  X, 
  Shield,
  Check,
  X as XIcon,
  AlertCircle
} from 'lucide-react';
import {
  Chip,
  Switch,
  FormControlLabel,
  Tooltip
} from '@mui/material';
import { clearError, clearSuccess } from '../../store/slices/userSlice';
import { PERMISSION_GROUPS, PERMISSION_KEYS, getDefaultPermissions } from '../../constants/permissions';
import { recordActivityChange } from '../../utils/activityCapture';

// Build a clean permissions object containing only the canonical page keys.
const pickPageKeys = (source = {}) => {
  const out = {};
  PERMISSION_KEYS.forEach((key) => { out[key] = source[key] === true; });
  return out;
};

const UserPermissionsModal = ({ isOpen, onClose, user, onSubmit, currentUser }) => {
  const dispatch = useDispatch();
  const { isLoading, error, success } = useSelector(state => state.user);
  const authCurrentUser = useSelector(state => state.auth.user);
  const effectiveCurrentUser = currentUser || authCurrentUser;

  const [permissions, setPermissions] = useState(() => pickPageKeys(getDefaultPermissions('viewer')));

  const [role, setRole] = useState('viewer');

  useEffect(() => {
    if (user) {
      // The server already returns the effective permission set (role defaults
      // for unconfigured users, stored choices once configured), so trust it.
      const base = getDefaultPermissions(user.role);
      setPermissions(pickPageKeys({ ...base, ...(user.permissions || {}) }));
      setRole(user.role);
    }
  }, [user]);

  const handlePermissionChange = (permission) => {
    setPermissions(prev => ({
      ...prev,
      [permission]: !prev[permission]
    }));
  };

  const handleRoleChange = (newRole) => {
    if (newRole === role) return;
    const nextPermissions = pickPageKeys(getDefaultPermissions(newRole));
    const labels = values => PERMISSION_GROUPS.flatMap(group => group.items.filter(({ key }) => values[key]).map(({ label }) => label));
    recordActivityChange({ field: 'User role', form: 'User permissions', before: role, after: newRole });
    recordActivityChange({ field: 'Page permissions', form: 'User permissions', before: labels(permissions), after: labels(nextPermissions) });
    setRole(newRole);
    // Reset the toggles to the new role's defaults.
    setPermissions(nextPermissions);
  };


  const handleSubmit = async (e) => {
    e.preventDefault();
    
    try {
      const userData = {
        role: role,
        permissions: pickPageKeys(permissions)
      };

      await onSubmit(userData);

    } catch (error) {
      // Error handled by Redux
    }
  };

  const handleClose = () => {
    if (user) {
      const base = getDefaultPermissions(user.role);
      setPermissions(pickPageKeys({ ...base, ...(user.permissions || {}) }));
      setRole(user.role);
    }
    dispatch(clearError());
    dispatch(clearSuccess());
    onClose();
  };

  const getRoleColor = (role) => {
    const colors = {
      super_admin: 'error',
      admin: 'warning',
      manager: 'info',
      dispatcher: 'success',
      driver: 'secondary',
      viewer: 'default'
    };
    return colors[role] || 'default';
  };

  const canEditRole = () => {
    if (!effectiveCurrentUser) return false;
    if (effectiveCurrentUser.role === 'super_admin') return true;
    if (effectiveCurrentUser.role === 'admin' && user?.role !== 'super_admin') return true;
    if (user?._id === effectiveCurrentUser._id) return false; // Users can't change their own role
    return false;
  };

  const canEditPermissions = () => {
    if (!effectiveCurrentUser) return false;
    if (effectiveCurrentUser.role === 'super_admin') return true;
    if (effectiveCurrentUser.role === 'admin' && user?.role !== 'super_admin') return true;
    return false;
  };

  if (!isOpen || !user || !effectiveCurrentUser) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black bg-opacity-50"
          onClick={handleClose}
        />
        
        {/* Modal */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 20 }}
          className="relative bg-white rounded-lg shadow-xl w-full max-w-4xl mx-4 max-h-[90vh] overflow-y-auto"
        >
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-200 sticky top-0 bg-white z-10">
            <div className="flex items-center space-x-2">
              <Shield className="w-6 h-6 text-purple-600" />
              <h2 className="text-xl font-semibold text-gray-900">Manage Permissions</h2>
              <Chip 
                label={user.profile?.firstName + ' ' + user.profile?.lastName} 
                size="small" 
                variant="outlined"
              />
            </div>
            <button
              onClick={handleClose}
              className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="p-6 space-y-6">
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 text-red-600 rounded-lg text-sm">
                {error}
              </div>
            )}

            {success && (
              <div className="p-3 bg-green-50 border border-green-200 text-green-600 rounded-lg text-sm">
                Permissions updated successfully!
              </div>
            )}

            {/* Role Selection */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <h3 className="text-lg font-medium text-blue-900 mb-3">User Role</h3>
              <div className="flex flex-wrap gap-2">
                {['viewer', 'driver', 'dispatcher', 'manager', 'admin', ...(effectiveCurrentUser.role === 'super_admin' ? ['super_admin'] : [])].map((roleOption) => (
                  <button
                    key={roleOption}
                    type="button"
                    onClick={() => canEditRole() && handleRoleChange(roleOption)}
                    disabled={!canEditRole()}
                    className={`px-4 py-2 rounded-lg border transition-colors ${
                      role === roleOption
                        ? 'bg-blue-500 text-white border-blue-500'
                        : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    } ${!canEditRole() ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    {roleOption.replace('_', ' ').toUpperCase()}
                  </button>
                ))}
              </div>
              {!canEditRole() && (
                <p className="text-sm text-blue-700 mt-2 flex items-center">
                  <AlertCircle className="w-4 h-4 mr-1" />
                  You don't have permission to change this user's role
                </p>
              )}
            </div>

            {/* Permissions Grid */}
            <div>
              <h3 className="text-lg font-medium text-gray-900 mb-4">Permissions</h3>
              
              {!canEditPermissions() ? (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                  <div className="flex items-center text-yellow-800">
                    <AlertCircle className="w-5 h-5 mr-2" />
                    <span>You don't have permission to edit permissions for this user</span>
                  </div>
                </div>
              ) : (
                <div className="space-y-5">
                  {PERMISSION_GROUPS.map((group) => (
                    <div key={group.label}>
                      <h4 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-2">{group.label}</h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {group.items.map(({ key, label, description }) => {
                          const enabled = permissions[key] === true;
                          return (
                            <div
                              key={key}
                              className={`border rounded-lg p-3 transition-colors ${
                                enabled ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-white'
                              }`}
                            >
                              <div className="flex items-center justify-between mb-1">
                                <h5 className="font-medium text-gray-900">{label}</h5>
                                <Tooltip title={description}>
                                  <div className="flex items-center space-x-2">
                                    <span className={`text-sm ${enabled ? 'text-green-600' : 'text-gray-500'}`}>
                                      {enabled ? 'Enabled' : 'Disabled'}
                                    </span>
                                    <FormControlLabel
                                      control={
                                        <Switch
                                          checked={enabled}
                                          inputProps={{ 'aria-label': `${label} permission` }}
                                          onChange={() => handlePermissionChange(key)}
                                          color="success"
                                          size="small"
                                        />
                                      }
                                      label=""
                                    />
                                  </div>
                                </Tooltip>
                              </div>
                              <p className="text-sm text-gray-600">{description}</p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Permission Summary */}
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
              <h4 className="font-medium text-gray-900 mb-3">Permission Summary</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div className="text-center">
                  <div className="text-2xl font-bold text-green-600">
                    {permissions ? Object.values(permissions).filter(Boolean).length : 0}
                  </div>
                  <div className="text-gray-600">Enabled</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-gray-600">
                    {permissions ? Object.values(permissions).length - Object.values(permissions).filter(Boolean).length : 0}
                  </div>
                  <div className="text-gray-600">Disabled</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-blue-600">
                    {permissions ? Object.values(permissions).length : 0}
                  </div>
                  <div className="text-gray-600">Total</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-bold text-purple-600 capitalize">
                    {role.replace('_', ' ')}
                  </div>
                  <div className="text-gray-600">Role</div>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end space-x-3 pt-4 border-t border-gray-200">
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 text-gray-700 bg-gray-200 rounded-lg hover:bg-gray-300 transition-colors"
                disabled={isLoading}
              >
                Cancel
              </button>
              {canEditPermissions() && (
                <button
                  type="submit"
                  disabled={isLoading}
                  className="flex items-center px-4 py-2 bg-purple-500 text-white rounded-lg hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Shield className="w-4 h-4 mr-2" />
                  {isLoading ? 'Saving...' : 'Save Permissions'}
                </button>
              )}
            </div>
          </form>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

export default UserPermissionsModal;
