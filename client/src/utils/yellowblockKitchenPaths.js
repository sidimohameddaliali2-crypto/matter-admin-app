export const KITCHEN_PATH = '/yellowblock/kitchen';
export const KITCHEN_LOGIN_PATH = `${KITCHEN_PATH}/login`;

export const isKitchenAppPath = pathname => [KITCHEN_PATH, KITCHEN_LOGIN_PATH].includes(pathname.replace(/\/$/, ''));
