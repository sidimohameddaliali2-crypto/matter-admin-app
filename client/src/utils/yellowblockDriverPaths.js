export const DRIVER_PATH = '/yellowblock/driver';
export const DRIVER_LOGIN_PATH = `${DRIVER_PATH}/login`;

export const isDriverAppPath = pathname => [DRIVER_PATH, DRIVER_LOGIN_PATH].includes(pathname.replace(/\/$/, ''));
